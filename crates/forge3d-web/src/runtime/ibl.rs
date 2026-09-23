#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use forge3d_core::gpu::GpuContext;
use forge3d_core::memory::{MemoryCategory, OverflowPolicy};
use wgpu::util::DeviceExt;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::{JsCast, JsValue};

use super::Forge3DRuntime;
#[cfg(target_arch = "wasm32")]
use crate::error::map_core_error;
use crate::error::{Forge3DErrorCode, WebError};

#[cfg(test)]
mod tests;

pub(super) const IBL_SOURCE_MAX_DIMENSION: u32 = 16384;
pub(super) const IBL_UNIFORM_BYTES: u64 = 32;
const IBL_COMPUTE_SHADER: &str = include_str!("ibl_compute.wgsl");
pub(super) const IBL_TEXTURES_LEDGER_KEY: &str = "ibl:textures";
pub(super) const IBL_UNIFORM_LEDGER_KEY: &str = "ibl:uniform";
pub(super) const IBL_TRANSIENT_LEDGER_KEY: &str = "ibl:transient";
const IBL_FALLBACK_TEXTURE_BYTES: u64 = 104;
const RGBA16F_TEXEL_BYTES: u64 = 8;
const RGBA32F_TEXEL_BYTES: u64 = 16;
const WORKGROUP_SIZE: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum IblQuality {
    Low,
    Medium,
    High,
    Ultra,
}

impl IblQuality {
    fn index(self) -> u32 {
        match self {
            IblQuality::Low => 0,
            IblQuality::Medium => 1,
            IblQuality::High => 2,
            IblQuality::Ultra => 3,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct IblQualitySpec {
    pub environment: u32,
    pub irradiance: u32,
    pub specular: u32,
    pub specular_mips: u32,
    pub brdf_lut: u32,
    pub samples: u32,
}

pub(super) fn ibl_quality_spec(quality: IblQuality) -> IblQualitySpec {
    match quality {
        IblQuality::Low => IblQualitySpec {
            environment: 32,
            irradiance: 8,
            specular: 32,
            specular_mips: 4,
            brdf_lut: 32,
            samples: 32,
        },
        IblQuality::Medium => IblQualitySpec {
            environment: 64,
            irradiance: 16,
            specular: 64,
            specular_mips: 5,
            brdf_lut: 64,
            samples: 64,
        },
        IblQuality::High => IblQualitySpec {
            environment: 128,
            irradiance: 32,
            specular: 128,
            specular_mips: 6,
            brdf_lut: 128,
            samples: 128,
        },
        IblQuality::Ultra => IblQualitySpec {
            environment: 256,
            irradiance: 64,
            specular: 256,
            specular_mips: 7,
            brdf_lut: 256,
            samples: 256,
        },
    }
}

fn parse_ibl_quality(value: &str) -> Option<IblQuality> {
    match value {
        "low" => Some(IblQuality::Low),
        "medium" => Some(IblQuality::Medium),
        "high" => Some(IblQuality::High),
        "ultra" => Some(IblQuality::Ultra),
        _ => None,
    }
}

pub(super) fn ibl_quality_name(quality: IblQuality) -> &'static str {
    match quality {
        IblQuality::Low => "low",
        IblQuality::Medium => "medium",
        IblQuality::High => "high",
        IblQuality::Ultra => "ultra",
    }
}

fn ibl_quality_ladder(requested: IblQuality) -> Vec<IblQuality> {
    let all = [
        IblQuality::Low,
        IblQuality::Medium,
        IblQuality::High,
        IblQuality::Ultra,
    ];
    let start = all
        .iter()
        .position(|quality| *quality == requested)
        .unwrap_or(0);
    let mut ladder: Vec<IblQuality> = all[..=start].iter().rev().copied().collect();
    if ladder.is_empty() {
        ladder.push(requested);
    }
    ladder
}

fn mip_size(size: u32, mip: u32) -> u32 {
    (size >> mip).max(1)
}

fn cube_level_bytes(face_size: u32) -> Option<u64> {
    u64::from(face_size)
        .checked_mul(u64::from(face_size))?
        .checked_mul(6)?
        .checked_mul(RGBA16F_TEXEL_BYTES)
}

pub(super) fn specular_cube_bytes(spec: &IblQualitySpec) -> Option<u64> {
    let mut total = 0u64;
    for mip in 0..spec.specular_mips {
        total = total.checked_add(cube_level_bytes(mip_size(spec.specular, mip))?)?;
    }
    Some(total)
}

fn brdf_lut_bytes(spec: &IblQualitySpec) -> Option<u64> {
    u64::from(spec.brdf_lut)
        .checked_mul(u64::from(spec.brdf_lut))?
        .checked_mul(RGBA16F_TEXEL_BYTES)
}

pub(super) fn ibl_prepared_lengths(spec: &IblQualitySpec) -> Option<(u64, u64, u64)> {
    Some((
        cube_level_bytes(spec.irradiance)?,
        specular_cube_bytes(spec)?,
        brdf_lut_bytes(spec)?,
    ))
}

fn environment_bytes(spec: &IblQualitySpec) -> Option<u64> {
    cube_level_bytes(spec.environment)
}

fn aligned_row_bytes(row_bytes: u32) -> u32 {
    row_bytes.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
}

fn readback_bytes(spec: &IblQualitySpec) -> Option<u64> {
    let cube_mip_bytes = |face_size: u32| -> Option<u64> {
        let row = face_size.checked_mul(RGBA16F_TEXEL_BYTES as u32)?;
        let padded = u64::from(aligned_row_bytes(row));
        padded.checked_mul(u64::from(face_size))?.checked_mul(6)
    };
    let mut specular = 0u64;
    for mip in 0..spec.specular_mips {
        specular = specular.checked_add(cube_mip_bytes(mip_size(spec.specular, mip))?)?;
    }
    let lut_row = u64::from(aligned_row_bytes(
        spec.brdf_lut * RGBA16F_TEXEL_BYTES as u32,
    ));
    cube_mip_bytes(spec.irradiance)?
        .checked_add(specular)?
        .checked_add(lut_row.checked_mul(u64::from(spec.brdf_lut))?)
}

fn source_bytes(parsed: &ParsedIbl) -> Option<u64> {
    u64::from(parsed.source_width)
        .checked_mul(u64::from(parsed.source_height))?
        .checked_mul(RGBA32F_TEXEL_BYTES)
}

fn invalid(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message.into())
}

fn resource_limit(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::ResourceLimitExceeded, message.into())
}

#[derive(Debug, Clone)]
pub(super) struct ParsedIblPrepared {
    pub irradiance_size: u32,
    pub specular_size: u32,
    pub specular_mip_count: u32,
    pub brdf_lut_size: u32,
    pub irradiance: Vec<u8>,
    pub specular: Vec<u8>,
    pub brdf_lut: Vec<u8>,
}

#[derive(Debug, Clone)]
pub(super) struct ParsedIbl {
    pub source_width: u32,
    pub source_height: u32,
    pub source_data: Vec<f32>,
    pub source_hash: String,
    pub intensity: f32,
    pub rotation_degrees: f32,
    pub requested_quality: IblQuality,
    pub effective_quality: IblQuality,
    pub prepared: Option<ParsedIblPrepared>,
}

fn validate_source_dimensions(width: u32, height: u32) -> Result<(), WebError> {
    if width == 0 || height == 0 {
        return Err(invalid("ibl source dimensions must be positive"));
    }
    if width > IBL_SOURCE_MAX_DIMENSION || height > IBL_SOURCE_MAX_DIMENSION {
        return Err(resource_limit(format!(
            "ibl source dimensions {width}x{height} exceed {IBL_SOURCE_MAX_DIMENSION}"
        )));
    }
    Ok(())
}

fn validate_source_data(parsed_source: (u32, u32, &[f32])) -> Result<(), WebError> {
    let (width, height, data) = parsed_source;
    validate_source_dimensions(width, height)?;
    let expected = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| resource_limit("ibl source pixel count overflowed"))?;
    if data.len() as u64 != expected {
        return Err(invalid(format!(
            "ibl source data length {} does not match {expected} floats",
            data.len()
        )));
    }
    if data.iter().any(|value| !value.is_finite()) {
        return Err(invalid("ibl source data must contain finite floats"));
    }
    Ok(())
}

fn validate_source_hash(hash: &str) -> Result<(), WebError> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(
            "ibl sourceHash must be a 64-character lowercase hex digest",
        ));
    }
    Ok(())
}

fn verify_source_hash(width: u32, height: u32, data: &[f32], hash: &str) -> Result<(), WebError> {
    let computed = forge3d_core::codecs::sha256::ibl_source_hash(width, height, data);
    if computed != hash {
        return Err(invalid("ibl sourceHash does not match the source data"));
    }
    Ok(())
}

fn validate_report_consistency(
    mode: &str,
    report_requested: &str,
    report_effective: &str,
    backend: &str,
    approximation: &str,
    requested_quality: IblQuality,
    effective_quality: IblQuality,
    prepared_present: bool,
) -> Result<(), WebError> {
    let expected_mode = if prepared_present {
        "prepared-upload"
    } else {
        "runtime-precompute"
    };
    if mode != expected_mode {
        return Err(invalid(format!(
            "ibl report effectiveMode must be '{expected_mode}' for this snapshot"
        )));
    }
    if parse_ibl_quality(report_requested) != Some(requested_quality) {
        return Err(invalid(
            "ibl report requestedQuality does not match the snapshot",
        ));
    }
    if parse_ibl_quality(report_effective) != Some(effective_quality) {
        return Err(invalid(
            "ibl report effectiveQuality does not match the snapshot",
        ));
    }
    match backend {
        "none" | "cache-storage" | "opfs" => {}
        _ => {
            return Err(invalid(format!(
                "ibl report cacheBackend '{backend}' is not an actual backend"
            )))
        }
    }
    if approximation != "split-sum-ggx" {
        return Err(invalid(
            "ibl report brdfApproximation must be 'split-sum-ggx'",
        ));
    }
    Ok(())
}

fn validate_prepared_payload(
    effective: IblQuality,
    prepared: &ParsedIblPrepared,
) -> Result<(), WebError> {
    let spec = ibl_quality_spec(effective);
    if prepared.irradiance_size != spec.irradiance
        || prepared.specular_size != spec.specular
        || prepared.specular_mip_count != spec.specular_mips
        || prepared.brdf_lut_size != spec.brdf_lut
    {
        return Err(invalid(
            "ibl prepared dimensions do not match the effective quality table",
        ));
    }
    let (irradiance, specular, brdf) = ibl_prepared_lengths(&spec)
        .ok_or_else(|| resource_limit("ibl prepared size overflowed"))?;
    if prepared.irradiance.len() as u64 != irradiance
        || prepared.specular.len() as u64 != specular
        || prepared.brdf_lut.len() as u64 != brdf
    {
        return Err(invalid(
            "ibl prepared payload lengths do not match the effective quality table",
        ));
    }
    Ok(())
}

fn build_parsed_ibl(
    width: u32,
    height: u32,
    data: Vec<f32>,
    source_hash: String,
    intensity: f32,
    rotation_degrees: f32,
    requested_quality: IblQuality,
    effective_quality: IblQuality,
    prepared: Option<ParsedIblPrepared>,
) -> Result<ParsedIbl, WebError> {
    validate_source_data((width, height, &data))?;
    validate_source_hash(&source_hash)?;
    if !intensity.is_finite() || intensity < 0.0 {
        return Err(invalid("ibl intensity must be finite and non-negative"));
    }
    if !rotation_degrees.is_finite() || !(0.0..360.0).contains(&rotation_degrees) {
        return Err(invalid("ibl rotationDegrees must be within [0, 360)"));
    }
    verify_source_hash(width, height, &data, &source_hash)?;
    if effective_quality.index() > requested_quality.index() {
        return Err(invalid(
            "ibl effectiveQuality cannot exceed requestedQuality",
        ));
    }
    if let Some(prepared) = &prepared {
        validate_prepared_payload(effective_quality, prepared)?;
    }
    Ok(ParsedIbl {
        source_width: width,
        source_height: height,
        source_data: data,
        source_hash,
        intensity,
        rotation_degrees,
        requested_quality,
        effective_quality,
        prepared,
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn ibl_from_json(value: &serde_json::Value) -> Result<Option<ParsedIbl>, WebError> {
    if value.is_null() {
        return Ok(None);
    }
    if !value.is_object() {
        return Err(invalid("ibl snapshot must be an object or null"));
    }
    let source = value
        .get("source")
        .ok_or_else(|| invalid("ibl snapshot requires a source object"))?;
    let width = json_u32(source, "width")?;
    let height = json_u32(source, "height")?;
    let data_values = source
        .get("data")
        .and_then(|data| data.as_array())
        .ok_or_else(|| invalid("ibl source data must be an array"))?;
    let mut data = Vec::with_capacity(data_values.len());
    for entry in data_values {
        data.push(
            entry
                .as_f64()
                .ok_or_else(|| invalid("ibl source data must contain numbers"))? as f32,
        );
    }
    let source_hash = source
        .get("sourceHash")
        .and_then(|hash| hash.as_str())
        .ok_or_else(|| invalid("ibl sourceHash must be a string"))?
        .to_string();
    let intensity = json_f32(value, "intensity")?;
    let rotation_degrees = json_f32(value, "rotationDegrees")?;
    let requested_quality = json_quality(value, "requestedQuality")?;
    let effective_quality = json_quality(value, "effectiveQuality")?;
    let prepared = match value.get("prepared") {
        None | Some(serde_json::Value::Null) => None,
        Some(prepared) => Some(parse_prepared_json(prepared)?),
    };
    validate_report_json(
        value,
        requested_quality,
        effective_quality,
        prepared.is_some(),
    )?;
    build_parsed_ibl(
        width,
        height,
        data,
        source_hash,
        intensity,
        rotation_degrees,
        requested_quality,
        effective_quality,
        prepared,
    )
    .map(Some)
}

#[cfg(not(target_arch = "wasm32"))]
fn validate_report_json(
    value: &serde_json::Value,
    requested_quality: IblQuality,
    effective_quality: IblQuality,
    prepared_present: bool,
) -> Result<(), WebError> {
    let report = value
        .get("report")
        .filter(|report| report.is_object())
        .ok_or_else(|| invalid("ibl report must be an object"))?;
    let text = |key: &str| -> Result<&str, WebError> {
        report
            .get(key)
            .and_then(|entry| entry.as_str())
            .ok_or_else(|| invalid(format!("ibl report {key} must be a string")))
    };
    if !report
        .get("cacheHit")
        .is_some_and(|entry| entry.is_boolean())
    {
        return Err(invalid("ibl report cacheHit must be a boolean"));
    }
    validate_report_consistency(
        text("effectiveMode")?,
        text("requestedQuality")?,
        text("effectiveQuality")?,
        text("cacheBackend")?,
        text("brdfApproximation")?,
        requested_quality,
        effective_quality,
        prepared_present,
    )?;
    text("reason")?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn json_u32(value: &serde_json::Value, key: &str) -> Result<u32, WebError> {
    value
        .get(key)
        .and_then(|entry| entry.as_u64())
        .and_then(|entry| u32::try_from(entry).ok())
        .ok_or_else(|| invalid(format!("ibl {key} must be a nonnegative integer")))
}

#[cfg(not(target_arch = "wasm32"))]
fn json_f32(value: &serde_json::Value, key: &str) -> Result<f32, WebError> {
    value
        .get(key)
        .and_then(|entry| entry.as_f64())
        .map(|entry| entry as f32)
        .ok_or_else(|| invalid(format!("ibl {key} must be a number")))
}

#[cfg(not(target_arch = "wasm32"))]
fn json_quality(value: &serde_json::Value, key: &str) -> Result<IblQuality, WebError> {
    let text = value
        .get(key)
        .and_then(|entry| entry.as_str())
        .ok_or_else(|| invalid(format!("ibl {key} must be a string")))?;
    parse_ibl_quality(text)
        .ok_or_else(|| invalid(format!("ibl {key} has unknown quality '{text}'")))
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_prepared_json(value: &serde_json::Value) -> Result<ParsedIblPrepared, WebError> {
    if value.get("format").and_then(|format| format.as_str()) != Some("rgba16float") {
        return Err(invalid("ibl prepared format must be 'rgba16float'"));
    }
    let bytes = |key: &str| -> Result<Vec<u8>, WebError> {
        value
            .get(key)
            .and_then(|entry| entry.as_array())
            .ok_or_else(|| invalid(format!("ibl prepared {key} must be an array")))?
            .iter()
            .map(|entry| {
                entry
                    .as_u64()
                    .and_then(|byte| u8::try_from(byte).ok())
                    .ok_or_else(|| invalid(format!("ibl prepared {key} must contain bytes")))
            })
            .collect()
    };
    Ok(ParsedIblPrepared {
        irradiance_size: json_u32(value, "irradianceSize")?,
        specular_size: json_u32(value, "specularSize")?,
        specular_mip_count: json_u32(value, "specularMipCount")?,
        brdf_lut_size: json_u32(value, "brdfLutSize")?,
        irradiance: bytes("irradiance")?,
        specular: bytes("specular")?,
        brdf_lut: bytes("brdfLut")?,
    })
}

#[cfg(target_arch = "wasm32")]
fn js_property(value: &JsValue, key: &str) -> Result<JsValue, WebError> {
    if value.is_null() || value.is_undefined() {
        return Err(invalid(format!("ibl {key} requires an object")));
    }
    js_sys::Reflect::get(value, &JsValue::from_str(key))
        .map_err(|_| invalid(format!("ibl {key} is not readable")))
}

#[cfg(target_arch = "wasm32")]
fn js_u32(value: &JsValue, key: &str) -> Result<u32, WebError> {
    let number = value
        .as_f64()
        .ok_or_else(|| invalid(format!("ibl {key} must be a number")))?;
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 || number > f64::from(u32::MAX)
    {
        return Err(invalid(format!("ibl {key} must be a nonnegative integer")));
    }
    Ok(number as u32)
}

#[cfg(target_arch = "wasm32")]
fn js_f32(value: &JsValue, key: &str) -> Result<f32, WebError> {
    let number = value
        .as_f64()
        .ok_or_else(|| invalid(format!("ibl {key} must be a number")))?;
    if !number.is_finite() {
        return Err(invalid(format!("ibl {key} must be finite")));
    }
    Ok(number as f32)
}

#[cfg(target_arch = "wasm32")]
fn js_string(value: &JsValue, key: &str) -> Result<String, WebError> {
    value
        .as_string()
        .ok_or_else(|| invalid(format!("ibl {key} must be a string")))
}

#[cfg(target_arch = "wasm32")]
fn js_bytes(value: &JsValue, key: &str) -> Result<Vec<u8>, WebError> {
    value
        .dyn_ref::<js_sys::Uint8Array>()
        .map(|array| array.to_vec())
        .ok_or_else(|| invalid(format!("ibl {key} must be a Uint8Array")))
}

#[cfg(target_arch = "wasm32")]
fn js_f32_array(value: &JsValue, key: &str) -> Result<Vec<f32>, WebError> {
    value
        .dyn_ref::<js_sys::Float32Array>()
        .map(|array| array.to_vec())
        .ok_or_else(|| invalid(format!("ibl {key} must be a Float32Array")))
}

#[cfg(target_arch = "wasm32")]
fn parse_prepared_js(value: &JsValue) -> Result<ParsedIblPrepared, WebError> {
    if js_string(&js_property(value, "format")?, "ibl.prepared.format")? != "rgba16float" {
        return Err(invalid("ibl prepared format must be 'rgba16float'"));
    }
    Ok(ParsedIblPrepared {
        irradiance_size: js_u32(
            &js_property(value, "irradianceSize")?,
            "ibl.prepared.irradianceSize",
        )?,
        specular_size: js_u32(
            &js_property(value, "specularSize")?,
            "ibl.prepared.specularSize",
        )?,
        specular_mip_count: js_u32(
            &js_property(value, "specularMipCount")?,
            "ibl.prepared.specularMipCount",
        )?,
        brdf_lut_size: js_u32(
            &js_property(value, "brdfLutSize")?,
            "ibl.prepared.brdfLutSize",
        )?,
        irradiance: js_bytes(
            &js_property(value, "irradiance")?,
            "ibl.prepared.irradiance",
        )?,
        specular: js_bytes(&js_property(value, "specular")?, "ibl.prepared.specular")?,
        brdf_lut: js_bytes(&js_property(value, "brdfLut")?, "ibl.prepared.brdfLut")?,
    })
}

#[cfg(target_arch = "wasm32")]
pub(super) fn ibl_from_js(value: &JsValue) -> Result<Option<ParsedIbl>, WebError> {
    if value.is_undefined() || value.is_null() {
        return Ok(None);
    }
    if !value.is_object() {
        return Err(invalid("ibl snapshot must be an object or null"));
    }
    let source = js_property(value, "source")?;
    if source.is_null() || source.is_undefined() {
        return Err(invalid("ibl snapshot requires a source object"));
    }
    let width = js_u32(&js_property(&source, "width")?, "ibl.source.width")?;
    let height = js_u32(&js_property(&source, "height")?, "ibl.source.height")?;
    let data = js_f32_array(&js_property(&source, "data")?, "ibl.source.data")?;
    let source_hash = js_string(
        &js_property(&source, "sourceHash")?,
        "ibl.source.sourceHash",
    )?;
    let intensity = js_f32(&js_property(value, "intensity")?, "ibl.intensity")?;
    let rotation_degrees = js_f32(
        &js_property(value, "rotationDegrees")?,
        "ibl.rotationDegrees",
    )?;
    let requested_text = js_string(
        &js_property(value, "requestedQuality")?,
        "ibl.requestedQuality",
    )?;
    let requested_quality = parse_ibl_quality(&requested_text).ok_or_else(|| {
        invalid(format!(
            "ibl requestedQuality '{requested_text}' is unknown"
        ))
    })?;
    let effective_text = js_string(
        &js_property(value, "effectiveQuality")?,
        "ibl.effectiveQuality",
    )?;
    let effective_quality = parse_ibl_quality(&effective_text).ok_or_else(|| {
        invalid(format!(
            "ibl effectiveQuality '{effective_text}' is unknown"
        ))
    })?;
    let prepared_value = js_property(value, "prepared")?;
    let prepared = if prepared_value.is_undefined() || prepared_value.is_null() {
        None
    } else {
        Some(parse_prepared_js(&prepared_value)?)
    };
    let report_value = js_property(value, "report")?;
    if !report_value.is_object() {
        return Err(invalid("ibl report must be an object"));
    }
    let mode = js_string(
        &js_property(&report_value, "effectiveMode")?,
        "ibl.report.effectiveMode",
    )?;
    let report_requested = js_string(
        &js_property(&report_value, "requestedQuality")?,
        "ibl.report.requestedQuality",
    )?;
    let report_effective = js_string(
        &js_property(&report_value, "effectiveQuality")?,
        "ibl.report.effectiveQuality",
    )?;
    let backend = js_string(
        &js_property(&report_value, "cacheBackend")?,
        "ibl.report.cacheBackend",
    )?;
    let approximation = js_string(
        &js_property(&report_value, "brdfApproximation")?,
        "ibl.report.brdfApproximation",
    )?;
    if js_property(&report_value, "cacheHit")?.as_bool().is_none() {
        return Err(invalid("ibl report cacheHit must be a boolean"));
    }
    js_string(&js_property(&report_value, "reason")?, "ibl.report.reason")?;
    validate_report_consistency(
        &mode,
        &report_requested,
        &report_effective,
        &backend,
        &approximation,
        requested_quality,
        effective_quality,
        prepared.is_some(),
    )?;
    build_parsed_ibl(
        width,
        height,
        data,
        source_hash,
        intensity,
        rotation_degrees,
        requested_quality,
        effective_quality,
        prepared,
    )
    .map(Some)
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct IblUniform {
    pub enabled: u32,
    pub specular_mip_count: u32,
    pub _pad0: [u32; 2],
    pub intensity: f32,
    pub rotation_radians: f32,
    pub _pad1: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct IblPassUniform {
    src_width: u32,
    src_height: u32,
    face_size: u32,
    mip_level: u32,
    roughness: f32,
    sample_count: u32,
    lut_size: u32,
    pad0: u32,
}

pub(super) struct IblResources {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub bind_group: wgpu::BindGroup,
    pub(super) specular_view: wgpu::TextureView,
    pub(super) irradiance_view: wgpu::TextureView,
    pub(super) brdf_lut_view: wgpu::TextureView,
    pub(super) uniform_buffer: wgpu::Buffer,
    pub retained_texture_bytes: u64,
    _textures: Vec<wgpu::Texture>,
    pub(super) sampler: wgpu::Sampler,
    /// Mirrors the uniform's `enabled` lane; selects the shader IBL region.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) enabled: bool,
}

pub(super) fn ibl_layout_entries() -> [wgpu::BindGroupLayoutEntry; 5] {
    [
        wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::Cube,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::Cube,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 2,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 3,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 4,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: wgpu::BufferSize::new(IBL_UNIFORM_BYTES),
            },
            count: None,
        },
    ]
}

pub(super) fn create_ibl_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    let entries = ibl_layout_entries()
        .into_iter()
        .chain(super::shadows::shadow_layout_entries())
        .collect::<Vec<_>>();
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("forge3d-ibl-layout"),
        entries: &entries,
    })
}

fn create_ibl_sampler(device: &wgpu::Device) -> wgpu::Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("forge3d-ibl-sampler"),
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        address_mode_w: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..Default::default()
    })
}

fn ibl_uniform(
    enabled: u32,
    specular_mip_count: u32,
    intensity: f32,
    rotation_degrees: f32,
) -> IblUniform {
    IblUniform {
        enabled,
        specular_mip_count,
        _pad0: [0; 2],
        intensity: intensity.max(0.0),
        rotation_radians: rotation_degrees.to_radians(),
        _pad1: [0.0; 2],
    }
}

fn rgba16f_cube_texture(
    device: &wgpu::Device,
    label: &str,
    face_size: u32,
    mip_count: u32,
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: face_size,
            height: face_size,
            depth_or_array_layers: 6,
        },
        mip_level_count: mip_count,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage,
        view_formats: &[],
    })
}

fn write_padded_rgba16f(
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    mip_level: u32,
    face_size: u32,
    layers: u32,
    data: &[u8],
) {
    let row_bytes = (face_size * RGBA16F_TEXEL_BYTES as u32) as usize;
    let padded_row = aligned_row_bytes(row_bytes as u32) as usize;
    let extent = wgpu::Extent3d {
        width: face_size,
        height: face_size,
        depth_or_array_layers: layers,
    };
    let target = wgpu::TexelCopyTextureInfo {
        texture,
        mip_level,
        origin: wgpu::Origin3d::ZERO,
        aspect: wgpu::TextureAspect::All,
    };
    if padded_row == row_bytes {
        queue.write_texture(
            target,
            data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes as u32),
                rows_per_image: Some(face_size),
            },
            extent,
        );
        return;
    }
    let face_bytes = row_bytes * face_size as usize;
    let mut staging = vec![0u8; padded_row * face_size as usize * layers as usize];
    for layer in 0..layers as usize {
        for row in 0..face_size as usize {
            let source_offset = layer * face_bytes + row * row_bytes;
            let target_offset = layer * padded_row * face_size as usize + row * padded_row;
            staging[target_offset..target_offset + row_bytes]
                .copy_from_slice(&data[source_offset..source_offset + row_bytes]);
        }
    }
    queue.write_texture(
        target,
        &staging,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(padded_row as u32),
            rows_per_image: Some(face_size),
        },
        extent,
    );
}

fn assemble_ibl_resources(
    context: &GpuContext,
    layout: &wgpu::BindGroupLayout,
    specular: wgpu::Texture,
    irradiance: wgpu::Texture,
    brdf_lut: wgpu::Texture,
    retained_texture_bytes: u64,
    uniform: IblUniform,
    shadows: &super::shadows::ShadowResources,
) -> IblResources {
    let sampler = create_ibl_sampler(&context.device);
    let specular_view = specular.create_view(&wgpu::TextureViewDescriptor {
        label: Some("forge3d-ibl-specular-view"),
        dimension: Some(wgpu::TextureViewDimension::Cube),
        ..Default::default()
    });
    let irradiance_view = irradiance.create_view(&wgpu::TextureViewDescriptor {
        label: Some("forge3d-ibl-irradiance-view"),
        dimension: Some(wgpu::TextureViewDimension::Cube),
        ..Default::default()
    });
    let brdf_lut_view = brdf_lut.create_view(&wgpu::TextureViewDescriptor {
        label: Some("forge3d-ibl-brdf-lut-view"),
        ..Default::default()
    });
    let uniform_buffer = context
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-ibl-uniform"),
            contents: bytemuck::bytes_of(&uniform),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
    let bind_group = context
        .device
        .create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge3d-ibl-bind-group"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&specular_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&irradiance_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&brdf_lut_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(&shadows.depth_array_view),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::Sampler(&shadows.comparison_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&shadows.plain_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: wgpu::BindingResource::TextureView(&shadows.moment_view),
                },
                wgpu::BindGroupEntry {
                    binding: 9,
                    resource: shadows.uniform_buffer.as_entire_binding(),
                },
            ],
        });
    IblResources {
        bind_group_layout: layout.clone(),
        bind_group,
        specular_view,
        irradiance_view,
        brdf_lut_view,
        uniform_buffer,
        retained_texture_bytes,
        _textures: vec![specular, irradiance, brdf_lut],
        sampler,
        enabled: uniform.enabled != 0,
    }
}

impl IblResources {
    pub(super) fn disabled(
        context: &GpuContext,
        layout: &wgpu::BindGroupLayout,
        shadows: &super::shadows::ShadowResources,
    ) -> Self {
        let black = vec![0u8; 48];
        let specular = rgba16f_cube_texture(
            &context.device,
            "forge3d-ibl-specular-fallback",
            1,
            1,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        );
        let irradiance = rgba16f_cube_texture(
            &context.device,
            "forge3d-ibl-irradiance-fallback",
            1,
            1,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        );
        let brdf_lut = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-ibl-brdf-lut-fallback"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        write_padded_rgba16f(&context.queue, &specular, 0, 1, 6, &black);
        write_padded_rgba16f(&context.queue, &irradiance, 0, 1, 6, &black);
        write_padded_rgba16f(&context.queue, &brdf_lut, 0, 1, 1, &black[..8]);
        assemble_ibl_resources(
            context,
            layout,
            specular,
            irradiance,
            brdf_lut,
            IBL_FALLBACK_TEXTURE_BYTES,
            ibl_uniform(0, 1, 0.0, 0.0),
            shadows,
        )
    }
}

fn build_prepared_ibl(
    context: &GpuContext,
    layout: &wgpu::BindGroupLayout,
    parsed: &ParsedIbl,
    prepared: &ParsedIblPrepared,
    shadows: &super::shadows::ShadowResources,
) -> Result<IblResources, WebError> {
    let irradiance = rgba16f_cube_texture(
        &context.device,
        "forge3d-ibl-irradiance",
        prepared.irradiance_size,
        1,
        wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
    );
    write_padded_rgba16f(
        &context.queue,
        &irradiance,
        0,
        prepared.irradiance_size,
        6,
        &prepared.irradiance,
    );
    let specular = rgba16f_cube_texture(
        &context.device,
        "forge3d-ibl-specular",
        prepared.specular_size,
        prepared.specular_mip_count,
        wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
    );
    let mut offset = 0usize;
    for mip in 0..prepared.specular_mip_count {
        let size = mip_size(prepared.specular_size, mip);
        let mip_bytes = cube_level_bytes(size)
            .ok_or_else(|| resource_limit("ibl prepared specular size overflowed"))?
            as usize;
        write_padded_rgba16f(
            &context.queue,
            &specular,
            mip,
            size,
            6,
            &prepared.specular[offset..offset + mip_bytes],
        );
        offset += mip_bytes;
    }
    let brdf_lut = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-ibl-brdf-lut"),
        size: wgpu::Extent3d {
            width: prepared.brdf_lut_size,
            height: prepared.brdf_lut_size,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    write_padded_rgba16f(
        &context.queue,
        &brdf_lut,
        0,
        prepared.brdf_lut_size,
        1,
        &prepared.brdf_lut,
    );
    let retained =
        (prepared.irradiance.len() + prepared.specular.len() + prepared.brdf_lut.len()) as u64;
    Ok(assemble_ibl_resources(
        context,
        layout,
        specular,
        irradiance,
        brdf_lut,
        retained,
        ibl_uniform(
            1,
            prepared.specular_mip_count,
            parsed.intensity,
            parsed.rotation_degrees,
        ),
        shadows,
    ))
}

#[derive(Debug, Clone, Copy)]
pub(super) struct IblSelection {
    pub quality: IblQuality,
    pub spec: IblQualitySpec,
    pub transient_bytes: u64,
    pub reason: &'static str,
}

pub(super) fn select_ibl_quality(
    memory: &super::memory::MemoryLedger,
    overflow_policy: OverflowPolicy,
    max_texture_dimension_2d: u32,
    parsed: &ParsedIbl,
    with_readback: bool,
) -> Result<IblSelection, WebError> {
    let source =
        source_bytes(parsed).ok_or_else(|| resource_limit("ibl source size overflowed"))?;
    let candidates: Vec<IblQuality> = match overflow_policy {
        OverflowPolicy::Reject => vec![parsed.requested_quality],
        OverflowPolicy::Downscale => ibl_quality_ladder(parsed.requested_quality),
    };
    let mut dimension_limited = false;
    for quality in candidates {
        let spec = ibl_quality_spec(quality);
        let largest = spec
            .environment
            .max(spec.specular)
            .max(spec.irradiance)
            .max(spec.brdf_lut);
        if largest > max_texture_dimension_2d
            || parsed.source_width > max_texture_dimension_2d
            || parsed.source_height > max_texture_dimension_2d
        {
            dimension_limited = true;
            continue;
        }
        let transient = environment_bytes(&spec)
            .and_then(|environment| environment.checked_add(source))
            .and_then(|total| {
                if with_readback {
                    total.checked_add(readback_bytes(&spec)?)
                } else {
                    Some(total)
                }
            })
            .ok_or_else(|| resource_limit("ibl transient size overflowed"))?;
        let retained = ibl_prepared_lengths(&spec)
            .and_then(|(irradiance, specular, brdf)| {
                irradiance.checked_add(specular)?.checked_add(brdf)
            })
            .and_then(|textures| textures.checked_add(IBL_UNIFORM_BYTES))
            .ok_or_else(|| resource_limit("ibl retained size overflowed"))?;
        let total = transient
            .checked_add(retained)
            .ok_or_else(|| resource_limit("ibl size overflowed"))?;
        if memory.fits_after_release(
            &[
                IBL_TEXTURES_LEDGER_KEY,
                IBL_UNIFORM_LEDGER_KEY,
                IBL_TRANSIENT_LEDGER_KEY,
            ],
            total,
        ) {
            return Ok(IblSelection {
                quality,
                spec,
                transient_bytes: transient,
                reason: if quality == parsed.requested_quality {
                    "requested quality"
                } else {
                    "memory budget"
                },
            });
        }
    }
    if dimension_limited {
        return Err(resource_limit(
            "ibl quality exceeds maxTextureDimension2D at every ladder step",
        ));
    }
    Err(resource_limit(format!(
        "ibl quality {} does not fit the memory budget",
        ibl_quality_name(parsed.requested_quality)
    )))
}

struct IblReadbackRegion {
    offset: u64,
    row_bytes: usize,
    padded_row_bytes: usize,
    rows: usize,
    layers: usize,
}

struct IblReadbackJob {
    buffer: wgpu::Buffer,
    regions: Vec<IblReadbackRegion>,
}

struct IblComputeOutput {
    irradiance: wgpu::Texture,
    specular: wgpu::Texture,
    brdf_lut: wgpu::Texture,
    jobs: Vec<IblReadbackJob>,
}

fn create_pass_uniform(
    device: &wgpu::Device,
    label: &str,
    uniform: IblPassUniform,
) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: bytemuck::bytes_of(&uniform),
        usage: wgpu::BufferUsages::UNIFORM,
    })
}

fn run_ibl_compute(
    context: &GpuContext,
    parsed: &ParsedIbl,
    spec: &IblQualitySpec,
    readback: bool,
) -> Result<IblComputeOutput, WebError> {
    let device = &context.device;
    let queue = &context.queue;
    let source_texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-ibl-source"),
        size: wgpu::Extent3d {
            width: parsed.source_width,
            height: parsed.source_height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    {
        let row_bytes = (parsed.source_width * RGBA32F_TEXEL_BYTES as u32) as usize;
        let padded_row = aligned_row_bytes(row_bytes as u32) as usize;
        let raw: &[u8] = bytemuck::cast_slice(&parsed.source_data);
        let extent = wgpu::Extent3d {
            width: parsed.source_width,
            height: parsed.source_height,
            depth_or_array_layers: 1,
        };
        let target = wgpu::TexelCopyTextureInfo {
            texture: &source_texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        };
        if padded_row == row_bytes {
            queue.write_texture(
                target,
                raw,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes as u32),
                    rows_per_image: Some(parsed.source_height),
                },
                extent,
            );
        } else {
            let mut staging = vec![0u8; padded_row * parsed.source_height as usize];
            for row in 0..parsed.source_height as usize {
                staging[row * padded_row..row * padded_row + row_bytes]
                    .copy_from_slice(&raw[row * row_bytes..row * row_bytes + row_bytes]);
            }
            queue.write_texture(
                target,
                &staging,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row as u32),
                    rows_per_image: Some(parsed.source_height),
                },
                extent,
            );
        }
    }

    let environment = rgba16f_cube_texture(
        device,
        "forge3d-ibl-environment",
        spec.environment,
        1,
        wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
    );
    let irradiance = rgba16f_cube_texture(
        device,
        "forge3d-ibl-irradiance",
        spec.irradiance,
        1,
        wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
    );
    let specular = rgba16f_cube_texture(
        device,
        "forge3d-ibl-specular",
        spec.specular,
        spec.specular_mips,
        wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
    );
    let brdf_lut = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-ibl-brdf-lut"),
        size: wgpu::Extent3d {
            width: spec.brdf_lut,
            height: spec.brdf_lut,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("forge3d-ibl-compute"),
        source: wgpu::ShaderSource::Wgsl(IBL_COMPUTE_SHADER.into()),
    });
    let sampler = create_ibl_sampler(device);

    let storage_array_binding = |binding: u32| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::StorageTexture {
            access: wgpu::StorageTextureAccess::WriteOnly,
            format: wgpu::TextureFormat::Rgba16Float,
            view_dimension: wgpu::TextureViewDimension::D2Array,
        },
        count: None,
    };
    let uniform_binding = |binding: u32| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<IblPassUniform>() as u64),
        },
        count: None,
    };

    let equirect_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("forge3d-ibl-equirect-layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            storage_array_binding(2),
            uniform_binding(3),
        ],
    });
    let convolve_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("forge3d-ibl-convolve-layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::Cube,
                    multisampled: false,
                },
                count: None,
            },
            storage_array_binding(2),
            uniform_binding(3),
            wgpu::BindGroupLayoutEntry {
                binding: 4,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    });
    let lut_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("forge3d-ibl-lut-layout"),
        entries: &[
            uniform_binding(3),
            wgpu::BindGroupLayoutEntry {
                binding: 5,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba16Float,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                count: None,
            },
        ],
    });

    let pipeline_layout = |layouts: &[&wgpu::BindGroupLayout], label: &str| {
        let owned: Vec<Option<&wgpu::BindGroupLayout>> =
            layouts.iter().map(|entry| Some(*entry)).collect();
        device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(label),
            bind_group_layouts: &owned,
            immediate_size: 0,
        })
    };
    let compute_pipeline = |layout: &wgpu::PipelineLayout, entry: &str, label: &str| {
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(label),
            layout: Some(layout),
            module: &module,
            entry_point: Some(entry),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        })
    };

    let equirect_pipeline_layout = pipeline_layout(&[&equirect_layout], "forge3d-ibl-equirect-pl");
    let equirect_pipeline = compute_pipeline(
        &equirect_pipeline_layout,
        "equirect_to_cube",
        "forge3d-ibl-equirect",
    );
    let convolve_pipeline_layout = pipeline_layout(&[&convolve_layout], "forge3d-ibl-convolve-pl");
    let irradiance_pipeline = compute_pipeline(
        &convolve_pipeline_layout,
        "irradiance_convolve",
        "forge3d-ibl-irradiance-compute",
    );
    let specular_pipeline = compute_pipeline(
        &convolve_pipeline_layout,
        "specular_prefilter",
        "forge3d-ibl-specular-compute",
    );
    let lut_pipeline_layout = pipeline_layout(&[&lut_layout], "forge3d-ibl-lut-pl");
    let lut_pipeline = compute_pipeline(&lut_pipeline_layout, "brdf_integrate", "forge3d-ibl-lut");

    let source_view = source_texture.create_view(&wgpu::TextureViewDescriptor::default());
    let environment_storage_view = environment.create_view(&wgpu::TextureViewDescriptor {
        label: Some("forge3d-ibl-env-storage"),
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    });
    let environment_cube_view = environment.create_view(&wgpu::TextureViewDescriptor {
        label: Some("forge3d-ibl-env-cube"),
        dimension: Some(wgpu::TextureViewDimension::Cube),
        ..Default::default()
    });
    let irradiance_storage_view = irradiance.create_view(&wgpu::TextureViewDescriptor {
        label: Some("forge3d-ibl-irradiance-storage"),
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    });
    let lut_storage_view = brdf_lut.create_view(&wgpu::TextureViewDescriptor::default());

    let pass_uniform = |src_w, src_h, face_size, mip_level, roughness, lut_size| {
        create_pass_uniform(
            device,
            "forge3d-ibl-pass-uniform",
            IblPassUniform {
                src_width: src_w,
                src_height: src_h,
                face_size,
                mip_level,
                roughness,
                sample_count: spec.samples,
                lut_size,
                pad0: 0,
            },
        )
    };

    let dispatch_groups = |size: u32| size.div_ceil(WORKGROUP_SIZE);

    let equirect_uniform = pass_uniform(
        parsed.source_width,
        parsed.source_height,
        spec.environment,
        0,
        0.0,
        0,
    );
    let equirect_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("forge3d-ibl-equirect-bg"),
        layout: &equirect_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&source_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::TextureView(&environment_storage_view),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: equirect_uniform.as_entire_binding(),
            },
        ],
    });
    let irradiance_uniform = pass_uniform(0, 0, spec.irradiance, 0, 0.0, 0);
    let irradiance_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("forge3d-ibl-irradiance-bg"),
        layout: &convolve_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&environment_cube_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::TextureView(&irradiance_storage_view),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: irradiance_uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
        ],
    });
    let mut specular_uniforms = Vec::with_capacity(spec.specular_mips as usize);
    let mut specular_bind_groups = Vec::with_capacity(spec.specular_mips as usize);
    let mut specular_mip_views = Vec::with_capacity(spec.specular_mips as usize);
    for mip in 0..spec.specular_mips {
        let size = mip_size(spec.specular, mip);
        let roughness = if spec.specular_mips > 1 {
            mip as f32 / (spec.specular_mips - 1) as f32
        } else {
            0.0
        };
        specular_mip_views.push(specular.create_view(&wgpu::TextureViewDescriptor {
            label: Some("forge3d-ibl-specular-mip"),
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            base_mip_level: mip,
            mip_level_count: Some(1),
            ..Default::default()
        }));
        specular_uniforms.push(pass_uniform(0, 0, size, mip, roughness, 0));
    }
    for mip in 0..spec.specular_mips {
        specular_bind_groups.push(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge3d-ibl-specular-bg"),
            layout: &convolve_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&environment_cube_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&specular_mip_views[mip as usize]),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: specular_uniforms[mip as usize].as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        }));
    }
    let lut_uniform = pass_uniform(0, 0, 0, 0, 0.0, spec.brdf_lut);
    let lut_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("forge3d-ibl-lut-bg"),
        layout: &lut_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 3,
                resource: lut_uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: wgpu::BindingResource::TextureView(&lut_storage_view),
            },
        ],
    });

    let mut jobs: Vec<IblReadbackJob> = Vec::new();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("forge3d-ibl-compute-encoder"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("forge3d-ibl-compute"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&equirect_pipeline);
        pass.set_bind_group(0, &equirect_bind_group, &[]);
        let groups = dispatch_groups(spec.environment);
        pass.dispatch_workgroups(groups, groups, 6);
        pass.set_pipeline(&irradiance_pipeline);
        pass.set_bind_group(0, &irradiance_bind_group, &[]);
        let groups = dispatch_groups(spec.irradiance);
        pass.dispatch_workgroups(groups, groups, 6);
        pass.set_pipeline(&specular_pipeline);
        for (mip, bind_group) in specular_bind_groups.iter().enumerate() {
            let size = mip_size(spec.specular, mip as u32);
            let groups = dispatch_groups(size);
            pass.set_bind_group(0, bind_group, &[]);
            pass.dispatch_workgroups(groups, groups, 6);
        }
        pass.set_pipeline(&lut_pipeline);
        pass.set_bind_group(0, &lut_bind_group, &[]);
        let groups = dispatch_groups(spec.brdf_lut);
        pass.dispatch_workgroups(groups, groups, 1);
    }

    if readback {
        let copy_cube_mip = |encoder: &mut wgpu::CommandEncoder,
                             jobs: &mut Vec<IblReadbackJob>,
                             texture: &wgpu::Texture,
                             mip: u32,
                             face_size: u32,
                             label: &str| {
            let row_bytes = face_size * RGBA16F_TEXEL_BYTES as u32;
            let padded_row = aligned_row_bytes(row_bytes);
            let buffer_size = u64::from(padded_row) * u64::from(face_size) * 6;
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: buffer_size,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture,
                    mip_level: mip,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(padded_row),
                        rows_per_image: Some(face_size),
                    },
                },
                wgpu::Extent3d {
                    width: face_size,
                    height: face_size,
                    depth_or_array_layers: 6,
                },
            );
            jobs.push(IblReadbackJob {
                buffer,
                regions: vec![IblReadbackRegion {
                    offset: 0,
                    row_bytes: row_bytes as usize,
                    padded_row_bytes: padded_row as usize,
                    rows: face_size as usize,
                    layers: 6,
                }],
            });
        };
        copy_cube_mip(
            &mut encoder,
            &mut jobs,
            &irradiance,
            0,
            spec.irradiance,
            "forge3d-ibl-irradiance-readback",
        );
        let mut specular_offset = 0u64;
        let mut specular_regions = Vec::with_capacity(spec.specular_mips as usize);
        let mut specular_total = 0u64;
        for mip in 0..spec.specular_mips {
            let size = mip_size(spec.specular, mip);
            let row_bytes = size * RGBA16F_TEXEL_BYTES as u32;
            let padded_row = aligned_row_bytes(row_bytes);
            specular_regions.push(IblReadbackRegion {
                offset: specular_offset,
                row_bytes: row_bytes as usize,
                padded_row_bytes: padded_row as usize,
                rows: size as usize,
                layers: 6,
            });
            specular_offset += u64::from(padded_row) * u64::from(size) * 6;
            specular_total = specular_offset;
        }
        let specular_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-ibl-specular-readback"),
            size: specular_total,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        for (mip, region) in specular_regions.iter().enumerate() {
            let size = mip_size(spec.specular, mip as u32);
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: &specular,
                    mip_level: mip as u32,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &specular_buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: region.offset,
                        bytes_per_row: Some(region.padded_row_bytes as u32),
                        rows_per_image: Some(size),
                    },
                },
                wgpu::Extent3d {
                    width: size,
                    height: size,
                    depth_or_array_layers: 6,
                },
            );
        }
        jobs.push(IblReadbackJob {
            buffer: specular_buffer,
            regions: specular_regions,
        });
        let lut_row = spec.brdf_lut * RGBA16F_TEXEL_BYTES as u32;
        let lut_padded = aligned_row_bytes(lut_row);
        let lut_size = u64::from(lut_padded) * u64::from(spec.brdf_lut);
        let lut_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-ibl-lut-readback"),
            size: lut_size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &brdf_lut,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &lut_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(lut_padded),
                    rows_per_image: Some(spec.brdf_lut),
                },
            },
            wgpu::Extent3d {
                width: spec.brdf_lut,
                height: spec.brdf_lut,
                depth_or_array_layers: 1,
            },
        );
        jobs.push(IblReadbackJob {
            buffer: lut_buffer,
            regions: vec![IblReadbackRegion {
                offset: 0,
                row_bytes: lut_row as usize,
                padded_row_bytes: lut_padded as usize,
                rows: spec.brdf_lut as usize,
                layers: 1,
            }],
        });
    }
    queue.submit(std::iter::once(encoder.finish()));

    Ok(IblComputeOutput {
        irradiance,
        specular,
        brdf_lut,
        jobs,
    })
}

fn strip_readback(mapped: &[u8], job: &IblReadbackJob) -> Vec<u8> {
    let mut out = Vec::new();
    for region in &job.regions {
        let tight = region.row_bytes * region.rows * region.layers;
        out.reserve(tight);
        for layer in 0..region.layers {
            for row in 0..region.rows {
                let start = region.offset as usize
                    + layer * region.padded_row_bytes * region.rows
                    + row * region.padded_row_bytes;
                out.extend_from_slice(&mapped[start..start + region.row_bytes]);
            }
        }
    }
    out
}

pub(super) fn build_ibl_resources(
    context: &GpuContext,
    layout: &wgpu::BindGroupLayout,
    parsed: Option<&ParsedIbl>,
    selection: Option<&IblSelection>,
    shadows: &super::shadows::ShadowResources,
) -> Result<IblResources, WebError> {
    match parsed {
        None => Ok(IblResources::disabled(context, layout, shadows)),
        Some(ibl) => match &ibl.prepared {
            Some(prepared) => build_prepared_ibl(context, layout, ibl, prepared, shadows),
            None => {
                let selection = selection.ok_or_else(|| {
                    WebError::new(
                        Forge3DErrorCode::InternalError,
                        "ibl compute requires a quality selection",
                    )
                })?;
                let output = run_ibl_compute(context, ibl, &selection.spec, false)?;
                let retained = ibl_prepared_lengths(&selection.spec)
                    .and_then(|(irr, spec, lut)| irr.checked_add(spec)?.checked_add(lut))
                    .ok_or_else(|| resource_limit("ibl retained size overflowed"))?;
                Ok(assemble_ibl_resources(
                    context,
                    layout,
                    output.specular,
                    output.irradiance,
                    output.brdf_lut,
                    retained,
                    ibl_uniform(
                        1,
                        selection.spec.specular_mips,
                        ibl.intensity,
                        ibl.rotation_degrees,
                    ),
                    shadows,
                ))
            }
        },
    }
}

pub(super) fn commit_ibl(runtime: &mut Forge3DRuntime, resources: IblResources) {
    runtime.ibl = Some(resources);
}

pub(super) fn admit_ibl_retained(
    memory: &mut super::memory::MemoryLedger,
    resources: &IblResources,
) -> Result<(), WebError> {
    let total = resources
        .retained_texture_bytes
        .checked_add(IBL_UNIFORM_BYTES)
        .ok_or_else(|| resource_limit("ibl memory accounting overflowed"))?;
    if !memory.fits_after_release(&[IBL_TEXTURES_LEDGER_KEY, IBL_UNIFORM_LEDGER_KEY], total) {
        return Err(resource_limit(format!(
            "ibl retained {total} bytes exceed the memory budget"
        )));
    }
    memory.replace(
        IBL_TEXTURES_LEDGER_KEY,
        MemoryCategory::Textures,
        resources.retained_texture_bytes,
    )?;
    memory.replace(
        IBL_UNIFORM_LEDGER_KEY,
        MemoryCategory::Buffers,
        IBL_UNIFORM_BYTES,
    )?;
    Ok(())
}

#[cfg(target_arch = "wasm32")]
pub(super) fn apply_parsed_ibl(
    runtime: &mut Forge3DRuntime,
    parsed: Option<&ParsedIbl>,
) -> Result<(), WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let layout = runtime
        .ibl
        .as_ref()
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime IBL resources are not available",
            )
        })?
        .bind_group_layout
        .clone();
    let shadows = runtime.shadows.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime shadow resources are not available",
        )
    })?;
    let mut planned = runtime.memory.clone();
    let selection = match parsed {
        Some(ibl) if ibl.prepared.is_none() => Some(select_ibl_quality(
            &planned,
            runtime.overflow_policy,
            runtime.max_texture_dimension_2d,
            ibl,
            false,
        )?),
        _ => None,
    };
    if let Some(selection) = &selection {
        planned.replace(
            IBL_TRANSIENT_LEDGER_KEY,
            MemoryCategory::Textures,
            selection.transient_bytes,
        )?;
    }
    let resources = build_ibl_resources(&context, &layout, parsed, selection.as_ref(), shadows)?;
    planned.release(IBL_TRANSIENT_LEDGER_KEY);
    admit_ibl_retained(&mut planned, &resources)?;
    runtime.memory = planned;
    commit_ibl(runtime, resources);
    if let (Some(scene), Some(textures), Some(ibl)) = (
        runtime.scene.as_mut(),
        runtime.textures.as_ref(),
        runtime.ibl.as_ref(),
    ) {
        scene.encode_bundles(&context, textures, ibl);
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
pub(super) fn set_ibl_runtime(
    runtime: &mut Forge3DRuntime,
    input: JsValue,
) -> Result<(), WebError> {
    let parsed = ibl_from_js(&input)?;
    apply_parsed_ibl(runtime, parsed.as_ref())
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn set_ibl_runtime(
    runtime: &mut Forge3DRuntime,
    input: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let _ = (runtime, input);
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "IBL updates are only available in wasm32 browser builds",
    ))
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn apply_parsed_ibl(
    runtime: &mut Forge3DRuntime,
    parsed: Option<&ParsedIbl>,
) -> Result<(), WebError> {
    let _ = (runtime, parsed);
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "IBL updates are only available in wasm32 browser builds",
    ))
}

#[cfg(target_arch = "wasm32")]
fn ibl_snapshot_to_js(
    parsed: &ParsedIbl,
    effective: IblQuality,
    prepared: Option<ParsedIblPrepared>,
    reason: &str,
) -> Result<JsValue, WebError> {
    let source = js_sys::Object::new();
    super::set_js_property(
        &source,
        "width",
        &JsValue::from_f64(f64::from(parsed.source_width)),
    );
    super::set_js_property(
        &source,
        "height",
        &JsValue::from_f64(f64::from(parsed.source_height)),
    );
    super::set_js_property(
        &source,
        "data",
        js_sys::Float32Array::from(parsed.source_data.as_slice()).as_ref(),
    );
    super::set_js_property(
        &source,
        "sourceHash",
        &JsValue::from_str(&parsed.source_hash),
    );

    let report = js_sys::Object::new();
    super::set_js_property(
        &report,
        "requestedQuality",
        &JsValue::from_str(ibl_quality_name(parsed.requested_quality)),
    );
    super::set_js_property(
        &report,
        "effectiveQuality",
        &JsValue::from_str(ibl_quality_name(effective)),
    );
    super::set_js_property(&report, "cacheBackend", &JsValue::from_str("none"));
    super::set_js_property(&report, "cacheHit", &JsValue::from_bool(false));
    super::set_js_property(
        &report,
        "effectiveMode",
        &JsValue::from_str(if prepared.is_some() {
            "prepared-upload"
        } else {
            "runtime-precompute"
        }),
    );
    super::set_js_property(
        &report,
        "brdfApproximation",
        &JsValue::from_str("split-sum-ggx"),
    );
    super::set_js_property(&report, "reason", &JsValue::from_str(reason));

    let snapshot = js_sys::Object::new();
    super::set_js_property(&snapshot, "source", &source);
    super::set_js_property(
        &snapshot,
        "intensity",
        &JsValue::from_f64(f64::from(parsed.intensity)),
    );
    super::set_js_property(
        &snapshot,
        "rotationDegrees",
        &JsValue::from_f64(f64::from(parsed.rotation_degrees)),
    );
    super::set_js_property(
        &snapshot,
        "requestedQuality",
        &JsValue::from_str(ibl_quality_name(parsed.requested_quality)),
    );
    super::set_js_property(
        &snapshot,
        "effectiveQuality",
        &JsValue::from_str(ibl_quality_name(effective)),
    );
    match prepared {
        Some(prepared) => {
            let spec = ibl_quality_spec(effective);
            let prepared_obj = js_sys::Object::new();
            super::set_js_property(&prepared_obj, "format", &JsValue::from_str("rgba16float"));
            super::set_js_property(
                &prepared_obj,
                "irradianceSize",
                &JsValue::from_f64(f64::from(spec.irradiance)),
            );
            super::set_js_property(
                &prepared_obj,
                "specularSize",
                &JsValue::from_f64(f64::from(spec.specular)),
            );
            super::set_js_property(
                &prepared_obj,
                "specularMipCount",
                &JsValue::from_f64(f64::from(spec.specular_mips)),
            );
            super::set_js_property(
                &prepared_obj,
                "brdfLutSize",
                &JsValue::from_f64(f64::from(spec.brdf_lut)),
            );
            super::set_js_property(
                &prepared_obj,
                "irradiance",
                js_sys::Uint8Array::from(prepared.irradiance.as_slice()).as_ref(),
            );
            super::set_js_property(
                &prepared_obj,
                "specular",
                js_sys::Uint8Array::from(prepared.specular.as_slice()).as_ref(),
            );
            super::set_js_property(
                &prepared_obj,
                "brdfLut",
                js_sys::Uint8Array::from(prepared.brdf_lut.as_slice()).as_ref(),
            );
            super::set_js_property(&snapshot, "prepared", &prepared_obj);
        }
        None => {}
    }
    super::set_js_property(&snapshot, "report", &report);
    Ok(snapshot.into())
}

#[cfg(target_arch = "wasm32")]
pub(super) async fn precompute_ibl_runtime(
    runtime: &mut Forge3DRuntime,
    input: JsValue,
) -> Result<JsValue, WebError> {
    let parsed =
        ibl_from_js(&input)?.ok_or_else(|| invalid("precomputeIbl requires an IBL snapshot"))?;
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let layout = runtime
        .ibl
        .as_ref()
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime IBL resources are not available",
            )
        })?
        .bind_group_layout
        .clone();
    let selection = select_ibl_quality(
        &runtime.memory,
        runtime.overflow_policy,
        runtime.max_texture_dimension_2d,
        &parsed,
        true,
    )?;
    runtime.memory.replace(
        IBL_TRANSIENT_LEDGER_KEY,
        MemoryCategory::Textures,
        selection.transient_bytes,
    )?;
    let computed = run_ibl_compute(&context, &parsed, &selection.spec, true);
    let computed = match computed {
        Ok(output) => output,
        Err(error) => {
            runtime.memory.release(IBL_TRANSIENT_LEDGER_KEY);
            return Err(error);
        }
    };
    let mut payloads = Vec::with_capacity(computed.jobs.len());
    for job in &computed.jobs {
        let size = job
            .regions
            .iter()
            .map(|region| {
                region.offset + (region.padded_row_bytes * region.rows * region.layers) as u64
            })
            .max()
            .unwrap_or(0);
        match super::readback::map_readback_buffer(&context, &job.buffer, size).await {
            Ok(mapped) => payloads.push(strip_readback(&mapped, job)),
            Err(error) => {
                runtime.memory.release(IBL_TRANSIENT_LEDGER_KEY);
                return Err(error);
            }
        }
    }
    runtime.memory.release(IBL_TRANSIENT_LEDGER_KEY);
    context.health.check().map_err(map_core_error)?;
    let mut payloads = payloads.into_iter();
    let prepared = ParsedIblPrepared {
        irradiance_size: selection.spec.irradiance,
        specular_size: selection.spec.specular,
        specular_mip_count: selection.spec.specular_mips,
        brdf_lut_size: selection.spec.brdf_lut,
        irradiance: payloads.next().unwrap_or_default(),
        specular: payloads.next().unwrap_or_default(),
        brdf_lut: payloads.next().unwrap_or_default(),
    };
    let retained = ibl_prepared_lengths(&selection.spec)
        .and_then(|(irr, spec, lut)| irr.checked_add(spec)?.checked_add(lut))
        .ok_or_else(|| resource_limit("ibl retained size overflowed"))?;
    let resources = assemble_ibl_resources(
        &context,
        &layout,
        computed.specular,
        computed.irradiance,
        computed.brdf_lut,
        retained,
        ibl_uniform(
            1,
            selection.spec.specular_mips,
            parsed.intensity,
            parsed.rotation_degrees,
        ),
        runtime.shadows.as_ref().ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime shadow resources are not available",
            )
        })?,
    );
    admit_ibl_retained(&mut runtime.memory, &resources)?;
    commit_ibl(runtime, resources);
    if let (Some(scene), Some(textures), Some(ibl)) = (
        runtime.scene.as_mut(),
        runtime.textures.as_ref(),
        runtime.ibl.as_ref(),
    ) {
        scene.encode_bundles(&context, textures, ibl);
    }
    let mut parsed = parsed;
    parsed.effective_quality = selection.quality;
    parsed.prepared = Some(prepared.clone());
    ibl_snapshot_to_js(&parsed, selection.quality, Some(prepared), selection.reason)
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::manual_async_fn)]
pub(super) async fn precompute_ibl_runtime(
    runtime: &mut Forge3DRuntime,
    input: wasm_bindgen::JsValue,
) -> Result<wasm_bindgen::JsValue, WebError> {
    let _ = (runtime, input);
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "IBL precomputation is only available in wasm32 browser builds",
    ))
}
