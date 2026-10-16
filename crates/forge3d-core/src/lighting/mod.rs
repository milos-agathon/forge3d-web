use crate::error::{Forge3dError, Result};

pub const MAX_LIGHTS: usize = 64;
pub const PACKED_LIGHT_BYTES: usize = 112;
pub const LIGHTING_UNIFORM_BYTES: usize = 32;
pub const LTC_LUT_SIZE: usize = 64;

const KIND_DIRECTIONAL: u32 = 0;
const KIND_POINT: u32 = 1;
const KIND_SPOT: u32 = 2;
const KIND_RECT: u32 = 3;

/// Bit 0 of `PackedLight::enabled`: the light contributes when set.
const ENABLED_FLAG: u32 = 1;
/// Bit 1 of `PackedLight::enabled`: rect lights emit from both faces.
/// Kept out of `casts_shadow` so shadow routing stays a separate concern.
const TWO_SIDED_FLAG: u32 = 2;

#[repr(C, align(16))]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct PackedLight {
    pub kind: u32,
    /// Bit 0: enabled. Bit 1 (rect only): two-sided emission.
    pub enabled: u32,
    pub casts_shadow: u32,
    pub falloff_mode: u32,
    pub color_intensity: [f32; 4],
    pub position_range: [f32; 4],
    pub direction_inner_cos: [f32; 4],
    pub right_width: [f32; 4],
    pub up_height: [f32; 4],
    pub soft_params: [f32; 4],
}

#[repr(C, align(16))]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct LightingUniform {
    pub light_count: u32,
    pub area_mode: u32,
    pub area_sample_count: u32,
    pub debug_bounds: u32,
    pub exposure: f32,
    pub ltc_lut_size: f32,
    pub _pad: [f32; 2],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoftLightFalloff {
    Linear,
    Quadratic,
    Cubic,
    Exponential,
    /// Native light-buffer attenuation: `(1 - (d/r)^2) / max(d^2, 1e-4)`.
    InverseSquare,
}

impl SoftLightFalloff {
    fn lane(self) -> u32 {
        match self {
            Self::Linear => 0,
            Self::Quadratic => 1,
            Self::Cubic => 2,
            Self::Exponential => 3,
            Self::InverseSquare => 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AreaLightMode {
    Ltc,
    Sampled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AreaLightConfig {
    pub mode: AreaLightMode,
    pub sample_count: u32,
    pub lut_size: u32,
}

impl Default for AreaLightConfig {
    fn default() -> Self {
        Self {
            mode: AreaLightMode::Ltc,
            sample_count: 4,
            lut_size: LTC_LUT_SIZE as u32,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DirectionalLight {
    pub color: [f32; 3],
    pub intensity: f32,
    pub enabled: bool,
    pub casts_shadow: bool,
    pub direction: [f32; 3],
}

#[derive(Debug, Clone, PartialEq)]
pub struct PointLight {
    pub color: [f32; 3],
    pub intensity: f32,
    pub enabled: bool,
    pub casts_shadow: bool,
    pub position: [f32; 3],
    pub range: f32,
    pub inner_radius: f32,
    pub edge_softness: f32,
    pub falloff: SoftLightFalloff,
    pub falloff_exponent: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpotLight {
    pub color: [f32; 3],
    pub intensity: f32,
    pub enabled: bool,
    pub casts_shadow: bool,
    pub position: [f32; 3],
    pub direction: [f32; 3],
    pub range: f32,
    pub inner_cone_degrees: f32,
    pub outer_cone_degrees: f32,
    pub inner_radius: f32,
    pub edge_softness: f32,
    pub falloff: SoftLightFalloff,
    pub falloff_exponent: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RectAreaLight {
    pub color: [f32; 3],
    pub intensity: f32,
    pub enabled: bool,
    pub casts_shadow: bool,
    pub position: [f32; 3],
    pub right: [f32; 3],
    pub up: [f32; 3],
    pub width: f32,
    pub height: f32,
    pub range: f32,
    pub edge_softness: f32,
    pub two_sided: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Light {
    Directional(DirectionalLight),
    Point(PointLight),
    Spot(SpotLight),
    Rect(RectAreaLight),
}

#[derive(Debug, Clone, PartialEq)]
pub struct LightingState {
    pub max_lights: u32,
    pub exposure: f32,
    pub debug_bounds: bool,
    pub area: AreaLightConfig,
    pub lights: Vec<Light>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LightBounds {
    Unbounded,
    Sphere { center: [f32; 3], radius: f32 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct LtcLut {
    pub matrix: Vec<[f32; 4]>,
    pub amplitude: Vec<f32>,
}

pub fn default_state() -> LightingState {
    LightingState {
        max_lights: MAX_LIGHTS as u32,
        exposure: 1.0,
        debug_bounds: false,
        area: AreaLightConfig::default(),
        lights: vec![
            Light::Directional(DirectionalLight {
                color: [1.0, 1.0, 1.0],
                intensity: 3.0,
                enabled: true,
                casts_shadow: true,
                direction: normalize3([0.48, -0.78, -0.40]),
            }),
            Light::Directional(DirectionalLight {
                color: [1.0, 1.0, 1.0],
                intensity: 0.36,
                enabled: true,
                casts_shadow: true,
                direction: normalize3([-0.55, -0.45, 0.35]),
            }),
        ],
    }
}

impl Light {
    pub fn validated(&self) -> Result<Light> {
        match self {
            Light::Directional(light) => {
                validate_base(light.color, light.intensity)?;
                Ok(Light::Directional(DirectionalLight {
                    direction: normalize3_checked(light.direction, "light.direction")?,
                    ..light.clone()
                }))
            }
            Light::Point(light) => {
                validate_base(light.color, light.intensity)?;
                validate_soft(light.range, light.inner_radius, light.edge_softness)?;
                validate_falloff_exponent(light.falloff_exponent)?;
                validate_vec3(light.position, "light.position")?;
                Ok(Light::Point(light.clone()))
            }
            Light::Spot(light) => {
                validate_base(light.color, light.intensity)?;
                validate_soft(light.range, light.inner_radius, light.edge_softness)?;
                validate_falloff_exponent(light.falloff_exponent)?;
                validate_vec3(light.position, "light.position")?;
                validate_cones(light.inner_cone_degrees, light.outer_cone_degrees)?;
                Ok(Light::Spot(SpotLight {
                    direction: normalize3_checked(light.direction, "light.direction")?,
                    ..light.clone()
                }))
            }
            Light::Rect(light) => {
                validate_base(light.color, light.intensity)?;
                validate_vec3(light.position, "light.position")?;
                validate_positive(light.range, "light.range")?;
                validate_positive(light.width, "light.width")?;
                validate_positive(light.height, "light.height")?;
                validate_nonnegative(light.edge_softness, "light.edgeSoftness")?;
                let right = normalize3_checked(light.right, "light.right")?;
                let up = orthogonalize(right, light.up)?;
                Ok(Light::Rect(RectAreaLight {
                    right,
                    up,
                    ..light.clone()
                }))
            }
        }
    }

    pub fn effective_range(&self) -> f32 {
        match self {
            Light::Directional(_) => f32::INFINITY,
            Light::Point(light) => light.range + light.edge_softness,
            Light::Spot(light) => light.range + light.edge_softness,
            Light::Rect(light) => light.range + light.edge_softness,
        }
    }

    pub fn affects_point(&self, point: [f32; 3]) -> bool {
        let enabled = match self {
            Light::Directional(light) => light.enabled,
            Light::Point(light) => light.enabled,
            Light::Spot(light) => light.enabled,
            Light::Rect(light) => light.enabled,
        };
        if !enabled {
            return false;
        }
        match self {
            Light::Directional(_) => true,
            Light::Point(light) => {
                let delta = sub3(point, light.position);
                length3(delta) <= self.effective_range()
            }
            Light::Spot(light) => {
                let delta = sub3(point, light.position);
                let distance = length3(delta);
                if distance > self.effective_range() {
                    return false;
                }
                if distance == 0.0 {
                    return true;
                }
                let cos = dot3(delta, light.direction) / distance;
                cos >= light.outer_cone_degrees.to_radians().cos()
            }
            Light::Rect(light) => {
                let delta = sub3(point, light.position);
                if length3(delta) > self.effective_range() {
                    return false;
                }
                if light.two_sided {
                    return true;
                }
                let normal = cross3(light.right, light.up);
                dot3(delta, normal) >= 0.0
            }
        }
    }

    pub fn bounds(&self) -> LightBounds {
        match self {
            Light::Directional(_) => LightBounds::Unbounded,
            Light::Point(light) => LightBounds::Sphere {
                center: light.position,
                radius: light.range + light.edge_softness,
            },
            Light::Spot(light) => LightBounds::Sphere {
                center: light.position,
                radius: light.range + light.edge_softness,
            },
            Light::Rect(light) => LightBounds::Sphere {
                center: light.position,
                radius: light.range
                    + light.edge_softness
                    + (light.width * 0.5).hypot(light.height * 0.5),
            },
        }
    }

    pub fn pack(&self) -> PackedLight {
        match self {
            Light::Directional(light) => PackedLight {
                kind: KIND_DIRECTIONAL,
                enabled: if light.enabled { ENABLED_FLAG } else { 0 },
                casts_shadow: light.casts_shadow as u32,
                falloff_mode: SoftLightFalloff::Quadratic.lane(),
                color_intensity: color_intensity(light.color, light.intensity),
                position_range: [0.0; 4],
                direction_inner_cos: [
                    light.direction[0],
                    light.direction[1],
                    light.direction[2],
                    0.0,
                ],
                right_width: [0.0; 4],
                up_height: [0.0; 4],
                soft_params: [0.0; 4],
            },
            Light::Point(light) => PackedLight {
                kind: KIND_POINT,
                enabled: if light.enabled { ENABLED_FLAG } else { 0 },
                casts_shadow: light.casts_shadow as u32,
                falloff_mode: light.falloff.lane(),
                color_intensity: color_intensity(light.color, light.intensity),
                position_range: [
                    light.position[0],
                    light.position[1],
                    light.position[2],
                    light.range,
                ],
                direction_inner_cos: [0.0; 4],
                right_width: [0.0; 4],
                up_height: [0.0; 4],
                soft_params: [
                    light.inner_radius,
                    light.edge_softness,
                    light.falloff_exponent,
                    0.0,
                ],
            },
            Light::Spot(light) => PackedLight {
                kind: KIND_SPOT,
                enabled: if light.enabled { ENABLED_FLAG } else { 0 },
                casts_shadow: light.casts_shadow as u32,
                falloff_mode: light.falloff.lane(),
                color_intensity: color_intensity(light.color, light.intensity),
                position_range: [
                    light.position[0],
                    light.position[1],
                    light.position[2],
                    light.range,
                ],
                direction_inner_cos: [
                    light.direction[0],
                    light.direction[1],
                    light.direction[2],
                    light.inner_cone_degrees.to_radians().cos(),
                ],
                right_width: [0.0; 4],
                up_height: [0.0; 4],
                soft_params: [
                    light.inner_radius,
                    light.edge_softness,
                    light.falloff_exponent,
                    light.outer_cone_degrees.to_radians().cos(),
                ],
            },
            Light::Rect(light) => {
                let normal = cross3(light.right, light.up);
                PackedLight {
                    kind: KIND_RECT,
                    enabled: (if light.enabled { ENABLED_FLAG } else { 0 })
                        | (if light.two_sided { TWO_SIDED_FLAG } else { 0 }),
                    casts_shadow: light.casts_shadow as u32,
                    falloff_mode: SoftLightFalloff::Quadratic.lane(),
                    color_intensity: color_intensity(light.color, light.intensity),
                    position_range: [
                        light.position[0],
                        light.position[1],
                        light.position[2],
                        light.range,
                    ],
                    direction_inner_cos: [normal[0], normal[1], normal[2], 0.0],
                    right_width: [light.right[0], light.right[1], light.right[2], light.width],
                    up_height: [light.up[0], light.up[1], light.up[2], light.height],
                    soft_params: [0.0, light.edge_softness, 0.0, 0.0],
                }
            }
        }
    }
}

impl LightingState {
    pub fn validated(&self) -> Result<LightingState> {
        if self.max_lights == 0 || self.max_lights > MAX_LIGHTS as u32 {
            return Err(invalid(
                "lighting.maxLights",
                "must be an integer between 1 and 64",
            ));
        }
        if !self.exposure.is_finite() || self.exposure < 0.0 {
            return Err(invalid(
                "lighting.exposure",
                "must be finite and nonnegative",
            ));
        }
        if ![1, 4, 8, 16].contains(&self.area.sample_count) {
            return Err(invalid(
                "lighting.areaLights.sampleCount",
                "must be 1, 4, 8, or 16",
            ));
        }
        if self.area.lut_size != LTC_LUT_SIZE as u32 {
            return Err(invalid("lighting.areaLights.lutSize", "must be 64"));
        }
        if self.lights.len() > self.max_lights as usize {
            return Err(invalid("lighting.lights", "exceeds maxLights"));
        }
        let mut lights = Vec::with_capacity(self.lights.len());
        for light in &self.lights {
            lights.push(light.validated()?);
        }
        Ok(LightingState {
            lights,
            ..self.clone()
        })
    }

    /// Pack validated lights into GPU lanes. Call `validated()` first.
    pub fn pack_lights(&self) -> Vec<PackedLight> {
        self.lights.iter().map(Light::pack).collect()
    }

    pub fn uniform(&self) -> LightingUniform {
        LightingUniform {
            light_count: self.lights.len() as u32,
            area_mode: match self.area.mode {
                AreaLightMode::Ltc => 0,
                AreaLightMode::Sampled => 1,
            },
            area_sample_count: self.area.sample_count,
            debug_bounds: self.debug_bounds as u32,
            exposure: self.exposure,
            ltc_lut_size: self.area.lut_size as f32,
            _pad: [0.0; 2],
        }
    }
}

pub fn generate_ltc_lut() -> LtcLut {
    let mut matrix = Vec::with_capacity(LTC_LUT_SIZE * LTC_LUT_SIZE);
    let mut amplitude = Vec::with_capacity(LTC_LUT_SIZE * LTC_LUT_SIZE);
    for row in 0..LTC_LUT_SIZE {
        let roughness = (row as f32 + 0.5) / LTC_LUT_SIZE as f32;
        let alpha = roughness * roughness;
        for column in 0..LTC_LUT_SIZE {
            let ndotv = (column as f32 + 0.5) / LTC_LUT_SIZE as f32;
            let stretch = 1.0 + alpha * (1.0 - ndotv) * 8.0;
            let m00 = 1.0 / stretch;
            let m11 = 1.0 / stretch;
            let m02 = alpha * (1.0 - ndotv) * 2.0;
            matrix.push([m00, m11, m02, 0.0]);
            amplitude.push(ndotv * (1.0 - alpha * 0.5) + 0.05);
        }
    }
    LtcLut { matrix, amplitude }
}

fn color_intensity(color: [f32; 3], intensity: f32) -> [f32; 4] {
    [color[0], color[1], color[2], intensity]
}

fn validate_base(color: [f32; 3], intensity: f32) -> Result<()> {
    for component in color {
        if !component.is_finite() || !(0.0..=1.0).contains(&component) {
            return Err(invalid(
                "light.color",
                "components must be finite and in the 0..1 range",
            ));
        }
    }
    if !intensity.is_finite() || intensity < 0.0 {
        return Err(invalid("light.intensity", "must be finite and nonnegative"));
    }
    Ok(())
}

fn validate_vec3(value: [f32; 3], field: &'static str) -> Result<()> {
    for component in value {
        if !component.is_finite() {
            return Err(invalid(field, "components must be finite"));
        }
    }
    Ok(())
}

fn validate_positive(value: f32, field: &'static str) -> Result<()> {
    if !value.is_finite() || value <= 0.0 {
        return Err(invalid(field, "must be finite and positive"));
    }
    Ok(())
}

fn validate_nonnegative(value: f32, field: &'static str) -> Result<()> {
    if !value.is_finite() || value < 0.0 {
        return Err(invalid(field, "must be finite and nonnegative"));
    }
    Ok(())
}

fn validate_soft(range: f32, inner_radius: f32, edge_softness: f32) -> Result<()> {
    validate_positive(range, "light.range")?;
    if !inner_radius.is_finite() || inner_radius < 0.0 || inner_radius >= range {
        return Err(invalid(
            "light.innerRadius",
            "must be in the 0..range interval",
        ));
    }
    validate_nonnegative(edge_softness, "light.edgeSoftness")
}

fn validate_falloff_exponent(exponent: f32) -> Result<()> {
    validate_positive(exponent, "light.falloffExponent")
}

fn validate_cones(inner_degrees: f32, outer_degrees: f32) -> Result<()> {
    for (value, field) in [
        (inner_degrees, "light.innerConeDegrees"),
        (outer_degrees, "light.outerConeDegrees"),
    ] {
        if !value.is_finite() || value < 0.0 || value >= 90.0 {
            return Err(invalid(
                field,
                "must be finite and in the 0..90 degree range",
            ));
        }
    }
    if inner_degrees > outer_degrees {
        return Err(invalid(
            "light.innerConeDegrees",
            "must not exceed outerConeDegrees",
        ));
    }
    Ok(())
}

fn orthogonalize(right: [f32; 3], up: [f32; 3]) -> Result<[f32; 3]> {
    let up = normalize3_checked(up, "light.up")?;
    let along = dot3(right, up);
    let projected = sub3(up, scale3(right, along));
    normalize3_checked(projected, "light.up")
}

fn normalize3_checked(value: [f32; 3], field: &'static str) -> Result<[f32; 3]> {
    validate_vec3(value, field)?;
    let length = length3(value);
    if !length.is_finite() || length == 0.0 {
        return Err(invalid(field, "must be a nonzero finite vector"));
    }
    Ok(scale3(value, 1.0 / length))
}

fn normalize3(value: [f32; 3]) -> [f32; 3] {
    let length = length3(value);
    scale3(value, 1.0 / length)
}

fn length3(value: [f32; 3]) -> f32 {
    (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt()
}

fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn sub3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale3(value: [f32; 3], scale: f32) -> [f32; 3] {
    [value[0] * scale, value[1] * scale, value[2] * scale]
}

fn invalid(field: &str, message: &str) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests;
