use forge3d_core::io::source::{bytes_to_f32_le, ByteRange};
use wasm_bindgen::{prelude::*, JsCast};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Blob, ReadableStreamDefaultReader, Request, RequestInit, RequestMode, Response};

use crate::error::{Forge3DErrorCode, WebError};
use crate::inputs::{
    validate_terrain_allocation, TerrainColorRampOptions, TerrainHeightmapOptions,
    TerrainPhysicalLimits,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserByteSourceKind {
    Url,
    Blob,
    File,
    ArrayBuffer,
}

pub async fn load_terrain_heightmap_source(
    input: JsValue,
    limits: TerrainPhysicalLimits,
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
    let allocation = validate_terrain_allocation(width, height, expected_count, limits)?;
    let expected_bytes = usize::try_from(allocation.sample_bytes).map_err(|_| {
        WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "terrain source payload size exceeds this platform's address space",
        )
    })?;
    let source = read_required_property(&input, "source")?;
    let range = read_optional_byte_range(&input, allocation.sample_bytes)?;
    let color_ramp = TerrainColorRampOptions::from_js_value(
        read_optional_property(&input, "colorRamp")?.unwrap_or(JsValue::UNDEFINED),
    )?;
    let signal = read_optional_property(&input, "signal")?.unwrap_or(JsValue::UNDEFINED);
    let on_progress = read_optional_property(&input, "onProgress")?
        .and_then(|value| value.dyn_into::<js_sys::Function>().ok());

    ensure_not_cancelled(&signal)?;
    report_progress(&on_progress, 0, None, false)?;
    let bytes =
        read_browser_source_bytes(&source, range, expected_bytes, &signal, &on_progress).await?;
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
    expected_bytes: usize,
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
        return read_array_buffer(buffer, range, expected_bytes, on_progress);
    }

    if source.is_instance_of::<web_sys::File>() {
        let file = source.clone().dyn_into::<Blob>().map_err(|_| {
            WebError::new(Forge3DErrorCode::InvalidInput, "File source is not a Blob")
        })?;
        return read_blob(
            file,
            range,
            expected_bytes,
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
            expected_bytes,
            signal,
            on_progress,
            BrowserByteSourceKind::Blob,
        )
        .await;
    }

    if let Some(url) = source.as_string().or_else(|| object_href(source)) {
        return read_url(url, range, expected_bytes, signal, on_progress).await;
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
    expected_bytes: usize,
    on_progress: &Option<js_sys::Function>,
) -> Result<Vec<u8>, WebError> {
    let total = buffer.byte_length() as u64;
    let (offset, length) = range_bounds(range, total)?;
    validate_exact_payload_length(length, expected_bytes)?;
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
    expected_bytes: usize,
    signal: &JsValue,
    on_progress: &Option<js_sys::Function>,
    _kind: BrowserByteSourceKind,
) -> Result<Vec<u8>, WebError> {
    ensure_not_cancelled(signal)?;
    let total = blob.size() as u64;
    let (offset, length) = range_bounds(range, total)?;
    validate_exact_payload_length(length, expected_bytes)?;
    let target = if range.is_some() {
        let start = offset as f64;
        let end = (offset + length) as f64;
        blob.slice_with_f64_and_f64(start, end).map_err(|error| {
            WebError::with_details(Forge3DErrorCode::IoError, "Blob slice failed", error)
        })?
    } else {
        blob
    };

    read_stream_body_bounded(target.stream(), expected_bytes, signal, on_progress).await
}

async fn read_url(
    url: String,
    range: Option<ByteRange>,
    expected_bytes: usize,
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
    validate_url_response_metadata(&response, range, expected_bytes)?;
    read_response_body_bounded(response, expected_bytes, signal, on_progress).await
}

fn validate_url_response_metadata(
    response: &Response,
    range: Option<ByteRange>,
    expected_bytes: usize,
) -> Result<(), WebError> {
    let content_range = response.headers().get("content-range").map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Failed to read Content-Range",
            error,
        )
    })?;
    let content_length = response.headers().get("content-length").map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Failed to read Content-Length",
            error,
        )
    })?;
    validate_url_response_metadata_values(
        response.status(),
        range,
        expected_bytes,
        content_range.as_deref(),
        content_length.as_deref(),
    )
}

fn validate_url_response_metadata_values(
    status: u16,
    range: Option<ByteRange>,
    expected_bytes: usize,
    content_range: Option<&str>,
    content_length: Option<&str>,
) -> Result<(), WebError> {
    match (range, status) {
        (Some(requested), 206) => {
            let content_range = content_range.ok_or_else(|| {
                WebError::new(
                    Forge3DErrorCode::IoError,
                    "HTTP 206 response is missing Content-Range",
                )
            })?;
            validate_content_range(content_range, requested, expected_bytes)?;
        }
        (Some(requested), 200) if requested.offset() == 0 => {}
        (Some(_), 200) => {
            return Err(WebError::new(
                Forge3DErrorCode::IoError,
                "Server ignored a nonzero terrain byte range",
            ));
        }
        (None, 200) => {}
        _ => {
            return Err(WebError::new(
                Forge3DErrorCode::IoError,
                format!("Unexpected HTTP status {status} for terrain source"),
            ));
        }
    }

    if let Some(content_length) = content_length {
        let content_length = content_length.parse::<usize>().map_err(|_| {
            WebError::new(
                Forge3DErrorCode::IoError,
                "Terrain response has a malformed Content-Length",
            )
        })?;
        validate_exact_payload_length(content_length as u64, expected_bytes)?;
    }
    Ok(())
}

fn validate_content_range(
    value: &str,
    requested: ByteRange,
    expected_bytes: usize,
) -> Result<(), WebError> {
    let (span, complete_length) = value
        .strip_prefix("bytes ")
        .and_then(|value| value.split_once('/'))
        .and_then(|(span, complete_length)| {
            let (start, end) = span.split_once('-')?;
            Some((
                (start.parse::<u64>().ok()?, end.parse::<u64>().ok()?),
                complete_length.parse::<u64>().ok()?,
            ))
        })
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::IoError,
                "Terrain response has a malformed Content-Range",
            )
        })?;
    let expected_end = requested
        .offset()
        .checked_add(expected_bytes as u64)
        .and_then(|end| end.checked_sub(1))
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::IoError,
                "Terrain Content-Range overflowed",
            )
        })?;
    if span != (requested.offset(), expected_end) || complete_length <= expected_end {
        return Err(WebError::new(
            Forge3DErrorCode::IoError,
            format!(
                "Terrain Content-Range {}-{}/{} does not match requested {}-{expected_end}",
                span.0,
                span.1,
                complete_length,
                requested.offset()
            ),
        ));
    }
    Ok(())
}

async fn read_response_body_bounded(
    response: Response,
    expected_bytes: usize,
    signal: &JsValue,
    on_progress: &Option<js_sys::Function>,
) -> Result<Vec<u8>, WebError> {
    let stream = response.body().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::IoError,
            "Terrain response has no readable body",
        )
    })?;
    read_stream_body_bounded(stream, expected_bytes, signal, on_progress).await
}

async fn read_stream_body_bounded(
    stream: web_sys::ReadableStream,
    expected_bytes: usize,
    signal: &JsValue,
    on_progress: &Option<js_sys::Function>,
) -> Result<Vec<u8>, WebError> {
    let reader = stream
        .get_reader()
        .dyn_into::<ReadableStreamDefaultReader>()
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Terrain response did not provide a default stream reader",
                error.into(),
            )
        })?;
    let mut body = BoundedResponseBody::new(expected_bytes);
    loop {
        if let Err(error) = ensure_not_cancelled(signal) {
            let _ = reader.cancel();
            return Err(error);
        }
        let chunk =
            await_browser_io(reader.read(), signal, "Fetch body stream read failed").await?;
        if let Err(error) = ensure_not_cancelled(signal) {
            let _ = reader.cancel();
            return Err(error);
        }
        let done = js_sys::Reflect::get(&chunk, &JsValue::from_str("done"))
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if done {
            break;
        }
        let value = js_sys::Reflect::get(&chunk, &JsValue::from_str("value")).map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Terrain response stream chunk has no value",
                error,
            )
        })?;
        if value.is_undefined() || value.is_null() {
            let _ = reader.cancel();
            return Err(WebError::new(
                Forge3DErrorCode::IoError,
                "Terrain response stream produced an empty chunk value",
            ));
        }
        let chunk = js_sys::Uint8Array::new(&value);
        let chunk_len = chunk.length() as usize;
        if !body.can_accept(chunk_len) {
            let _ = reader.cancel();
            return Err(BoundedResponseBody::limit_error());
        }
        let old_len = body.len();
        let mut chunk_bytes = vec![0; chunk_len];
        chunk.copy_to(&mut chunk_bytes);
        if let Err(error) = body.push(&chunk_bytes) {
            let _ = reader.cancel();
            return Err(error);
        }
        if let Err(error) = report_progress(
            on_progress,
            body.len() as u64,
            Some(expected_bytes as u64),
            false,
        ) {
            let _ = reader.cancel();
            return Err(error);
        }
        debug_assert_eq!(body.len(), old_len + chunk_len);
    }
    let bytes = body.finish()?;
    report_progress(
        on_progress,
        bytes.len() as u64,
        Some(expected_bytes as u64),
        true,
    )?;
    Ok(bytes)
}

struct BoundedResponseBody {
    bytes: Vec<u8>,
    expected_bytes: usize,
}

impl BoundedResponseBody {
    fn new(expected_bytes: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(expected_bytes),
            expected_bytes,
        }
    }

    fn len(&self) -> usize {
        self.bytes.len()
    }

    fn can_accept(&self, chunk_len: usize) -> bool {
        self.bytes
            .len()
            .checked_add(chunk_len)
            .is_some_and(|length| length <= self.expected_bytes)
    }

    fn push(&mut self, chunk: &[u8]) -> Result<(), WebError> {
        if !self.can_accept(chunk.len()) {
            return Err(Self::limit_error());
        }
        self.bytes.extend_from_slice(chunk);
        Ok(())
    }

    fn finish(self) -> Result<Vec<u8>, WebError> {
        if self.bytes.len() != self.expected_bytes {
            return Err(WebError::new(
                Forge3DErrorCode::IoError,
                format!(
                    "Terrain response body contained {} bytes; expected {}",
                    self.bytes.len(),
                    self.expected_bytes
                ),
            ));
        }
        Ok(self.bytes)
    }

    fn limit_error() -> WebError {
        WebError::new(
            Forge3DErrorCode::IoError,
            "Terrain response body exceeded the expected payload length",
        )
    }
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

fn read_optional_byte_range(
    input: &JsValue,
    expected_bytes: u64,
) -> Result<Option<ByteRange>, WebError> {
    let offset = read_optional_u64_property(input, "byteOffset")?.unwrap_or(0);
    let length = read_optional_u64_property(input, "byteLength")?;
    if offset == 0 && length.is_none() {
        return Ok(None);
    }
    if let Some(length) = length {
        if length != expected_bytes {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                format!(
                    "terrain source byteLength must equal width * height * 4 ({expected_bytes})"
                ),
            ));
        }
    }

    ByteRange::new(offset, Some(expected_bytes))
        .map(Some)
        .map_err(crate::error::map_core_error)
}

fn validate_exact_payload_length(actual: u64, expected_bytes: usize) -> Result<(), WebError> {
    if actual != expected_bytes as u64 {
        return Err(WebError::new(
            Forge3DErrorCode::IoError,
            format!("Terrain source payload contains {actual} bytes; expected {expected_bytes}"),
        ));
    }
    Ok(())
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
    use forge3d_core::io::source::ByteRange;

    use super::{unsupported_source_for_phase6, BrowserByteSourceKind};

    #[test]
    fn phase6_browser_io_skeleton_reports_future_source_support() {
        let error = unsupported_source_for_phase6(BrowserByteSourceKind::Url);
        assert_eq!(error.code().as_str(), "UNSUPPORTED_FEATURE");
        assert!(error.message().contains("Phase 12"));
    }

    #[test]
    fn content_range_requires_the_exact_requested_span() {
        let range = ByteRange::new(128, Some(16)).unwrap();
        super::validate_content_range("bytes 128-143/1024", range, 16).unwrap();

        let error = super::validate_content_range("bytes 128-144/1024", range, 16).unwrap_err();
        assert_eq!(error.code().as_str(), "IO_ERROR");
    }

    #[test]
    fn url_response_policy_accepts_only_exact_ranges_and_zero_offset_200() {
        let zero = ByteRange::new(0, Some(16)).unwrap();
        let nonzero = ByteRange::new(4, Some(16)).unwrap();

        super::validate_url_response_metadata_values(
            206,
            Some(nonzero),
            16,
            Some("bytes 4-19/64"),
            Some("16"),
        )
        .unwrap();
        super::validate_url_response_metadata_values(200, Some(zero), 16, None, Some("16"))
            .unwrap();
        super::validate_url_response_metadata_values(200, None, 16, None, None).unwrap();

        for result in [
            super::validate_url_response_metadata_values(206, Some(nonzero), 16, None, Some("16")),
            super::validate_url_response_metadata_values(
                206,
                Some(nonzero),
                16,
                Some("bytes 5-20/64"),
                Some("16"),
            ),
            super::validate_url_response_metadata_values(200, Some(nonzero), 16, None, Some("16")),
            super::validate_url_response_metadata_values(416, Some(nonzero), 16, None, None),
            super::validate_url_response_metadata_values(200, Some(zero), 16, None, Some("15")),
            super::validate_url_response_metadata_values(200, None, 16, None, Some("dishonest")),
        ] {
            assert_eq!(result.unwrap_err().code().as_str(), "IO_ERROR");
        }
    }

    #[test]
    fn bounded_response_body_rejects_truncation_and_oversize() {
        let mut exact = super::BoundedResponseBody::new(4);
        exact.push(&[1, 2]).unwrap();
        exact.push(&[3, 4]).unwrap();
        assert_eq!(exact.finish().unwrap(), vec![1, 2, 3, 4]);

        let mut truncated = super::BoundedResponseBody::new(4);
        truncated.push(&[1, 2, 3]).unwrap();
        assert_eq!(truncated.finish().unwrap_err().code().as_str(), "IO_ERROR");

        let mut oversized = super::BoundedResponseBody::new(4);
        assert!(!oversized.can_accept(5));
        assert_eq!(
            oversized
                .push(&[1, 2, 3, 4, 5])
                .unwrap_err()
                .code()
                .as_str(),
            "IO_ERROR"
        );
    }
}
