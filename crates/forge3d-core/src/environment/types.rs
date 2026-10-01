use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Environment {
    #[serde(default)]
    pub sun_clock: Option<SunClock>,
    pub sky: Option<Sky>,
    pub fog: Option<Fog>,
    pub clouds: Option<Clouds>,
    pub volumes: Vec<DensityVolume>,
    pub water: Vec<WaterLayer>,
    pub sun_direction: [f32; 3],
    pub sun_color: [f32; 3],
    pub sun_intensity: f32,
    pub resolution_scale: f32,
    pub steps: u32,
    pub temporal_weight: f32,
    pub volumetric_mode: String,
    pub max_distance: f32,
    pub debug: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SunClock {
    pub latitude: f64,
    pub longitude: f64,
    pub unix_seconds: f64,
    pub time_scale: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sky {
    pub model: String,
    pub turbidity: f32,
    pub ground_albedo: f32,
    pub sun_size: f32,
    pub exposure: f32,
    pub sun_intensity: f32,
    pub aerial_perspective: bool,
    pub aerial_density: f32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fog {
    pub density: f32,
    pub height: f32,
    pub falloff: f32,
    pub mode: String,
    pub scattering: f32,
    pub absorption: f32,
    pub color: [f32; 3],
    pub anisotropy: f32,
    pub god_rays: bool,
    pub shaft_intensity: f32,
    pub shaft_samples: u32,
    pub use_shadows: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Clouds {
    pub render_path: String,
    pub color: [f32; 3],
    pub scatter_strength: f32,
    pub mode: String,
    pub density: f32,
    pub coverage: f32,
    pub scale: f32,
    pub height: f32,
    pub thickness: f32,
    pub wind: [f32; 2],
    pub animation_speed: f32,
    pub seed: u32,
    pub shadow_strength: f32,
    pub absorption: f32,
    pub anisotropy: f32,
    pub ambient: f32,
    pub fade_distance: f32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DensityVolume {
    pub bounds: [f32; 6],
    pub density: f32,
    pub color: [f32; 3],
    pub anisotropy: f32,
    pub dimensions: [u32; 3],
    pub data: Vec<f32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaterLayer {
    pub mode: String,
    pub fresnel_power: f32,
    pub hue_shift: f32,
    pub tint_color: [f32; 3],
    pub tint_strength: f32,
    pub ripple_scale: f32,
    pub ripple_speed: f32,
    pub refraction_strength: f32,
    pub shore_attenuation_width: f32,
    pub wave_distortion_strength: f32,
    pub bounds: [f32; 4],
    pub height: f32,
    pub shallow_color: [f32; 3],
    pub deep_color: [f32; 3],
    pub depth_scale: f32,
    pub alpha: f32,
    pub wave_amplitude: f32,
    pub wave_frequency: f32,
    pub wave_speed: f32,
    pub flow: [f32; 2],
    pub roughness: f32,
    pub reflection: String,
    pub reflection_strength: f32,
    pub foam_width: f32,
    pub foam_intensity: f32,
    pub mask_dimensions: [u32; 2],
    pub mask: Vec<f32>,
}
