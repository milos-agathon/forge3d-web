//! Stateless W09 baker. The math is the pinned native bf8db93 implementation.
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    heights: Vec<f32>,
    width: u32,
    height: u32,
    terrain_width: f32,
    #[serde(default)]
    terrain_origin: [f32; 2],
    position: [f32; 3],
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

#[wasm_bindgen(js_name = bakeTerrainProbe)]
pub fn bake_terrain_probe(value: JsValue) -> Result<JsValue, JsValue> {
    let i: Input = serde_wasm_bindgen::from_value(value).map_err(|e| invalid(e.to_string()))?;
    if i.width < 2
        || i.height < 2
        || u64::from(i.width) * u64::from(i.height) > 16_777_216
        || i.heights.len() as u64 != u64::from(i.width) * u64::from(i.height)
        || !i
            .heights
            .iter()
            .chain(&i.position)
            .chain(&i.sky_color)
            .chain(&i.terrain_color)
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
    // Browser terrain is y-up, [0,width]^2. The native baker is z-up and centered.
    let half = i.terrain_width * 0.5;
    let centered = [
        i.position[0] - i.terrain_origin[0] - half,
        i.position[2] - i.terrain_origin[1] - half,
    ];
    if i.terrain_origin.iter().any(|v| !v.is_finite()) || centered.iter().any(|v| v.abs() > half) {
        return Err(invalid("probe position must lie over the source terrain"));
    }
    let placement = ProbePlacement::new(
        ProbeGridDesc {
            origin: centered,
            spacing: [1.0, 1.0],
            dims: [1, 1],
            height_offset: 1.0,
            influence_radius: 1.0,
        },
        vec![[centered[0], centered[1], i.position[1]]],
    );
    let analytical = HeightfieldAnalyticalBaker {
        heightfield: i.heights.clone(),
        height_dims: (i.width, i.height),
        terrain_span: [i.terrain_width; 2],
        sky_color: i.sky_color,
        sky_intensity: i.sky_intensity,
        ray_count: i.ray_count,
        max_trace_distance: i.max_trace_distance,
    };
    let sh = analytical
        .bake(&placement)
        .map_err(|e| invalid(e.to_string()))?;
    let mut env = HdrImage {
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
    if let Some(l) = i.reflection_lighting {
        if !l
            .light_direction
            .iter()
            .chain(&l.light_color)
            .chain(
                [
                    l.light_intensity,
                    l.environment_intensity,
                    l.environment_rotation_rad,
                ]
                .iter(),
            )
            .all(|v| v.is_finite())
            || l.light_direction.iter().map(|v| v * v).sum::<f32>() < 1e-12
            || l.light_intensity < 0.0
            || l.environment_intensity < 0.0
        {
            return Err(invalid("invalid reflection lighting"));
        }
        if let Some(e) = l.environment {
            let pixels = u64::from(e.width) * u64::from(e.height);
            if pixels == 0
                || pixels > 262144
                || e.data.len() as u64 != pixels * 3
                || e.data.iter().any(|v| !v.is_finite() || *v < 0.0)
            {
                return Err(invalid("invalid probe environment"));
            }
            env = HdrImage {
                width: e.width,
                height: e.height,
                data: e.data,
            };
        }
        lighting.env_intensity = l.environment_intensity;
        lighting.env_rotation_rad = l.environment_rotation_rad;
        lighting.light_dir = l.light_direction;
        lighting.light_color = l.light_color;
        lighting.light_intensity = l.light_intensity;
    }
    lighting.env_image = Some(&env);
    let material = i
        .reflection_material
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
    if let Some(o) = &material.overlay {
        if o.stops.len() > 64
            || ![o.domain.0, o.domain.1, o.strength, o.offset]
                .iter()
                .all(|v| v.is_finite())
            || o.domain.0 >= o.domain.1
            || o.stops
                .iter()
                .any(|(p, c)| !p.is_finite() || c.iter().any(|v| !v.is_finite()))
        {
            return Err(invalid("invalid reflection overlay"));
        }
    }
    let reflection = HeightfieldReflectionBaker {
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
    let cube = reflection
        .bake(&placement)
        .map_err(|e| invalid(e.to_string()))?;
    let output = Output {
        coefficients: sh.probes[0].coeffs.iter().flatten().copied().collect(),
        reflection_mips: cube.probes[0]
            .mips
            .iter()
            .map(|m| m.texels.iter().flatten().copied().collect())
            .collect(),
    };
    serde_wasm_bindgen::to_value(&output).map_err(|e| invalid(e.to_string()))
}
