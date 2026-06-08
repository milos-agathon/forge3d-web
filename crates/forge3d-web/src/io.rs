use forge3d_core::io::source::{bytes_to_f32_le, ByteRange};
use wasm_bindgen::{prelude::*, JsCast};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Blob, Request, RequestInit, RequestMode, Response};

use crate::error::{Forge3DErrorCode, WebError};
use crate::inputs::{TerrainColorRampOptions, TerrainHeightmapOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserByteSourceKind {
    Url,
    Blob,
    File,
    ArrayBuffer,
}

pub async fn load_terrain_heightmap_source(
    input: JsValue,
) -> Result<TerrainHeightmapOptions, WebError> {
    if input.is_undefined() || input.is_null() {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "terrain source input must be an object",
        ));
    }

    let width = read_u32_property(&input, "width")?;
    let height = read_u32_property(&input, "height")?;
    let expected_count = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::InvalidInput,
                "terrain source width * height overflowed",
            )
        })?;
    let source = read_required_property(&input, "source")?;
    let range = read_optional_byte_range(&input)?;
    let color_ramp = TerrainColorRampOptions::from_js_value(
        read_optional_property(&input, "colorRamp")?.unwrap_or(JsValue::UNDEFINED),
    )?;
    let signal = read_optional_property(&input, "signal")?.unwrap_or(JsValue::UNDEFINED);
    let on_progress = read_optional_property(&input, "onProgress")?
        .and_then(|value| value.dyn_into::<js_sys::Function>().ok());

    ensure_not_cancelled(&signal)?;
    report_progress(&on_progress, 0, None, false)?;
    let bytes = read_browser_source_bytes(&source, range, &signal, &on_progress).await?;
    ensure_not_cancelled(&signal)?;
    let heights = bytes_to_f32_le(&bytes, Some(expected_count)).map_err(|error| {
        WebError::new(
            Forge3DErrorCode::IoError,
            format!("Terrain source body could not be decoded: {error}"),
        )
    })?;

    Ok(TerrainHeightmapOptions {
        width,
        height,
        heights,
        color_ramp,
    })
}

pub async fn read_browser_source_bytes(
    source: &JsValue,
    range: Option<ByteRange>,
    signal: &JsValue,
    on_progress: &Option<js_sys::Function>,
) -> Result<Vec<u8>, WebError> {
    ensure_not_cancelled(signal)?;

    if source.is_instance_of::<js_sys::ArrayBuffer>() {
        let buffer = source
            .clone()
            .dyn_into::<js_sys::ArrayBuffer>()
            .map_err(|_| {
                WebError::new(
                    Forge3DErrorCode::InvalidInput,
                    "ArrayBuffer source could not be read",
                )
            })?;
        return read_array_buffer(buffer, range, on_progress);
    }

    if source.is_instance_of::<web_sys::File>() {
        let file = source.clone().dyn_into::<Blob>().map_err(|_| {
            WebError::new(Forge3DErrorCode::InvalidInput, "File source is not a Blob")
        })?;
        return read_blob(
            file,
            range,
            signal,
            on_progress,
            BrowserByteSourceKind::File,
        )
        .await;
    }

    if source.is_instance_of::<Blob>() {
        let blob = source.clone().dyn_into::<Blob>().map_err(|_| {
            WebError::new(
                Forge3DErrorCode::InvalidInput,
                "Blob source could not be read",
            )
        })?;
        return read_blob(
            blob,
            range,
            signal,
            on_progress,
            BrowserByteSourceKind::Blob,
        )
        .await;
    }

    if let Some(url) = source.as_string().or_else(|| object_href(source)) {
        return read_url(url, range, signal, on_progress).await;
    }

    Err(WebError::new(
        Forge3DErrorCode::InvalidInput,
        "terrain source must be a URL string, URL object, File, Blob, or ArrayBuffer",
    ))
}

pub fn unsupported_source_for_phase6(kind: BrowserByteSourceKind) -> WebError {
    WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        format!("{kind:?} byte sources are scheduled for Phase 12"),
    )
}

fn read_array_buffer(
    buffer: js_sys::ArrayBuffer,
    range: Option<ByteRange>,
    on_progress: &Option<js_sys::Function>,
) -> Result<Vec<u8>, WebError> {
    let total = buffer.byte_length() as u64;
    let (offset, length) = range_bounds(range, total)?;
    let offset = u32::try_from(offset).map_err(|_| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            "ArrayBuffer byteOffset exceeds the browser typed-array range",
        )
    })?;
    let length = u32::try_from(length).map_err(|_| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            "ArrayBuffer byteLength exceeds the browser typed-array range",
        )
    })?;
    let view = js_sys::Uint8Array::new_with_byte_offset_and_length(&buffer, offset, length);
    let bytes = view.to_vec();
    report_progress(on_progress, bytes.len() as u64, Some(total), true)?;
    Ok(bytes)
}

async fn read_blob(
    blob: Blob,
    range: Option<ByteRange>,
    signal: &JsValue,
    on_progress: &Option<js_sys::Function>,
    _kind: BrowserByteSourceKind,
) -> Result<Vec<u8>, WebError> {
    ensure_not_cancelled(signal)?;
    let total = blob.size() as u64;
    let (offset, length) = range_bounds(range, total)?;
    let target = if range.is_some() {
        let start = offset as f64;
        let end = (offset + length) as f64;
        blob.slice_with_f64_and_f64(start, end).map_err(|error| {
            WebError::with_details(Forge3DErrorCode::IoError, "Blob slice failed", error)
        })?
    } else {
        blob
    };

    let promise = target.array_buffer();
    let buffer = await_browser_io(promise, signal, "Blob read failed").await?;
    let buffer = buffer.dyn_into::<js_sys::ArrayBuffer>().map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Blob did not resolve to an ArrayBuffer",
            error,
        )
    })?;
    let bytes = js_sys::Uint8Array::new(&buffer).to_vec();
    report_progress(on_progress, bytes.len() as u64, Some(total), true)?;
    Ok(bytes)
}

async fn read_url(
    url: String,
    range: Option<ByteRange>,
    signal: &JsValue,
    on_progress: &Option<js_sys::Function>,
) -> Result<Vec<u8>, WebError> {
    ensure_not_cancelled(signal)?;
    let window = web_sys::window()
        .ok_or_else(|| WebError::new(Forge3DErrorCode::IoError, "Window is not available"))?;
    let init = RequestInit::new();
    init.set_method("GET");
    init.set_mode(RequestMode::Cors);
    if !signal.is_undefined() && !signal.is_null() {
        set_property(init.as_ref(), "signal", signal)?;
    }
    if let Some(range) = range {
        let header = range_header(range)?;
        let headers = js_sys::Object::new();
        set_property(headers.as_ref(), "Range", &JsValue::from_str(&header))?;
        set_property(init.as_ref(), "headers", headers.as_ref())?;
    }

    let request = Request::new_with_str_and_init(&url, &init).map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            format!("Failed to create fetch request for {url}"),
            error,
        )
    })?;
    let response = await_browser_io(
        window.fetch_with_request(&request),
        signal,
        "Fetch request failed",
    )
    .await?;
    let response = response.dyn_into::<Response>().map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Fetch did not resolve to a Response",
            error,
        )
    })?;

    if !response.ok() {
        return Err(WebError::new(
            Forge3DErrorCode::IoError,
            format!("Fetch failed with HTTP status {}", response.status()),
        ));
    }

    let total = response
        .headers()
        .get("content-length")
        .ok()
        .flatten()
        .and_then(|value| value.parse::<u64>().ok());
    let buffer = await_browser_io(
        response.array_buffer().map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Response.arrayBuffer failed",
                error,
            )
        })?,
        signal,
        "Fetch body read failed",
    )
    .await?;
    let buffer = buffer.dyn_into::<js_sys::ArrayBuffer>().map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Fetch body did not resolve to an ArrayBuffer",
            error,
        )
    })?;
    let bytes = js_sys::Uint8Array::new(&buffer).to_vec();
    report_progress(on_progress, bytes.len() as u64, total, true)?;
    Ok(bytes)
}

async fn await_browser_io(
    promise: js_sys::Promise,
    signal: &JsValue,
    message: &'static str,
) -> Result<JsValue, WebError> {
    match JsFuture::from(promise).await {
        Ok(value) => Ok(value),
        Err(error) if signal_is_aborted(signal) || is_abort_error(&error) => Err(WebError::new(
            Forge3DErrorCode::RequestCancelled,
            "Request cancelled",
        )),
        Err(error) => Err(WebError::with_details(
            Forge3DErrorCode::IoError,
            message,
            error,
        )),
    }
}

fn read_optional_byte_range(input: &JsValue) -> Result<Option<ByteRange>, WebError> {
    let offset = read_optional_u64_property(input, "byteOffset")?.unwrap_or(0);
    let length = read_optional_u64_property(input, "byteLength")?;
    if offset == 0 && length.is_none() {
        return Ok(None);
    }

    ByteRange::new(offset, length)
        .map(Some)
        .map_err(crate::error::map_core_error)
}

fn range_bounds(range: Option<ByteRange>, total: u64) -> Result<(u64, u64), WebError> {
    let range = range.unwrap_or(ByteRange::new(0, None).map_err(crate::error::map_core_error)?);
    if range.offset() > total {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "byteOffset is beyond the source length",
        ));
    }
    let length = range.length().unwrap_or(total - range.offset());
    let end = range.offset().checked_add(length).ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            "byteOffset + byteLength overflowed",
        )
    })?;
    if end > total {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "byte range extends beyond the source length",
        ));
    }
    Ok((range.offset(), length))
}

fn range_header(range: ByteRange) -> Result<String, WebError> {
    let end = range.end_exclusive().and_then(|end| end.checked_sub(1));
    Ok(match end {
        Some(end) => format!("bytes={}-{}", range.offset(), end),
        None => format!("bytes={}-", range.offset()),
    })
}

fn report_progress(
    callback: &Option<js_sys::Function>,
    loaded: u64,
    total: Option<u64>,
    done: bool,
) -> Result<(), WebError> {
    let Some(callback) = callback else {
        return Ok(());
    };

    let progress = js_sys::Object::new();
    set_property(
        progress.as_ref(),
        "loaded",
        &JsValue::from_f64(loaded as f64),
    )?;
    if let Some(total) = total {
        set_property(progress.as_ref(), "total", &JsValue::from_f64(total as f64))?;
    }
    set_property(progress.as_ref(), "done", &JsValue::from_bool(done))?;
    callback
        .call1(&JsValue::UNDEFINED, progress.as_ref())
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Terrain source progress callback failed",
                error,
            )
        })?;
    Ok(())
}

fn ensure_not_cancelled(signal: &JsValue) -> Result<(), WebError> {
    if signal_is_aborted(signal) {
        return Err(WebError::new(
            Forge3DErrorCode::RequestCancelled,
            "Request cancelled",
        ));
    }
    Ok(())
}

fn signal_is_aborted(signal: &JsValue) -> bool {
    if signal.is_undefined() || signal.is_null() {
        return false;
    }
    js_sys::Reflect::get(signal, &JsValue::from_str("aborted"))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn is_abort_error(error: &JsValue) -> bool {
    js_sys::Reflect::get(error, &JsValue::from_str("name"))
        .ok()
        .and_then(|value| value.as_string())
        .map(|name| name == "AbortError")
        .unwrap_or(false)
}

fn read_required_property(input: &JsValue, name: &str) -> Result<JsValue, WebError> {
    let value = read_optional_property(input, name)?.ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("missing terrain source {name}"),
        )
    })?;
    Ok(value)
}

fn read_optional_property(input: &JsValue, name: &str) -> Result<Option<JsValue>, WebError> {
    let value = js_sys::Reflect::get(input, &JsValue::from_str(name)).map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::InvalidInput,
            format!("failed to read terrain source {name}"),
            error,
        )
    })?;
    if value.is_undefined() || value.is_null() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

fn read_u32_property(input: &JsValue, name: &str) -> Result<u32, WebError> {
    let value = read_required_property(input, name)?;
    let number = value.as_f64().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("terrain source {name} must be a number"),
        )
    })?;
    if !number.is_finite() || number.fract() != 0.0 || number <= 0.0 || number > u32::MAX as f64 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("terrain source {name} must be a positive integer"),
        ));
    }
    Ok(number as u32)
}

fn read_optional_u64_property(input: &JsValue, name: &str) -> Result<Option<u64>, WebError> {
    let Some(value) = read_optional_property(input, name)? else {
        return Ok(None);
    };
    let number = value.as_f64().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("terrain source {name} must be a number"),
        )
    })?;
    if !number.is_finite() || number.fract() != 0.0 || number < 0.0 || number > u64::MAX as f64 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("terrain source {name} must be a non-negative integer"),
        ));
    }
    Ok(Some(number as u64))
}

fn object_href(value: &JsValue) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str("href"))
        .ok()
        .and_then(|href| href.as_string())
}

fn set_property(target: &JsValue, name: &str, value: &JsValue) -> Result<(), WebError> {
    js_sys::Reflect::set(target, &JsValue::from_str(name), value)
        .map(|_| ())
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                format!("failed to set browser IO property {name}"),
                error,
            )
        })
}

#[cfg(test)]
mod tests {
    use super::{unsupported_source_for_phase6, BrowserByteSourceKind};

    #[test]
    fn phase6_browser_io_skeleton_reports_future_source_support() {
        let error = unsupported_source_for_phase6(BrowserByteSourceKind::Url);
        assert_eq!(error.code().as_str(), "UNSUPPORTED_FEATURE");
        assert!(error.message().contains("Phase 12"));
    }
}
