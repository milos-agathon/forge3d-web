use crate::camera::CameraInput;
use crate::error::{Forge3dError, Result};
use bytemuck::{Pod, Zeroable};

fn invalid(field: &str, message: impl Into<String>) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.into(),
    }
}

fn validate_finite(field: &str, value: f32) -> Result<f32> {
    if !value.is_finite() {
        return Err(invalid(field, "must be finite"));
    }
    Ok(value)
}

pub const MAX_SHADOW_CASCADES: usize = 4;
pub const SHADOW_MAP_MIN: u32 = 256;
pub const SHADOW_MAP_MAX: u32 = 4096;
pub const SHADOW_UNIFORM_BYTES: usize = 368;
pub const SHADOW_DEPTH_UNIFORM_BYTES: usize = 64;
pub const MOMENT_FORMAT_RGBA32FLOAT: &str = "rgba32float";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ShadowFilter {
    Hard,
    #[default]
    Pcf,
    Pcss,
    Vsm,
    Evsm,
    Msm,
}

impl ShadowFilter {
    pub fn from_name(name: &str) -> Result<Self> {
        if name.eq_ignore_ascii_case("csm") {
            return Err(invalid(
                "filter",
                "csm is a cascade pipeline, not a shadow filter",
            ));
        }
        if name.eq_ignore_ascii_case("hard") {
            Ok(Self::Hard)
        } else if name.eq_ignore_ascii_case("pcf") {
            Ok(Self::Pcf)
        } else if name.eq_ignore_ascii_case("pcss") {
            Ok(Self::Pcss)
        } else if name.eq_ignore_ascii_case("vsm") {
            Ok(Self::Vsm)
        } else if name.eq_ignore_ascii_case("evsm") {
            Ok(Self::Evsm)
        } else if name.eq_ignore_ascii_case("msm") {
            Ok(Self::Msm)
        } else {
            Err(invalid(
                "filter",
                format!("unknown shadow filter \"{name}\""),
            ))
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Hard => "hard",
            Self::Pcf => "pcf",
            Self::Pcss => "pcss",
            Self::Vsm => "vsm",
            Self::Evsm => "evsm",
            Self::Msm => "msm",
        }
    }

    pub fn lane(self) -> u32 {
        match self {
            Self::Hard => 0,
            Self::Pcf => 1,
            Self::Pcss => 2,
            Self::Vsm => 3,
            Self::Evsm => 4,
            Self::Msm => 5,
        }
    }

    pub fn requires_moments(self) -> bool {
        matches!(self, Self::Vsm | Self::Evsm | Self::Msm)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ShadowDebugView {
    #[default]
    None,
    Cascades,
    ShadowFactor,
}

impl ShadowDebugView {
    pub fn from_name(name: &str) -> Result<Self> {
        match name {
            "none" => Ok(Self::None),
            "cascades" => Ok(Self::Cascades),
            "shadow-factor" => Ok(Self::ShadowFactor),
            other => Err(invalid(
                "debugView",
                format!("unknown shadow debug view \"{other}\""),
            )),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Cascades => "cascades",
            Self::ShadowFactor => "shadow-factor",
        }
    }

    pub fn mode(self) -> u32 {
        match self {
            Self::None => 0,
            Self::Cascades => 1,
            Self::ShadowFactor => 2,
        }
    }
}

fn finite_nonnegative(name: &str, value: f32) -> Result<f32> {
    validate_finite(name, value)?;
    if value < 0.0 {
        return Err(invalid(name, format!("{name} must be nonnegative")));
    }
    Ok(value)
}

#[derive(Clone, Copy, Debug)]
pub struct ShadowConfig {
    pub enabled: bool,
    pub filter: ShadowFilter,
    pub map_size: u32,
    pub depth_bias: f32,
    pub normal_bias: f32,
    pub slope_bias: f32,
    pub softness: f32,
    pub pcss_blocker_radius: f32,
    pub pcss_filter_radius: f32,
    pub light_size: f32,
    pub moment_bias: f32,
    pub light_bleed_reduction: f32,
    pub evsm_positive_exponent: f32,
    pub evsm_negative_exponent: f32,
    pub peter_panning_offset: f32,
}

impl Default for ShadowConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            filter: ShadowFilter::Pcf,
            map_size: 2048,
            depth_bias: 0.002,
            normal_bias: 0.02,
            slope_bias: 0.01,
            softness: 1.0,
            pcss_blocker_radius: 2.0,
            pcss_filter_radius: 4.0,
            light_size: 0.25,
            moment_bias: 0.0005,
            light_bleed_reduction: 0.2,
            evsm_positive_exponent: 5.0,
            evsm_negative_exponent: 5.0,
            peter_panning_offset: 0.001,
        }
    }
}

impl ShadowConfig {
    pub fn validated(self) -> Result<Self> {
        if !self.map_size.is_power_of_two()
            || !(SHADOW_MAP_MIN..=SHADOW_MAP_MAX).contains(&self.map_size)
        {
            return Err(invalid("mapSize", format!("shadow mapSize must be a power of two between {SHADOW_MAP_MIN} and {SHADOW_MAP_MAX}")));
        }
        finite_nonnegative("depthBias", self.depth_bias)?;
        finite_nonnegative("normalBias", self.normal_bias)?;
        finite_nonnegative("slopeBias", self.slope_bias)?;
        finite_nonnegative("softness", self.softness)?;
        finite_nonnegative("pcssBlockerRadius", self.pcss_blocker_radius)?;
        finite_nonnegative("pcssFilterRadius", self.pcss_filter_radius)?;
        validate_finite("lightSize", self.light_size)?;
        if self.light_size <= 0.0 {
            return Err(invalid("lightSize", "must be greater than zero"));
        }
        finite_nonnegative("momentBias", self.moment_bias)?;
        validate_finite("lightBleedReduction", self.light_bleed_reduction)?;
        if !(0.0..1.0).contains(&self.light_bleed_reduction) {
            return Err(invalid("lightBleedReduction", "must be in [0, 1)"));
        }
        validate_finite("evsmPositiveExponent", self.evsm_positive_exponent)?;
        if self.evsm_positive_exponent <= 0.0 || self.evsm_positive_exponent > 10.0 {
            return Err(invalid("evsmPositiveExponent", "must be in (0, 10]"));
        }
        validate_finite("evsmNegativeExponent", self.evsm_negative_exponent)?;
        if self.evsm_negative_exponent <= 0.0 || self.evsm_negative_exponent > 10.0 {
            return Err(invalid("evsmNegativeExponent", "must be in (0, 10]"));
        }
        finite_nonnegative("peterPanningOffset", self.peter_panning_offset)?;
        Ok(self)
    }

    pub fn requires_moments(&self) -> bool {
        self.filter.requires_moments()
    }

    pub fn peter_panning_safe(&self) -> bool {
        self.depth_bias > 1e-4 && self.peter_panning_offset > 1e-4
    }

    pub fn estimated_gpu_bytes(&self, cascade_count: u32) -> Result<u64> {
        if !(1..=MAX_SHADOW_CASCADES as u32).contains(&cascade_count) {
            return Err(invalid(
                "cascadeCount",
                "shadow cascade count must be between 1 and 4",
            ));
        }
        if !self.enabled {
            return Ok(0);
        }
        let cascades = u64::from(cascade_count);
        let texels = u64::from(self.map_size)
            .checked_mul(u64::from(self.map_size))
            .ok_or_else(|| invalid("mapSize", "shadow map bytes overflowed"))?;
        let depth = texels
            .checked_mul(4)
            .and_then(|value| value.checked_mul(cascades))
            .ok_or_else(|| invalid("mapSize", "shadow map bytes overflowed"))?;
        let moments = if self.requires_moments() {
            texels
                .checked_mul(16)
                .and_then(|value| value.checked_mul(cascades))
                .ok_or_else(|| invalid("mapSize", "shadow moment bytes overflowed"))?
        } else {
            0
        };
        let uniforms = (SHADOW_UNIFORM_BYTES as u64)
            .checked_add(cascades.saturating_mul(SHADOW_DEPTH_UNIFORM_BYTES as u64))
            .ok_or_else(|| invalid("mapSize", "shadow uniform bytes overflowed"))?;
        depth
            .checked_add(moments)
            .and_then(|value| value.checked_add(uniforms))
            .ok_or_else(|| invalid("mapSize", "shadow gpu bytes overflowed"))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CsmConfig {
    pub enabled: bool,
    pub cascade_count: u32,
    pub max_distance: f32,
    pub split_lambda: f32,
    pub blend_range: f32,
    pub stabilize: bool,
    pub debug_view: ShadowDebugView,
}

impl Default for CsmConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            cascade_count: 3,
            max_distance: 200.0,
            split_lambda: 0.75,
            blend_range: 0.1,
            stabilize: true,
            debug_view: ShadowDebugView::None,
        }
    }
}

impl CsmConfig {
    pub fn validated(self) -> Result<Self> {
        if self.enabled && !(2..=MAX_SHADOW_CASCADES as u32).contains(&self.cascade_count) {
            return Err(invalid("cascadeCount", "must be between 2 and 4"));
        }
        validate_finite("maxDistance", self.max_distance)?;
        if self.max_distance <= 0.0 {
            return Err(invalid("maxDistance", "must be greater than zero"));
        }
        validate_finite("splitLambda", self.split_lambda)?;
        if !(0.0..=1.0).contains(&self.split_lambda) {
            return Err(invalid("splitLambda", "must be in [0, 1]"));
        }
        validate_finite("blendRange", self.blend_range)?;
        if !(0.0..=1.0).contains(&self.blend_range) {
            return Err(invalid("blendRange", "must be in [0, 1]"));
        }
        Ok(self)
    }

    pub fn effective_cascade_count(&self) -> u32 {
        if self.enabled {
            self.cascade_count
        } else {
            1
        }
    }
}

pub fn shadow_split_distances(near: f32, far: f32, csm: &CsmConfig) -> Result<Vec<f32>> {
    validate_finite("near", near)?;
    validate_finite("far", far)?;
    if near <= 0.0 || far <= near {
        return Err(invalid("near", "camera planes must satisfy 0 < near < far"));
    }
    let shadow_far = far.min(csm.max_distance);
    if shadow_far <= near {
        return Err(invalid(
            "maxDistance",
            "shadow far plane must exceed the camera near plane",
        ));
    }
    if !csm.enabled {
        return Ok(vec![near, shadow_far]);
    }
    let count = csm.cascade_count as usize;
    let lambda = csm.split_lambda;
    let mut splits = Vec::with_capacity(count + 1);
    splits.push(near);
    for index in 1..count {
        let fraction = index as f32 / count as f32;
        let uniform = near + (shadow_far - near) * fraction;
        let logarithmic = near * (shadow_far / near).powf(fraction);
        splits.push(lambda * logarithmic + (1.0 - lambda) * uniform);
    }
    splits.push(shadow_far);
    Ok(splits)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StabilizedBounds {
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub texel_size: f32,
}

pub fn stabilize_bounds(min: [f32; 3], max: [f32; 3], map_size: u32) -> Result<StabilizedBounds> {
    for value in min.iter().chain(max.iter()) {
        if !value.is_finite() {
            return Err(invalid("bounds", "shadow cascade bounds must be finite"));
        }
    }
    if !map_size.is_power_of_two() || !(SHADOW_MAP_MIN..=SHADOW_MAP_MAX).contains(&map_size) {
        return Err(invalid("mapSize", "shadow map size must be a power of two"));
    }
    let width = (max[0] - min[0]).max(0.0);
    let height = (max[1] - min[1]).max(0.0);
    let extent = width.max(height);
    if extent <= 0.0 {
        return Err(invalid("bounds", "shadow cascade extent must be positive"));
    }
    let texel_size = extent / map_size as f32;
    let center_x = (min[0] + max[0]) * 0.5;
    let center_y = (min[1] + max[1]) * 0.5;
    let snapped_x = (center_x / texel_size).round() * texel_size;
    let snapped_y = (center_y / texel_size).round() * texel_size;
    let half = extent * 0.5;
    Ok(StabilizedBounds {
        min: [snapped_x - half, snapped_y - half, min[2]],
        max: [snapped_x + half, snapped_y + half, max[2]],
        texel_size,
    })
}

#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ShadowUniform {
    pub matrices: [[[f32; 4]; 4]; 4],
    pub splits: [f32; 4],
    pub light_direction: [f32; 4],
    /// mapSize, invMapSize, depthBias, normalBias
    pub params0: [f32; 4],
    /// slopeBias, softness, blockerRadius, filterRadius
    pub params1: [f32; 4],
    /// lightSize, momentBias, bleedReduction, evsmPositive
    pub params2: [f32; 4],
    /// evsmNegative, blendRange, maxDistance, splitLambda
    pub params3: [f32; 4],
    /// enabled, filter, cascadeCount, debugMode
    pub control: [u32; 4],
}

const _: () = assert!(std::mem::size_of::<ShadowUniform>() == SHADOW_UNIFORM_BYTES);

#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ShadowDepthUniform {
    pub matrix: [[f32; 4]; 4],
}

const _: () = assert!(std::mem::size_of::<ShadowDepthUniform>() == SHADOW_DEPTH_UNIFORM_BYTES);

pub fn pack_shadow_uniform(
    matrices: &[[[f32; 4]; 4]],
    split_boundaries: &[f32],
    light_direction: [f32; 3],
    config: &ShadowConfig,
    csm: &CsmConfig,
    enabled: bool,
) -> ShadowUniform {
    let mut uniform = ShadowUniform::zeroed();
    for (index, matrix) in matrices.iter().enumerate().take(MAX_SHADOW_CASCADES) {
        uniform.matrices[index] = *matrix;
    }
    let last_split = split_boundaries.last().copied().unwrap_or(1.0);
    for index in 0..MAX_SHADOW_CASCADES {
        uniform.splits[index] = split_boundaries
            .get(index + 1)
            .copied()
            .unwrap_or(last_split);
    }
    // light_direction.w carries the peter-panning offset: receivers are shifted
    // along the travel direction in light space before the depth compare.
    uniform.light_direction = [
        light_direction[0],
        light_direction[1],
        light_direction[2],
        config.peter_panning_offset,
    ];
    uniform.params0 = [
        config.map_size as f32,
        1.0 / config.map_size as f32,
        config.depth_bias,
        config.normal_bias,
    ];
    uniform.params1 = [
        config.slope_bias,
        config.softness,
        config.pcss_blocker_radius,
        config.pcss_filter_radius,
    ];
    uniform.params2 = [
        config.light_size,
        config.moment_bias,
        config.light_bleed_reduction,
        config.evsm_positive_exponent,
    ];
    uniform.params3 = [
        config.evsm_negative_exponent,
        csm.blend_range,
        csm.max_distance,
        csm.split_lambda,
    ];
    uniform.control = [
        u32::from(enabled),
        config.filter.lane(),
        matrices.len().max(1) as u32,
        csm.debug_view.mode(),
    ];
    uniform
}

#[derive(Clone, Copy, Debug)]
pub struct ShadowCascade {
    pub near: f32,
    pub far: f32,
    pub texel_size: f32,
    pub matrix: [[f32; 4]; 4],
}

fn light_view_matrix(direction: glam::Vec3) -> glam::Mat4 {
    let up = if direction.y.abs() > 0.99 {
        glam::Vec3::Z
    } else {
        glam::Vec3::Y
    };
    glam::Mat4::look_at_rh(-direction, glam::Vec3::ZERO, up)
}

pub fn build_shadow_cascades(
    camera: &CameraInput,
    aspect: f32,
    light_direction: [f32; 3],
    config: &ShadowConfig,
    csm: &CsmConfig,
) -> Result<Vec<ShadowCascade>> {
    validate_finite("aspect", aspect)?;
    if aspect <= 0.0 {
        return Err(invalid("aspect", "camera aspect must be greater than zero"));
    }
    let direction = glam::Vec3::from_array(light_direction);
    if !direction.is_finite() || direction.length_squared() <= 0.0 {
        return Err(invalid(
            "lightDirection",
            "shadow caster light direction must be nonzero",
        ));
    }
    let direction = direction.normalize();
    let splits = shadow_split_distances(camera.near, camera.far, csm)?;
    let position = glam::Vec3::from_array(camera.position);
    let target = glam::Vec3::from_array(camera.target);
    let up_hint = glam::Vec3::from_array(camera.up)
        .try_normalize()
        .unwrap_or(glam::Vec3::Y);
    let forward = (target - position)
        .try_normalize()
        .unwrap_or(glam::Vec3::NEG_Z);
    let right = forward
        .cross(up_hint)
        .try_normalize()
        .unwrap_or(glam::Vec3::X);
    let up = right
        .cross(forward)
        .try_normalize()
        .unwrap_or(glam::Vec3::Y);
    let tan_half_fov = (camera.fov_y_degrees.to_radians() * 0.5).tan();
    let light_view = light_view_matrix(direction);

    let cascade_count = csm.effective_cascade_count() as usize;
    let mut cascades = Vec::with_capacity(cascade_count);
    for index in 0..cascade_count {
        let slice_near = splits[index];
        let slice_far = splits[index + 1];
        let mut light_min = glam::Vec3::splat(f32::INFINITY);
        let mut light_max = glam::Vec3::splat(f32::NEG_INFINITY);
        for depth in [slice_near, slice_far] {
            let half_height = depth * tan_half_fov;
            let half_width = half_height * aspect;
            for sign_y in [-1.0_f32, 1.0] {
                for sign_x in [-1.0_f32, 1.0] {
                    let corner = position
                        + forward * depth
                        + right * (sign_x * half_width)
                        + up * (sign_y * half_height);
                    let light_space = light_view.transform_point3(corner);
                    light_min = light_min.min(light_space);
                    light_max = light_max.max(light_space);
                }
            }
        }
        let bounds = if csm.stabilize {
            stabilize_bounds(light_min.to_array(), light_max.to_array(), config.map_size)?
        } else {
            let width = (light_max.x - light_min.x).max(0.0);
            let height = (light_max.y - light_min.y).max(0.0);
            let extent = width.max(height);
            if extent <= 0.0 {
                return Err(invalid("bounds", "shadow cascade extent must be positive"));
            }
            StabilizedBounds {
                min: light_min.to_array(),
                max: light_max.to_array(),
                texel_size: extent / config.map_size as f32,
            }
        };
        let z_extent = (bounds.max[2] - bounds.min[2]).abs();
        let margin = z_extent * 0.05 + config.peter_panning_offset;
        let near = -bounds.max[2] - margin;
        let far = -bounds.min[2];
        let projection = glam::Mat4::orthographic_rh(
            bounds.min[0],
            bounds.max[0],
            bounds.min[1],
            bounds.max[1],
            near.min(far - 1e-4),
            far.max(near + 1e-4),
        );
        let matrix = projection * light_view;
        for value in matrix.to_cols_array() {
            if !value.is_finite() {
                return Err(invalid("matrix", "shadow cascade matrix must be finite"));
            }
        }
        cascades.push(ShadowCascade {
            near: slice_near,
            far: slice_far,
            texel_size: bounds.texel_size,
            matrix: matrix.to_cols_array_2d(),
        });
    }
    Ok(cascades)
}

#[cfg(test)]
mod tests;
