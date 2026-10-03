use super::super::offline::gpu::read_texture;
use super::*;
use forge3d_core::readback::{decode_float_rows, decode_u32_rows, ReadbackFormat};
pub(crate) async fn read_pick_map(
    runtime: &mut Forge3DRuntime,
) -> Result<wasm_bindgen::JsValue, WebError> {
    let context = runtime
        .context
        .clone()
        .ok_or_else(|| invalid("GPU context unavailable"))?;
    // Use the same fresh frame as screenshot; old frames cannot pick stale edits.
    super::super::readback::read_rgba_runtime(runtime).await?;
    let width = runtime.width;
    let height = runtime.height;
    let pixels = width as usize * height as usize;
    let planned = u64::from(width).div_ceil(64) * 256 * u64::from(height) * 6;
    runtime
        .memory
        .replace("vectors:readback", MemoryCategory::Readback, planned)?;
    let result = async {
        let (ids, depth, world) = if let Some(v) = &runtime.vectors {
            let (bytes, layout) = read_texture(
                &context,
                &v.id.texture,
                ReadbackFormat::R32Uint,
                width,
                height,
            )
            .await?;
            let ids = decode_u32_rows(&bytes, layout).map_err(crate::error::map_core_error)?;
            let (bytes, layout) = read_texture(
                &context,
                &v.depth.texture,
                ReadbackFormat::R32Float,
                width,
                height,
            )
            .await?;
            let depth = decode_float_rows(&bytes, layout, ReadbackFormat::R32Float)
                .map_err(crate::error::map_core_error)?;
            let (bytes, layout) = read_texture(
                &context,
                &v.world.texture,
                ReadbackFormat::Rgba32Float,
                width,
                height,
            )
            .await?;
            let world4 = decode_float_rows(&bytes, layout, ReadbackFormat::Rgba32Float)
                .map_err(crate::error::map_core_error)?;
            let world: Vec<f32> = world4
                .chunks_exact(4)
                .flat_map(|p| p[..3].iter().copied())
                .collect();
            (ids, depth, world)
        } else {
            (vec![0; pixels], vec![1.; pixels], vec![0.; pixels * 3])
        };
        let result = js_sys::Object::new();
        let result: wasm_bindgen::JsValue = result.into();
        for (name, value) in [
            ("width", wasm_bindgen::JsValue::from(width)),
            ("height", wasm_bindgen::JsValue::from(height)),
            ("ids", js_sys::Uint32Array::from(ids.as_slice()).into()),
            ("depth", js_sys::Float32Array::from(depth.as_slice()).into()),
            (
                "worldPositions",
                js_sys::Float32Array::from(world.as_slice()).into(),
            ),
        ] {
            super::super::device_health::set_js_property(&result, name, &value);
        }
        Ok(result)
    }
    .await;
    runtime.memory.release("vectors:readback");
    result
}
