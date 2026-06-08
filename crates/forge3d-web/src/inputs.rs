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

#[derive(Debug, Clone)]
pub struct TerrainHeightmapOptions {
    pub width: u32,
    pub height: u32,
    pub heights: Vec<f32>,
    pub color_ramp: TerrainColorRampOptions,
}

impl TerrainHeightmapOptions {
    pub fn from_js_value(value: JsValue) -> Result<Self, WebError> {
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
        let mut heights = vec![0.0; heights_array.length() as usize];
        heights_array.copy_to(&mut heights);
        let color_ramp_value = js_sys::Reflect::get(&value, &JsValue::from_str("colorRamp"))
            .map_err(|_| WebError::new(Forge3DErrorCode::InvalidInput, "invalid colorRamp"))?;
        let color_ramp = TerrainColorRampOptions::from_js_value(color_ramp_value)?;

        Ok(Self {
            width,
            height,
            heights,
            color_ramp,
        })
    }

    pub fn validate(&self) -> Result<forge3d_core::terrain::TerrainHeightmapInput, WebError> {
        self.color_ramp.validate()?;
        forge3d_core::terrain::TerrainHeightmapInput::new(
            self.width,
            self.height,
            self.heights.clone(),
        )
        .map_err(crate::error::map_core_error)
    }
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
    LowPower,
    HighPerformance,
}

impl PowerPreferenceOption {
    pub fn to_wgpu(self) -> wgpu::PowerPreference {
        match self {
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
