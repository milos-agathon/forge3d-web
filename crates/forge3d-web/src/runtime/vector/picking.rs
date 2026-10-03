use super::*;
use forge3d_core::readback::{decode_float_rows, decode_u32_rows, ReadbackFormat};
#[derive(Deserialize)]
struct Region {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
async fn read_region(
    context: &GpuContext,
    texture: &wgpu::Texture,
    format: ReadbackFormat,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<(Vec<u8>, forge3d_core::readback::ReadbackLayout), WebError> {
    let layout = format
        .layout(width, height)
        .map_err(crate::error::map_core_error)?;
    let staging = super::super::offline::gpu::staging_buffer(
        &context.device,
        "vector:bounded-readback",
        layout.buffer_size,
    );
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("vector:bounded-readback"),
        });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d { x, y, z: 0 },
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(layout.padded_bytes_per_row),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    context.queue.submit(Some(encoder.finish()));
    let bytes =
        super::super::readback::map_readback_buffer(context, &staging, layout.buffer_size).await?;
    Ok((bytes, layout))
}
pub(crate) async fn read_pick_map(
    runtime: &mut Forge3DRuntime,
    input: wasm_bindgen::JsValue,
) -> Result<wasm_bindgen::JsValue, WebError> {
    let context = runtime
        .context
        .clone()
        .ok_or_else(|| invalid("GPU context unavailable"))?;
    let region: Region = if input.is_undefined() || input.is_null() {
        Region {
            x: 0.,
            y: 0.,
            width: runtime.width as f64,
            height: runtime.height as f64,
        }
    } else {
        serde_wasm_bindgen::from_value(input).map_err(|e| invalid(e.to_string()))?
    };
    if [region.x, region.y, region.width, region.height]
        .iter()
        .any(|v| !v.is_finite())
        || region.width < 0.
        || region.height < 0.
    {
        return Err(invalid("invalid vector pick region"));
    }
    let x = region.x.floor().clamp(0., runtime.width as f64) as u32;
    let y = region.y.floor().clamp(0., runtime.height as f64) as u32;
    let right = (region.x + region.width)
        .ceil()
        .clamp(0., runtime.width as f64) as u32;
    let bottom = (region.y + region.height)
        .ceil()
        .clamp(0., runtime.height as f64) as u32;
    let width = right.saturating_sub(x);
    let height = bottom.saturating_sub(y);
    let pixels = width as usize * height as usize;
    if pixels > 0 && runtime.vectors.as_ref().is_some_and(|v| v.pick_dirty.get()) {
        // Render without a screenshot readback. Color and pick share the same pass.
        if !super::super::render::render_runtime(runtime)? {
            return Err(invalid("vector pick frame unavailable"));
        }
    }
    let planned = if pixels == 0 {
        0
    } else {
        [
            ReadbackFormat::R32Uint,
            ReadbackFormat::R32Float,
            ReadbackFormat::Rgba32Float,
        ]
        .into_iter()
        .map(|f| {
            f.layout(width, height)
                .map(|l| l.buffer_size)
                .map_err(crate::error::map_core_error)
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .sum()
    };
    runtime
        .memory
        .replace("vectors:readback", MemoryCategory::Readback, planned)?;
    if let Some(v) = runtime.vectors.as_ref() {
        v.pick_readback_peak
            .set(v.pick_readback_peak.get().max(planned));
    }
    let result = async {
        let (ids, depth, world) = if let Some(v) = runtime.vectors.as_ref().filter(|_| pixels > 0) {
            let (bytes, layout) = read_region(
                &context,
                &v.id.texture,
                ReadbackFormat::R32Uint,
                x,
                y,
                width,
                height,
            )
            .await?;
            let ids = decode_u32_rows(&bytes, layout).map_err(crate::error::map_core_error)?;
            let (bytes, layout) = read_region(
                &context,
                &v.depth.texture,
                ReadbackFormat::R32Float,
                x,
                y,
                width,
                height,
            )
            .await?;
            let depth = decode_float_rows(&bytes, layout, ReadbackFormat::R32Float)
                .map_err(crate::error::map_core_error)?;
            let (bytes, layout) = read_region(
                &context,
                &v.world.texture,
                ReadbackFormat::Rgba32Float,
                x,
                y,
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
        let result: wasm_bindgen::JsValue = js_sys::Object::new().into();
        for (name, value) in [
            ("x", x.into()),
            ("y", y.into()),
            ("width", width.into()),
            ("height", height.into()),
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
/// Diagnostic reads actual compacted GPU bytes, independently projects on CPU.
pub(crate) async fn read_projection(
    runtime: &mut Forge3DRuntime,
) -> Result<wasm_bindgen::JsValue, WebError> {
    let c = runtime
        .context
        .clone()
        .ok_or_else(|| invalid("GPU context unavailable"))?;
    let v = runtime
        .vectors
        .as_ref()
        .ok_or_else(|| invalid("vector layers unavailable"))?;
    let camera = super::super::terrain::create_camera_uniform(&runtime.camera, v.width, v.height)?;
    let cpu = forge3d_core::vector::project_and_cull(
        &v.vertices,
        glam::Mat4::from_cols_array_2d(&camera.view_projection),
        glam::Vec2::new(v.width as f32, v.height as f32),
    );
    let mut encoder = c
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("vector:projection-diagnostic"),
        });
    v.prepare_frame(runtime, &mut encoder, None);
    c.queue.submit(Some(encoder.finish()));
    let commands = super::super::offline::gpu::read_buffer(&c, &v.commands, 16).await?;
    let count = u32::from_le_bytes(commands[..4].try_into().expect("indirect count"));
    let gpu = if count == 0 {
        Vec::new()
    } else {
        super::super::offline::gpu::read_buffer(&c, &v.projected, count as u64 * 80).await?
    };
    let cpu_bytes: &[u8] = bytemuck::cast_slice(&cpu);
    let result: wasm_bindgen::JsValue = js_sys::Object::new().into();
    for (name, value) in [
        ("gpu", js_sys::Uint8Array::from(gpu.as_slice()).into()),
        ("cpu", js_sys::Uint8Array::from(cpu_bytes).into()),
        ("vertexCount", count.into()),
        ("byteIdentical", (gpu == cpu_bytes).into()),
    ] {
        super::super::device_health::set_js_property(&result, name, &value);
    }
    Ok(result)
}
