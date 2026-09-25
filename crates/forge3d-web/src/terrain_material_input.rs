//! `terrain.material` input (W07): serde settings plus decoded images.
//!
//! Every field is optional and resolves against the core native defaults, so
//! the TypeScript-normalized snapshot and a raw partial object both parse.
//! Images travel as `{ width, height, data: Uint8Array }` and are read by
//! reflection instead of serde to avoid per-byte deserialization.

use forge3d_core::terrain_material::{
    AlbedoMode, HeightCurveMode, PomMode, SamplingAddress, SamplingFilter, SpecularAaQuality,
    TerrainLayerImage, TerrainMaskImage, TerrainMaterialDebugView, TerrainMaterialLayer,
    TerrainMaterialSettings, TERRAIN_MATERIAL_LAYER_CAPACITY,
};
use serde::de::IgnoredAny;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::error::{map_core_error, Forge3DErrorCode, WebError};

/// A validated terrain material plus the images it references.
#[derive(Debug, Clone, PartialEq)]
pub struct TerrainMaterialOptions {
    pub settings: TerrainMaterialSettings,
    pub layer_images: Vec<Option<TerrainLayerImage>>,
    pub detail_normal: Option<TerrainLayerImage>,
    /// Snow, rock and wetness coverage masks.
    pub masks: [Option<TerrainMaskImage>; 3],
}

impl TerrainMaterialOptions {
    /// Uploaded image bytes (CPU copies held until the GPU arrays are built).
    pub fn image_bytes(&self) -> u64 {
        let layers: u64 = self
            .layer_images
            .iter()
            .flatten()
            .map(|image| image.rgba.len() as u64)
            .sum();
        let masks: u64 = self
            .masks
            .iter()
            .flatten()
            .map(|mask| mask.values.len() as u64)
            .sum();
        layers
            + masks
            + self
                .detail_normal
                .as_ref()
                .map_or(0, |image| image.rgba.len() as u64)
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum AlbedoModeJs {
    Material,
    Colormap,
    Mix,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PomModeJs {
    Occlusion,
    Relief,
    Parallax,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum CurveModeJs {
    Linear,
    Pow,
    Smoothstep,
    Lut,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum FilterJs {
    Linear,
    Nearest,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum AddressJs {
    Repeat,
    ClampToEdge,
    MirrorRepeat,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum SpecularAaQualityJs {
    Off,
    Native,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum DebugViewJs {
    None,
    MaterialAlbedo,
    TriplanarWeights,
    TriplanarChecker,
    PomOffset,
    SpecularAaVariance,
    Roughness,
    LayerWeights,
    Subsurface,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayerJs {
    base_color: Option<[f32; 3]>,
    roughness: Option<f32>,
    metallic: Option<f32>,
    #[allow(dead_code)]
    texture: Option<IgnoredAny>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriplanarJs {
    scale: Option<f32>,
    blend_sharpness: Option<f32>,
    normal_strength: Option<f32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PomJs {
    enabled: Option<bool>,
    mode: Option<PomModeJs>,
    scale: Option<f32>,
    min_steps: Option<u32>,
    max_steps: Option<u32>,
    refine_steps: Option<u32>,
    shadow: Option<bool>,
    occlusion: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LodJs {
    level: Option<u32>,
    bias: Option<f32>,
    lod0_bias: Option<f32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SamplingJs {
    mag_filter: Option<FilterJs>,
    min_filter: Option<FilterJs>,
    mip_filter: Option<FilterJs>,
    anisotropy: Option<u32>,
    address_u: Option<AddressJs>,
    address_v: Option<AddressJs>,
    address_w: Option<AddressJs>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClampJs {
    height_range: Option<[f32; 2]>,
    slope_range: Option<[f32; 2]>,
    ambient_range: Option<[f32; 2]>,
    shadow_range: Option<[f32; 2]>,
    occlusion_range: Option<[f32; 2]>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeightCurveJs {
    mode: Option<CurveModeJs>,
    strength: Option<f32>,
    power: Option<f32>,
    lut: Option<Vec<f32>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnowJs {
    enabled: Option<bool>,
    altitude_min: Option<f32>,
    altitude_blend: Option<f32>,
    slope_max: Option<f32>,
    slope_blend: Option<f32>,
    aspect_influence: Option<f32>,
    color: Option<[f32; 3]>,
    roughness: Option<f32>,
    subsurface_strength: Option<f32>,
    subsurface_tint: Option<[f32; 3]>,
    #[allow(dead_code)]
    mask: Option<IgnoredAny>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RockJs {
    enabled: Option<bool>,
    slope_min: Option<f32>,
    slope_blend: Option<f32>,
    color: Option<[f32; 3]>,
    roughness: Option<f32>,
    subsurface_strength: Option<f32>,
    subsurface_tint: Option<[f32; 3]>,
    #[allow(dead_code)]
    mask: Option<IgnoredAny>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WetnessJs {
    enabled: Option<bool>,
    strength: Option<f32>,
    slope_influence: Option<f32>,
    subsurface_strength: Option<f32>,
    subsurface_tint: Option<[f32; 3]>,
    #[allow(dead_code)]
    mask: Option<IgnoredAny>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VariationJs {
    macro_scale: Option<f32>,
    detail_scale: Option<f32>,
    octaves: Option<u32>,
    snow_macro_amplitude: Option<f32>,
    snow_detail_amplitude: Option<f32>,
    rock_macro_amplitude: Option<f32>,
    rock_detail_amplitude: Option<f32>,
    wetness_macro_amplitude: Option<f32>,
    wetness_detail_amplitude: Option<f32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayersJs {
    snow: Option<SnowJs>,
    rock: Option<RockJs>,
    wetness: Option<WetnessJs>,
    variation: Option<VariationJs>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DetailJs {
    enabled: Option<bool>,
    scale: Option<f32>,
    normal_strength: Option<f32>,
    albedo_noise: Option<f32>,
    fade_start: Option<f32>,
    fade_end: Option<f32>,
    sigma_px: Option<f32>,
    strength: Option<f32>,
    #[allow(dead_code)]
    normal_map: Option<IgnoredAny>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpecularAaJs {
    quality: Option<SpecularAaQualityJs>,
    sigma_scale: Option<f32>,
}

/// Serde view of `terrain.material` (image fields are skipped here).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerrainMaterialJs {
    albedo_mode: Option<AlbedoModeJs>,
    colormap_strength: Option<f32>,
    gamma: Option<f32>,
    colormap_srgb: Option<bool>,
    output_srgb_eotf: Option<bool>,
    lambert_contrast: Option<f32>,
    roughness_multiplier: Option<f32>,
    hue_variation: Option<f32>,
    material_set: Option<Vec<LayerJs>>,
    triplanar: Option<TriplanarJs>,
    pom: Option<PomJs>,
    lod: Option<LodJs>,
    sampling: Option<SamplingJs>,
    clamp: Option<ClampJs>,
    height_curve: Option<HeightCurveJs>,
    layers: Option<LayersJs>,
    detail: Option<DetailJs>,
    specular_aa: Option<SpecularAaJs>,
    debug_view: Option<DebugViewJs>,
}

fn filter(value: Option<FilterJs>, fallback: SamplingFilter) -> SamplingFilter {
    match value {
        None => fallback,
        Some(FilterJs::Linear) => SamplingFilter::Linear,
        Some(FilterJs::Nearest) => SamplingFilter::Nearest,
    }
}

fn address(value: Option<AddressJs>, fallback: SamplingAddress) -> SamplingAddress {
    match value {
        None => fallback,
        Some(AddressJs::Repeat) => SamplingAddress::Repeat,
        Some(AddressJs::ClampToEdge) => SamplingAddress::ClampToEdge,
        Some(AddressJs::MirrorRepeat) => SamplingAddress::MirrorRepeat,
    }
}

impl TerrainMaterialJs {
    /// Resolves against the native defaults and validates with core rules.
    pub(crate) fn to_settings(&self) -> Result<TerrainMaterialSettings, WebError> {
        let mut s = TerrainMaterialSettings::default();
        if let Some(mode) = self.albedo_mode {
            s.albedo_mode = match mode {
                AlbedoModeJs::Material => AlbedoMode::Material,
                AlbedoModeJs::Colormap => AlbedoMode::Colormap,
                AlbedoModeJs::Mix => AlbedoMode::Mix,
            };
        }
        s.colormap_strength = self.colormap_strength.unwrap_or(s.colormap_strength);
        s.gamma = self.gamma.unwrap_or(s.gamma);
        s.colormap_srgb = self.colormap_srgb.unwrap_or(s.colormap_srgb);
        s.output_srgb_eotf = self.output_srgb_eotf.unwrap_or(s.output_srgb_eotf);
        s.lambert_contrast = self.lambert_contrast.unwrap_or(s.lambert_contrast);
        s.roughness_multiplier = self.roughness_multiplier.unwrap_or(s.roughness_multiplier);
        s.hue_variation = self.hue_variation.unwrap_or(s.hue_variation);
        if let Some(layers) = &self.material_set {
            if layers.is_empty() || layers.len() > TERRAIN_MATERIAL_LAYER_CAPACITY {
                return Err(WebError::new(
                    Forge3DErrorCode::InvalidInput,
                    "Invalid input material.materialSet: must contain between 1 and 4 layers",
                ));
            }
            let defaults = forge3d_core::terrain_material::terrain_default_layers();
            s.material_set = layers
                .iter()
                .enumerate()
                .map(|(index, layer)| {
                    let fallback = defaults[index.min(defaults.len() - 1)].clone();
                    TerrainMaterialLayer {
                        base_color: layer.base_color.unwrap_or(fallback.base_color),
                        roughness: layer.roughness.unwrap_or(fallback.roughness),
                        metallic: layer.metallic.unwrap_or(fallback.metallic),
                    }
                })
                .collect();
        }
        if let Some(t) = &self.triplanar {
            s.triplanar.scale = t.scale.unwrap_or(s.triplanar.scale);
            s.triplanar.blend_sharpness = t.blend_sharpness.unwrap_or(s.triplanar.blend_sharpness);
            s.triplanar.normal_strength = t.normal_strength.unwrap_or(s.triplanar.normal_strength);
        }
        if let Some(p) = &self.pom {
            s.pom.enabled = p.enabled.unwrap_or(s.pom.enabled);
            if let Some(mode) = p.mode {
                s.pom.mode = match mode {
                    PomModeJs::Occlusion => PomMode::Occlusion,
                    PomModeJs::Relief => PomMode::Relief,
                    PomModeJs::Parallax => PomMode::Parallax,
                };
            }
            s.pom.scale = p.scale.unwrap_or(s.pom.scale);
            s.pom.min_steps = p.min_steps.unwrap_or(s.pom.min_steps);
            s.pom.max_steps = p.max_steps.unwrap_or(s.pom.max_steps);
            s.pom.refine_steps = p.refine_steps.unwrap_or(s.pom.refine_steps);
            s.pom.shadow = p.shadow.unwrap_or(s.pom.shadow);
            s.pom.occlusion = p.occlusion.unwrap_or(s.pom.occlusion);
        }
        if let Some(l) = &self.lod {
            s.lod.level = l.level.unwrap_or(s.lod.level);
            s.lod.bias = l.bias.unwrap_or(s.lod.bias);
            s.lod.lod0_bias = l.lod0_bias.unwrap_or(s.lod.lod0_bias);
        }
        if let Some(m) = &self.sampling {
            s.sampling.mag_filter = filter(m.mag_filter, s.sampling.mag_filter);
            s.sampling.min_filter = filter(m.min_filter, s.sampling.min_filter);
            s.sampling.mip_filter = filter(m.mip_filter, s.sampling.mip_filter);
            s.sampling.anisotropy = m.anisotropy.unwrap_or(s.sampling.anisotropy);
            s.sampling.address_u = address(m.address_u, s.sampling.address_u);
            s.sampling.address_v = address(m.address_v, s.sampling.address_v);
            s.sampling.address_w = address(m.address_w, s.sampling.address_w);
        }
        if let Some(c) = &self.clamp {
            s.clamp.height_range = c.height_range.or(s.clamp.height_range);
            s.clamp.slope_range = c.slope_range.unwrap_or(s.clamp.slope_range);
            s.clamp.ambient_range = c.ambient_range.unwrap_or(s.clamp.ambient_range);
            s.clamp.shadow_range = c.shadow_range.unwrap_or(s.clamp.shadow_range);
            s.clamp.occlusion_range = c.occlusion_range.unwrap_or(s.clamp.occlusion_range);
        }
        if let Some(h) = &self.height_curve {
            if let Some(mode) = h.mode {
                s.height_curve.mode = match mode {
                    CurveModeJs::Linear => HeightCurveMode::Linear,
                    CurveModeJs::Pow => HeightCurveMode::Pow,
                    CurveModeJs::Smoothstep => HeightCurveMode::Smoothstep,
                    CurveModeJs::Lut => HeightCurveMode::Lut,
                };
            }
            s.height_curve.strength = h.strength.unwrap_or(s.height_curve.strength);
            s.height_curve.power = h.power.unwrap_or(s.height_curve.power);
            s.height_curve.lut = h.lut.clone();
        }
        if let Some(layers) = &self.layers {
            let m = &mut s.layers;
            if let Some(snow) = &layers.snow {
                m.snow_enabled = snow.enabled.unwrap_or(m.snow_enabled);
                m.snow_altitude_min = snow.altitude_min.unwrap_or(m.snow_altitude_min);
                m.snow_altitude_blend = snow.altitude_blend.unwrap_or(m.snow_altitude_blend);
                m.snow_slope_max = snow.slope_max.unwrap_or(m.snow_slope_max);
                m.snow_slope_blend = snow.slope_blend.unwrap_or(m.snow_slope_blend);
                m.snow_aspect_influence = snow.aspect_influence.unwrap_or(m.snow_aspect_influence);
                m.snow_color = snow.color.unwrap_or(m.snow_color);
                m.snow_roughness = snow.roughness.unwrap_or(m.snow_roughness);
                m.snow_subsurface_strength = snow
                    .subsurface_strength
                    .unwrap_or(m.snow_subsurface_strength);
                m.snow_subsurface_tint = snow.subsurface_tint.unwrap_or(m.snow_subsurface_tint);
            }
            if let Some(rock) = &layers.rock {
                m.rock_enabled = rock.enabled.unwrap_or(m.rock_enabled);
                m.rock_slope_min = rock.slope_min.unwrap_or(m.rock_slope_min);
                m.rock_slope_blend = rock.slope_blend.unwrap_or(m.rock_slope_blend);
                m.rock_color = rock.color.unwrap_or(m.rock_color);
                m.rock_roughness = rock.roughness.unwrap_or(m.rock_roughness);
                m.rock_subsurface_strength = rock
                    .subsurface_strength
                    .unwrap_or(m.rock_subsurface_strength);
                m.rock_subsurface_tint = rock.subsurface_tint.unwrap_or(m.rock_subsurface_tint);
            }
            if let Some(wet) = &layers.wetness {
                m.wetness_enabled = wet.enabled.unwrap_or(m.wetness_enabled);
                m.wetness_strength = wet.strength.unwrap_or(m.wetness_strength);
                m.wetness_slope_influence =
                    wet.slope_influence.unwrap_or(m.wetness_slope_influence);
                m.wetness_subsurface_strength = wet
                    .subsurface_strength
                    .unwrap_or(m.wetness_subsurface_strength);
                m.wetness_subsurface_tint =
                    wet.subsurface_tint.unwrap_or(m.wetness_subsurface_tint);
            }
            if let Some(v) = &layers.variation {
                let n = &mut m.variation;
                n.macro_scale = v.macro_scale.unwrap_or(n.macro_scale);
                n.detail_scale = v.detail_scale.unwrap_or(n.detail_scale);
                n.octaves = v.octaves.unwrap_or(n.octaves);
                n.snow_macro_amplitude = v.snow_macro_amplitude.unwrap_or(n.snow_macro_amplitude);
                n.snow_detail_amplitude =
                    v.snow_detail_amplitude.unwrap_or(n.snow_detail_amplitude);
                n.rock_macro_amplitude = v.rock_macro_amplitude.unwrap_or(n.rock_macro_amplitude);
                n.rock_detail_amplitude =
                    v.rock_detail_amplitude.unwrap_or(n.rock_detail_amplitude);
                n.wetness_macro_amplitude = v
                    .wetness_macro_amplitude
                    .unwrap_or(n.wetness_macro_amplitude);
                n.wetness_detail_amplitude = v
                    .wetness_detail_amplitude
                    .unwrap_or(n.wetness_detail_amplitude);
            }
        }
        if let Some(d) = &self.detail {
            s.detail.enabled = d.enabled.unwrap_or(s.detail.enabled);
            s.detail.detail_scale = d.scale.unwrap_or(s.detail.detail_scale);
            s.detail.normal_strength = d.normal_strength.unwrap_or(s.detail.normal_strength);
            s.detail.albedo_noise = d.albedo_noise.unwrap_or(s.detail.albedo_noise);
            s.detail.fade_start = d.fade_start.unwrap_or(s.detail.fade_start);
            s.detail.fade_end = d.fade_end.unwrap_or(s.detail.fade_end);
            s.detail.detail_sigma_px = d.sigma_px.unwrap_or(s.detail.detail_sigma_px);
            s.detail.detail_strength = d.strength.unwrap_or(s.detail.detail_strength);
        }
        if let Some(aa) = &self.specular_aa {
            if let Some(quality) = aa.quality {
                s.specular_aa.quality = match quality {
                    SpecularAaQualityJs::Off => SpecularAaQuality::Off,
                    SpecularAaQualityJs::Native => SpecularAaQuality::Native,
                    SpecularAaQualityJs::Medium => SpecularAaQuality::Medium,
                    SpecularAaQualityJs::High => SpecularAaQuality::High,
                };
            }
            s.specular_aa.sigma_scale = aa.sigma_scale.unwrap_or(s.specular_aa.sigma_scale);
        }
        if let Some(view) = self.debug_view {
            s.debug_view = match view {
                DebugViewJs::None => TerrainMaterialDebugView::None,
                DebugViewJs::MaterialAlbedo => TerrainMaterialDebugView::MaterialAlbedo,
                DebugViewJs::TriplanarWeights => TerrainMaterialDebugView::TriplanarWeights,
                DebugViewJs::TriplanarChecker => TerrainMaterialDebugView::TriplanarChecker,
                DebugViewJs::PomOffset => TerrainMaterialDebugView::PomOffset,
                DebugViewJs::SpecularAaVariance => TerrainMaterialDebugView::SpecularAaVariance,
                DebugViewJs::Roughness => TerrainMaterialDebugView::Roughness,
                DebugViewJs::LayerWeights => TerrainMaterialDebugView::LayerWeights,
                DebugViewJs::Subsurface => TerrainMaterialDebugView::Subsurface,
            };
        }
        s.validate().map_err(map_core_error)?;
        Ok(s)
    }
}

fn invalid(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message)
}

fn get(value: &JsValue, name: &str) -> Result<Option<JsValue>, WebError> {
    if !value.is_object() {
        return Ok(None);
    }
    let property = js_sys::Reflect::get(value, &JsValue::from_str(name))
        .map_err(|_| invalid(format!("terrain material {name} could not be read")))?;
    Ok(if property.is_undefined() || property.is_null() {
        None
    } else {
        Some(property)
    })
}

/// Reads `{ width, height, data: Uint8Array }`; size consistency is reported
/// later as a fallback diagnostic, matching native texture-load failures.
fn read_image(value: &JsValue, field: &str) -> Result<(u32, u32, Vec<u8>), WebError> {
    let dimension = |name: &str| -> Result<u32, WebError> {
        get(value, name)?
            .and_then(|number| number.as_f64())
            .filter(|number| number.fract() == 0.0 && *number >= 1.0 && *number <= u32::MAX as f64)
            .map(|number| number as u32)
            .ok_or_else(|| {
                invalid(format!(
                    "Invalid input material.{field}: width and height must be positive integers"
                ))
            })
    };
    let width = dimension("width")?;
    let height = dimension("height")?;
    let data = get(value, "data")?
        .and_then(|data| data.dyn_into::<js_sys::Uint8Array>().ok())
        .ok_or_else(|| {
            invalid(format!(
                "Invalid input material.{field}: data must be a Uint8Array"
            ))
        })?;
    Ok((width, height, data.to_vec()))
}

fn layer_image(value: Option<JsValue>, field: &str) -> Result<Option<TerrainLayerImage>, WebError> {
    value
        .map(|value| {
            read_image(&value, field).map(|(width, height, rgba)| TerrainLayerImage {
                width,
                height,
                rgba,
            })
        })
        .transpose()
}

fn mask_image(value: Option<JsValue>, field: &str) -> Result<Option<TerrainMaskImage>, WebError> {
    value
        .map(|value| {
            read_image(&value, field).map(|(width, height, values)| TerrainMaskImage {
                width,
                height,
                values,
            })
        })
        .transpose()
}

/// Parses `terrain.material`; `None` when the property is absent.
pub fn read_terrain_material(
    terrain: &JsValue,
) -> Result<Option<TerrainMaterialOptions>, WebError> {
    let Some(material) = get(terrain, "material")? else {
        return Ok(None);
    };
    if !material.is_object() || js_sys::Array::is_array(&material) {
        return Err(invalid("Invalid input material: must be an object"));
    }
    let parsed: TerrainMaterialJs = serde_wasm_bindgen::from_value(material.clone())
        .map_err(|error| invalid(format!("Invalid terrain material input: {error}")))?;
    let settings = parsed.to_settings()?;
    let mut layer_images = Vec::with_capacity(settings.material_set.len());
    if let Some(layers) = get(&material, "materialSet")? {
        let layers = js_sys::Array::from(&layers);
        for (index, layer) in layers.iter().enumerate() {
            let field = format!("materialSet[{index}].texture");
            layer_images.push(layer_image(get(&layer, "texture")?, &field)?);
        }
    }
    layer_images.resize(settings.material_set.len(), None);
    let detail_normal = match get(&material, "detail")? {
        Some(detail) => layer_image(get(&detail, "normalMap")?, "detail.normalMap")?,
        None => None,
    };
    let mut masks: [Option<TerrainMaskImage>; 3] = [None, None, None];
    if let Some(layers) = get(&material, "layers")? {
        for (index, name) in ["snow", "rock", "wetness"].iter().enumerate() {
            if let Some(layer) = get(&layers, name)? {
                masks[index] = mask_image(get(&layer, "mask")?, &format!("layers.{name}.mask"))?;
            }
        }
    }
    Ok(Some(TerrainMaterialOptions {
        settings,
        layer_images,
        detail_normal,
        masks,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: serde_json::Value) -> Result<TerrainMaterialSettings, WebError> {
        let parsed: TerrainMaterialJs = serde_json::from_value(json).expect("serde shape");
        parsed.to_settings()
    }

    #[test]
    fn empty_object_resolves_to_native_defaults() {
        assert_eq!(
            parse(serde_json::json!({})).unwrap(),
            TerrainMaterialSettings::default()
        );
    }

    #[test]
    fn partial_fields_override_defaults() {
        let settings = parse(serde_json::json!({
            "albedoMode": "material",
            "pom": { "enabled": true, "maxSteps": 64 },
            "layers": {
                "snow": { "enabled": true, "altitudeMin": 1.2, "subsurfaceStrength": 0.8 },
                "variation": { "snowMacroAmplitude": 0.5 }
            },
            "materialSet": [{ "roughness": 0.9 }, {}],
            "specularAa": { "quality": "high" },
            "debugView": "layer-weights"
        }))
        .unwrap();
        assert_eq!(settings.albedo_mode, AlbedoMode::Material);
        assert!(settings.pom.enabled);
        assert_eq!(settings.pom.max_steps, 64);
        assert_eq!(settings.pom.min_steps, 12);
        assert!(settings.layers.snow_enabled);
        assert_eq!(settings.layers.snow_altitude_min, 1.2);
        assert_eq!(settings.layers.variation.snow_macro_amplitude, 0.5);
        assert_eq!(settings.material_set.len(), 2);
        assert_eq!(settings.material_set[0].roughness, 0.9);
        assert_eq!(settings.material_set[0].base_color, [0.28, 0.26, 0.24]);
        assert_eq!(settings.material_set[1].roughness, 0.85);
        assert_eq!(settings.specular_aa.quality, SpecularAaQuality::High);
        assert_eq!(settings.debug_view, TerrainMaterialDebugView::LayerWeights);
    }

    #[test]
    fn invalid_values_use_native_messages() {
        let error = parse(serde_json::json!({ "pom": { "maxSteps": 101 } })).unwrap_err();
        assert_eq!(error.code(), Forge3DErrorCode::InvalidInput);
        assert_eq!(
            error.message(),
            "Invalid input material.pom.maxSteps: max_steps must be <= 100"
        );
        let error =
            parse(serde_json::json!({ "layers": { "snow": { "slopeMax": 91 } } })).unwrap_err();
        assert!(error
            .message()
            .contains("snow_slope_max must be in [0, 90]"));
        let error = parse(serde_json::json!({ "heightCurve": { "mode": "lut" } })).unwrap_err();
        assert!(error
            .message()
            .contains("height_curve_lut is required when height_curve_mode='lut'"));
        let error = parse(serde_json::json!({ "materialSet": [] })).unwrap_err();
        assert!(error.message().contains("between 1 and 4 layers"));
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let parsed: Result<TerrainMaterialJs, _> =
            serde_json::from_value(serde_json::json!({ "pomm": {} }));
        assert!(parsed.is_err());
        let parsed: Result<TerrainMaterialJs, _> = serde_json::from_value(
            serde_json::json!({ "layers": { "snow": { "mask": { "width": 1 } } } }),
        );
        assert!(
            parsed.is_ok(),
            "image fields are read by reflection, not serde"
        );
    }
}
