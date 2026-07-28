use serde::Deserialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::error::{Forge3DErrorCode, WebError};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeOptions {
    #[serde(default)]
    pub power_preference: PowerPreferenceOption,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default)]
    pub device_pixel_ratio: Option<f64>,
    #[serde(default)]
    pub clear_color: Option<[f32; 4]>,
    #[serde(default)]
    pub alpha_mode: AlphaModeOption,
    #[serde(default)]
    pub color_space: ColorSpaceOption,
    #[serde(default)]
    pub diagnostics: bool,
}

impl RuntimeOptions {
    pub fn from_js_value(value: JsValue) -> Result<Self, WebError> {
        let options = if value.is_undefined() || value.is_null() {
            Self::default()
        } else {
            serde_wasm_bindgen::from_value(value).map_err(|error| {
                WebError::new(
                    Forge3DErrorCode::InvalidInput,
                    format!("Invalid runtime options: {error}"),
                )
            })?
        };

        options.validate()?;
        Ok(options)
    }

    pub fn pixel_size(
        &self,
        fallback_width: u32,
        fallback_height: u32,
    ) -> Result<(u32, u32), WebError> {
        let width = self.width.unwrap_or(fallback_width.max(1));
        let height = self.height.unwrap_or(fallback_height.max(1));
        let ratio = self.device_pixel_ratio.unwrap_or(1.0);

        validate_positive_dimension("width", width)?;
        validate_positive_dimension("height", height)?;
        if !ratio.is_finite() || ratio <= 0.0 {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                "devicePixelRatio must be finite and greater than zero",
            ));
        }

        let pixel_width = scaled_dimension("width", width, ratio)?;
        let pixel_height = scaled_dimension("height", height, ratio)?;
        Ok((pixel_width, pixel_height))
    }

    pub fn clear_color(&self) -> [f32; 4] {
        self.clear_color.unwrap_or([0.0, 0.0, 0.0, 1.0])
    }

    fn validate(&self) -> Result<(), WebError> {
        if let Some(width) = self.width {
            validate_positive_dimension("width", width)?;
        }
        if let Some(height) = self.height {
            validate_positive_dimension("height", height)?;
        }
        if let Some(ratio) = self.device_pixel_ratio {
            if !ratio.is_finite() || ratio <= 0.0 {
                return Err(WebError::new(
                    Forge3DErrorCode::InvalidInput,
                    "devicePixelRatio must be finite and greater than zero",
                ));
            }
        }
        if let Some(color) = self.clear_color {
            for (index, channel) in color.iter().enumerate() {
                if !channel.is_finite() || !(0.0..=1.0).contains(channel) {
                    return Err(WebError::new(
                        Forge3DErrorCode::InvalidInput,
                        format!("clearColor[{index}] must be finite and in the range [0, 1]"),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct TerrainHeightmapOptions {
    pub width: u32,
    pub height: u32,
    pub heights: Vec<f32>,
    pub color_ramp: TerrainColorRampOptions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerrainPhysicalLimits {
    pub max_texture_dimension_2d: u32,
    pub max_buffer_size: u64,
}

impl TerrainPhysicalLimits {
    pub fn from_device(device: &wgpu::Device) -> Self {
        let limits = device.limits();
        Self {
            max_texture_dimension_2d: limits.max_texture_dimension_2d,
            max_buffer_size: limits.max_buffer_size,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerrainAllocation {
    pub sample_count: usize,
    pub sample_bytes: u64,
    pub vertex_count: u64,
    pub vertex_bytes: u64,
    pub index_count: u64,
    pub index_bytes: u64,
}

impl TerrainHeightmapOptions {
    pub fn from_js_value_with_limits(
        value: JsValue,
        limits: TerrainPhysicalLimits,
    ) -> Result<Self, WebError> {
        if value.is_undefined() || value.is_null() {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                "terrain input must be an object",
            ));
        }

        let width = read_u32_property(&value, "width")?;
        let height = read_u32_property(&value, "height")?;
        let heights_value = js_sys::Reflect::get(&value, &JsValue::from_str("heights"))
            .map_err(|_| WebError::new(Forge3DErrorCode::InvalidInput, "missing heights"))?;
        let heights_array = heights_value
            .dyn_into::<js_sys::Float32Array>()
            .map_err(|_| {
                WebError::new(
                    Forge3DErrorCode::InvalidInput,
                    "heights must be a Float32Array",
                )
            })?;
        validate_terrain_allocation(width, height, heights_array.length() as usize, limits)?;
        let color_ramp_value = js_sys::Reflect::get(&value, &JsValue::from_str("colorRamp"))
            .map_err(|_| WebError::new(Forge3DErrorCode::InvalidInput, "invalid colorRamp"))?;
        let color_ramp = TerrainColorRampOptions::from_js_value(color_ramp_value)?;

        let mut heights = vec![0.0; heights_array.length() as usize];
        heights_array.copy_to(&mut heights);

        Ok(Self {
            width,
            height,
            heights,
            color_ramp,
        })
    }

    pub fn validate(self) -> Result<forge3d_core::terrain::TerrainHeightmapInput, WebError> {
        self.color_ramp.validate()?;
        forge3d_core::terrain::TerrainHeightmapInput::new(self.width, self.height, self.heights)
            .map_err(crate::error::map_core_error)
    }
}

pub fn validate_terrain_allocation(
    width: u32,
    height: u32,
    heights_length: usize,
    limits: TerrainPhysicalLimits,
) -> Result<TerrainAllocation, WebError> {
    if width == 0 || height == 0 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "terrain width and height must be greater than zero",
        ));
    }
    if width < 2 || height < 2 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "terrain width and height must be at least 2 to draw a mesh",
        ));
    }
    if width > limits.max_texture_dimension_2d || height > limits.max_texture_dimension_2d {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "terrain dimensions {width}x{height} exceed maxTextureDimension2D {}",
                limits.max_texture_dimension_2d
            ),
        ));
    }

    let sample_count_u64 = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| resource_overflow("terrain sample count"))?;
    let sample_count =
        usize::try_from(sample_count_u64).map_err(|_| resource_overflow("terrain sample count"))?;
    if heights_length != sample_count {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("heights length must equal width * height ({sample_count})"),
        ));
    }
    let sample_bytes = sample_count_u64
        .checked_mul(std::mem::size_of::<f32>() as u64)
        .ok_or_else(|| resource_overflow("terrain sample bytes"))?;

    let skirt_vertices = u64::from(width)
        .checked_mul(2)
        .and_then(|value| value.checked_add(u64::from(height).checked_mul(2)?))
        .ok_or_else(|| resource_overflow("terrain skirt vertex count"))?;
    let vertex_count = sample_count_u64
        .checked_add(skirt_vertices)
        .ok_or_else(|| resource_overflow("terrain vertex count"))?;
    if vertex_count > u64::from(u32::MAX) {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "terrain mesh exceeds the u32 vertex-index address space",
        ));
    }
    let vertex_bytes = vertex_count
        .checked_mul((std::mem::size_of::<[f32; 3]>() + std::mem::size_of::<[f32; 2]>()) as u64)
        .ok_or_else(|| resource_overflow("terrain vertex bytes"))?;

    let cells = u64::from(width - 1)
        .checked_mul(u64::from(height - 1))
        .ok_or_else(|| resource_overflow("terrain cell count"))?;
    let base_indices = cells
        .checked_mul(6)
        .ok_or_else(|| resource_overflow("terrain index count"))?;
    let skirt_edges = u64::from(width - 1)
        .checked_mul(2)
        .and_then(|value| value.checked_add(u64::from(height - 1).checked_mul(2)?))
        .ok_or_else(|| resource_overflow("terrain skirt edge count"))?;
    let index_count = skirt_edges
        .checked_mul(6)
        .and_then(|value| value.checked_add(base_indices))
        .ok_or_else(|| resource_overflow("terrain index count"))?;
    if index_count > u64::from(u32::MAX) {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "terrain mesh has more indices than a single u32 draw range can address",
        ));
    }
    let index_bytes = index_count
        .checked_mul(std::mem::size_of::<u32>() as u64)
        .ok_or_else(|| resource_overflow("terrain index bytes"))?;

    if vertex_bytes > limits.max_buffer_size {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "terrain vertex buffer requires {vertex_bytes} bytes but maxBufferSize is {}",
                limits.max_buffer_size
            ),
        ));
    }
    if index_bytes > limits.max_buffer_size {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "terrain index buffer requires {index_bytes} bytes but maxBufferSize is {}",
                limits.max_buffer_size
            ),
        ));
    }

    Ok(TerrainAllocation {
        sample_count,
        sample_bytes,
        vertex_count,
        vertex_bytes,
        index_count,
        index_bytes,
    })
}

fn resource_overflow(resource: &str) -> WebError {
    WebError::new(
        Forge3DErrorCode::ResourceLimitExceeded,
        format!("{resource} overflowed"),
    )
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerrainColorRampOptions {
    pub stops: Vec<TerrainColorStopOptions>,
}

impl TerrainColorRampOptions {
    pub fn from_js_value(value: JsValue) -> Result<Self, WebError> {
        let ramp = if value.is_undefined() || value.is_null() {
            Self::default()
        } else {
            validate_color_ramp_shape_before_deserialize(&value)?;
            serde_wasm_bindgen::from_value(value).map_err(|error| {
                WebError::new(
                    Forge3DErrorCode::InvalidInput,
                    format!("Invalid colorRamp input: {error}"),
                )
            })?
        };
        ramp.validate()?;
        Ok(ramp)
    }

    pub fn validate(&self) -> Result<(), WebError> {
        if self.stops.len() < 2 || self.stops.len() > 8 {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                "colorRamp.stops must contain between 2 and 8 stops",
            ));
        }
        let mut previous = f32::NEG_INFINITY;
        for (index, stop) in self.stops.iter().enumerate() {
            if !stop.position.is_finite() || !(0.0..=1.0).contains(&stop.position) {
                return Err(WebError::new(
                    Forge3DErrorCode::InvalidInput,
                    format!("colorRamp.stops[{index}].position must be finite and in [0, 1]"),
                ));
            }
            if stop.position < previous {
                return Err(WebError::new(
                    Forge3DErrorCode::InvalidInput,
                    "colorRamp.stops positions must be ordered",
                ));
            }
            for (channel_index, channel) in stop.color.iter().enumerate() {
                if !channel.is_finite() || !(0.0..=1.0).contains(channel) {
                    return Err(WebError::new(
                        Forge3DErrorCode::InvalidInput,
                        format!(
                            "colorRamp.stops[{index}].color[{channel_index}] must be finite and in [0, 1]"
                        ),
                    ));
                }
            }
            previous = stop.position;
        }
        Ok(())
    }
}

fn validate_color_ramp_shape_before_deserialize(value: &JsValue) -> Result<(), WebError> {
    if !value.is_object() {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "colorRamp must be an object",
        ));
    }
    let stops = js_sys::Reflect::get(value, &JsValue::from_str("stops")).map_err(|_| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            "colorRamp.stops could not be read",
        )
    })?;
    if !js_sys::Array::is_array(&stops) {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "colorRamp.stops must be an array",
        ));
    }
    let length = js_sys::Array::from(&stops).length();
    if !(2..=8).contains(&length) {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "colorRamp.stops must contain between 2 and 8 stops",
        ));
    }
    Ok(())
}

impl Default for TerrainColorRampOptions {
    fn default() -> Self {
        Self {
            stops: vec![
                TerrainColorStopOptions::new(0.0, [199.0 / 255.0, 208.0 / 255.0, 177.0 / 255.0]),
                TerrainColorStopOptions::new(0.1667, [211.0 / 255.0, 226.0 / 255.0, 193.0 / 255.0]),
                TerrainColorStopOptions::new(0.3333, [247.0 / 255.0, 244.0 / 255.0, 201.0 / 255.0]),
                TerrainColorStopOptions::new(0.5, [252.0 / 255.0, 232.0 / 255.0, 171.0 / 255.0]),
                TerrainColorStopOptions::new(0.6667, [227.0 / 255.0, 183.0 / 255.0, 112.0 / 255.0]),
                TerrainColorStopOptions::new(0.8333, [185.0 / 255.0, 137.0 / 255.0, 53.0 / 255.0]),
                TerrainColorStopOptions::new(1.0, [116.0 / 255.0, 94.0 / 255.0, 55.0 / 255.0]),
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerrainColorStopOptions {
    pub position: f32,
    pub color: [f32; 3],
}

impl TerrainColorStopOptions {
    fn new(position: f32, color: [f32; 3]) -> Self {
        Self { position, color }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CameraOptions {
    pub position: [f32; 3],
    pub target: [f32; 3],
    pub up: [f32; 3],
    pub fov_y_degrees: f32,
    pub near: f32,
    pub far: f32,
}

impl CameraOptions {
    pub fn from_js_value(value: JsValue) -> Result<Self, WebError> {
        if value.is_undefined() || value.is_null() {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                "camera input must be an object",
            ));
        }

        serde_wasm_bindgen::from_value(value).map_err(|error| {
            WebError::new(
                Forge3DErrorCode::InvalidInput,
                format!("Invalid camera input: {error}"),
            )
        })
    }

    pub fn validate(&self) -> Result<forge3d_core::camera::CameraInput, WebError> {
        forge3d_core::camera::CameraInput::new(
            self.position,
            self.target,
            self.up,
            self.fov_y_degrees,
            self.near,
            self.far,
        )
        .map_err(crate::error::map_core_error)
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResizeOptions {
    pub width: u32,
    pub height: u32,
    pub device_pixel_ratio: f64,
}

impl ResizeOptions {
    pub fn from_js_value(value: JsValue) -> Result<Self, WebError> {
        if value.is_undefined() || value.is_null() {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                "resize input must be an object",
            ));
        }

        let options: Self = serde_wasm_bindgen::from_value(value).map_err(|error| {
            WebError::new(
                Forge3DErrorCode::InvalidInput,
                format!("Invalid resize input: {error}"),
            )
        })?;
        options.validate()?;
        Ok(options)
    }

    pub fn pixel_size(&self) -> Result<(u32, u32), WebError> {
        self.validate()?;
        Ok((
            scaled_dimension("width", self.width, self.device_pixel_ratio)?,
            scaled_dimension("height", self.height, self.device_pixel_ratio)?,
        ))
    }

    fn validate(&self) -> Result<(), WebError> {
        validate_positive_dimension("width", self.width)?;
        validate_positive_dimension("height", self.height)?;
        if !self.device_pixel_ratio.is_finite() || self.device_pixel_ratio <= 0.0 {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                "devicePixelRatio must be finite and greater than zero",
            ));
        }
        Ok(())
    }
}

impl Default for RuntimeOptions {
    fn default() -> Self {
        Self {
            power_preference: PowerPreferenceOption::HighPerformance,
            width: None,
            height: None,
            device_pixel_ratio: None,
            clear_color: None,
            alpha_mode: AlphaModeOption::Premultiplied,
            color_space: ColorSpaceOption::Srgb,
            diagnostics: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PowerPreferenceOption {
    None,
    LowPower,
    HighPerformance,
}

impl PowerPreferenceOption {
    pub fn to_wgpu(self) -> wgpu::PowerPreference {
        match self {
            Self::None => wgpu::PowerPreference::None,
            Self::LowPower => wgpu::PowerPreference::LowPower,
            Self::HighPerformance => wgpu::PowerPreference::HighPerformance,
        }
    }
}

impl Default for PowerPreferenceOption {
    fn default() -> Self {
        Self::HighPerformance
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AlphaModeOption {
    Opaque,
    Premultiplied,
}

impl AlphaModeOption {
    pub fn preferred_wgpu(self) -> wgpu::CompositeAlphaMode {
        match self {
            Self::Opaque => wgpu::CompositeAlphaMode::Opaque,
            Self::Premultiplied => wgpu::CompositeAlphaMode::PreMultiplied,
        }
    }
}

impl Default for AlphaModeOption {
    fn default() -> Self {
        Self::Premultiplied
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ColorSpaceOption {
    Srgb,
}

impl Default for ColorSpaceOption {
    fn default() -> Self {
        Self::Srgb
    }
}

fn validate_positive_dimension(field: &str, value: u32) -> Result<(), WebError> {
    if value == 0 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("{field} must be greater than zero"),
        ));
    }
    Ok(())
}

fn scaled_dimension(field: &str, value: u32, ratio: f64) -> Result<u32, WebError> {
    let scaled = (value as f64 * ratio).round();
    if !scaled.is_finite() || scaled < 1.0 || scaled > u32::MAX as f64 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("{field} multiplied by devicePixelRatio is outside the supported range"),
        ));
    }
    Ok(scaled as u32)
}

fn read_u32_property(value: &JsValue, name: &str) -> Result<u32, WebError> {
    let property = js_sys::Reflect::get(value, &JsValue::from_str(name)).map_err(|_| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("missing terrain {name}"),
        )
    })?;
    let number = property.as_f64().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("terrain {name} must be a number"),
        )
    })?;

    if !number.is_finite() || number.fract() != 0.0 || number < 0.0 || number > u32::MAX as f64 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("terrain {name} must be a non-negative integer"),
        ));
    }

    Ok(number as u32)
}

#[cfg(test)]
mod tests {
    use super::{
        AlphaModeOption, CameraOptions, PowerPreferenceOption, ResizeOptions, RuntimeOptions,
        TerrainColorRampOptions, TerrainColorStopOptions, TerrainHeightmapOptions,
        TerrainPhysicalLimits,
    };

    #[test]
    fn runtime_options_default_to_browser_mvp_values() {
        let options = RuntimeOptions::default();

        assert_eq!(
            options.power_preference,
            PowerPreferenceOption::HighPerformance
        );
        assert_eq!(options.alpha_mode, AlphaModeOption::Premultiplied);
        assert_eq!(options.clear_color(), [0.0, 0.0, 0.0, 1.0]);
        assert!(!options.diagnostics);
    }

    #[test]
    fn runtime_options_support_explicit_no_power_preference() {
        assert_eq!(
            PowerPreferenceOption::None.to_wgpu(),
            wgpu::PowerPreference::None
        );
    }

    #[test]
    fn runtime_options_compute_dpr_scaled_pixel_size() {
        let options = RuntimeOptions {
            width: Some(320),
            height: Some(240),
            device_pixel_ratio: Some(2.0),
            ..RuntimeOptions::default()
        };

        assert_eq!(options.pixel_size(1, 1).unwrap(), (640, 480));
    }

    #[test]
    fn runtime_options_reject_zero_dimensions() {
        let options = RuntimeOptions {
            width: Some(0),
            ..RuntimeOptions::default()
        };

        assert_eq!(
            options.pixel_size(1, 1).unwrap_err().code().as_str(),
            "INVALID_INPUT"
        );
    }

    #[test]
    fn terrain_heightmap_options_reject_wrong_lengths() {
        let options = TerrainHeightmapOptions {
            width: 3,
            height: 2,
            heights: vec![0.0, 0.1, 0.2, 0.3, 0.4],
            color_ramp: TerrainColorRampOptions::default(),
        };

        let error = options.validate().unwrap_err();

        assert_eq!(error.code().as_str(), "INVALID_INPUT");
        assert!(error.message().contains("width * height"));
    }

    #[test]
    fn terrain_heightmap_options_reject_non_finite_values() {
        let options = TerrainHeightmapOptions {
            width: 2,
            height: 2,
            heights: vec![0.0, f32::NAN, 0.5, 1.0],
            color_ramp: TerrainColorRampOptions::default(),
        };

        let error = options.validate().unwrap_err();

        assert_eq!(error.code().as_str(), "INVALID_INPUT");
        assert!(error.message().contains("finite"));
    }

    #[test]
    fn terrain_allocation_rejects_physical_limits_before_copy_or_mesh_creation() {
        let limits = TerrainPhysicalLimits {
            max_texture_dimension_2d: 1024,
            max_buffer_size: 64 * 1024,
        };

        let dimension_error =
            super::validate_terrain_allocation(2048, 2, 4096, limits).unwrap_err();
        assert_eq!(dimension_error.code().as_str(), "RESOURCE_LIMIT_EXCEEDED");

        let buffer_error =
            super::validate_terrain_allocation(100, 100, 10_000, limits).unwrap_err();
        assert_eq!(buffer_error.code().as_str(), "RESOURCE_LIMIT_EXCEEDED");
    }

    #[test]
    fn terrain_allocation_computes_skirted_mesh_bytes_with_checked_arithmetic() {
        let allocation = super::validate_terrain_allocation(
            2,
            2,
            4,
            TerrainPhysicalLimits {
                max_texture_dimension_2d: 8192,
                max_buffer_size: u64::MAX,
            },
        )
        .unwrap();

        assert_eq!(allocation.sample_bytes, 16);
        assert_eq!(allocation.vertex_count, 12);
        assert_eq!(allocation.vertex_bytes, 240);
        assert_eq!(allocation.index_count, 30);
        assert_eq!(allocation.index_bytes, 120);
    }

    #[test]
    fn terrain_color_ramp_defaults_to_faa_vfr_contour_stops() {
        let ramp = TerrainColorRampOptions::default();

        assert_eq!(ramp.stops.len(), 7);
        assert_eq!(ramp.stops[0].position, 0.0);
        assert_eq!(
            ramp.stops[0].color,
            [199.0 / 255.0, 208.0 / 255.0, 177.0 / 255.0]
        );
        assert_eq!(ramp.stops[6].position, 1.0);
        assert_eq!(
            ramp.stops[6].color,
            [116.0 / 255.0, 94.0 / 255.0, 55.0 / 255.0]
        );
    }

    #[test]
    fn terrain_color_ramp_rejects_unordered_stops() {
        let ramp = TerrainColorRampOptions {
            stops: vec![
                TerrainColorStopOptions {
                    position: 0.75,
                    color: [1.0, 1.0, 1.0],
                },
                TerrainColorStopOptions {
                    position: 0.25,
                    color: [0.0, 0.0, 0.0],
                },
            ],
        };

        let error = ramp.validate().unwrap_err();

        assert_eq!(error.code().as_str(), "INVALID_INPUT");
        assert!(error.message().contains("ordered"));
    }

    #[test]
    fn camera_options_reject_non_finite_values() {
        let options = CameraOptions {
            position: [0.0, f32::NAN, 2.0],
            target: [0.0, 0.0, 0.0],
            up: [0.0, 1.0, 0.0],
            fov_y_degrees: 45.0,
            near: 0.01,
            far: 100.0,
        };

        let error = options.validate().unwrap_err();

        assert_eq!(error.code().as_str(), "INVALID_INPUT");
        assert!(error.message().contains("position"));
    }

    #[test]
    fn resize_options_compute_dpr_scaled_pixel_size() {
        let options = ResizeOptions {
            width: 96,
            height: 72,
            device_pixel_ratio: 2.0,
        };

        assert_eq!(options.pixel_size().unwrap(), (192, 144));
    }

    #[test]
    fn resize_options_reject_non_finite_dpr() {
        let options = ResizeOptions {
            width: 96,
            height: 72,
            device_pixel_ratio: f64::INFINITY,
        };

        assert_eq!(
            options.pixel_size().unwrap_err().code().as_str(),
            "INVALID_INPUT"
        );
    }
}
