use super::{frame::read_frame_runtime, reference};
use crate::error::{Forge3DErrorCode, WebError};
use crate::runtime::Forge3DRuntime;
use wasm_bindgen::JsValue;

pub(in crate::runtime) async fn read_map_frame_runtime(
    runtime: &mut Forge3DRuntime,
) -> Result<JsValue, WebError> {
    // W08 keeps the complete capture lifecycle, including its residency maps.
    if runtime
        .terrain
        .as_ref()
        .is_some_and(|t| t.clipmap.is_some() || t.streaming.is_some() || t.vt.is_some())
    {
        return Ok(JsValue::UNDEFINED);
    }
    let bytes = u64::from(runtime.width) * u64::from(runtime.height) * 4;
    if runtime
        .context
        .as_ref()
        .is_some_and(|c| bytes > u64::from(c.device.limits().max_storage_buffer_binding_size))
    {
        return Ok(JsValue::UNDEFINED);
    }
    let started = crate::runtime::timing::now_ms();
    // Geometry (including scatter and vector picking) writes the canonical
    // unjittered hardware depth. Color-only weather leaves that depth intact.
    // MapScene routes heightfields containing nodata through full capture.
    let frame = if runtime.postfx.is_some()
        || runtime
            .environment
            .as_ref()
            .is_some_and(|e| !e.snapshot.water.is_empty())
        || runtime
            .vectors
            .as_ref()
            .is_some_and(|v| v.needs_reference_depth(&runtime.camera))
        || runtime.depth_attachment.is_none()
        || runtime.terrain.as_ref().is_some_and(|t| t.render_mode == 1)
    {
        let depth = reference::read_depth(runtime).await?;
        let mut frame = read_frame_runtime(runtime, false).await?;
        frame.coverage = Some(depth.into_iter().map(|d| u8::from(d < 1.0)).collect());
        frame
    } else {
        read_frame_runtime(runtime, true).await?
    };
    // This private offscreen path can be the first actual draw. Report its
    // executed world/overlay plan without a discarded surface presentation.
    crate::runtime::render::record_frame_stats(
        runtime,
        crate::runtime::timing::now_ms() - started,
    )?;
    let result = js_sys::Object::new();
    for (name, bytes) in [("rgba", frame.rgba), ("coverage", frame.coverage.unwrap())] {
        js_sys::Reflect::set(
            &result,
            &JsValue::from_str(name),
            &js_sys::Uint8Array::from(bytes.as_slice()),
        )
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::InternalError,
                "Failed to return map frame readback",
                error,
            )
        })?;
    }
    Ok(result.into())
}
