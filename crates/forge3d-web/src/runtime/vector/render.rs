use super::*;
impl Resources {
    pub(super) fn prepare_frame(
        &self,
        runtime: &Forge3DRuntime,
        encoder: &mut wgpu::CommandEncoder,
        vp: Option<[[f32; 4]; 4]>,
    ) {
        let c = runtime.context.as_ref().expect("live context");
        let camera =
            super::super::terrain::create_camera_uniform(&runtime.camera, self.width, self.height)
                .expect("validated camera");
        let vp = vp.unwrap_or(camera.view_projection);
        let params = Params {
            vp,
            viewport: [
                self.width as f32,
                self.height as f32,
                self.vertices.len() as f32,
                0.,
            ],
            eye: camera.camera_position,
            forward: camera.camera_forward,
            camera: [runtime.camera.near, runtime.camera.far, 0., 0.],
        };
        c.queue
            .write_buffer(&self.uniform, 0, bytemuck::bytes_of(&params));
        if let Some(compute) = &self.compute {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("vector:extrusion-culling"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &compute.group, &[]);
            pass.set_pipeline(&compute.expand);
            pass.dispatch_workgroups((self.vertices.len() as u32 / 3).div_ceil(64).max(1), 1, 1);
            let blocks = (self.vertices.len() as u32 / 3).div_ceil(256).max(1);
            pass.set_pipeline(&compute.scan_triangles);
            pass.dispatch_workgroups(blocks, 1, 1);
            pass.set_pipeline(&compute.scan_blocks);
            pass.dispatch_workgroups(blocks.div_ceil(256), 1, 1);
            pass.set_pipeline(&compute.scan_supers);
            pass.dispatch_workgroups(1, 1, 1);
            pass.set_pipeline(&compute.compact);
            pass.dispatch_workgroups((self.vertices.len() as u32 / 3).div_ceil(64).max(1), 1, 1);
        } else {
            let vertices = forge3d_core::vector::project_and_cull(
                &self.vertices,
                glam::Mat4::from_cols_array_2d(&vp),
                glam::Vec2::new(self.width as f32, self.height as f32),
            );
            if !vertices.is_empty() {
                c.queue
                    .write_buffer(&self.projected, 0, bytemuck::cast_slice(&vertices));
            }
            c.queue.write_buffer(
                &self.commands,
                0,
                bytemuck::cast_slice(&[vertices.len() as u32, 1, 0, 0]),
            );
        }
    }
    fn draw(&self, pass: &mut wgpu::RenderPass<'_>, pipeline: &wgpu::RenderPipeline) {
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &self.draw_group, &[]);
        pass.draw_indirect(&self.commands, 0);
    }
    fn layers(
        &self,
        runtime: &Forge3DRuntime,
        encoder: &mut wgpu::CommandEncoder,
        depth: &wgpu::TextureView,
        vp: Option<[[f32; 4]; 4]>,
    ) {
        self.prepare_frame(runtime, encoder, vp);
        if vp.is_some() {
            self.highlight_bounds_dirty.set(true);
        }
        // The opaque pass establishes the nearest visible vector surface.
        // OIT is then tested against terrain/scene and this vector depth.
        {
            let colors = [gpu::attachment(
                &self.opaque.view,
                Some(wgpu::Color::TRANSPARENT),
            )];
            let mut pass = gpu::pass(encoder, &colors, Some(depth), true);
            self.draw(&mut pass, &self.opaque_pipeline);
        }
        let mut colors = vec![gpu::attachment(
            &self.accum.view,
            Some(wgpu::Color::TRANSPARENT),
        )];
        if self.mode == "wboit" {
            colors.push(gpu::attachment(&self.reveal.view, Some(wgpu::Color::WHITE)));
        }
        {
            let mut pass = gpu::pass(encoder, &colors, Some(depth), false);
            self.draw(&mut pass, &self.color_pipeline);
        }
        let colors = [
            gpu::attachment(&self.id.view, Some(wgpu::Color::TRANSPARENT)),
            gpu::attachment(
                &self.depth.view,
                Some(wgpu::Color {
                    r: 1.,
                    g: 0.,
                    b: 0.,
                    a: 0.,
                }),
            ),
            gpu::attachment(&self.world.view, Some(wgpu::Color::TRANSPARENT)),
        ];
        let mut pass = gpu::pass(encoder, &colors, Some(depth), true);
        self.draw(&mut pass, &self.pick_pipeline);
        self.pick_renders.set(self.pick_renders.get() + 1);
        self.pick_dirty.set(vp.is_some());
    }
    fn resolve(
        &self,
        runtime: &Forge3DRuntime,
        encoder: &mut wgpu::CommandEncoder,
        destination: &wgpu::TextureView,
        format: wgpu::TextureFormat,
        background: Option<&Target>,
    ) {
        let c = runtime.context.as_ref().expect("live context");
        let mut mode_bytes = bytemuck::cast_slice(&[
            if self.mode == "wboit" {
                1
            } else {
                0
            },
            self.highlight_count,
            u32::from(background.is_some()),
            self.highlight_radius,
        ])
        .to_vec();
        mode_bytes.extend_from_slice(bytemuck::cast_slice(&[self.highlight_bound, 0., 0., 0.]));
        let uniform = gpu::buffer(
            &c.device,
            "vector:resolve-mode",
            &mode_bytes,
            wgpu::BufferUsages::UNIFORM,
        );
        let dirty = self.highlight_bounds_dirty.replace(false);
        if self.highlight_radius > 0 && dirty {
            let group = gpu::bind(
                &c.device,
                &self.bounds_layout,
                &[
                    B::TextureView(&self.id.view),
                    self.highlights.as_entire_binding(),
                    self.highlight_bounds.as_entire_binding(),
                    uniform.as_entire_binding(),
                ],
            );
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("vector:highlight-bounds"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &group, &[]);
            pass.set_pipeline(&self.bounds_reset);
            pass.dispatch_workgroups(1, 1, 1);
            pass.set_pipeline(&self.bounds_reduce);
            pass.dispatch_workgroups(self.width.div_ceil(8), self.height.div_ceil(8), 1);
        }
        if dirty {
            let group = gpu::bind(
                &c.device,
                &self.highlight_layout,
                &[
                    B::TextureView(&self.accum.view),
                    B::TextureView(&self.reveal.view),
                    B::TextureView(&self.id.view),
                    B::TextureView(&background.unwrap_or(&self.background).view),
                    self.highlights.as_entire_binding(),
                    uniform.as_entire_binding(),
                    B::TextureView(&self.opaque.view),
                    self.highlight_bounds.as_entire_binding(),
                ],
            );
            let colors = [
                gpu::attachment(&self.highlight_overlay.view, Some(wgpu::Color::TRANSPARENT)),
                gpu::attachment(&self.highlight_tint.view, Some(wgpu::Color::TRANSPARENT)),
            ];
            let mut pass = gpu::pass(encoder, &colors, None, false);
            pass.set_pipeline(&self.highlight_pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        let group = gpu::bind(
            &c.device,
            &self.resolve_layout,
            &[
                B::TextureView(&self.accum.view),
                B::TextureView(&self.reveal.view),
                B::TextureView(&self.id.view),
                B::TextureView(&background.unwrap_or(&self.background).view),
                self.highlights.as_entire_binding(),
                uniform.as_entire_binding(),
                B::TextureView(&self.opaque.view),
                self.highlight_bounds.as_entire_binding(),
                B::TextureView(&self.highlight_overlay.view),
                B::TextureView(&self.highlight_tint.view),
            ],
        );
        let mut pipelines = self.resolve_pipelines.borrow_mut();
        let pipeline = pipelines
            .entry((format, background.is_some()))
            .or_insert_with(|| {
                gpu::pipeline(
                    &c.device,
                    &self.resolve_layout,
                    &self.resolve_shader,
                    "fs",
                    &[gpu::target(
                        format,
                        if background.is_some() {
                            None
                        } else {
                            Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING)
                        },
                    )],
                    None,
                )
            });
        let colors = [gpu::attachment(destination, None)];
        let mut pass = gpu::pass(encoder, &colors, None, false);
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
}
pub(crate) fn encode(
    runtime: &Forge3DRuntime,
    encoder: &mut wgpu::CommandEncoder,
    color: &wgpu::TextureView,
    format: wgpu::TextureFormat,
    depth: &wgpu::TextureView,
) {
    if let Some(v) = &runtime.vectors {
        v.layers(runtime, encoder, depth, None);
        v.resolve(runtime, encoder, color, format, None);
    }
}
pub(crate) fn encode_capture(
    runtime: &Forge3DRuntime,
    encoder: &mut wgpu::CommandEncoder,
    targets: &super::super::offline::gpu::CaptureTargets,
    surface: bool,
    vp: Option<[[f32; 4]; 4]>,
) {
    let Some(v) = &runtime.vectors else { return };
    v.layers(runtime, encoder, &targets.depth_stencil.view, vp);
    let bg = if targets.color.texture.format() == wgpu::TextureFormat::Rgba16Float {
        &v.background16
    } else {
        &v.background
    };
    super::super::offline::gpu::copy_texture(
        encoder,
        &targets.color.texture,
        &bg.texture,
        v.width,
        v.height,
    );
    v.resolve(
        runtime,
        encoder,
        &targets.color.view,
        targets.color.texture.format(),
        Some(bg),
    );
    {
        let colors = [
            gpu::attachment(&targets.depth.view, None),
            gpu::attachment(&targets.id.view, None),
        ];
        let mut pass = gpu::pass(encoder, &colors, Some(&targets.depth_stencil.view), true);
        v.draw(&mut pass, &v.aov_pipeline);
    }
    if surface {
        let colors = [
            gpu::attachment(&targets.albedo.view, None),
            gpu::attachment(&targets.normal.view, None),
        ];
        let mut pass = gpu::pass(encoder, &colors, Some(&targets.depth_stencil.view), false);
        v.draw(&mut pass, &v.surface_pipeline);
    }
}
