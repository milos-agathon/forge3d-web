//! Terrain PBR/POM material model (W07, parity rows T05-T07).
//!
//! Mirrors the native `terrain_params.py` settings (`TriplanarSettings`,
//! `PomSettings`, `LodSettings`, `SamplingSettings`, `ClampSettings`,
//! `MaterialLayerSettings`, `MaterialNoiseSettings`, `DetailSettings`), the
//! `MaterialSet.terrain_default` layer table, and the uniform packing of
//! `1f4084a:src/terrain/renderer/upload.rs` and `bind_groups/terrain_pass.rs`.
//! Validation messages keep the native wording under a `material.*` field.

use crate::error::{Forge3dError, Result};

mod texture;

pub use texture::{
    assemble_aux_array, assemble_material_array, TerrainAuxArray, TerrainLayerImage,
    TerrainMaskImage, TerrainMaterialArray, TerrainMaterialDiagnostic,
};

/// Native `MAX_LAYERS` for terrain material sets.
pub const TERRAIN_MATERIAL_LAYER_CAPACITY: usize = 4;
/// Entries in a height-curve lookup table.
pub const HEIGHT_CURVE_LUT_SIZE: usize = 256;
/// Size of [`TerrainMaterialUniform`] in bytes.
pub const TERRAIN_MATERIAL_UNIFORM_BYTES: usize = (29 + 64) * 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlbedoMode {
    Material,
    Colormap,
    Mix,
}

impl AlbedoMode {
    /// Native `albedo_mode_f` lane.
    pub fn lane(self) -> f32 {
        match self {
            Self::Material => 0.0,
            Self::Colormap => 1.0,
            Self::Mix => 2.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PomMode {
    Occlusion,
    Relief,
    Parallax,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeightCurveMode {
    Linear,
    Pow,
    Smoothstep,
    Lut,
}

impl HeightCurveMode {
    fn lane(self) -> f32 {
        match self {
            Self::Linear => 0.0,
            Self::Pow => 1.0,
            Self::Smoothstep => 2.0,
            Self::Lut => 3.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SamplingFilter {
    Linear,
    Nearest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SamplingAddress {
    Repeat,
    ClampToEdge,
    MirrorRepeat,
}

/// Specular anti-aliasing tiers. `Native` keeps the native variance threshold
/// of 1.0, which leaves ordinary terrain untouched; `Medium` and `High` lower
/// the threshold so Toksvig widening engages on real normal variance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecularAaQuality {
    Off,
    Native,
    Medium,
    High,
}

impl SpecularAaQuality {
    pub fn variance_threshold(self) -> f32 {
        match self {
            Self::Off => f32::INFINITY,
            Self::Native => 1.0,
            Self::Medium => 0.25,
            Self::High => 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerrainMaterialDebugView {
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

impl TerrainMaterialDebugView {
    fn lane(self) -> f32 {
        match self {
            Self::None => 0.0,
            Self::MaterialAlbedo => 1.0,
            Self::TriplanarWeights => 2.0,
            Self::TriplanarChecker => 3.0,
            Self::PomOffset => 4.0,
            Self::SpecularAaVariance => 5.0,
            Self::Roughness => 6.0,
            Self::LayerWeights => 7.0,
            Self::Subsurface => 8.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TriplanarSettings {
    pub scale: f32,
    pub blend_sharpness: f32,
    pub normal_strength: f32,
}

impl Default for TriplanarSettings {
    fn default() -> Self {
        Self {
            scale: 6.0,
            blend_sharpness: 4.0,
            normal_strength: 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PomSettings {
    pub enabled: bool,
    pub mode: PomMode,
    pub scale: f32,
    pub min_steps: u32,
    pub max_steps: u32,
    pub refine_steps: u32,
    pub shadow: bool,
    pub occlusion: bool,
}

impl Default for PomSettings {
    /// Native `make_terrain_params_config` values with POM switched off, so
    /// the zero-feature material reproduces the existing terrain image.
    fn default() -> Self {
        Self {
            enabled: false,
            mode: PomMode::Occlusion,
            scale: 0.04,
            min_steps: 12,
            max_steps: 40,
            refine_steps: 4,
            shadow: true,
            occlusion: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LodSettings {
    pub level: u32,
    pub bias: f32,
    pub lod0_bias: f32,
}

impl Default for LodSettings {
    fn default() -> Self {
        Self {
            level: 0,
            bias: 0.0,
            lod0_bias: -0.5,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SamplingSettings {
    pub mag_filter: SamplingFilter,
    pub min_filter: SamplingFilter,
    pub mip_filter: SamplingFilter,
    pub anisotropy: u32,
    pub address_u: SamplingAddress,
    pub address_v: SamplingAddress,
    pub address_w: SamplingAddress,
}

impl Default for SamplingSettings {
    fn default() -> Self {
        Self {
            mag_filter: SamplingFilter::Linear,
            min_filter: SamplingFilter::Linear,
            mip_filter: SamplingFilter::Linear,
            anisotropy: 8,
            address_u: SamplingAddress::Repeat,
            address_v: SamplingAddress::Repeat,
            address_w: SamplingAddress::Repeat,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClampSettings {
    /// `None` resolves to the terrain height domain, as in native.
    pub height_range: Option<[f32; 2]>,
    pub slope_range: [f32; 2],
    pub ambient_range: [f32; 2],
    pub shadow_range: [f32; 2],
    pub occlusion_range: [f32; 2],
}

impl Default for ClampSettings {
    fn default() -> Self {
        Self {
            height_range: None,
            slope_range: [0.04, 1.0],
            ambient_range: [0.22, 0.38],
            shadow_range: [0.30, 1.0],
            occlusion_range: [0.65, 1.0],
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HeightCurveSettings {
    pub mode: HeightCurveMode,
    pub strength: f32,
    pub power: f32,
    pub lut: Option<Vec<f32>>,
}

impl Default for HeightCurveSettings {
    fn default() -> Self {
        Self {
            mode: HeightCurveMode::Linear,
            strength: 0.0,
            power: 1.0,
            lut: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaterialNoiseSettings {
    pub macro_scale: f32,
    pub detail_scale: f32,
    pub octaves: u32,
    pub snow_macro_amplitude: f32,
    pub snow_detail_amplitude: f32,
    pub rock_macro_amplitude: f32,
    pub rock_detail_amplitude: f32,
    pub wetness_macro_amplitude: f32,
    pub wetness_detail_amplitude: f32,
}

impl Default for MaterialNoiseSettings {
    fn default() -> Self {
        Self {
            macro_scale: 3.5,
            detail_scale: 18.0,
            octaves: 4,
            snow_macro_amplitude: 0.0,
            snow_detail_amplitude: 0.0,
            rock_macro_amplitude: 0.0,
            rock_detail_amplitude: 0.0,
            wetness_macro_amplitude: 0.0,
            wetness_detail_amplitude: 0.0,
        }
    }
}

impl MaterialNoiseSettings {
    /// Native `variation_enabled`: any nonzero amplitude.
    pub fn enabled(&self) -> bool {
        [
            self.snow_macro_amplitude,
            self.snow_detail_amplitude,
            self.rock_macro_amplitude,
            self.rock_detail_amplitude,
            self.wetness_macro_amplitude,
            self.wetness_detail_amplitude,
        ]
        .iter()
        .any(|amplitude| *amplitude > 0.0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaterialLayerSettings {
    pub snow_enabled: bool,
    pub snow_altitude_min: f32,
    pub snow_altitude_blend: f32,
    pub snow_slope_max: f32,
    pub snow_slope_blend: f32,
    pub snow_aspect_influence: f32,
    pub snow_color: [f32; 3],
    pub snow_roughness: f32,
    pub snow_subsurface_strength: f32,
    pub snow_subsurface_tint: [f32; 3],
    pub rock_enabled: bool,
    pub rock_slope_min: f32,
    pub rock_slope_blend: f32,
    pub rock_color: [f32; 3],
    pub rock_roughness: f32,
    pub rock_subsurface_strength: f32,
    pub rock_subsurface_tint: [f32; 3],
    pub wetness_enabled: bool,
    pub wetness_strength: f32,
    pub wetness_slope_influence: f32,
    pub wetness_subsurface_strength: f32,
    pub wetness_subsurface_tint: [f32; 3],
    pub variation: MaterialNoiseSettings,
}

impl Default for MaterialLayerSettings {
    fn default() -> Self {
        Self {
            snow_enabled: false,
            snow_altitude_min: 2000.0,
            snow_altitude_blend: 500.0,
            snow_slope_max: 45.0,
            snow_slope_blend: 15.0,
            snow_aspect_influence: 0.3,
            snow_color: [0.95, 0.95, 0.98],
            snow_roughness: 0.4,
            snow_subsurface_strength: 0.0,
            snow_subsurface_tint: [1.0, 1.0, 1.0],
            rock_enabled: false,
            rock_slope_min: 45.0,
            rock_slope_blend: 10.0,
            rock_color: [0.35, 0.32, 0.28],
            rock_roughness: 0.8,
            rock_subsurface_strength: 0.0,
            rock_subsurface_tint: [1.0, 1.0, 1.0],
            wetness_enabled: false,
            wetness_strength: 0.3,
            wetness_slope_influence: 0.5,
            wetness_subsurface_strength: 0.0,
            wetness_subsurface_tint: [1.0, 1.0, 1.0],
            variation: MaterialNoiseSettings::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DetailSettings {
    pub enabled: bool,
    pub detail_scale: f32,
    pub normal_strength: f32,
    pub albedo_noise: f32,
    pub fade_start: f32,
    pub fade_end: f32,
    /// Gaussian sigma recorded for a DEM-derived detail normal map.
    pub detail_sigma_px: f32,
    /// Detail normal-map blend strength (0 disables the map).
    pub detail_strength: f32,
}

impl Default for DetailSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            detail_scale: 2.0,
            normal_strength: 0.3,
            albedo_noise: 0.1,
            fade_start: 50.0,
            fade_end: 200.0,
            detail_sigma_px: 3.0,
            detail_strength: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpecularAaSettings {
    pub quality: SpecularAaQuality,
    pub sigma_scale: f32,
}

impl Default for SpecularAaSettings {
    /// Native `VF_SPEC_AA_ENABLED=1`, `VF_SPECAA_SIGMA_SCALE=1`.
    fn default() -> Self {
        Self {
            quality: SpecularAaQuality::Native,
            sigma_scale: 1.0,
        }
    }
}

/// One `MaterialSet` layer: the flat albedo used when no texture is uploaded
/// for it, plus its roughness and metallic lanes.
#[derive(Debug, Clone, PartialEq)]
pub struct TerrainMaterialLayer {
    pub base_color: [f32; 3],
    pub roughness: f32,
    pub metallic: f32,
}

/// Native `MaterialSet.terrain_default()`: rock, grass, dirt and snow.
pub fn terrain_default_layers() -> Vec<TerrainMaterialLayer> {
    vec![
        TerrainMaterialLayer {
            base_color: [0.28, 0.26, 0.24],
            roughness: 0.50,
            metallic: 0.0,
        },
        TerrainMaterialLayer {
            base_color: [0.18, 0.38, 0.10],
            roughness: 0.85,
            metallic: 0.0,
        },
        TerrainMaterialLayer {
            base_color: [0.35, 0.25, 0.15],
            roughness: 0.50,
            metallic: 0.0,
        },
        TerrainMaterialLayer {
            base_color: [0.95, 0.97, 1.0],
            roughness: 0.25,
            metallic: 0.0,
        },
    ]
}

/// Native `GpuMaterialSet` layer centers: evenly spaced over [0, 1].
pub fn layer_centers(layer_count: usize) -> [f32; TERRAIN_MATERIAL_LAYER_CAPACITY] {
    let mut centers = [0.0f32; TERRAIN_MATERIAL_LAYER_CAPACITY];
    let count = layer_count.clamp(1, TERRAIN_MATERIAL_LAYER_CAPACITY);
    if count > 1 {
        let denom = (count as f32 - 1.0).max(1.0);
        for (index, center) in centers.iter_mut().enumerate().take(count) {
            *center = index as f32 / denom;
        }
    }
    centers
}

/// Native `build_shading_uniforms` blend half-width.
pub fn layer_blend_half(layer_count: usize) -> f32 {
    let count = layer_count.max(1) as f32;
    if count <= 1.0 {
        1.0
    } else {
        f32::max(0.5 / count, 0.05)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainMaterialSettings {
    pub albedo_mode: AlbedoMode,
    pub colormap_strength: f32,
    pub gamma: f32,
    pub colormap_srgb: bool,
    pub output_srgb_eotf: bool,
    pub lambert_contrast: f32,
    pub roughness_multiplier: f32,
    pub hue_variation: f32,
    pub material_set: Vec<TerrainMaterialLayer>,
    pub triplanar: TriplanarSettings,
    pub pom: PomSettings,
    pub lod: LodSettings,
    pub sampling: SamplingSettings,
    pub clamp: ClampSettings,
    pub height_curve: HeightCurveSettings,
    pub layers: MaterialLayerSettings,
    pub detail: DetailSettings,
    pub specular_aa: SpecularAaSettings,
    pub debug_view: TerrainMaterialDebugView,
}

impl Default for TerrainMaterialSettings {
    /// The zero-feature material: colormap albedo at full strength, POM,
    /// detail and every layer disabled, so it reproduces the existing image.
    fn default() -> Self {
        Self {
            albedo_mode: AlbedoMode::Colormap,
            colormap_strength: 1.0,
            gamma: 2.2,
            colormap_srgb: false,
            output_srgb_eotf: false,
            lambert_contrast: 0.0,
            roughness_multiplier: 1.0,
            hue_variation: 0.08,
            material_set: terrain_default_layers(),
            triplanar: TriplanarSettings::default(),
            pom: PomSettings::default(),
            lod: LodSettings::default(),
            sampling: SamplingSettings::default(),
            clamp: ClampSettings::default(),
            height_curve: HeightCurveSettings::default(),
            layers: MaterialLayerSettings::default(),
            detail: DetailSettings::default(),
            specular_aa: SpecularAaSettings::default(),
            debug_view: TerrainMaterialDebugView::None,
        }
    }
}

fn invalid(field: &str, message: impl Into<String>) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: format!("material.{field}"),
        message: message.into(),
    }
}

fn finite(value: f32, field: &str) -> Result<f32> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(invalid(field, "must be finite"))
    }
}

fn in_unit(value: f32, field: &str, message: &str) -> Result<()> {
    if (0.0..=1.0).contains(&finite(value, field)?) {
        Ok(())
    } else {
        Err(invalid(field, message))
    }
}

fn positive(value: f32, field: &str) -> Result<()> {
    if finite(value, field)? > 0.0 {
        Ok(())
    } else {
        Err(invalid(field, "must be > 0"))
    }
}

fn unit_color(color: [f32; 3], field: &str, components_message: &str) -> Result<()> {
    for component in color {
        in_unit(component, field, components_message)?;
    }
    Ok(())
}

fn ordered(range: [f32; 2], field: &str) -> Result<()> {
    finite(range[0], field)?;
    finite(range[1], field)?;
    if range[0] >= range[1] {
        return Err(invalid(field, "min must be < max"));
    }
    Ok(())
}

impl TerrainMaterialSettings {
    /// Validates every field with the native `__post_init__` rules.
    pub fn validate(&self) -> Result<()> {
        in_unit(
            self.colormap_strength,
            "colormapStrength",
            "colormap_strength must be 0-1",
        )?;
        if finite(self.gamma, "gamma")? < 0.1 {
            return Err(invalid("gamma", "must be >= 0.1"));
        }
        in_unit(
            self.lambert_contrast,
            "lambertContrast",
            "lambert_contrast must be in [0, 1]",
        )?;
        positive(self.roughness_multiplier, "roughnessMultiplier")?;
        if !(0.0..=1.0).contains(&finite(self.hue_variation, "hueVariation")?) {
            return Err(invalid("hueVariation", "must be in [0, 1]"));
        }
        self.validate_material_set()?;
        self.validate_surface()?;
        self.validate_layers()?;
        self.validate_detail()?;
        positive(self.specular_aa.sigma_scale, "specularAa.sigmaScale")?;
        Ok(())
    }

    fn validate_material_set(&self) -> Result<()> {
        let count = self.material_set.len();
        if count == 0 || count > TERRAIN_MATERIAL_LAYER_CAPACITY {
            return Err(invalid(
                "materialSet",
                "must contain between 1 and 4 layers",
            ));
        }
        for (index, layer) in self.material_set.iter().enumerate() {
            let field = format!("materialSet[{index}]");
            unit_color(
                layer.base_color,
                &format!("{field}.baseColor"),
                "components must be in [0, 1]",
            )?;
            let roughness = finite(layer.roughness, &format!("{field}.roughness"))?;
            if !(0.04..=1.0).contains(&roughness) {
                return Err(invalid(
                    &format!("{field}.roughness"),
                    "roughness must be in [0.04, 1.0]",
                ));
            }
            in_unit(
                layer.metallic,
                &format!("{field}.metallic"),
                "metallic must be in [0, 1]",
            )?;
        }
        Ok(())
    }

    fn validate_surface(&self) -> Result<()> {
        let triplanar = &self.triplanar;
        if finite(triplanar.scale, "triplanar.scale")? <= 0.0 {
            return Err(invalid("triplanar.scale", "scale must be > 0"));
        }
        if finite(triplanar.blend_sharpness, "triplanar.blendSharpness")? <= 0.0 {
            return Err(invalid(
                "triplanar.blendSharpness",
                "blend_sharpness must be > 0",
            ));
        }
        if finite(triplanar.normal_strength, "triplanar.normalStrength")? < 0.0 {
            return Err(invalid(
                "triplanar.normalStrength",
                "normal_strength must be >= 0",
            ));
        }
        let pom = &self.pom;
        if finite(pom.scale, "pom.scale")? < 0.0 {
            return Err(invalid("pom.scale", "scale must be >= 0"));
        }
        if pom.min_steps < 1 {
            return Err(invalid("pom.minSteps", "min_steps must be >= 1"));
        }
        if pom.max_steps < pom.min_steps {
            return Err(invalid("pom.maxSteps", "max_steps must be >= min_steps"));
        }
        if pom.max_steps > 100 {
            return Err(invalid("pom.maxSteps", "max_steps must be <= 100"));
        }
        finite(self.lod.bias, "lod.bias")?;
        finite(self.lod.lod0_bias, "lod.lod0Bias")?;
        if !(1..=16).contains(&self.sampling.anisotropy) {
            return Err(invalid("sampling.anisotropy", "anisotropy must be 1-16"));
        }
        let clamp = &self.clamp;
        if let Some(range) = clamp.height_range {
            ordered(range, "clamp.heightRange")?;
        }
        ordered(clamp.slope_range, "clamp.slopeRange")?;
        ordered(clamp.ambient_range, "clamp.ambientRange")?;
        ordered(clamp.shadow_range, "clamp.shadowRange")?;
        ordered(clamp.occlusion_range, "clamp.occlusionRange")?;
        let curve = &self.height_curve;
        in_unit(
            curve.strength,
            "heightCurve.strength",
            "height_curve_strength must be in [0, 1]",
        )?;
        if finite(curve.power, "heightCurve.power")? <= 0.0 {
            return Err(invalid(
                "heightCurve.power",
                "height_curve_power must be > 0",
            ));
        }
        match (&curve.lut, curve.mode) {
            (None, HeightCurveMode::Lut) => {
                return Err(invalid(
                    "heightCurve.lut",
                    "height_curve_lut is required when height_curve_mode='lut'",
                ));
            }
            (Some(lut), _) => {
                if lut.len() != HEIGHT_CURVE_LUT_SIZE {
                    return Err(invalid(
                        "heightCurve.lut",
                        "height_curve_lut must be a 1D float32 array of length 256",
                    ));
                }
                if lut.iter().any(|value| !value.is_finite()) {
                    return Err(invalid(
                        "heightCurve.lut",
                        "height_curve_lut must contain finite values",
                    ));
                }
                if lut.iter().any(|value| !(0.0..=1.0).contains(value)) {
                    return Err(invalid(
                        "heightCurve.lut",
                        "height_curve_lut values must be within [0, 1]",
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn validate_layers(&self) -> Result<()> {
        let layers = &self.layers;
        finite(layers.snow_altitude_min, "layers.snow.altitudeMin")?;
        if finite(layers.snow_altitude_blend, "layers.snow.altitudeBlend")? <= 0.0 {
            return Err(invalid(
                "layers.snow.altitudeBlend",
                "snow_altitude_blend must be > 0",
            ));
        }
        if !(0.0..=90.0).contains(&finite(layers.snow_slope_max, "layers.snow.slopeMax")?) {
            return Err(invalid(
                "layers.snow.slopeMax",
                "snow_slope_max must be in [0, 90]",
            ));
        }
        if finite(layers.snow_slope_blend, "layers.snow.slopeBlend")? <= 0.0 {
            return Err(invalid(
                "layers.snow.slopeBlend",
                "snow_slope_blend must be > 0",
            ));
        }
        in_unit(
            layers.snow_aspect_influence,
            "layers.snow.aspectInfluence",
            "snow_aspect_influence must be in [0, 1]",
        )?;
        // Native only checks the (R, G, B) arity of layer colors.
        for component in layers.snow_color {
            finite(component, "layers.snow.color")?;
        }
        in_unit(
            layers.snow_roughness,
            "layers.snow.roughness",
            "snow_roughness must be in [0, 1]",
        )?;
        in_unit(
            layers.snow_subsurface_strength,
            "layers.snow.subsurfaceStrength",
            "snow_subsurface_strength must be in [0, 1]",
        )?;
        unit_color(
            layers.snow_subsurface_tint,
            "layers.snow.subsurfaceTint",
            "snow_subsurface_tint components must be in [0, 1]",
        )?;
        if !(0.0..=90.0).contains(&finite(layers.rock_slope_min, "layers.rock.slopeMin")?) {
            return Err(invalid(
                "layers.rock.slopeMin",
                "rock_slope_min must be in [0, 90]",
            ));
        }
        if finite(layers.rock_slope_blend, "layers.rock.slopeBlend")? <= 0.0 {
            return Err(invalid(
                "layers.rock.slopeBlend",
                "rock_slope_blend must be > 0",
            ));
        }
        for component in layers.rock_color {
            finite(component, "layers.rock.color")?;
        }
        in_unit(
            layers.rock_roughness,
            "layers.rock.roughness",
            "rock_roughness must be in [0, 1]",
        )?;
        in_unit(
            layers.rock_subsurface_strength,
            "layers.rock.subsurfaceStrength",
            "rock_subsurface_strength must be in [0, 1]",
        )?;
        unit_color(
            layers.rock_subsurface_tint,
            "layers.rock.subsurfaceTint",
            "rock_subsurface_tint components must be in [0, 1]",
        )?;
        in_unit(
            layers.wetness_strength,
            "layers.wetness.strength",
            "wetness_strength must be in [0, 1]",
        )?;
        in_unit(
            layers.wetness_slope_influence,
            "layers.wetness.slopeInfluence",
            "wetness_slope_influence must be in [0, 1]",
        )?;
        in_unit(
            layers.wetness_subsurface_strength,
            "layers.wetness.subsurfaceStrength",
            "wetness_subsurface_strength must be in [0, 1]",
        )?;
        unit_color(
            layers.wetness_subsurface_tint,
            "layers.wetness.subsurfaceTint",
            "wetness_subsurface_tint components must be in [0, 1]",
        )?;
        let variation = &layers.variation;
        if finite(variation.macro_scale, "layers.variation.macroScale")? <= 0.0 {
            return Err(invalid(
                "layers.variation.macroScale",
                "macro_scale must be > 0",
            ));
        }
        if finite(variation.detail_scale, "layers.variation.detailScale")? <= 0.0 {
            return Err(invalid(
                "layers.variation.detailScale",
                "detail_scale must be > 0",
            ));
        }
        if !(1..=8).contains(&variation.octaves) {
            return Err(invalid(
                "layers.variation.octaves",
                "octaves must be in [1, 8]",
            ));
        }
        for (field, native, value) in [
            (
                "snowMacroAmplitude",
                "snow_macro_amplitude",
                variation.snow_macro_amplitude,
            ),
            (
                "snowDetailAmplitude",
                "snow_detail_amplitude",
                variation.snow_detail_amplitude,
            ),
            (
                "rockMacroAmplitude",
                "rock_macro_amplitude",
                variation.rock_macro_amplitude,
            ),
            (
                "rockDetailAmplitude",
                "rock_detail_amplitude",
                variation.rock_detail_amplitude,
            ),
            (
                "wetnessMacroAmplitude",
                "wetness_macro_amplitude",
                variation.wetness_macro_amplitude,
            ),
            (
                "wetnessDetailAmplitude",
                "wetness_detail_amplitude",
                variation.wetness_detail_amplitude,
            ),
        ] {
            in_unit(
                value,
                &format!("layers.variation.{field}"),
                &format!("{native} must be in [0, 1]"),
            )?;
        }
        Ok(())
    }

    fn validate_detail(&self) -> Result<()> {
        let detail = &self.detail;
        if finite(detail.detail_scale, "detail.scale")? <= 0.0 {
            return Err(invalid("detail.scale", "detail_scale must be > 0"));
        }
        in_unit(
            detail.normal_strength,
            "detail.normalStrength",
            "normal_strength must be in [0, 1]",
        )?;
        if !(0.0..=0.5).contains(&finite(detail.albedo_noise, "detail.albedoNoise")?) {
            return Err(invalid(
                "detail.albedoNoise",
                "albedo_noise must be in [0, 0.5]",
            ));
        }
        if finite(detail.fade_start, "detail.fadeStart")? < 0.0 {
            return Err(invalid("detail.fadeStart", "fade_start must be >= 0"));
        }
        if finite(detail.fade_end, "detail.fadeEnd")? <= detail.fade_start {
            return Err(invalid("detail.fadeEnd", "fade_end must be > fade_start"));
        }
        if finite(detail.detail_sigma_px, "detail.sigmaPx")? <= 0.0 {
            return Err(invalid("detail.sigmaPx", "detail_sigma_px must be > 0"));
        }
        in_unit(
            detail.detail_strength,
            "detail.strength",
            "detail_strength must be in [0, 1]",
        )?;
        Ok(())
    }

    /// Height range after resolving the default against the terrain domain.
    pub fn resolved_height_range(&self, domain: [f32; 2]) -> [f32; 2] {
        self.clamp.height_range.unwrap_or(domain)
    }

    /// Packs the GPU uniform. `mask_bits` marks uploaded snow (1), rock (2)
    /// and wetness (4) masks; `has_detail_map` marks an uploaded normal map.
    pub fn pack(
        &self,
        domain: [f32; 2],
        mask_bits: u32,
        has_detail_map: bool,
    ) -> TerrainMaterialUniform {
        let height_range = self.resolved_height_range(domain);
        let layer_count = self
            .material_set
            .len()
            .clamp(1, TERRAIN_MATERIAL_LAYER_CAPACITY);
        let mut layer_roughness = [1.0f32; TERRAIN_MATERIAL_LAYER_CAPACITY];
        let mut layer_metallic = [0.0f32; TERRAIN_MATERIAL_LAYER_CAPACITY];
        for (index, layer) in self.material_set.iter().take(layer_count).enumerate() {
            layer_roughness[index] = layer.roughness;
            layer_metallic[index] = layer.metallic;
        }
        let pom = &self.pom;
        let pom_flags = if pom.enabled {
            1 | if pom.occlusion { 2 } else { 0 } | if pom.shadow { 4 } else { 0 }
        } else {
            0
        };
        let (min_steps, max_steps, refine_steps) = if pom.enabled {
            (
                pom.min_steps as f32,
                pom.max_steps as f32,
                pom.refine_steps as f32,
            )
        } else {
            (0.0, 0.0, 0.0)
        };
        let layers = &self.layers;
        let variation = &layers.variation;
        let deg = std::f32::consts::PI / 180.0;
        let flag = |enabled: bool| if enabled { 1.0 } else { 0.0 };
        let rgb = |color: [f32; 3], w: f32| [color[0], color[1], color[2], w];
        let spec_aa_enabled = self.specular_aa.quality != SpecularAaQuality::Off;
        let mut lut = [[0.0f32; 4]; HEIGHT_CURVE_LUT_SIZE / 4];
        if let Some(values) = &self.height_curve.lut {
            for (index, value) in values.iter().enumerate().take(HEIGHT_CURVE_LUT_SIZE) {
                lut[index / 4][index % 4] = *value;
            }
        }
        TerrainMaterialUniform {
            control: [
                1.0,
                self.albedo_mode.lane(),
                self.colormap_strength.clamp(0.0, 1.0),
                self.gamma.max(0.1),
            ],
            flags: [
                flag(self.colormap_srgb),
                flag(self.output_srgb_eotf),
                self.roughness_multiplier.max(0.001),
                self.hue_variation,
            ],
            spec_aa: [
                flag(spec_aa_enabled),
                self.specular_aa.sigma_scale.max(0.0),
                if spec_aa_enabled {
                    self.specular_aa.quality.variance_threshold()
                } else {
                    0.0
                },
                self.detail.detail_strength.clamp(0.0, 1.0),
            ],
            triplanar: [
                self.triplanar.scale,
                self.triplanar.blend_sharpness,
                self.triplanar.normal_strength,
                if pom.enabled { pom.scale } else { 0.0 },
            ],
            pom_steps: [min_steps, max_steps, refine_steps, pom_flags as f32],
            layer_heights: layer_centers(layer_count),
            layer_roughness,
            layer_metallic,
            layer_control: [
                layer_count as f32,
                layer_blend_half(layer_count),
                self.lod.bias,
                self.lod.lod0_bias,
            ],
            clamp0: [
                height_range[0],
                height_range[1],
                self.clamp.slope_range[0],
                self.clamp.slope_range[1],
            ],
            clamp1: [
                self.clamp.ambient_range[0],
                self.clamp.ambient_range[1],
                self.clamp.shadow_range[0],
                self.clamp.shadow_range[1],
            ],
            clamp2: [
                self.clamp.occlusion_range[0],
                self.clamp.occlusion_range[1],
                self.lod.level as f32,
                self.sampling.anisotropy as f32,
            ],
            height_curve: [
                self.height_curve.mode.lane(),
                self.height_curve.strength.clamp(0.0, 1.0),
                self.height_curve.power.max(0.01),
                self.lambert_contrast.clamp(0.0, 1.0),
            ],
            detail0: [
                flag(self.detail.enabled),
                self.detail.detail_scale.max(0.1),
                self.detail.normal_strength.clamp(0.0, 1.0),
                self.detail.albedo_noise.clamp(0.0, 0.5),
            ],
            detail1: [
                self.detail.fade_start.max(0.0),
                self.detail
                    .fade_end
                    .max(self.detail.fade_start.max(0.0) + 1.0),
                flag(has_detail_map && self.detail.detail_strength > 0.0),
                (mask_bits & 7) as f32,
            ],
            debug: [self.debug_view.lane(), 0.0, 0.0, 0.0],
            snow_params0: [
                layers.snow_altitude_min,
                layers.snow_altitude_blend,
                layers.snow_slope_max * deg,
                layers.snow_slope_blend * deg,
            ],
            snow_params1: [
                layers.snow_aspect_influence,
                layers.snow_roughness,
                flag(layers.snow_enabled),
                layers.snow_subsurface_strength,
            ],
            snow_color: rgb(layers.snow_color, 0.0),
            snow_sss_tint: rgb(layers.snow_subsurface_tint, 0.0),
            rock_params: [
                layers.rock_slope_min * deg,
                layers.rock_slope_blend * deg,
                layers.rock_roughness,
                flag(layers.rock_enabled),
            ],
            rock_color: rgb(layers.rock_color, layers.rock_subsurface_strength),
            rock_sss_tint: rgb(layers.rock_subsurface_tint, 0.0),
            wetness_params: [
                layers.wetness_strength,
                layers.wetness_slope_influence,
                flag(layers.wetness_enabled),
                layers.wetness_subsurface_strength,
            ],
            wetness_sss_tint: rgb(layers.wetness_subsurface_tint, 0.0),
            variation_params0: [
                variation.macro_scale,
                variation.detail_scale,
                variation.octaves.clamp(1, 8) as f32,
                flag(variation.enabled()),
            ],
            snow_variation: [
                variation.snow_macro_amplitude,
                variation.snow_detail_amplitude,
                0.0,
                0.0,
            ],
            rock_variation: [
                variation.rock_macro_amplitude,
                variation.rock_detail_amplitude,
                0.0,
                0.0,
            ],
            wetness_variation: [
                variation.wetness_macro_amplitude,
                variation.wetness_detail_amplitude,
                0.0,
                0.0,
            ],
            height_curve_lut: lut,
        }
    }
}

/// GPU layout of `TerrainMaterialUniform` in `terrain_material.wgsl`.
#[repr(C, align(16))]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct TerrainMaterialUniform {
    pub control: [f32; 4],
    pub flags: [f32; 4],
    pub spec_aa: [f32; 4],
    pub triplanar: [f32; 4],
    pub pom_steps: [f32; 4],
    pub layer_heights: [f32; 4],
    pub layer_roughness: [f32; 4],
    pub layer_metallic: [f32; 4],
    pub layer_control: [f32; 4],
    pub clamp0: [f32; 4],
    pub clamp1: [f32; 4],
    pub clamp2: [f32; 4],
    pub height_curve: [f32; 4],
    pub detail0: [f32; 4],
    pub detail1: [f32; 4],
    pub debug: [f32; 4],
    pub snow_params0: [f32; 4],
    pub snow_params1: [f32; 4],
    pub snow_color: [f32; 4],
    pub snow_sss_tint: [f32; 4],
    pub rock_params: [f32; 4],
    pub rock_color: [f32; 4],
    pub rock_sss_tint: [f32; 4],
    pub wetness_params: [f32; 4],
    pub wetness_sss_tint: [f32; 4],
    pub variation_params0: [f32; 4],
    pub snow_variation: [f32; 4],
    pub rock_variation: [f32; 4],
    pub wetness_variation: [f32; 4],
    pub height_curve_lut: [[f32; 4]; HEIGHT_CURVE_LUT_SIZE / 4],
}

impl TerrainMaterialUniform {
    /// The uniform bound when no terrain material is set (`control.x == 0`).
    pub fn disabled() -> Self {
        bytemuck::Zeroable::zeroed()
    }
}

#[cfg(test)]
mod tests;
