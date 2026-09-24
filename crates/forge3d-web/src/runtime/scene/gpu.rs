use forge3d_core::gpu::GpuContext;
use wgpu::util::DeviceExt;

use super::geometry::{LitVertex, OverlayVertex};
use super::pipelines::{
    create_overlay_pipeline, create_world_capture_pipeline, create_world_pipeline, OVERLAY_SHADER,
    WORLD_SHADER,
};
use crate::error::WebError;
use crate::runtime::ibl::IblResources;
use crate::runtime::lighting::LightingResources;
use crate::runtime::offline::CapturePass;
use crate::runtime::shader_variants::{specialize, ShaderFeatures};
use crate::runtime::terrain::{create_camera_uniform, DEPTH_FORMAT};
use crate::runtime::textures::TextureResources;

#[derive(Debug, Clone)]
pub(crate) struct OverlayGeometry {
    pub bounds: [f32; 4],
    pub color: [f32; 4],
}

#[derive(Debug, Clone)]
pub(crate) struct DrawRange {
    pub pass: String,
    pub first_vertex: u32,
    pub vertex_count: u32,
    pub triangles: u64,
    pub material_index: u32,
}

#[derive(Debug, Default)]
pub(super) struct BuiltGeometry {
    pub world_vertices: Vec<LitVertex>,
    pub world_ranges: Vec<DrawRange>,
    pub overlay_vertices: Vec<OverlayVertex>,
    pub overlay_ranges: Vec<DrawRange>,
    pub overlays: Vec<OverlayGeometry>,
}

pub(crate) struct NativeScene {
    camera_layout: wgpu::BindGroupLayout,
    camera_buffer: wgpu::Buffer,
    camera_bind_group: wgpu::BindGroup,
    lighting_layout: wgpu::BindGroupLayout,
    lighting_bind_group: wgpu::BindGroup,
    texture_layout: wgpu::BindGroupLayout,
    ibl_layout: wgpu::BindGroupLayout,
    world_shader: wgpu::ShaderModule,
    /// Shader features `world_shader`/`world_pipeline` were specialized for.
    world_features: ShaderFeatures,
    overlay_shader: wgpu::ShaderModule,
    world_pipeline: wgpu::RenderPipeline,
    overlay_pipeline: wgpu::RenderPipeline,
    format: wgpu::TextureFormat,
    pub(crate) world_vertex_buffer: Option<wgpu::Buffer>,
    pub(crate) overlay_vertex_buffer: Option<wgpu::Buffer>,
    pub(crate) world_bundle: Option<wgpu::RenderBundle>,
    pub(crate) overlay_bundle: Option<wgpu::RenderBundle>,
    pub(crate) world_ranges: Vec<DrawRange>,
    pub(crate) overlay_ranges: Vec<DrawRange>,
    pub(crate) overlays: Vec<OverlayGeometry>,
    pub(crate) pass_names: Vec<String>,
    /// Offline capture pipelines `(features, primary, surface)`, compiled on
    /// the first capture and reused until the lighting features change.
    capture_world: Option<(ShaderFeatures, wgpu::RenderPipeline, wgpu::RenderPipeline)>,
    capture_overlay: Option<wgpu::RenderPipeline>,
}

impl NativeScene {
    pub(super) fn new(
        context: &GpuContext,
        format: wgpu::TextureFormat,
        geometry: BuiltGeometry,
        camera: &forge3d_core::camera::CameraInput,
        width: u32,
        height: u32,
        pass_names: Vec<String>,
        lighting: &LightingResources,
        textures: &TextureResources,
        ibl: &IblResources,
        world_features: ShaderFeatures,
    ) -> Result<Self, WebError> {
        let camera_layout =
            context
                .device
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("forge3d-web-scene-camera-layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                });
        let camera_uniform = create_camera_uniform(camera, width, height)?;
        let camera_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("forge3d-web-scene-camera-uniform"),
                contents: bytemuck::bytes_of(&camera_uniform),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        let camera_bind_group = context
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("forge3d-web-scene-camera-bind-group"),
                layout: &camera_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera_buffer.as_entire_binding(),
                }],
            });
        let world_shader = create_world_shader(context, world_features);
        let overlay_shader = context
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("forge3d-web-scene-overlay-shader"),
                source: wgpu::ShaderSource::Wgsl(OVERLAY_SHADER.into()),
            });
        let world_pipeline = create_world_pipeline(
            &context.device,
            format,
            &camera_layout,
            &lighting.bind_group_layout,
            &textures.bind_group_layout,
            &ibl.bind_group_layout,
            &world_shader,
        );
        let overlay_pipeline = create_overlay_pipeline(&context.device, format, &overlay_shader);

        let mut scene = Self {
            camera_layout,
            camera_buffer,
            camera_bind_group,
            lighting_layout: lighting.bind_group_layout.clone(),
            lighting_bind_group: lighting.bind_group.clone(),
            texture_layout: textures.bind_group_layout.clone(),
            ibl_layout: ibl.bind_group_layout.clone(),
            world_shader,
            world_features,
            overlay_shader,
            world_pipeline,
            overlay_pipeline,
            format,
            world_vertex_buffer: None,
            overlay_vertex_buffer: None,
            world_bundle: None,
            overlay_bundle: None,
            world_ranges: geometry.world_ranges.clone(),
            overlay_ranges: geometry.overlay_ranges.clone(),
            overlays: geometry.overlays.clone(),
            pass_names,
            capture_world: None,
            capture_overlay: None,
        };
        scene.upload_geometry(context, &geometry);
        scene.encode_bundles(context, textures, ibl);
        Ok(scene)
    }

    fn upload_geometry(&mut self, context: &GpuContext, geometry: &BuiltGeometry) {
        self.world_vertex_buffer = if geometry.world_vertices.is_empty() {
            None
        } else {
            Some(
                context
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("forge3d-web-scene-world-vertices"),
                        contents: bytemuck::cast_slice(&geometry.world_vertices),
                        usage: wgpu::BufferUsages::VERTEX,
                    }),
            )
        };
        self.overlay_vertex_buffer = if geometry.overlay_vertices.is_empty() {
            None
        } else {
            Some(
                context
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("forge3d-web-scene-overlay-vertices"),
                        contents: bytemuck::cast_slice(&geometry.overlay_vertices),
                        usage: wgpu::BufferUsages::VERTEX,
                    }),
            )
        };
    }

    pub(crate) fn encode_bundles(
        &mut self,
        context: &GpuContext,
        textures: &TextureResources,
        ibl: &IblResources,
    ) {
        self.world_bundle = self.world_vertex_buffer.as_ref().map(|buffer| {
            let mut encoder =
                context
                    .device
                    .create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
                        label: Some("forge3d-web-scene-world-bundle"),
                        color_formats: &[Some(self.format)],
                        depth_stencil: Some(wgpu::RenderBundleDepthStencil {
                            format: DEPTH_FORMAT,
                            depth_read_only: false,
                            stencil_read_only: true,
                        }),
                        sample_count: 1,
                        multiview: None,
                    });
            encoder.set_pipeline(&self.world_pipeline);
            encoder.set_bind_group(0, &self.camera_bind_group, &[]);
            encoder.set_bind_group(1, &self.lighting_bind_group, &[]);
            encoder.set_bind_group(3, &ibl.bind_group, &[]);
            encoder.set_vertex_buffer(0, buffer.slice(..));
            for range in &self.world_ranges {
                encoder.set_bind_group(2, textures.bind_group_for(range.material_index), &[]);
                encoder.draw(
                    range.first_vertex..range.first_vertex + range.vertex_count,
                    0..1,
                );
            }
            encoder.finish(&wgpu::RenderBundleDescriptor {
                label: Some("forge3d-web-scene-world-bundle"),
            })
        });
        self.overlay_bundle = self.overlay_vertex_buffer.as_ref().map(|buffer| {
            let mut encoder =
                context
                    .device
                    .create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
                        label: Some("forge3d-web-scene-overlay-bundle"),
                        color_formats: &[Some(self.format)],
                        depth_stencil: None,
                        sample_count: 1,
                        multiview: None,
                    });
            encoder.set_pipeline(&self.overlay_pipeline);
            encoder.set_vertex_buffer(0, buffer.slice(..));
            for range in &self.overlay_ranges {
                encoder.draw(
                    range.first_vertex..range.first_vertex + range.vertex_count,
                    0..1,
                );
            }
            encoder.finish(&wgpu::RenderBundleDescriptor {
                label: Some("forge3d-web-scene-overlay-bundle"),
            })
        });
    }

    pub(crate) fn rebuild_overlays(
        &mut self,
        context: &GpuContext,
        textures: &TextureResources,
        ibl: &IblResources,
        width: u32,
        height: u32,
    ) {
        let mut vertices = Vec::new();
        let mut ranges = Vec::with_capacity(self.overlays.len());
        for overlay in &self.overlays {
            let first_vertex = vertices.len() as u32;
            vertices.extend_from_slice(&super::geometry::overlay_vertices(
                overlay.bounds,
                overlay.color,
                width,
                height,
            ));
            ranges.push(DrawRange {
                pass: "overlay".to_string(),
                first_vertex,
                vertex_count: 6,
                triangles: 2,
                material_index: 0,
            });
        }
        self.overlay_vertex_buffer = if vertices.is_empty() {
            None
        } else {
            Some(
                context
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("forge3d-web-scene-overlay-vertices"),
                        contents: bytemuck::cast_slice(&vertices),
                        usage: wgpu::BufferUsages::VERTEX,
                    }),
            )
        };
        self.overlay_ranges = ranges;
        self.encode_bundles(context, textures, ibl);
    }

    pub(crate) fn update_camera(
        &self,
        context: &GpuContext,
        camera: &forge3d_core::camera::CameraInput,
        width: u32,
        height: u32,
    ) -> Result<(), WebError> {
        let uniform = create_camera_uniform(camera, width, height)?;
        context
            .queue
            .write_buffer(&self.camera_buffer, 0, bytemuck::bytes_of(&uniform));
        Ok(())
    }

    /// Recompiles the world pipeline for `features` and re-encodes the world
    /// bundle when they differ from the current specialization.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(crate) fn use_world_variant(
        &mut self,
        context: &GpuContext,
        features: ShaderFeatures,
        textures: &TextureResources,
        ibl: &IblResources,
    ) {
        if self.world_features == features {
            return;
        }
        self.world_shader = create_world_shader(context, features);
        self.world_features = features;
        self.world_pipeline = create_world_pipeline(
            &context.device,
            self.format,
            &self.camera_layout,
            &self.lighting_layout,
            &self.texture_layout,
            &self.ibl_layout,
            &self.world_shader,
        );
        self.encode_bundles(context, textures, ibl);
    }

    pub(crate) fn rebuild_pipelines(
        &mut self,
        context: &GpuContext,
        format: wgpu::TextureFormat,
        textures: &TextureResources,
        ibl: &IblResources,
    ) {
        self.world_pipeline = create_world_pipeline(
            &context.device,
            format,
            &self.camera_layout,
            &self.lighting_layout,
            &self.texture_layout,
            &self.ibl_layout,
            &self.world_shader,
        );
        self.overlay_pipeline =
            create_overlay_pipeline(&context.device, format, &self.overlay_shader);
        self.format = format;
        self.encode_bundles(context, textures, ibl);
    }

    /// Scene camera bind group bound to an offline capture camera buffer.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(crate) fn capture_camera_bind_group(
        &self,
        device: &wgpu::Device,
        camera_buffer: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge3d-web-scene-capture-camera-bind-group"),
            layout: &self.camera_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: camera_buffer.as_entire_binding(),
            }],
        })
    }

    /// Ensures capture pipelines exist for the current world specialization.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(crate) fn prepare_capture(&mut self, context: &GpuContext) {
        let current = self.world_features;
        let stale = self
            .capture_world
            .as_ref()
            .map_or(true, |(features, _, _)| *features != current);
        if stale && self.world_vertex_buffer.is_some() {
            let features = current.with_capture();
            let shader = context
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("forge3d-web-scene-world-capture-shader"),
                    source: wgpu::ShaderSource::Wgsl(specialize(WORLD_SHADER, features).into()),
                });
            let layouts = [
                &self.camera_layout,
                &self.lighting_layout,
                &self.texture_layout,
                &self.ibl_layout,
            ];
            let primary = create_world_capture_pipeline(
                &context.device,
                layouts,
                &shader,
                CapturePass::Primary,
            );
            let surface = create_world_capture_pipeline(
                &context.device,
                layouts,
                &shader,
                CapturePass::Surface,
            );
            self.capture_world = Some((current, primary, surface));
        }
        if self.capture_overlay.is_none() && self.overlay_vertex_buffer.is_some() {
            self.capture_overlay = Some(create_overlay_pipeline(
                &context.device,
                crate::runtime::offline::CAPTURE_OVERLAY_FORMAT,
                &self.overlay_shader,
            ));
        }
    }

    /// Draws the world geometry into an open capture pass.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(crate) fn draw_capture_world(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        which: CapturePass,
        camera_bind_group: &wgpu::BindGroup,
        textures: &TextureResources,
        ibl: &IblResources,
    ) {
        let (Some((_, primary, surface)), Some(buffer)) = (
            self.capture_world.as_ref(),
            self.world_vertex_buffer.as_ref(),
        ) else {
            return;
        };
        pass.set_pipeline(match which {
            CapturePass::Primary => primary,
            CapturePass::Surface => surface,
        });
        pass.set_bind_group(0, camera_bind_group, &[]);
        pass.set_bind_group(1, &self.lighting_bind_group, &[]);
        pass.set_bind_group(3, &ibl.bind_group, &[]);
        pass.set_vertex_buffer(0, buffer.slice(..));
        for range in &self.world_ranges {
            pass.set_bind_group(2, textures.bind_group_for(range.material_index), &[]);
            pass.draw(
                range.first_vertex..range.first_vertex + range.vertex_count,
                0..1,
            );
        }
    }

    /// Draws the overlays into an open capture overlay-layer pass.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(crate) fn draw_capture_overlays(&self, pass: &mut wgpu::RenderPass<'_>) -> bool {
        let (Some(pipeline), Some(buffer)) = (
            self.capture_overlay.as_ref(),
            self.overlay_vertex_buffer.as_ref(),
        ) else {
            return false;
        };
        pass.set_pipeline(pipeline);
        pass.set_vertex_buffer(0, buffer.slice(..));
        for range in &self.overlay_ranges {
            pass.draw(
                range.first_vertex..range.first_vertex + range.vertex_count,
                0..1,
            );
        }
        !self.overlay_ranges.is_empty()
    }

    pub(super) fn world_vertex_bytes(&self) -> u64 {
        (self
            .world_ranges
            .iter()
            .map(|range| range.vertex_count)
            .sum::<u32>() as u64)
            * std::mem::size_of::<LitVertex>() as u64
    }

    pub(super) fn overlay_vertex_bytes(&self) -> u64 {
        (self
            .overlay_ranges
            .iter()
            .map(|range| range.vertex_count)
            .sum::<u32>() as u64)
            * std::mem::size_of::<OverlayVertex>() as u64
    }
}

fn create_world_shader(context: &GpuContext, features: ShaderFeatures) -> wgpu::ShaderModule {
    context
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("forge3d-web-scene-world-shader"),
            source: wgpu::ShaderSource::Wgsl(specialize(WORLD_SHADER, features).into()),
        })
}
