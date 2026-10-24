use super::super::Forge3DRuntime;
pub(in crate::runtime) fn encode_scene_render_pass(
    runtime: &Forge3DRuntime,
    encoder: &mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    label: &'static str,
    timestamp_slot: Option<usize>,
    preserve_depth: bool,
) {
    let destination = view;
    let view = runtime.environment.as_ref().map_or(view, |e| &e.world.view);
    if let Some(e) = &runtime.environment {
        e.reflection.encode(runtime, encoder);
    }
    let depth_stencil_attachment =
        runtime
            .depth_attachment
            .as_ref()
            .map(|depth| wgpu::RenderPassDepthStencilAttachment {
                view: &depth.view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: if preserve_depth
                        || runtime.environment.is_some()
                        || runtime.vectors.is_some()
                    {
                        wgpu::StoreOp::Store
                    } else {
                        wgpu::StoreOp::Discard
                    },
                }),
                stencil_ops: None,
            });
    let world_writes = timestamp_slot.and_then(|slot| {
        runtime
            .query_ring
            .as_ref()
            .map(|ring| ring.pass_writes(slot, 0))
    });
    {
        let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: runtime.clear_color[0] as f64,
                        g: runtime.clear_color[1] as f64,
                        b: runtime.clear_color[2] as f64,
                        a: runtime.clear_color[3] as f64,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment,
            occlusion_query_set: None,
            timestamp_writes: world_writes,
            multiview_mask: None,
        });

        if let (Some(terrain), Some(lighting), Some(textures), Some(ibl)) = (
            runtime.terrain.as_ref(),
            runtime.lighting.as_ref(),
            runtime.textures.as_ref(),
            runtime.ibl.as_ref(),
        ) {
            let (group0, group2) = terrain.profile_bind_groups(textures.bind_group_for(0));
            render_pass.set_pipeline(&terrain.pipeline);
            render_pass.set_bind_group(0, group0, &[]);
            render_pass.set_bind_group(1, &lighting.bind_group, &[]);
            let masked_group = runtime
                .environment
                .as_ref()
                .and_then(|e| e.reflection.material_group(runtime));
            render_pass.set_bind_group(2, masked_group.as_ref().unwrap_or(group2), &[]);
            render_pass.set_bind_group(3, &ibl.bind_group, &[]);
            render_pass.set_vertex_buffer(0, terrain.vertex_buffer.slice(..));
            render_pass.set_index_buffer(terrain.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            if terrain.render_mode == 1 {
                // Screen mode: fullscreen triangle generated from vertex_index.
                render_pass.draw(0..3, 0..1);
            } else {
                render_pass.draw_indexed(0..terrain.index_count, 0, 0..1);
            }
        }
        if let Some(scene) = runtime.scene.as_ref() {
            if let Some(bundle) = scene.world_bundle.as_ref() {
                render_pass.execute_bundles(std::iter::once(bundle));
            }
        }
        if let Some(scatter) = runtime.scatter.as_ref() {
            scatter.draw(&mut render_pass, runtime, None);
        }
    }

    if let (Some(depth), Some(surface)) = (&runtime.depth_attachment, &runtime.surface_state) {
        let format = runtime
            .environment
            .as_ref()
            .map_or(surface.config.format, |e| e.world.texture.format());
        super::super::vector::encode(runtime, encoder, view, format, &depth.view);
    }
    if let (Some(e), Some(depth), Some(surface)) = (
        &runtime.environment,
        &runtime.depth_attachment,
        &runtime.surface_state,
    ) {
        e.encode(
            runtime,
            encoder,
            view,
            &depth.view,
            destination,
            surface.config.format,
        );
    }
    let view = destination;

    let overlay_writes = timestamp_slot.and_then(|slot| {
        runtime
            .query_ring
            .as_ref()
            .map(|ring| ring.pass_writes(slot, 1))
    });
    let has_overlay = runtime
        .scene
        .as_ref()
        .and_then(|scene| scene.overlay_bundle.as_ref())
        .is_some();
    if !has_overlay && overlay_writes.is_none() {
        return;
    }
    let mut overlay_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("forge3d-web-overlay-pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        occlusion_query_set: None,
        timestamp_writes: overlay_writes,
        multiview_mask: None,
    });
    if let Some(scene) = runtime.scene.as_ref() {
        if let Some(bundle) = scene.overlay_bundle.as_ref() {
            overlay_pass.execute_bundles(std::iter::once(bundle));
        }
    }
}
