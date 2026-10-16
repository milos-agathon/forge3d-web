//! Stateless W09 bakers. The math is the pinned native bf8db93 implementation.
use crate::error::{to_js_error, Forge3DErrorCode, WebError};
use forge3d_core::terrain_probes::{
    baker::ProbeBaker,
    heightfield_baker::HeightfieldAnalyticalBaker,
    reflection_baker::{
        HeightfieldReflectionBaker, ReflectionAlbedoMode, ReflectionCaptureLighting,
        ReflectionTerrainMaterial,
    },
    types::{ProbeGridDesc, ProbePlacement},
    HdrImage,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

const MAX_IRRADIANCE_PROBES: usize = 4096;
const MAX_REFLECTION_PROBES: usize = 256;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    heights: Vec<f32>,
    width: u32,
    height: u32,
    terrain_width: f32,
    #[serde(default)]
    terrain_origin: [f32; 2],
    #[serde(default)]
    position: Option<[f32; 3]>,
    #[serde(default)]
    irradiance_positions: Vec<f32>,
    #[serde(default)]
    reflection_positions: Vec<f32>,
    sky_color: [f32; 3],
    sky_intensity: f32,
    ray_count: u32,
    max_trace_distance: f32,
    reflection_resolution: u32,
    reflection_samples: u32,
    terrain_color: [f32; 3],
    reflection_material: Option<ReflectionTerrainMaterial>,
    reflection_lighting: Option<Lighting>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Environment {
    width: u32,
    height: u32,
    data: Vec<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lighting {
    light_direction: [f32; 3],
    light_color: [f32; 3],
    light_intensity: f32,
    environment: Option<Environment>,
    environment_intensity: f32,
    environment_rotation_rad: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    coefficients: Vec<f32>,
    reflection_mips: Vec<Vec<f32>>,
}

fn invalid(message: impl Into<String>) -> JsValue {
    to_js_error(WebError::new(Forge3DErrorCode::InvalidInput, message))
}

fn parse(value: JsValue) -> Result<Input, JsValue> {
    serde_wasm_bindgen::from_value(value).map_err(|e| invalid(e.to_string()))
}

fn validate_common(i: &Input) -> Result<(), JsValue> {
    if i.width < 2
        || i.height < 2
        || u64::from(i.width) * u64::from(i.height) > 16_777_216
        || i.heights.len() as u64 != u64::from(i.width) * u64::from(i.height)
        || !i
            .heights
            .iter()
            .chain(&i.sky_color)
            .chain(&i.terrain_color)
            .chain(&i.terrain_origin)
            .all(|v| v.is_finite())
        || ![i.terrain_width, i.sky_intensity, i.max_trace_distance]
            .iter()
            .all(|v| v.is_finite())
        || i.terrain_width <= 0.0
        || i.max_trace_distance <= 0.0
        || i.sky_intensity < 0.0
        || i.ray_count == 0
        || i.ray_count > 4096
        || !i.reflection_resolution.is_power_of_two()
        || i.reflection_resolution > 64
        || i.reflection_samples == 0
        || i.reflection_samples > 256
    {
        return Err(invalid(
            "invalid probe bake dimensions, values or work limits",
        ));
    }
    Ok(())
}

fn placement(i: &Input, positions: &[f32], limit: usize) -> Result<ProbePlacement, JsValue> {
    if positions.is_empty()
        || !positions.len().is_multiple_of(3)
        || positions.len() / 3 > limit
        || positions.iter().any(|value| !value.is_finite())
    {
        return Err(invalid("invalid probe placement dimensions or values"));
    }
    let half = i.terrain_width * 0.5;
    let positions_ws: Result<Vec<[f32; 3]>, JsValue> = positions
        .chunks_exact(3)
        .map(|position| {
            // Browser terrain is y-up, [origin, origin + width]^2. Native is z-up and centered.
            let centered = [
                position[0] - i.terrain_origin[0] - half,
                position[2] - i.terrain_origin[1] - half,
            ];
            if centered.iter().any(|value| value.abs() > half) {
                return Err(invalid("probe position must lie over the source terrain"));
            }
            Ok([centered[0], centered[1], position[1]])
        })
        .collect();
    let positions_ws = positions_ws?;
    let count = u32::try_from(positions_ws.len())
        .map_err(|_| invalid("probe placement count overflowed"))?;
    Ok(ProbePlacement::new(
        ProbeGridDesc {
            origin: [0.0, 0.0],
            spacing: [1.0, 1.0],
            dims: [count, 1],
            height_offset: 1.0,
            influence_radius: 1.0,
        },
        positions_ws,
    ))
}

fn bake_irradiance(i: &Input, placement: &ProbePlacement) -> Result<Vec<f32>, JsValue> {
    let analytical = HeightfieldAnalyticalBaker {
        heightfield: i.heights.clone(),
        height_dims: (i.width, i.height),
        terrain_span: [i.terrain_width; 2],
        sky_color: i.sky_color,
        sky_intensity: i.sky_intensity,
        ray_count: i.ray_count,
        max_trace_distance: i.max_trace_distance,
    };
    let baked = analytical
        .bake(placement)
        .map_err(|e| invalid(e.to_string()))?;
    Ok(baked
        .probes
        .iter()
        .flat_map(|probe| probe.coeffs.iter().flatten().copied())
        .collect())
}

fn reflection_material(i: &Input) -> Result<ReflectionTerrainMaterial, JsValue> {
    let material = i
        .reflection_material
        .clone()
        .unwrap_or_else(|| ReflectionTerrainMaterial {
            albedo_mode: ReflectionAlbedoMode::Material,
            colormap_strength: 0.0,
            raw_height_range: (0.0, 1.0),
            overlay: None,
            grass_color: i.terrain_color,
            dirt_color: i.terrain_color,
            rock_color: i.terrain_color,
            snow_color: i.terrain_color,
            snow_enabled: false,
            snow_altitude_min: 0.0,
            snow_altitude_blend: 1.0,
            snow_slope_max_deg: 45.0,
            snow_slope_blend_deg: 1.0,
            snow_aspect_influence: 0.0,
            rock_enabled: false,
            rock_slope_min_deg: 45.0,
            rock_slope_blend_deg: 1.0,
            wetness_enabled: false,
            wetness_strength: 0.0,
            wetness_slope_influence: 0.0,
        });
    if !material
        .grass_color
        .iter()
        .chain(&material.dirt_color)
        .chain(&material.rock_color)
        .chain(&material.snow_color)
        .chain(
            [
                material.colormap_strength,
                material.raw_height_range.0,
                material.raw_height_range.1,
                material.snow_altitude_min,
                material.snow_altitude_blend,
                material.snow_slope_max_deg,
                material.snow_slope_blend_deg,
                material.snow_aspect_influence,
                material.rock_slope_min_deg,
                material.rock_slope_blend_deg,
                material.wetness_strength,
                material.wetness_slope_influence,
            ]
            .iter(),
        )
        .all(|v| v.is_finite())
        || material.raw_height_range.0 >= material.raw_height_range.1
        || material.snow_altitude_blend <= 0.0
        || material.snow_slope_blend_deg <= 0.0
        || material.rock_slope_blend_deg <= 0.0
    {
        return Err(invalid("invalid reflection terrain material"));
    }
    if let Some(overlay) = &material.overlay {
        if overlay.stops.len() > 64
            || ![
                overlay.domain.0,
                overlay.domain.1,
                overlay.strength,
                overlay.offset,
            ]
            .iter()
            .all(|v| v.is_finite())
            || overlay.domain.0 >= overlay.domain.1
            || overlay.stops.iter().any(|(position, color)| {
                !position.is_finite() || color.iter().any(|v| !v.is_finite())
            })
        {
            return Err(invalid("invalid reflection overlay"));
        }
    }
    Ok(material)
}

fn bake_reflection(i: &Input, placement: &ProbePlacement) -> Result<Vec<Vec<f32>>, JsValue> {
    let material = reflection_material(i)?;
    let mut environment = HdrImage {
        width: 1,
        height: 1,
        data: i.sky_color.to_vec(),
    };
    let mut lighting = ReflectionCaptureLighting {
        env_image: None,
        env_intensity: i.sky_intensity,
        env_rotation_rad: 0.0,
        light_dir: [0.0, 0.0, 1.0],
        light_color: [1.0; 3],
        light_intensity: 1.0,
    };
    if let Some(source) = &i.reflection_lighting {
        if !source
            .light_direction
            .iter()
            .chain(&source.light_color)
            .chain(
                [
                    source.light_intensity,
                    source.environment_intensity,
                    source.environment_rotation_rad,
                ]
                .iter(),
            )
            .all(|v| v.is_finite())
            || source.light_direction.iter().map(|v| v * v).sum::<f32>() < 1e-12
            || source.light_intensity < 0.0
            || source.environment_intensity < 0.0
        {
            return Err(invalid("invalid reflection lighting"));
        }
        if let Some(image) = &source.environment {
            let pixels = u64::from(image.width) * u64::from(image.height);
            if pixels == 0
                || pixels > 262144
                || image.data.len() as u64 != pixels * 3
                || image.data.iter().any(|v| !v.is_finite() || *v < 0.0)
            {
                return Err(invalid("invalid probe environment"));
            }
            environment = HdrImage {
                width: image.width,
                height: image.height,
                data: image.data.clone(),
            };
        }
        lighting.env_intensity = source.environment_intensity;
        lighting.env_rotation_rad = source.environment_rotation_rad;
        lighting.light_dir = source.light_direction;
        lighting.light_color = source.light_color;
        lighting.light_intensity = source.light_intensity;
    }
    lighting.env_image = Some(&environment);
    let baker = HeightfieldReflectionBaker {
        heightfield: &i.heights,
        height_dims: (i.width, i.height),
        terrain_span: [i.terrain_width; 2],
        z_scale: 1.0,
        resolution: i.reflection_resolution,
        prefilter_sample_count: i.reflection_samples,
        trace_steps: 96,
        trace_refine_steps: 8,
        max_trace_distance: i.max_trace_distance,
        material,
        lighting,
    };
    let baked = baker.bake(placement).map_err(|e| invalid(e.to_string()))?;
    let mut levels = Vec::with_capacity(baked.mip_level_count as usize);
    for level in 0..baked.mip_level_count as usize {
        levels.push(
            baked
                .probes
                .iter()
                .flat_map(|probe| probe.mips[level].texels.iter().flatten().copied())
                .collect(),
        );
    }
    Ok(levels)
}

fn serialize(output: &Output) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(output).map_err(|e| invalid(e.to_string()))
}

/// Backward-compatible single-position combined baker.
#[wasm_bindgen(js_name = bakeTerrainProbe)]
pub fn bake_terrain_probe(value: JsValue) -> Result<JsValue, JsValue> {
    let input = parse(value)?;
    validate_common(&input)?;
    let position = input
        .position
        .ok_or_else(|| invalid("probe position is required"))?;
    let placement = placement(&input, &position, 1)?;
    serialize(&Output {
        coefficients: bake_irradiance(&input, &placement)?,
        reflection_mips: bake_reflection(&input, &placement)?,
    })
}

/// Batch baker used by the browser worker for native-shape independent grids.
#[wasm_bindgen(js_name = bakeTerrainProbeGrids)]
pub fn bake_terrain_probe_grids(value: JsValue) -> Result<JsValue, JsValue> {
    let input = parse(value)?;
    validate_common(&input)?;
    let irradiance = placement(&input, &input.irradiance_positions, MAX_IRRADIANCE_PROBES)?;
    let reflection = placement(&input, &input.reflection_positions, MAX_REFLECTION_PROBES)?;
    serialize(&Output {
        coefficients: bake_irradiance(&input, &irradiance)?,
        reflection_mips: bake_reflection(&input, &reflection)?,
    })
}
