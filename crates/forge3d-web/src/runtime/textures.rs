use std::collections::BTreeMap;

use forge3d_core::materials::{
    MaterialState, MATERIAL_FLAG_BASE_COLOR_TEXTURE, MATERIAL_FLAG_EMISSIVE_TEXTURE,
    MATERIAL_FLAG_METALLIC_ROUGHNESS_TEXTURE, MATERIAL_FLAG_NORMAL_TEXTURE,
    MATERIAL_FLAG_OCCLUSION_TEXTURE,
};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::{JsCast, JsValue};

use super::memory::MemoryLedger;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};

pub(super) const MAX_TEXTURE_DIMENSION: u32 = 16384;
pub(super) const TEXTURE_FALLBACK_KEY: &str = "textures:fallback";
pub(super) const TEXTURE_PAYLOAD_KEY: &str = "textures:payload";
pub(super) const FALLBACK_BYTES: u64 = 20;

pub(super) fn texture_memory_keys() -> [&'static str; 2] {
    [TEXTURE_FALLBACK_KEY, TEXTURE_PAYLOAD_KEY]
}

fn invalid(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message.into())
}

fn unsupported(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::UnsupportedFeature, message.into())
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ParsedTextureLevel {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ParsedTextureImage {
    pub format: wgpu::TextureFormat,
    pub levels: Vec<ParsedTextureLevel>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct ParsedSampler {
    pub address_mode_u: wgpu::AddressMode,
    pub address_mode_v: wgpu::AddressMode,
    pub mag_filter: wgpu::FilterMode,
    pub min_filter: wgpu::FilterMode,
    pub mipmap_filter: wgpu::MipmapFilterMode,
    pub max_anisotropy: u16,
}

impl Default for ParsedSampler {
    fn default() -> Self {
        Self {
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            max_anisotropy: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ParsedTextureSet {
    pub images: [Option<ParsedTextureImage>; 5],
    pub sampler: ParsedSampler,
}

impl Default for ParsedTextureSet {
    fn default() -> Self {
        Self {
            images: [None, None, None, None, None],
            sampler: ParsedSampler::default(),
        }
    }
}

impl ParsedTextureSet {
    pub(super) fn flag_bits(&self) -> u32 {
        let mut flags = 0;
        for (index, image) in self.images.iter().enumerate() {
            if image.is_some() {
                flags |= match index {
                    0 => MATERIAL_FLAG_BASE_COLOR_TEXTURE,
                    1 => MATERIAL_FLAG_NORMAL_TEXTURE,
                    2 => MATERIAL_FLAG_METALLIC_ROUGHNESS_TEXTURE,
                    3 => MATERIAL_FLAG_OCCLUSION_TEXTURE,
                    _ => MATERIAL_FLAG_EMISSIVE_TEXTURE,
                };
            }
        }
        flags
    }

    pub(super) fn payload_bytes(&self) -> u64 {
        self.images
            .iter()
            .flatten()
            .flat_map(|image| image.levels.iter())
            .map(|level| level.data.len() as u64)
            .sum()
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) struct ParsedMaterials {
    pub state: MaterialState,
    pub texture_sets: BTreeMap<u32, ParsedTextureSet>,
}

const SEMANTIC_FIELDS: [(&str, &str); 5] = [
    ("baseColor", "base-color"),
    ("normal", "normal"),
    ("metallicRoughness", "metallic-roughness"),
    ("occlusion", "occlusion"),
    ("emissive", "emissive"),
];

fn compressed_block_bytes(format: wgpu::TextureFormat) -> Option<u32> {
    match format {
        wgpu::TextureFormat::Bc1RgbaUnorm | wgpu::TextureFormat::Bc1RgbaUnormSrgb => Some(8),
        wgpu::TextureFormat::Bc3RgbaUnorm
        | wgpu::TextureFormat::Bc3RgbaUnormSrgb
        | wgpu::TextureFormat::Bc7RgbaUnorm
        | wgpu::TextureFormat::Bc7RgbaUnormSrgb
        | wgpu::TextureFormat::Etc2Rgba8Unorm
        | wgpu::TextureFormat::Etc2Rgba8UnormSrgb
        | wgpu::TextureFormat::Astc { .. } => Some(16),
        _ => None,
    }
}

fn map_texture_format(name: &str) -> Option<wgpu::TextureFormat> {
    Some(match name {
        "rgba8unorm" => wgpu::TextureFormat::Rgba8Unorm,
        "rgba8unorm-srgb" => wgpu::TextureFormat::Rgba8UnormSrgb,
        "bc1-rgba-unorm" => wgpu::TextureFormat::Bc1RgbaUnorm,
        "bc1-rgba-unorm-srgb" => wgpu::TextureFormat::Bc1RgbaUnormSrgb,
        "bc3-rgba-unorm" => wgpu::TextureFormat::Bc3RgbaUnorm,
        "bc3-rgba-unorm-srgb" => wgpu::TextureFormat::Bc3RgbaUnormSrgb,
        "bc7-rgba-unorm" => wgpu::TextureFormat::Bc7RgbaUnorm,
        "bc7-rgba-unorm-srgb" => wgpu::TextureFormat::Bc7RgbaUnormSrgb,
        "etc2-rgba8unorm" => wgpu::TextureFormat::Etc2Rgba8Unorm,
        "etc2-rgba8unorm-srgb" => wgpu::TextureFormat::Etc2Rgba8UnormSrgb,
        "astc-4x4-unorm" => wgpu::TextureFormat::Astc {
            block: wgpu::AstcBlock::B4x4,
            channel: wgpu::AstcChannel::Unorm,
        },
        "astc-4x4-unorm-srgb" => wgpu::TextureFormat::Astc {
            block: wgpu::AstcBlock::B4x4,
            channel: wgpu::AstcChannel::UnormSrgb,
        },
        _ => return None,
    })
}

fn required_feature(format: wgpu::TextureFormat) -> Option<wgpu::Features> {
    match format {
        wgpu::TextureFormat::Bc1RgbaUnorm
        | wgpu::TextureFormat::Bc1RgbaUnormSrgb
        | wgpu::TextureFormat::Bc3RgbaUnorm
        | wgpu::TextureFormat::Bc3RgbaUnormSrgb
        | wgpu::TextureFormat::Bc7RgbaUnorm
        | wgpu::TextureFormat::Bc7RgbaUnormSrgb => Some(wgpu::Features::TEXTURE_COMPRESSION_BC),
        wgpu::TextureFormat::Etc2Rgba8Unorm | wgpu::TextureFormat::Etc2Rgba8UnormSrgb => {
            Some(wgpu::Features::TEXTURE_COMPRESSION_ETC2)
        }
        wgpu::TextureFormat::Astc { .. } => Some(wgpu::Features::TEXTURE_COMPRESSION_ASTC),
        _ => None,
    }
}

fn level_byte_length(format: wgpu::TextureFormat, width: u32, height: u32) -> Option<u64> {
    match compressed_block_bytes(format) {
        Some(block) => {
            let blocks_x = u64::from(width.div_ceil(4));
            let blocks_y = u64::from(height.div_ceil(4));
            blocks_x
                .checked_mul(blocks_y)?
                .checked_mul(u64::from(block))
        }
        None => u64::from(width)
            .checked_mul(u64::from(height))?
            .checked_mul(4),
    }
}

struct RawImage {
    width: u32,
    height: u32,
    format: String,
    color_space: String,
    base: Vec<u8>,
    mipmaps: Vec<(u32, u32, Vec<u8>)>,
}

fn validate_image(
    semantic_index: usize,
    raw: RawImage,
    field: &str,
) -> Result<ParsedTextureImage, WebError> {
    let (field_name, semantic) = SEMANTIC_FIELDS[semantic_index];
    let format = map_texture_format(&raw.format).ok_or_else(|| {
        invalid(format!(
            "material.textures.{field_name}.format is not supported: {}",
            raw.format
        ))
    })?;
    if raw.color_space != "srgb" && raw.color_space != "linear" {
        return Err(invalid(format!(
            "{field}.colorSpace must be srgb or linear"
        )));
    }
    let srgb = format.is_srgb();
    if semantic_index == 1 || semantic_index == 2 || semantic_index == 3 {
        if raw.color_space != "linear" || srgb {
            return Err(invalid(format!(
                "{field} requires linear colorSpace and a non-sRGB format for {semantic}"
            )));
        }
    } else if srgb != (raw.color_space == "srgb") {
        return Err(invalid(format!(
            "{field} requires an sRGB format iff colorSpace is srgb"
        )));
    }
    if raw.width < 1
        || raw.width > MAX_TEXTURE_DIMENSION
        || raw.height < 1
        || raw.height > MAX_TEXTURE_DIMENSION
    {
        return Err(invalid(format!(
            "{field} dimensions must be between 1 and {MAX_TEXTURE_DIMENSION}"
        )));
    }
    let mut levels = Vec::with_capacity(raw.mipmaps.len() + 1);
    let expected = level_byte_length(format, raw.width, raw.height)
        .ok_or_else(|| invalid(format!("{field} level byte size overflowed")))?;
    if raw.base.len() as u64 != expected {
        return Err(invalid(format!(
            "{field}.data must contain exactly {expected} bytes"
        )));
    }
    levels.push(ParsedTextureLevel {
        width: raw.width,
        height: raw.height,
        data: raw.base,
    });
    for (index, (width, height, data)) in raw.mipmaps.into_iter().enumerate() {
        let previous = levels.last().expect("base level exists");
        let expected_width = (previous.width / 2).max(1);
        let expected_height = (previous.height / 2).max(1);
        if width != expected_width || height != expected_height {
            return Err(invalid(format!(
                "{field}.levels[{index}] must be exactly {expected_width}x{expected_height}"
            )));
        }
        let expected = level_byte_length(format, width, height)
            .ok_or_else(|| invalid(format!("{field} level byte size overflowed")))?;
        if data.len() as u64 != expected {
            return Err(invalid(format!(
                "{field}.levels[{index}] must contain exactly {expected} bytes"
            )));
        }
        levels.push(ParsedTextureLevel {
            width,
            height,
            data,
        });
    }
    Ok(ParsedTextureImage { format, levels })
}

fn parse_wrap(value: Option<&str>, field: &str) -> Result<wgpu::AddressMode, WebError> {
    match value {
        None => Ok(wgpu::AddressMode::Repeat),
        Some("repeat") => Ok(wgpu::AddressMode::Repeat),
        Some("clamp-to-edge") => Ok(wgpu::AddressMode::ClampToEdge),
        Some("mirror-repeat") => Ok(wgpu::AddressMode::MirrorRepeat),
        Some(_) => Err(invalid(format!("{field} must be a valid wrap mode"))),
    }
}

fn parse_filter_mode(value: Option<&str>, field: &str) -> Result<wgpu::FilterMode, WebError> {
    match value {
        None => Ok(wgpu::FilterMode::Linear),
        Some("nearest") => Ok(wgpu::FilterMode::Nearest),
        Some("linear") => Ok(wgpu::FilterMode::Linear),
        Some(_) => Err(invalid(format!("{field} must be nearest or linear"))),
    }
}

fn parse_mipmap_mode(value: Option<&str>, field: &str) -> Result<wgpu::MipmapFilterMode, WebError> {
    Ok(match parse_filter_mode(value, field)? {
        wgpu::FilterMode::Nearest => wgpu::MipmapFilterMode::Nearest,
        wgpu::FilterMode::Linear => wgpu::MipmapFilterMode::Linear,
    })
}

struct RawSampler {
    wrap_u: Option<String>,
    wrap_v: Option<String>,
    mag_filter: Option<String>,
    min_filter: Option<String>,
    mipmap_filter: Option<String>,
    max_anisotropy: Option<u64>,
}

fn validate_sampler(raw: RawSampler, field: &str) -> Result<ParsedSampler, WebError> {
    let max_anisotropy = match raw.max_anisotropy {
        None => 1u16,
        Some(value) => {
            if ![1, 2, 4, 8, 16].contains(&value) {
                return Err(invalid(format!(
                    "{field}.maxAnisotropy must be one of 1, 2, 4, 8, 16"
                )));
            }
            value as u16
        }
    };
    let mag_filter = parse_filter_mode(raw.mag_filter.as_deref(), field)?;
    let min_filter = parse_filter_mode(raw.min_filter.as_deref(), field)?;
    let mipmap_filter = parse_mipmap_mode(raw.mipmap_filter.as_deref(), field)?;
    if max_anisotropy > 1
        && !(mag_filter == wgpu::FilterMode::Linear
            && min_filter == wgpu::FilterMode::Linear
            && mipmap_filter == wgpu::MipmapFilterMode::Linear)
    {
        return Err(invalid(format!(
            "{field}.maxAnisotropy above 1 requires linear mag/min/mipmap filters"
        )));
    }
    Ok(ParsedSampler {
        address_mode_u: parse_wrap(raw.wrap_u.as_deref(), field)?,
        address_mode_v: parse_wrap(raw.wrap_v.as_deref(), field)?,
        mag_filter,
        min_filter,
        mipmap_filter,
        max_anisotropy,
    })
}

#[allow(dead_code)]
fn texture_set_from_json(value: &serde_json::Value) -> Result<ParsedTextureSet, WebError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("material.textures must be an object"))?;
    let mut images: [Option<ParsedTextureImage>; 5] = Default::default();
    for (index, (field_name, _)) in SEMANTIC_FIELDS.iter().enumerate() {
        let Some(image_value) = object.get(*field_name) else {
            continue;
        };
        let image_object = image_value
            .as_object()
            .ok_or_else(|| invalid(format!("material.textures.{field_name} must be an object")))?;
        let field = format!("material.textures.{field_name}");
        let json_u32 = |name: &str| -> Result<u32, WebError> {
            image_object
                .get(name)
                .and_then(|value| value.as_u64())
                .filter(|value| *value <= u64::from(u32::MAX))
                .map(|value| value as u32)
                .ok_or_else(|| invalid(format!("{field}.{name} must be a nonnegative integer")))
        };
        let json_str = |name: &str| -> Result<String, WebError> {
            image_object
                .get(name)
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .ok_or_else(|| invalid(format!("{field}.{name} must be a string")))
        };
        let json_bytes = |value: &serde_json::Value, name: &str| -> Result<Vec<u8>, WebError> {
            let array = value
                .as_array()
                .ok_or_else(|| invalid(format!("{field}.{name} must be a byte array")))?;
            let mut bytes = Vec::with_capacity(array.len());
            for component in array {
                bytes.push(
                    component
                        .as_u64()
                        .filter(|value| *value <= 255)
                        .map(|value| value as u8)
                        .ok_or_else(|| invalid(format!("{field}.{name} entries must be bytes")))?,
                );
            }
            Ok(bytes)
        };
        let mipmaps_value = image_object
            .get("levels")
            .and_then(|value| value.as_array())
            .ok_or_else(|| invalid(format!("{field}.levels must be an array")))?;
        if mipmaps_value.is_empty() {
            return Err(invalid(format!(
                "{field}.levels must contain the base level"
            )));
        }
        let mut mipmaps = Vec::with_capacity(mipmaps_value.len().saturating_sub(1));
        for (level_index, level) in mipmaps_value.iter().enumerate().skip(1) {
            let level_object = level.as_object().ok_or_else(|| {
                invalid(format!("{field}.levels[{level_index}] must be an object"))
            })?;
            let width = level_object
                .get("width")
                .and_then(|value| value.as_u64())
                .map(|value| value as u32)
                .ok_or_else(|| {
                    invalid(format!(
                        "{field}.levels[{level_index}].width must be an integer"
                    ))
                })?;
            let height = level_object
                .get("height")
                .and_then(|value| value.as_u64())
                .map(|value| value as u32)
                .ok_or_else(|| {
                    invalid(format!(
                        "{field}.levels[{level_index}].height must be an integer"
                    ))
                })?;
            let data = level_object.get("data").ok_or_else(|| {
                invalid(format!("{field}.levels[{level_index}].data is required"))
            })?;
            mipmaps.push((width, height, json_bytes(data, "levels.data")?));
        }
        let base_level = mipmaps_value[0]
            .as_object()
            .ok_or_else(|| invalid(format!("{field}.levels[0] must be an object")))?;
        let base_data = base_level
            .get("data")
            .ok_or_else(|| invalid(format!("{field}.levels[0].data is required")))?;
        images[index] = Some(validate_image(
            index,
            RawImage {
                width: json_u32("width")?,
                height: json_u32("height")?,
                format: json_str("format")?,
                color_space: json_str("colorSpace")?,
                base: json_bytes(base_data, "levels[0].data")?,
                mipmaps,
            },
            &field,
        )?);
    }
    let sampler = object
        .get("sampler")
        .and_then(|value| value.as_object())
        .ok_or_else(|| invalid("material.textures.sampler must be an object"))?;
    let sampler_string = |name: &str| -> Result<Option<String>, WebError> {
        match sampler.get(name) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(serde_json::Value::String(text)) => Ok(Some(text.clone())),
            Some(_) => Err(invalid(format!(
                "material.textures.sampler.{name} must be a string"
            ))),
        }
    };
    let max_anisotropy = match sampler.get("maxAnisotropy") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => Some(value.as_u64().ok_or_else(|| {
            invalid("material.textures.sampler.maxAnisotropy must be an integer")
        })?),
    };
    let parsed_sampler = validate_sampler(
        RawSampler {
            wrap_u: sampler_string("wrapU")?,
            wrap_v: sampler_string("wrapV")?,
            mag_filter: sampler_string("magFilter")?,
            min_filter: sampler_string("minFilter")?,
            mipmap_filter: sampler_string("mipmapFilter")?,
            max_anisotropy,
        },
        "material.textures.sampler",
    )?;
    Ok(ParsedTextureSet {
        images,
        sampler: parsed_sampler,
    })
}

#[cfg(target_arch = "wasm32")]
fn js_get(value: &JsValue, name: &str) -> Result<JsValue, WebError> {
    js_sys::Reflect::get(value, &JsValue::from_str(name))
        .map_err(|_| invalid(format!("material.textures.{name} could not be read")))
}

#[cfg(target_arch = "wasm32")]
fn js_u32(value: &JsValue, field: &str) -> Result<u32, WebError> {
    value
        .as_f64()
        .filter(|number| number.is_finite() && number.fract() == 0.0 && *number >= 0.0)
        .filter(|number| *number <= f64::from(u32::MAX))
        .map(|number| number as u32)
        .ok_or_else(|| {
            invalid(format!(
                "material.textures.{field} must be a nonnegative integer"
            ))
        })
}

#[cfg(target_arch = "wasm32")]
fn js_string(value: &JsValue, field: &str) -> Result<String, WebError> {
    value
        .as_string()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| {
            invalid(format!(
                "material.textures.{field} must be a nonempty string"
            ))
        })
}

#[cfg(target_arch = "wasm32")]
fn js_bytes(value: &JsValue, field: &str) -> Result<Vec<u8>, WebError> {
    if let Some(array) = value.dyn_ref::<js_sys::Uint8Array>() {
        let mut bytes = vec![0u8; array.length() as usize];
        array.copy_to(&mut bytes);
        return Ok(bytes);
    }
    if js_sys::Array::is_array(value) {
        let array = js_sys::Array::from(value);
        let mut bytes = Vec::with_capacity(array.length() as usize);
        for entry in array.iter() {
            let component = entry
                .as_f64()
                .filter(|number| number.fract() == 0.0 && (0.0..=255.0).contains(number))
                .ok_or_else(|| {
                    invalid(format!("material.textures.{field} entries must be bytes"))
                })?;
            bytes.push(component as u8);
        }
        return Ok(bytes);
    }
    Err(invalid(format!(
        "material.textures.{field} must be a Uint8Array"
    )))
}

#[cfg(target_arch = "wasm32")]
fn texture_set_from_js(value: &JsValue) -> Result<ParsedTextureSet, WebError> {
    if !value.is_object() || value.is_null() {
        return Err(invalid("material.textures must be an object"));
    }
    let mut images: [Option<ParsedTextureImage>; 5] = Default::default();
    for (index, (field_name, _)) in SEMANTIC_FIELDS.iter().enumerate() {
        let image_value = js_get(value, field_name)?;
        if image_value.is_undefined() || image_value.is_null() {
            continue;
        }
        if !image_value.is_object() {
            return Err(invalid(format!(
                "material.textures.{field_name} must be an object"
            )));
        }
        let field = format!("material.textures.{field_name}");
        let width = js_u32(&js_get(&image_value, "width")?, "width")?;
        let height = js_u32(&js_get(&image_value, "height")?, "height")?;
        let format = js_string(&js_get(&image_value, "format")?, "format")?;
        let color_space = js_string(&js_get(&image_value, "colorSpace")?, "colorSpace")?;
        let levels_value = js_get(&image_value, "levels")?;
        if !js_sys::Array::is_array(&levels_value) {
            return Err(invalid(format!("{field}.levels must be an array")));
        }
        let levels_array = js_sys::Array::from(&levels_value);
        if levels_array.length() == 0 {
            return Err(invalid(format!(
                "{field}.levels must contain the base level"
            )));
        }
        let mut level_inputs = Vec::with_capacity(levels_array.length() as usize);
        for (level_index, level) in levels_array.iter().enumerate() {
            if !level.is_object() {
                return Err(invalid(format!(
                    "{field}.levels[{level_index}] must be an object"
                )));
            }
            let level_width = js_u32(&js_get(&level, "width")?, "levels.width")?;
            let level_height = js_u32(&js_get(&level, "height")?, "levels.height")?;
            let data = js_bytes(&js_get(&level, "data")?, "levels.data")?;
            level_inputs.push((level_width, level_height, data));
        }
        let (base_width, base_height, base_data) = level_inputs.remove(0);
        if base_width != width || base_height != height {
            return Err(invalid(format!(
                "{field}.levels[0] must match the image dimensions"
            )));
        }
        let mipmaps = level_inputs;
        images[index] = Some(validate_image(
            index,
            RawImage {
                width,
                height,
                format,
                color_space,
                base: base_data,
                mipmaps,
            },
            &field,
        )?);
    }
    let sampler_value = js_get(value, "sampler")?;
    let sampler = if sampler_value.is_undefined() || sampler_value.is_null() {
        ParsedSampler::default()
    } else {
        if !sampler_value.is_object() {
            return Err(invalid("material.textures.sampler must be an object"));
        }
        let field = "material.textures.sampler";
        let string_option = |name: &str| -> Result<Option<String>, WebError> {
            let entry = js_get(&sampler_value, name)?;
            if entry.is_undefined() || entry.is_null() {
                Ok(None)
            } else {
                Ok(Some(js_string(&entry, name)?))
            }
        };
        let max_anisotropy = {
            let entry = js_get(&sampler_value, "maxAnisotropy")?;
            if entry.is_undefined() || entry.is_null() {
                None
            } else {
                Some(
                    entry
                        .as_f64()
                        .filter(|number| number.fract() == 0.0 && *number >= 0.0)
                        .map(|number| number as u64)
                        .ok_or_else(|| {
                            invalid(format!("{field}.maxAnisotropy must be an integer"))
                        })?,
                )
            }
        };
        validate_sampler(
            RawSampler {
                wrap_u: string_option("wrapU")?,
                wrap_v: string_option("wrapV")?,
                mag_filter: string_option("magFilter")?,
                min_filter: string_option("minFilter")?,
                mipmap_filter: string_option("mipmapFilter")?,
                max_anisotropy,
            },
            field,
        )?
    };
    Ok(ParsedTextureSet { images, sampler })
}

#[allow(dead_code)]
pub(super) fn materials_and_textures_from_json(
    value: &serde_json::Value,
) -> Result<ParsedMaterials, WebError> {
    let mut state = super::lighting::material_state_from_json(value)?;
    let mut texture_sets = BTreeMap::new();
    let entries = value
        .get("materials")
        .and_then(|value| value.as_array())
        .ok_or_else(|| invalid("materials.materials must be an array"))?;
    for slot in &mut state.slots {
        let entry = entries
            .iter()
            .find(|entry| {
                entry
                    .get("index")
                    .and_then(|index| index.as_u64())
                    .is_some_and(|index| index == u64::from(slot.index))
            })
            .ok_or_else(|| invalid("materials.materials index lookup failed"))?;
        let material = entry
            .get("material")
            .and_then(|value| value.as_object())
            .ok_or_else(|| invalid("materials.materials.material must be an object"))?;
        let set = match material.get("textures") {
            None | Some(serde_json::Value::Null) => ParsedTextureSet::default(),
            Some(value) => texture_set_from_json(value)?,
        };
        slot.material.flags = set.flag_bits();
        texture_sets.insert(slot.index, set);
    }
    let state = state.validated().map_err(map_core_error)?;
    Ok(ParsedMaterials {
        state,
        texture_sets,
    })
}

#[cfg(target_arch = "wasm32")]
pub(super) fn materials_and_textures_from_js(value: &JsValue) -> Result<ParsedMaterials, WebError> {
    let materials_value = js_get(value, "materials")?;
    if !js_sys::Array::is_array(&materials_value) {
        return Err(invalid("materials.materials must be an array"));
    }
    let entries = js_sys::Array::from(&materials_value);
    let mut texture_sets = BTreeMap::new();
    let sanitized_entries = js_sys::Array::new();
    for entry in entries.iter() {
        if !entry.is_object() {
            return Err(invalid("materials.materials entries must be objects"));
        }
        let index = js_sys::Reflect::get(&entry, &JsValue::from_str("index"))
            .map_err(|_| invalid("materials.materials.index could not be read"))?
            .as_f64()
            .filter(|value| value.fract() == 0.0 && *value >= 0.0)
            .map(|value| value as u32)
            .ok_or_else(|| invalid("materials.materials.index must be a nonnegative integer"))?;
        let material = js_get(&entry, "material")?;
        if !material.is_object() || material.is_null() {
            return Err(invalid("materials.materials.material must be an object"));
        }
        let textures_value = js_get(&material, "textures")?;
        let set = if textures_value.is_undefined() || textures_value.is_null() {
            ParsedTextureSet::default()
        } else {
            texture_set_from_js(&textures_value)?
        };
        texture_sets.insert(index, set);
        let material_clone = js_sys::Object::assign(
            &js_sys::Object::new(),
            material
                .dyn_ref::<js_sys::Object>()
                .ok_or_else(|| invalid("materials.materials.material must be an object"))?,
        );
        js_sys::Reflect::set(
            &material_clone,
            &JsValue::from_str("textures"),
            &JsValue::UNDEFINED,
        )
        .map_err(|_| invalid("materials snapshot could not be sanitized"))?;
        let entry_clone = js_sys::Object::assign(
            &js_sys::Object::new(),
            entry
                .dyn_ref::<js_sys::Object>()
                .ok_or_else(|| invalid("materials.materials entries must be objects"))?,
        );
        js_sys::Reflect::set(
            &entry_clone,
            &JsValue::from_str("material"),
            &material_clone,
        )
        .map_err(|_| invalid("materials snapshot could not be sanitized"))?;
        sanitized_entries.push(&entry_clone);
    }
    let root_clone = js_sys::Object::assign(
        &js_sys::Object::new(),
        value
            .dyn_ref::<js_sys::Object>()
            .ok_or_else(|| invalid("materials snapshot must be an object"))?,
    );
    js_sys::Reflect::set(
        &root_clone,
        &JsValue::from_str("materials"),
        &sanitized_entries,
    )
    .map_err(|_| invalid("materials snapshot could not be sanitized"))?;
    let json: serde_json::Value = serde_wasm_bindgen::from_value(root_clone.into())
        .map_err(|error| invalid(format!("materials snapshot is malformed: {error}")))?;
    let mut state = super::lighting::material_state_from_json(&json)?;
    for slot in &mut state.slots {
        if let Some(set) = texture_sets.get(&slot.index) {
            slot.material.flags = set.flag_bits();
        }
    }
    let state = state.validated().map_err(map_core_error)?;
    Ok(ParsedMaterials {
        state,
        texture_sets,
    })
}

#[allow(dead_code)]
pub(super) struct TextureResources {
    pub bind_group_layout: wgpu::BindGroupLayout,
    bind_groups: BTreeMap<u32, wgpu::BindGroup>,
    _textures: Vec<wgpu::Texture>,
    _samplers: Vec<wgpu::Sampler>,
    pub payload_bytes: u64,
}

impl TextureResources {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn new(
        context: &forge3d_core::gpu::GpuContext,
        texture_sets: &BTreeMap<u32, ParsedTextureSet>,
        memory: &MemoryLedger,
        max_texture_dimension_2d: u32,
    ) -> Result<Self, WebError> {
        let mut sets: BTreeMap<u32, ParsedTextureSet> = texture_sets.clone();
        sets.entry(0).or_default();
        let payload_bytes: u64 = sets.values().map(|set| set.payload_bytes()).sum();
        let total = FALLBACK_BYTES.saturating_add(payload_bytes);
        if !memory.fits_after_release(&texture_memory_keys(), total) {
            return Err(WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                format!("material textures require {total} bytes beyond the memory budget"),
            ));
        }
        let features = context.device.features();
        let max_dimension = max_texture_dimension_2d.min(MAX_TEXTURE_DIMENSION);
        for (index, set) in &sets {
            for (semantic_index, image) in set.images.iter().enumerate() {
                let Some(image) = image else {
                    continue;
                };
                let (field_name, _) = SEMANTIC_FIELDS[semantic_index];
                if let Some(feature) = required_feature(image.format) {
                    if !features.contains(feature) {
                        return Err(unsupported(format!(
                            "material {index} texture {field_name} requires device feature {feature:?}"
                        )));
                    }
                }
                for level in &image.levels {
                    if level.width > max_dimension || level.height > max_dimension {
                        return Err(WebError::new(
                            Forge3DErrorCode::ResourceLimitExceeded,
                            format!(
                                "material {index} texture {field_name} exceeds maxTextureDimension2D {max_dimension}"
                            ),
                        ));
                    }
                }
            }
        }

        let bind_group_layout =
            context
                .device
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("forge3d-web-textures-bind-group-layout"),
                    entries: &texture_layout_entries(),
                });
        let mut keep_textures = Vec::new();
        let mut keep_samplers = Vec::new();
        let fallback_pixels: [[u8; 4]; 5] = [
            [255, 255, 255, 255],
            [128, 128, 255, 255],
            [255, 255, 0, 255],
            [255, 255, 255, 255],
            [0, 0, 0, 255],
        ];
        let mut fallback_views = Vec::with_capacity(5);
        for (semantic_index, pixel) in fallback_pixels.iter().enumerate() {
            let srgb = semantic_index == 0 || semantic_index == 4;
            let format = if srgb {
                wgpu::TextureFormat::Rgba8UnormSrgb
            } else {
                wgpu::TextureFormat::Rgba8Unorm
            };
            let texture = context.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("forge3d-web-texture-fallback"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            context.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                pixel,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(4),
                    rows_per_image: Some(1),
                },
                wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
            );
            fallback_views.push(texture.create_view(&wgpu::TextureViewDescriptor::default()));
            keep_textures.push(texture);
        }

        let mut bind_groups = BTreeMap::new();
        for (index, set) in &sets {
            let mut views: Vec<Option<wgpu::TextureView>> = vec![None; 5];
            for (semantic_index, image) in set.images.iter().enumerate() {
                let Some(image) = image else {
                    continue;
                };
                let base = &image.levels[0];
                let texture = context.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("forge3d-web-material-texture"),
                    size: wgpu::Extent3d {
                        width: base.width,
                        height: base.height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: image.levels.len() as u32,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: image.format,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                });
                for (mip_level, level) in image.levels.iter().enumerate() {
                    let (bytes_per_row, rows_per_image) =
                        if let Some(block) = compressed_block_bytes(image.format) {
                            (level.width.div_ceil(4) * block, level.height.div_ceil(4))
                        } else {
                            (level.width * 4, level.height)
                        };
                    context.queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &texture,
                            mip_level: mip_level as u32,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        &level.data,
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(bytes_per_row),
                            rows_per_image: Some(rows_per_image),
                        },
                        wgpu::Extent3d {
                            width: level.width,
                            height: level.height,
                            depth_or_array_layers: 1,
                        },
                    );
                }
                views[semantic_index] =
                    Some(texture.create_view(&wgpu::TextureViewDescriptor::default()));
                keep_textures.push(texture);
            }
            let sampler = context.device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("forge3d-web-material-sampler"),
                address_mode_u: set.sampler.address_mode_u,
                address_mode_v: set.sampler.address_mode_v,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: set.sampler.mag_filter,
                min_filter: set.sampler.min_filter,
                mipmap_filter: set.sampler.mipmap_filter,
                anisotropy_clamp: set.sampler.max_anisotropy,
                ..wgpu::SamplerDescriptor::default()
            });
            keep_samplers.push(sampler);
            let sampler = keep_samplers.last().expect("sampler pushed");
            let entries = [
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        views[0].as_ref().unwrap_or(&fallback_views[0]),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        views[1].as_ref().unwrap_or(&fallback_views[1]),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(
                        views[2].as_ref().unwrap_or(&fallback_views[2]),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(
                        views[3].as_ref().unwrap_or(&fallback_views[3]),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(
                        views[4].as_ref().unwrap_or(&fallback_views[4]),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ];
            let bind_group = context
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("forge3d-web-material-textures"),
                    layout: &bind_group_layout,
                    entries: &entries,
                });
            bind_groups.insert(*index, bind_group);
        }
        Ok(Self {
            bind_group_layout,
            bind_groups,
            _textures: keep_textures,
            _samplers: keep_samplers,
            payload_bytes,
        })
    }

    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn bind_group_for(&self, material_index: u32) -> &wgpu::BindGroup {
        self.bind_groups
            .get(&material_index)
            .or_else(|| self.bind_groups.get(&0))
            .or_else(|| self.bind_groups.values().next())
            .expect("texture resources always contain a default bind group")
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn texture_layout_entries() -> [wgpu::BindGroupLayoutEntry; 6] {
    let texture = |binding: u32| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    };
    [
        texture(0),
        texture(1),
        texture(2),
        texture(3),
        texture(4),
        wgpu::BindGroupLayoutEntry {
            binding: 5,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        },
    ]
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn build_texture_resources(
    context: &forge3d_core::gpu::GpuContext,
    memory: &super::memory::MemoryLedger,
    max_texture_dimension_2d: u32,
    texture_sets: &BTreeMap<u32, ParsedTextureSet>,
) -> Result<TextureResources, WebError> {
    TextureResources::new(context, texture_sets, memory, max_texture_dimension_2d)
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn commit_textures(runtime: &mut super::Forge3DRuntime, resources: TextureResources) {
    runtime.textures = Some(resources);
}

#[cfg(test)]
mod tests;
