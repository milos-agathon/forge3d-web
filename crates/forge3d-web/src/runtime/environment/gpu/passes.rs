use super::bindings::{draw, pipeline, view_entry};
use super::*;
impl EnvironmentResources {
    pub(super) fn group(
        &self,
        device: &wgpu::Device,
        color: &wgpu::TextureView,
        depth: &wgpu::TextureView,
        effect: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        let entries = [
            wgpu::BindGroupEntry {
                binding: 0,
                resource: self.uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: self.payload.as_entire_binding(),
            },
            view_entry(2, color),
            view_entry(3, depth),
            view_entry(4, effect),
            view_entry(5, &self.history.view),
            view_entry(6, &self.previous_depth.view),
            wgpu::BindGroupEntry {
                binding: 7,
                resource: wgpu::BindingResource::Sampler(&self.sampler),
            },
            view_entry(8, &self.reflection.array_view),
            view_entry(9, &self.froxel.view),
        ];
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("environment-frame-group"),
            layout: &self.layout,
            entries: &entries,
        })
    }
    pub fn encode(
        &self,
        runtime: &Forge3DRuntime,
        encoder: &mut wgpu::CommandEncoder,
        color: &wgpu::TextureView,
        depth: &wgpu::TextureView,
        out: &wgpu::TextureView,
        format: wgpu::TextureFormat,
    ) {
        let context = runtime.context.as_ref().expect("context");
        let device = &context.device;
        let shadows = runtime.shadows.as_ref().expect("shadows");
        let shadow_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("environment-shadows-group"),
            layout: &self.shadow_layout,
            entries: &[
                view_entry(0, &shadows.depth_array_view),
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: shadows.uniform_buffer.as_entire_binding(),
                },
            ],
        });
        // The effect shader does not bind its own output as a sampled texture.
        if self.snapshot.volumetric_mode == "froxel" {
            self.froxel
                .encode(device, encoder, &self.uniform, depth, &shadow_group);
        }
        let group = self.group(device, color, depth, &self.history.view);
        draw(
            encoder,
            &self.effect.view,
            &self.effect_pipeline,
            &group,
            &shadow_group,
            &runtime.ibl.as_ref().unwrap().bind_group,
        );
        let group = self.group(device, color, depth, &self.effect.view);
        let mut pipelines = self.pipelines.borrow_mut();
        if !pipelines.iter().any(|(f, _)| *f == format) {
            pipelines.push((
                format,
                pipeline(
                    device,
                    &self.layout,
                    &self.shadow_layout,
                    &self.ibl_layout,
                    &self.shader,
                    "fs_composite",
                    format,
                ),
            ));
        }
        let composite = &pipelines
            .iter()
            .find(|(f, _)| *f == format)
            .expect("pipeline")
            .1;
        draw(
            encoder,
            out,
            composite,
            &group,
            &shadow_group,
            &runtime.ibl.as_ref().unwrap().bind_group,
        );
        drop(pipelines);
        // fs_depth does not sample previous depth, but its static layout still binds it:
        // use a separate bind group backed by the world color for that unused slot.
        let depth_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("environment-history-depth-group"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: self.payload.as_entire_binding(),
                },
                view_entry(2, color),
                view_entry(3, depth),
                view_entry(4, &self.effect.view),
                view_entry(5, &self.history.view),
                view_entry(6, color),
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                view_entry(8, &self.reflection.array_view),
                view_entry(9, &self.froxel.view),
            ],
        });
        draw(
            encoder,
            &self.previous_depth.view,
            &self.depth_pipeline,
            &depth_group,
            &shadow_group,
            &runtime.ibl.as_ref().unwrap().bind_group,
        );
        let (w, h) = self.snapshot.effect_size(self.width, self.height);
        encoder.copy_texture_to_texture(
            self.effect.texture.as_image_copy(),
            self.history.texture.as_image_copy(),
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        if let Ok(vp) = runtime
            .camera
            .view_projection_matrix(self.width as f32 / self.height as f32)
        {
            self.previous_vp.set(vp);
        }
        self.last_time.set(runtime.time_seconds);
        self.history_valid.set(true);
    }
}
