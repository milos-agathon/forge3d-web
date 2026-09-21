use forge3d_core::gpu::GpuContext;
use wgpu::util::DeviceExt;

use super::geometry::ColorVertex;
use super::pipelines::{
    create_overlay_pipeline, create_world_pipeline, OVERLAY_SHADER, WORLD_SHADER,
};
use crate::error::WebError;
use crate::runtime::terrain::{create_camera_uniform, DEPTH_FORMAT};

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
}

#[derive(Debug, Default)]
pub(super) struct BuiltGeometry {
    pub world_vertices: Vec<ColorVertex>,
    pub world_ranges: Vec<DrawRange>,
    pub overlay_vertices: Vec<ColorVertex>,
    pub overlay_ranges: Vec<DrawRange>,
    pub overlays: Vec<OverlayGeometry>,
}

pub(crate) struct NativeScene {
    camera_layout: wgpu::BindGroupLayout,
    camera_buffer: wgpu::Buffer,
    camera_bind_group: wgpu::BindGroup,
    world_shader: wgpu::ShaderModule,
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
    ) -> Result<Self, WebError> {
        let camera_layout =
            context
                .device
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("forge3d-web-scene-camera-layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
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
        let world_shader = context
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("forge3d-web-scene-world-shader"),
                source: wgpu::ShaderSource::Wgsl(WORLD_SHADER.into()),
            });
        let overlay_shader = context
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("forge3d-web-scene-overlay-shader"),
                source: wgpu::ShaderSource::Wgsl(OVERLAY_SHADER.into()),
            });
        let world_pipeline =
            create_world_pipeline(&context.device, format, &camera_layout, &world_shader);
        let overlay_pipeline = create_overlay_pipeline(&context.device, format, &overlay_shader);

        let mut scene = Self {
            camera_layout,
            camera_buffer,
            camera_bind_group,
            world_shader,
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
        };
        scene.upload_geometry(context, &geometry);
        scene.encode_bundles(context);
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

    pub(super) fn encode_bundles(&mut self, context: &GpuContext) {
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
            encoder.set_vertex_buffer(0, buffer.slice(..));
            for range in &self.world_ranges {
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

    pub(crate) fn rebuild_overlays(&mut self, context: &GpuContext, width: u32, height: u32) {
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
        self.encode_bundles(context);
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

    pub(crate) fn rebuild_pipelines(&mut self, context: &GpuContext, format: wgpu::TextureFormat) {
        self.world_pipeline = create_world_pipeline(
            &context.device,
            format,
            &self.camera_layout,
            &self.world_shader,
        );
        self.overlay_pipeline =
            create_overlay_pipeline(&context.device, format, &self.overlay_shader);
        self.format = format;
        self.encode_bundles(context);
    }

    pub(super) fn world_vertex_bytes(&self) -> u64 {
        (self
            .world_ranges
            .iter()
            .map(|range| range.vertex_count)
            .sum::<u32>() as u64)
            * std::mem::size_of::<ColorVertex>() as u64
    }

    pub(super) fn overlay_vertex_bytes(&self) -> u64 {
        (self
            .overlay_ranges
            .iter()
            .map(|range| range.vertex_count)
            .sum::<u32>() as u64)
            * std::mem::size_of::<ColorVertex>() as u64
    }
}
