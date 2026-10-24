use crate::error::{Forge3DErrorCode, WebError};
use forge3d_core::gpu::GpuContext;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
struct Unmap<'a>(&'a wgpu::Buffer);
impl Drop for Unmap<'_> {
    fn drop(&mut self) {
        self.0.unmap();
    }
}
pub(in crate::runtime) async fn map_readback_buffer(
    context: &GpuContext,
    buffer: &wgpu::Buffer,
    size: u64,
) -> Result<Vec<u8>, WebError> {
    let _unmap = Unmap(buffer);
    let slice = buffer.slice(..);
    let promise = js_sys::Promise::new(&mut |resolve, reject| {
        slice.map_async(wgpu::MapMode::Read, move |result| match result {
            Ok(()) => {
                let _ = resolve.call0(&JsValue::NULL);
            }
            Err(error) => {
                let _ = reject.call1(&JsValue::NULL, &JsValue::from_str(&error.to_string()));
            }
        });
    });
    let _ = context.device.poll(wgpu::PollType::Poll);

    let mapped_result = JsFuture::from(promise).await.map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Frame readback mapping failed",
            error,
        )
    });

    if let Err(error) = mapped_result {
        return Err(error);
    }
    let data = {
        let mapped = buffer.slice(0..size).get_mapped_range();
        mapped.to_vec()
    };
    Ok(data)
}
