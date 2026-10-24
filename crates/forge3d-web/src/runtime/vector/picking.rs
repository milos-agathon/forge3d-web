use super::super::texture_readback::{self, Job, Region as TextureRegion, Request};
use super::*;
use forge3d_core::readback::ReadbackFormat;
#[derive(Deserialize)]
struct Region {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
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
    let (ids, depth, world) = if let Some(v) = runtime.vectors.as_ref().filter(|_| pixels > 0) {
        let requests: Vec<_> = [
            (&v.id.texture, ReadbackFormat::R32Uint),
            (&v.depth.texture, ReadbackFormat::R32Float),
            (&v.world.texture, ReadbackFormat::Rgba32Float),
        ]
        .into_iter()
        .map(|(texture, format)| {
            let mut region = TextureRegion::image(width, height, 0, format);
            region.origin.x = x;
            region.origin.y = y;
            Request { texture, region }
        })
        .collect();
        let plans = Job::plans(&requests, context.device.limits().max_buffer_size)?;
        let planned = plans.last().map_or(0, |p| p.end());
        v.pick_readback_peak
            .set(v.pick_readback_peak.get().max(planned));
        let data =
            texture_readback::read(&context, &mut runtime.memory, "vectors:readback", &requests)
                .await?;
        let ids = data[0].uints()?;
        let depth = data[1].floats()?;
        let world4 = data[2].floats()?;
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
