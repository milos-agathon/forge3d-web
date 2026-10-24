use super::super::{
    offline::{gpu, gpu::CaptureTargets, CapturePass, TerrainCapture},
    Forge3DRuntime,
};
fn color_attachment<'a>(
    view: &'a wgpu::TextureView,
    clear: [f64; 4],
) -> Option<wgpu::RenderPassColorAttachment<'a>> {
    Some(wgpu::RenderPassColorAttachment {
        view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color {
                r: clear[0],
                g: clear[1],
                b: clear[2],
                a: clear[3],
            }),
            store: wgpu::StoreOp::Store,
        },
    })
}

/// The same linear G-buffer encoder is used by offline capture and W11.
pub(in crate::runtime) struct CaptureView<'a> {
    pub width: u32,
    pub height: u32,
    pub targets: &'a CaptureTargets,
    pub terrain: Option<&'a TerrainCapture>,
    pub scene_camera: Option<&'a wgpu::BindGroup>,
    pub environment_source: Option<&'a gpu::Target>,
    pub surface: bool,
    pub overlay: bool,
    pub realtime: bool,
    pub depth_reference: bool,
    pub vector_view_projection: Option<[[f32; 4]; 4]>,
}
pub(in crate::runtime) fn encode_capture_view(
    runtime: &Forge3DRuntime,
    session: &CaptureView<'_>,
    encoder: &mut wgpu::CommandEncoder,
    surface: bool,
) {
    let (Some(lighting), Some(textures), Some(ibl)) = (
        runtime.lighting.as_ref(),
        runtime.textures.as_ref(),
        runtime.ibl.as_ref(),
    ) else {
        return;
    };
    if let Some(e) = runtime
        .environment
        .as_ref()
        .filter(|_| !session.depth_reference)
    {
        e.reflection.encode(runtime, encoder);
    }
    let targets = &session.targets;
    let clear = runtime.clear_color.map(f64::from);
    let passes: &[CapturePass] = if surface && session.surface {
        &[CapturePass::Primary, CapturePass::Surface]
    } else {
        &[CapturePass::Primary]
    };
    for which in passes {
        let colors = match which {
            CapturePass::Primary => vec![
                color_attachment(&targets.color.view, clear),
                color_attachment(&targets.depth.view, [1.0, 0.0, 0.0, 0.0]),
                color_attachment(&targets.id.view, [0.0; 4]),
                color_attachment(&targets.motion.view, [0.0; 4]),
            ],
            CapturePass::Surface => vec![
                color_attachment(&targets.albedo.view, [0.0; 4]),
                color_attachment(&targets.normal.view, [0.0; 4]),
            ],
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(match which {
                CapturePass::Primary => "forge3d-web-capture-primary",
                CapturePass::Surface => "forge3d-web-capture-surface",
            }),
            color_attachments: &colors,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &targets.depth_stencil.view,
                depth_ops: Some(wgpu::Operations {
                    load: match which {
                        CapturePass::Primary => wgpu::LoadOp::Clear(1.0),
                        CapturePass::Surface => wgpu::LoadOp::Load,
                    },
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        if let (Some(terrain), Some(capture)) = (runtime.terrain.as_ref(), session.terrain.as_ref())
        {
            let pipeline = match which {
                CapturePass::Primary => Some(&capture.primary),
                CapturePass::Surface => capture.surface.as_ref(),
            };
            if let Some(pipeline) = pipeline {
                pass.set_pipeline(pipeline);
                let (_, group2) = terrain.profile_bind_groups(textures.bind_group_for(0));
                pass.set_bind_group(0, &capture.bind_group, &[]);
                pass.set_bind_group(1, &lighting.bind_group, &[]);
                let masked_group = runtime
                    .environment
                    .as_ref()
                    .and_then(|e| e.reflection.material_group(runtime));
                pass.set_bind_group(2, masked_group.as_ref().unwrap_or(group2), &[]);
                pass.set_bind_group(3, &ibl.bind_group, &[]);
                pass.set_vertex_buffer(0, terrain.vertex_buffer.slice(..));
                pass.set_index_buffer(terrain.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                if terrain.render_mode == 1 {
                    pass.draw(0..3, 0..1);
                } else {
                    pass.draw_indexed(0..terrain.index_count, 0, 0..1);
                }
            }
        }
        if let (Some(scene), Some(camera)) = (runtime.scene.as_ref(), session.scene_camera.as_ref())
        {
            scene.draw_capture_world(&mut pass, *which, camera, textures, ibl);
        }
        if let Some(scatter) = runtime.scatter.as_ref() {
            scatter.draw(&mut pass, runtime, Some(*which));
        }
    }
    super::super::vector::encode_capture(
        runtime,
        encoder,
        targets,
        surface && session.surface,
        session.vector_view_projection,
    );
    if let (Some(e), Some(source)) = (&runtime.environment, &session.environment_source) {
        // The private map reference consumes depth only. Water still contributes
        // geometric AOVs; sky, fog, clouds and reflections only affect color.
        if !session.depth_reference {
            encoder.copy_texture_to_texture(
                targets.color.texture.as_image_copy(),
                source.texture.as_image_copy(),
                wgpu::Extent3d {
                    width: session.width,
                    height: session.height,
                    depth_or_array_layers: 1,
                },
            );
            if !session.realtime {
                e.history_valid.set(false);
            }
            e.encode(
                runtime,
                encoder,
                &source.view,
                &targets.depth_stencil.view,
                &targets.color.view,
                targets.color.texture.format(),
            );
        }
        e.encode_water_aovs(
            runtime,
            encoder,
            &source.view,
            targets,
            surface && session.surface,
        );
        if !session.realtime && !session.depth_reference {
            e.history_valid.set(false);
        }
    }
    if session.overlay && surface {
        if let Some(scene) = runtime.scene.as_ref() {
            let colors = [color_attachment(&targets.overlay.view, [0.0; 4])];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("forge3d-web-capture-overlay"),
                color_attachments: &colors,
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });
            scene.draw_capture_overlays(&mut pass);
        }
    }
}
