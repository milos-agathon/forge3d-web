use super::*;

impl ScatterResources {
    pub(crate) fn transparent(&self) -> bool {
        self.batches
            .iter()
            .any(|b| b.input.color[3] < 1.0 || b.input.terrain_blend.enabled)
    }
    pub(crate) fn triangles(&self) -> u64 {
        self.batches
            .iter()
            .flat_map(|b| b.levels.iter().chain(&b.clusters))
            .map(|d| u64::from(d.index_count / 3) * u64::from(d.count))
            .sum()
    }
    pub(crate) fn prepare(
        &mut self,
        runtime: &Forge3DRuntime,
        uniform: &crate::runtime::terrain::CaptureCameraUniform,
    ) -> Result<(), WebError> {
        let context = runtime
            .context
            .as_ref()
            .ok_or_else(|| invalid("scatter runtime disposed"))?;
        context
            .queue
            .write_buffer(&self.camera, 0, bytemuck::bytes_of(uniform));
        let features = crate::runtime::shader_variants::runtime_lighting_features(runtime)?
            .with_capture_blend(self.transparent());
        let format = runtime.surface_state.as_ref().unwrap().config.format;
        if features != self.features || format != self.format {
            let layouts = [
                &self.layout,
                &runtime.lighting.as_ref().unwrap().bind_group_layout,
                &runtime.textures.as_ref().unwrap().bind_group_layout,
                &runtime.ibl.as_ref().unwrap().bind_group_layout,
            ];
            (self.pipeline, self.primary, self.surface) =
                pipelines(&context.device, layouts, features, format);
            self.features = features;
            self.format = format;
        }
        let (height, pages, mapping, height_scale, stream) = match runtime.terrain.as_ref() {
            Some(t) => {
                let (origin, dims, view, pages, lods, tile, slots) = if let Some(s) = &t.streaming {
                    (
                        s.placement.origin,
                        [s.pyramid.width(), s.pyramid.height()],
                        s.atlas_view.clone(),
                        s.page_table_view.clone(),
                        s.pyramid.lod_count(),
                        s.pyramid.tile_size(),
                        s.slots_per_row,
                    )
                } else {
                    (
                        t.heightfield_origin,
                        [t.height_width, t.height_height],
                        t.height_texture.create_view(&Default::default()),
                        self.fallback_pages.clone(),
                        0,
                        1,
                        1,
                    )
                };
                let span = [
                    t.params.spacing[0] * (dims[0] - 1).max(1) as f32,
                    t.params.spacing[1] * (dims[1] - 1).max(1) as f32,
                ];
                (
                    view,
                    pages,
                    [origin[0], origin[1], 1.0 / span[0], 1.0 / span[1]],
                    [t.params.domain_min, t.params.exaggeration, lods as f32, 1.0],
                    [dims[0], dims[1], tile, slots],
                )
            }
            None => (
                self.fallback_height.clone(),
                self.fallback_pages.clone(),
                [0.0, 0.0, 1.0, 1.0],
                [0.0, 1.0, 0.0, 0.0],
                [1, 1, 1, 1],
            ),
        };
        let mut stats = ScatterStats {
            batch_count: self.batches.len() as u32,
            ..Default::default()
        };
        for batch in &mut self.batches {
            let selected = batch.input.select(runtime.camera.position.into());
            stats.total_instances += selected.stats.total_instances;
            stats.visible_instances += selected.stats.visible_instances;
            stats.culled_instances += selected.stats.culled_instances;
            stats.hlod_cluster_draws += selected.stats.hlod_cluster_draws;
            stats.hlod_covered_instances += selected.stats.hlod_covered_instances;
            stats.effective_draws += selected.stats.effective_draws;
            for (i, count) in selected.stats.lod_instance_counts.iter().enumerate() {
                if stats.lod_instance_counts.len() <= i {
                    stats.lod_instance_counts.resize(i + 1, 0);
                }
                stats.lod_instance_counts[i] += count;
            }
            for (i, draw) in batch.levels.iter_mut().enumerate() {
                let instances: Vec<Instance> = selected.levels[i]
                    .iter()
                    .map(|&id| Instance {
                        rows: batch.input.transforms[id * 16..id * 16 + 16]
                            .try_into()
                            .unwrap(),
                        meta: [(batch.id_start + id as u32) as f32, 0.0, 0.0, 0.0],
                    })
                    .collect();
                upload(
                    context,
                    &self.layout,
                    &self.camera,
                    draw,
                    &instances,
                    &height,
                    &pages,
                    settings(
                        &batch.input,
                        runtime.time_seconds,
                        draw.max_height,
                        mapping,
                        height_scale,
                        stream,
                    ),
                );
            }
            for (i, draw) in batch.clusters.iter_mut().enumerate() {
                let instances = if selected.clusters.contains(&i) {
                    vec![Instance {
                        rows: glam::Mat4::IDENTITY.to_cols_array(),
                        meta: [
                            (batch.id_start + batch.input.clusters[i].instance_indices[0] as u32)
                                as f32,
                            0.0,
                            0.0,
                            0.0,
                        ],
                    }]
                } else {
                    vec![]
                };
                upload(
                    context,
                    &self.layout,
                    &self.camera,
                    draw,
                    &instances,
                    &height,
                    &pages,
                    settings(
                        &batch.input,
                        runtime.time_seconds,
                        draw.max_height,
                        mapping,
                        height_scale,
                        stream,
                    ),
                );
            }
        }
        self.stats = stats;
        Ok(())
    }
    pub(crate) fn draw(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        runtime: &Forge3DRuntime,
        capture: Option<CapturePass>,
    ) {
        pass.set_pipeline(match capture {
            None => &self.pipeline,
            Some(CapturePass::Primary) => &self.primary,
            Some(CapturePass::Surface) => &self.surface,
        });
        pass.set_bind_group(1, &runtime.lighting.as_ref().unwrap().bind_group, &[]);
        pass.set_bind_group(2, runtime.textures.as_ref().unwrap().bind_group_for(0), &[]);
        pass.set_bind_group(3, &runtime.ibl.as_ref().unwrap().bind_group, &[]);
        for b in &self.batches {
            for d in b.levels.iter().chain(&b.clusters) {
                if d.count == 0 {
                    continue;
                }
                pass.set_bind_group(0, &d.group, &[]);
                pass.set_vertex_buffer(0, d.vertex.slice(..));
                pass.set_vertex_buffer(1, d.instances.slice(..));
                pass.set_index_buffer(d.index.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..d.index_count, 0, 0..d.count);
            }
        }
    }
}
fn upload(
    context: &GpuContext,
    layout: &wgpu::BindGroupLayout,
    camera: &wgpu::Buffer,
    draw: &mut Draw,
    instances: &[Instance],
    height: &wgpu::TextureView,
    pages: &wgpu::TextureView,
    settings: Settings,
) {
    draw.count = instances.len() as u32;
    if instances.is_empty() {
        return;
    }
    context
        .queue
        .write_buffer(&draw.instances, 0, bytemuck::cast_slice(instances));
    context
        .queue
        .write_buffer(&draw.settings, 0, bytemuck::bytes_of(&settings));
    draw.group = group(
        &context.device,
        layout,
        camera,
        &draw.settings,
        height,
        pages,
    );
}
fn settings(
    batch: &ScatterBatch,
    time: f32,
    max_height: f32,
    mapping: [f32; 4],
    height: [f32; 4],
    stream: [u32; 4],
) -> Settings {
    let w = &batch.wind;
    let active = w.enabled && w.amplitude > 0.0;
    let angle = w.direction_degrees.to_radians();
    Settings {
        phase: if active {
            [
                time * w.speed * std::f32::consts::TAU,
                time * w.gust_frequency * std::f32::consts::TAU,
                w.gust_strength,
                w.rigidity,
            ]
        } else {
            [0.0; 4]
        },
        vector: if active {
            [
                angle.cos() * w.amplitude,
                0.0,
                angle.sin() * w.amplitude,
                max_height,
            ]
        } else {
            [0.0; 4]
        },
        fade: [w.bend_start, w.bend_extent, w.fade_start, w.fade_end],
        blend: [
            u32::from(batch.terrain_blend.enabled) as f32,
            batch.terrain_blend.bury_depth,
            batch.terrain_blend.fade_distance,
            0.0,
        ],
        contact: [
            u32::from(batch.terrain_contact.enabled) as f32,
            batch.terrain_contact.distance,
            batch.terrain_contact.strength,
            batch.terrain_contact.vertical_weight,
        ],
        mapping,
        height,
        stream,
    }
}
