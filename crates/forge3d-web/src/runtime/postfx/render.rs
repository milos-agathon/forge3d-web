use super::super::offline::gpu::{copy_texture, read_texture_mip};
use super::*;
use forge3d_core::{
    offline::jitter::JitterSequence,
    readback::{decode_float_rows, ReadbackFormat},
};
use wgpu::BindingResource as B;

/// Display frames advance history; screenshots reuse the latest unchanged frame.
pub(crate) fn encode(
    runtime: &mut Forge3DRuntime,
    encoder: &mut wgpu::CommandEncoder,
    destination: &wgpu::TextureView,
    advance: bool,
) -> Result<(), WebError> {
    let Some(mut fx) = runtime.postfx.take() else {
        return Ok(());
    };
    let result = (|| {
        let context = runtime
            .context
            .clone()
            .ok_or_else(|| invalid("GPU context unavailable"))?;
        if fx.capture.is_none() {
            let bytes = planned_bytes(
                &fx.config,
                runtime.width,
                runtime.height,
                runtime.environment.is_some(),
                runtime.scatter.as_ref().is_some_and(|s| s.transparent()),
            );
            runtime
                .memory
                .replace(KEY, MemoryCategory::Textures, bytes)?;
            fx.bytes = bytes;
            fx.capture = Some(CaptureFrame::new(runtime, &context)?);
        }
        let accumulation_samples = fx
            .config
            .effects
            .iter()
            .find(|e| e.enabled && e.kind == forge3d_core::postfx::EffectKind::AccumulationAa)
            .map(|e| e.params[0] as u32);
        if (advance && accumulation_samples.is_none_or(|n| fx.temporal.frames < n))
            || fx.last_camera != Some(runtime.camera)
            || fx.last_time != runtime.time_seconds
        {
            if fx.temporal.camera_cut(&runtime.camera) {
                fx.temporal.reset("camera-cut");
            }
            let accumulation =
                fx.config.effects.iter().any(|e| {
                    e.enabled && e.kind == forge3d_core::postfx::EffectKind::AccumulationAa
                });
            if accumulation
                && (fx.temporal.previous.is_some_and(|c| c != runtime.camera)
                    || fx.last_time != runtime.time_seconds)
            {
                fx.temporal.reset("scene");
            }
            let jitter = fx.config.effects.iter().any(|e| {
                e.enabled
                    && ((e.kind == forge3d_core::postfx::EffectKind::Taa && e.params[4] != 0.)
                        || (e.kind == forge3d_core::postfx::EffectKind::AccumulationAa
                            && e.params[1] != 0.))
            });
            fx.previous_jitter = fx.jitter;
            fx.jitter = if jitter {
                if accumulation {
                    JitterSequence::new(accumulation_samples.unwrap(), None)
                        .get(fx.temporal.frames as usize)
                } else {
                    forge3d_core::offline::jitter::halton_2_3(fx.temporal.frames, 8)
                }
            } else {
                [0.; 2]
            };
            let previous = fx.temporal.previous.unwrap_or(runtime.camera);
            let capture = fx.capture.as_ref().unwrap();
            capture.update(runtime, &context, &previous, fx.jitter)?;
            capture.encode(runtime, encoder);
            build_hzb(&fx, &context, encoder);
            for stage in &fx.stages {
                let input = stage
                    .plan
                    .input
                    .map_or(&capture.targets.color.view, |i| &fx.stages[i].output.view);
                let auxiliary = stage
                    .plan
                    .auxiliary
                    .map_or(input, |i| &fx.stages[i].output.view);
                let camera = super::super::terrain::create_capture_camera_uniform(
                    &runtime.camera,
                    &previous,
                    fx.width,
                    fx.height,
                    fx.jitter,
                    1,
                )?;
                let vp = glam::Mat4::from_cols_array_2d(&camera.base.view_projection);
                let mut parameters = stage.plan.parameters;
                parameters[14] = fx.previous_jitter[0];
                parameters[15] = fx.previous_jitter[1];
                let screen = u32::from(
                    runtime.terrain.as_ref().is_some_and(|t| t.render_mode == 1)
                        && stage.plan.lane == 19,
                );
                let params = Params {
                    size: [fx.width, fx.height, stage.plan.lane, fx.temporal.frames],
                    control: [u32::from(fx.temporal.frames > 0), screen, 0, 0],
                    parameters,
                    inverse_vp: vp.inverse().to_cols_array_2d(),
                    view_projection: vp.to_cols_array_2d(),
                    eye: camera.base.camera_position,
                    forward: camera.base.camera_forward,
                    camera: [
                        runtime.camera.near,
                        runtime.camera.far,
                        fx.jitter[0],
                        fx.jitter[1],
                    ],
                };
                context
                    .queue
                    .write_buffer(&stage.uniform, 0, bytemuck::bytes_of(&params));
                let history = stage.history.as_ref().map_or(input, |t| &t.view);
                let ibl = runtime
                    .ibl
                    .as_ref()
                    .ok_or_else(|| invalid("IBL resources unavailable"))?;
                let group = gpu::bind(
                    &context.device,
                    &stage.plan.label,
                    &fx.pipelines.layout,
                    &[
                        B::TextureView(input),
                        B::TextureView(&capture.targets.depth.view),
                        B::TextureView(&capture.targets.normal.view),
                        B::TextureView(&capture.targets.albedo.view),
                        B::TextureView(&capture.targets.motion.view),
                        B::TextureView(history),
                        B::TextureView(&fx.old_depth.view),
                        B::TextureView(&fx.old_id.view),
                        B::TextureView(&capture.targets.id.view),
                        B::TextureView(&fx.hzb.view),
                        B::TextureView(auxiliary),
                        B::TextureView(&stage.output.view),
                        stage.uniform.as_entire_binding(),
                        stage.lut.as_entire_binding(),
                        B::TextureView(&ibl.specular_view),
                        B::TextureView(&ibl.irradiance_view),
                        B::Sampler(&ibl.sampler),
                        ibl.uniform_buffer.as_entire_binding(),
                        B::TextureView(&ibl.brdf_lut_view),
                    ],
                );
                gpu::dispatch(
                    encoder,
                    &stage.plan.label,
                    &fx.pipelines.compute,
                    &group,
                    fx.width,
                    fx.height,
                );
                if let Some(history) = &stage.history {
                    copy_texture(
                        encoder,
                        &stage.output.texture,
                        &history.texture,
                        fx.width,
                        fx.height,
                    );
                }
            }
            copy_texture(
                encoder,
                &capture.targets.depth.texture,
                &fx.old_depth.texture,
                fx.width,
                fx.height,
            );
            copy_texture(
                encoder,
                &capture.targets.id.texture,
                &fx.old_id.texture,
                fx.width,
                fx.height,
            );
            fx.temporal.advance(runtime.camera);
            fx.last_camera = Some(runtime.camera);
            fx.last_time = runtime.time_seconds;
        }
        present(runtime, &fx, &context, encoder, destination)?;
        Ok(())
    })();
    runtime.postfx = Some(fx);
    result
}
fn build_hzb(fx: &Resources, context: &GpuContext, encoder: &mut wgpu::CommandEncoder) {
    let mut source = &fx.capture.as_ref().unwrap().targets.depth.view;
    for (i, (width, height)) in hzb_dimensions(fx.width, fx.height).into_iter().enumerate() {
        let destination = &fx.hzb_views[i];
        let group = gpu::bind(
            &context.device,
            "postfx:hzb",
            &fx.pipelines.hzb_layout,
            &[B::TextureView(source), B::TextureView(destination)],
        );
        gpu::dispatch(
            encoder,
            "postfx:hzb",
            &fx.pipelines.hzb,
            &group,
            width,
            height,
        );
        source = destination;
    }
}
fn effect_view<'a>(fx: &'a Resources, id: &str) -> Option<&'a wgpu::TextureView> {
    let stages: Vec<_> = fx.stages.iter().filter(|s| s.plan.effect == id).collect();
    stages
        .iter()
        .rev()
        .find(|s| matches!(s.plan.lane, 7 | 11 | 12))
        .or_else(|| stages.last())
        .map(|s| &s.output.view)
}
fn present(
    runtime: &Forge3DRuntime,
    fx: &Resources,
    context: &GpuContext,
    encoder: &mut wgpu::CommandEncoder,
    destination: &wgpu::TextureView,
) -> Result<(), WebError> {
    let capture = fx.capture.as_ref().unwrap();
    let last = fx
        .stages
        .last()
        .map_or(&capture.targets.color.view, |s| &s.output.view);
    let debug = &fx.config.debug;
    let mode = [
        "none", "color", "depth", "normal", "albedo", "motion", "hzb", "effect",
    ]
    .iter()
    .position(|v| *v == debug.view)
    .unwrap_or(0) as u32;
    let srgb = runtime
        .surface_state
        .as_ref()
        .is_some_and(|s| s.config.format.is_srgb());
    context.queue.write_buffer(
        &fx.output_params,
        0,
        bytemuck::bytes_of(&[mode, debug.hzb_mip, u32::from(srgb), 0]),
    );
    let effect = debug
        .effect_id
        .as_deref()
        .and_then(|id| effect_view(fx, id))
        .unwrap_or(last);
    let group = gpu::bind(
        &context.device,
        "postfx:output",
        &fx.pipelines.output_layout,
        &[
            B::TextureView(if mode == 1 {
                &capture.targets.color.view
            } else {
                last
            }),
            B::TextureView(&capture.targets.depth.view),
            B::TextureView(&capture.targets.normal.view),
            B::TextureView(&capture.targets.albedo.view),
            B::TextureView(&capture.targets.motion.view),
            B::TextureView(&fx.hzb.view),
            B::TextureView(effect),
            fx.output_params.as_entire_binding(),
        ],
    );
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("postfx:output"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: destination,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&fx.pipelines.output);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
    // Display overlays run after the sole output transfer, outside HDR effects.
    if let Some(bundle) = runtime
        .scene
        .as_ref()
        .and_then(|s| s.overlay_bundle.as_ref())
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("postfx:overlay"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: destination,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.execute_bundles(std::iter::once(bundle));
    }
    Ok(())
}
pub(crate) async fn read_intermediate(
    runtime: &mut Forge3DRuntime,
    name: &str,
) -> Result<JsValue, WebError> {
    if runtime.postfx.is_none() {
        return Err(invalid("no post-FX chain is active"));
    }
    // Prepare an unchanged-frame screenshot to execute pending settings/camera
    // edits; this does not advance an already valid history.
    let _ = super::super::readback::read_rgba_runtime(runtime).await?;
    let context = runtime
        .context
        .clone()
        .ok_or_else(|| invalid("GPU context unavailable"))?;
    let fx = runtime.postfx.as_ref().unwrap();
    let capture = fx.capture.as_ref().unwrap();
    let mip = if name == "hzb" {
        0
    } else if let Some(level) = name.strip_prefix("hzb:") {
        level
            .parse::<u32>()
            .map_err(|_| invalid("invalid HZB mip"))?
    } else {
        0
    };
    if mip >= fx.hzb_views.len() as u32 {
        return Err(invalid("HZB mip outside pyramid"));
    }
    let (target, format, channels) = match name {
        _ if name == "hzb" || name.starts_with("hzb:") => (&fx.hzb, ReadbackFormat::R32Float, 1),
        "color" => (&capture.targets.color, ReadbackFormat::Rgba32Float, 4),
        "depth" => (&capture.targets.depth, ReadbackFormat::R32Float, 1),
        "normal" => (&capture.targets.normal, ReadbackFormat::Rgba32Float, 4),
        "albedo" => (&capture.targets.albedo, ReadbackFormat::Rgba32Float, 4),
        "motion" => (&capture.targets.motion, ReadbackFormat::Rg32Float, 2),
        _ => {
            let stage = fx
                .stages
                .iter()
                .find(|s| s.plan.label == name)
                .or_else(|| fx.stages.iter().rev().find(|s| s.plan.effect == name))
                .ok_or_else(|| invalid(format!("unknown intermediate {name}")))?;
            (&stage.output, ReadbackFormat::Rgba16Float, 4)
        }
    };
    let (width, height) = ((fx.width >> mip).max(1), (fx.height >> mip).max(1));
    let format = if name == "color" && target.texture.format() == wgpu::TextureFormat::Rgba16Float {
        ReadbackFormat::Rgba16Float
    } else {
        format
    };
    let layout = format.layout(width, height).map_err(map_core_error)?;
    runtime.memory.replace(
        "postfx:readback",
        MemoryCategory::Readback,
        layout.buffer_size,
    )?;
    let result = read_texture_mip(&context, &target.texture, format, width, height, mip).await;
    runtime.memory.release("postfx:readback");
    let (bytes, layout) = result?;
    let floats = decode_float_rows(&bytes, layout, format).map_err(map_core_error)?;
    let value = js_sys::Object::new();
    super::super::device_health::set_js_property(&value, "width", &JsValue::from_f64(width as f64));
    super::super::device_health::set_js_property(
        &value,
        "height",
        &JsValue::from_f64(height as f64),
    );
    super::super::device_health::set_js_property(
        &value,
        "channels",
        &JsValue::from_f64(channels as f64),
    );
    super::super::device_health::set_js_property(
        &value,
        "data",
        &js_sys::Float32Array::from(floats.as_slice()).into(),
    );
    Ok(value.into())
}
