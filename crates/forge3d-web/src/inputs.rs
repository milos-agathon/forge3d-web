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

        Ok(Self {
            width,
            height,
            heights,
        })
    }

    pub fn validate(&self) -> Result<forge3d_core::terrain::TerrainHeightmapInput, WebError> {
        forge3d_core::terrain::TerrainHeightmapInput::new(
            self.width,
            self.height,
            self.heights.clone(),
        )
        .map_err(crate::error::map_core_error)
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
    use super::{AlphaModeOption, PowerPreferenceOption, RuntimeOptions, TerrainHeightmapOptions};

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
        };

        let error = options.validate().unwrap_err();

        assert_eq!(error.code().as_str(), "INVALID_INPUT");
        assert!(error.message().contains("finite"));
    }
}
