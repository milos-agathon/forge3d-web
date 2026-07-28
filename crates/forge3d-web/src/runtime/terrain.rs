use forge3d_core::gpu::GpuContext;
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

use super::Forge3DRuntime;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};
use crate::inputs::{
    CameraOptions, ResizeOptions, TerrainColorRampOptions, TerrainHeightmapOptions,
};

pub(super) fn set_terrain_runtime(
    runtime: &mut Forge3DRuntime,
    terrain: JsValue,
) -> Result<(), WebError> {
    let terrain = TerrainHeightmapOptions::from_js_value_with_limits(
        terrain,
        crate::inputs::TerrainPhysicalLimits {
            max_texture_dimension_2d: runtime.max_texture_dimension_2d,
            max_buffer_size: runtime.max_buffer_size,
        },
    )?;
    set_terrain_options_runtime(runtime, terrain)
}

pub(super) fn set_terrain_options_runtime(
    runtime: &mut Forge3DRuntime,
    terrain: TerrainHeightmapOptions,
) -> Result<(), WebError> {
    let context = runtime.context.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let surface_state = runtime.surface_state.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime surface state is not available",
        )
    })?;

    let color_ramp = terrain.color_ramp.clone();
    let terrain = terrain.validate()?;
    runtime.terrain = Some(TerrainRenderResources::new(
        context,
        surface_state.config.format,
        &terrain,
        &color_ramp,
        runtime.clear_color,
        &runtime.camera,
        runtime.width,
        runtime.height,
    )?);
    Ok(())
}

pub(super) fn set_camera_runtime(
    runtime: &mut Forge3DRuntime,
    camera: JsValue,
) -> Result<(), WebError> {
    let context = runtime.context.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;

    let camera = CameraOptions::from_js_value(camera)?.validate()?;
    if let Some(terrain) = runtime.terrain.as_ref() {
        terrain.update_camera(context, &camera, runtime.width, runtime.height)?;
    }
    runtime.camera = camera;
    Ok(())
}

pub(super) fn resize_runtime(runtime: &mut Forge3DRuntime, size: JsValue) -> Result<(), WebError> {
    let context = runtime.context.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let surface_state = runtime.surface_state.as_mut().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime surface state is not available",
        )
    })?;

    let (width, height) = ResizeOptions::from_js_value(size)?.pixel_size()?;
    if width > runtime.max_texture_dimension_2d || height > runtime.max_texture_dimension_2d {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "canvas dimensions {width}x{height} exceed maxTextureDimension2D {}",
                runtime.max_texture_dimension_2d
            ),
        ));
    }
    runtime.canvas.set_width(width);
    runtime.canvas.set_height(height);
    surface_state
        .resize(context, width, height)
        .map_err(map_core_error)?;
    runtime.width = width;
    runtime.height = height;
    runtime.depth_attachment = Some(DepthAttachment::new(context, width, height));

    if let Some(terrain) = runtime.terrain.as_ref() {
        terrain.update_camera(context, &runtime.camera, width, height)?;
    }
    Ok(())
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct TerrainVertex {
    pub(super) position: [f32; 3],
    pub(super) uv: [f32; 2],
}

const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;

pub(super) struct DepthAttachment {
    #[allow(dead_code)]
    texture: wgpu::Texture,
    pub(super) view: wgpu::TextureView,
}

impl DepthAttachment {
    pub(super) fn new(context: &GpuContext, width: u32, height: u32) -> Self {
        let texture = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-web-terrain-depth"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self { texture, view }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CameraUniform {
    view_projection: [[f32; 4]; 4],
}

const MAX_COLOR_RAMP_STOPS: usize = 8;
pub(super) const TERRAIN_SKIRT_DEPTH: f32 = 0.24;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct ColorRampUniform {
    stops: [[f32; 4]; MAX_COLOR_RAMP_STOPS],
    stop_count: u32,
    // WGSL uniform layout aligns the following vec3<u32> member to 16 bytes:
    // 128 bytes of stops + 4 stop-count bytes + 12 padding bytes + 16 clear-color bytes.
    _stop_count_alignment_padding: [u32; 3],
    clear_color: [f32; 4],
}

impl ColorRampUniform {
    fn from_options(options: &TerrainColorRampOptions, clear_color: [f32; 4]) -> Self {
        let mut stops = [[0.0; 4]; MAX_COLOR_RAMP_STOPS];
        for (index, stop) in options.stops.iter().take(MAX_COLOR_RAMP_STOPS).enumerate() {
            stops[index] = [stop.color[0], stop.color[1], stop.color[2], stop.position];
        }
        Self {
            stops,
            stop_count: options.stops.len().min(MAX_COLOR_RAMP_STOPS) as u32,
            _stop_count_alignment_padding: [0; 3],
            clear_color,
        }
    }
}

pub(super) struct TerrainRenderResources {
    pub(super) pipeline: wgpu::RenderPipeline,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pipeline_layout: wgpu::PipelineLayout,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    shader: wgpu::ShaderModule,
    pub(super) bind_group: wgpu::BindGroup,
    pub(super) vertex_buffer: wgpu::Buffer,
    pub(super) index_buffer: wgpu::Buffer,
    pub(super) index_count: u32,
    camera_buffer: wgpu::Buffer,
    #[allow(dead_code)]
    color_ramp_buffer: wgpu::Buffer,
    #[allow(dead_code)]
    height_texture: wgpu::Texture,
    #[allow(dead_code)]
    sampler: wgpu::Sampler,
}

impl TerrainRenderResources {
    #[allow(clippy::too_many_arguments)]
    fn new(
        context: &GpuContext,
        surface_format: wgpu::TextureFormat,
        terrain: &forge3d_core::terrain::TerrainHeightmapInput,
        color_ramp: &TerrainColorRampOptions,
        clear_color: [f32; 4],
        camera: &forge3d_core::camera::CameraInput,
        width: u32,
        height: u32,
    ) -> Result<Self, WebError> {
        let (vertex_buffer, index_buffer, index_count) =
            create_terrain_mesh_buffers(context, terrain)?;
        let (height_texture, height_view) = create_height_texture(context, terrain);
        let camera_uniform = create_camera_uniform(camera, width, height)?;
        let color_ramp_uniform = ColorRampUniform::from_options(color_ramp, clear_color);
        let camera_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("forge3d-web-terrain-camera-uniform"),
                contents: bytemuck::bytes_of(&camera_uniform),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        let color_ramp_buffer =
            context
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("forge3d-web-terrain-color-ramp-uniform"),
                    contents: bytemuck::bytes_of(&color_ramp_uniform),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });
        let sampler = context.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("forge3d-web-terrain-nearest-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..wgpu::SamplerDescriptor::default()
        });
        let bind_group_layout =
            context
                .device
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("forge3d-web-terrain-bind-group-layout"),
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::VERTEX,
                            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 2,
                            visibility: wgpu::ShaderStages::VERTEX,
                            ty: wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Uniform,
                                has_dynamic_offset: false,
                                min_binding_size: None,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 3,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Uniform,
                                has_dynamic_offset: false,
                                min_binding_size: None,
                            },
                            count: None,
                        },
                    ],
                });
        let bind_group = context
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("forge3d-web-terrain-bind-group"),
                layout: &bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&height_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: camera_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: color_ramp_buffer.as_entire_binding(),
                    },
                ],
            });
        let pipeline_layout =
            context
                .device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("forge3d-web-terrain-pipeline-layout"),
                    bind_group_layouts: &[Some(&bind_group_layout)],
                    immediate_size: 0,
                });
        let shader = context
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("forge3d-web-terrain-shader"),
                source: wgpu::ShaderSource::Wgsl(TERRAIN_SHADER.into()),
            });
        let pipeline = context
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("forge3d-web-terrain-pipeline"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &[wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<TerrainVertex>() as wgpu::BufferAddress,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &[
                            wgpu::VertexAttribute {
                                offset: 0,
                                shader_location: 0,
                                format: wgpu::VertexFormat::Float32x3,
                            },
                            wgpu::VertexAttribute {
                                offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                                shader_location: 1,
                                format: wgpu::VertexFormat::Float32x2,
                            },
                        ],
                    }],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: surface_format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    strip_index_format: None,
                    front_face: wgpu::FrontFace::Ccw,
                    cull_mode: None,
                    unclipped_depth: false,
                    polygon_mode: wgpu::PolygonMode::Fill,
                    conservative: false,
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: DEPTH_FORMAT,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::LessEqual),
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });

        Ok(Self {
            pipeline,
            pipeline_layout,
            shader,
            bind_group,
            vertex_buffer,
            index_buffer,
            index_count,
            camera_buffer,
            color_ramp_buffer,
            height_texture,
            sampler,
        })
    }

    fn update_camera(
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

    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn rebuild_pipeline(
        &mut self,
        context: &GpuContext,
        surface_format: wgpu::TextureFormat,
    ) {
        self.pipeline = create_terrain_render_pipeline(
            &context.device,
            surface_format,
            &self.pipeline_layout,
            &self.shader,
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn create_terrain_render_pipeline(
    device: &wgpu::Device,
    surface_format: wgpu::TextureFormat,
    pipeline_layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("forge3d-web-terrain-pipeline"),
        layout: Some(pipeline_layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[wgpu::VertexBufferLayout {
                array_stride: std::mem::size_of::<TerrainVertex>() as wgpu::BufferAddress,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[
                    wgpu::VertexAttribute {
                        offset: 0,
                        shader_location: 0,
                        format: wgpu::VertexFormat::Float32x3,
                    },
                    wgpu::VertexAttribute {
                        offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                        shader_location: 1,
                        format: wgpu::VertexFormat::Float32x2,
                    },
                ],
            }],
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: surface_format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            strip_index_format: None,
            front_face: wgpu::FrontFace::Ccw,
            cull_mode: None,
            unclipped_depth: false,
            polygon_mode: wgpu::PolygonMode::Fill,
            conservative: false,
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

fn create_terrain_mesh_buffers(
    context: &GpuContext,
    terrain: &forge3d_core::terrain::TerrainHeightmapInput,
) -> Result<(wgpu::Buffer, wgpu::Buffer, u32), WebError> {
    let mesh = terrain.mesh_descriptor().map_err(map_core_error)?;
    let mut vertices = mesh
        .vertices
        .iter()
        .map(|vertex| TerrainVertex {
            position: vertex.position,
            uv: vertex.uv,
        })
        .collect::<Vec<_>>();
    let mut indices = mesh.indices;
    append_terrain_edge_skirts(&mut vertices, &mut indices, terrain.width, terrain.height)?;

    let vertex_buffer = context
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-web-terrain-vertices"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
    let index_buffer = context
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-web-terrain-indices"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

    Ok((vertex_buffer, index_buffer, indices.len() as u32))
}

pub(super) fn append_terrain_edge_skirts(
    vertices: &mut Vec<TerrainVertex>,
    indices: &mut Vec<u32>,
    width: u32,
    height: u32,
) -> Result<(), WebError> {
    if width < 2 || height < 2 {
        return Ok(());
    }

    let width_usize = width as usize;
    let height_usize = height as usize;
    append_horizontal_skirt(vertices, indices, 0, width_usize, false)?;
    append_horizontal_skirt(vertices, indices, height_usize - 1, width_usize, true)?;
    append_vertical_skirt(vertices, indices, 0, width_usize, height_usize, true)?;
    append_vertical_skirt(
        vertices,
        indices,
        width_usize - 1,
        width_usize,
        height_usize,
        false,
    )?;
    Ok(())
}

fn append_horizontal_skirt(
    vertices: &mut Vec<TerrainVertex>,
    indices: &mut Vec<u32>,
    row: usize,
    width: usize,
    reverse: bool,
) -> Result<(), WebError> {
    let skirt_indices = (0..width)
        .map(|column| push_skirt_vertex(vertices, row * width + column))
        .collect::<Result<Vec<_>, _>>()?;
    for column in 0..(width - 1) {
        let a = (row * width + column) as u32;
        let b = (row * width + column + 1) as u32;
        let a_skirt = skirt_indices[column];
        let b_skirt = skirt_indices[column + 1];
        if reverse {
            indices.extend_from_slice(&[a, b, a_skirt, b, b_skirt, a_skirt]);
        } else {
            indices.extend_from_slice(&[a, a_skirt, b, b, a_skirt, b_skirt]);
        }
    }
    Ok(())
}

fn append_vertical_skirt(
    vertices: &mut Vec<TerrainVertex>,
    indices: &mut Vec<u32>,
    column: usize,
    width: usize,
    height: usize,
    reverse: bool,
) -> Result<(), WebError> {
    let skirt_indices = (0..height)
        .map(|row| push_skirt_vertex(vertices, row * width + column))
        .collect::<Result<Vec<_>, _>>()?;
    for row in 0..(height - 1) {
        let a = (row * width + column) as u32;
        let b = ((row + 1) * width + column) as u32;
        let a_skirt = skirt_indices[row];
        let b_skirt = skirt_indices[row + 1];
        if reverse {
            indices.extend_from_slice(&[a, b, a_skirt, b, b_skirt, a_skirt]);
        } else {
            indices.extend_from_slice(&[a, a_skirt, b, b, a_skirt, b_skirt]);
        }
    }
    Ok(())
}

fn push_skirt_vertex(
    vertices: &mut Vec<TerrainVertex>,
    source_index: usize,
) -> Result<u32, WebError> {
    let mut vertex = *vertices.get(source_index).ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            "terrain skirt source vertex is out of range",
        )
    })?;
    vertex.position[1] -= TERRAIN_SKIRT_DEPTH;
    let index = u32::try_from(vertices.len()).map_err(|_| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            "terrain skirt mesh is too large for u32 indices",
        )
    })?;
    vertices.push(vertex);
    Ok(index)
}

fn create_height_texture(
    context: &GpuContext,
    terrain: &forge3d_core::terrain::TerrainHeightmapInput,
) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-web-terrain-height-r32float"),
        size: wgpu::Extent3d {
            width: terrain.width,
            height: terrain.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    upload_r32float_texture(context, &texture, terrain);
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn create_camera_uniform(
    camera: &forge3d_core::camera::CameraInput,
    width: u32,
    height: u32,
) -> Result<CameraUniform, WebError> {
    if height == 0 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "camera aspect ratio height must be greater than zero",
        ));
    }
    let aspect_ratio = width as f32 / height as f32;
    Ok(CameraUniform {
        view_projection: camera
            .view_projection_matrix(aspect_ratio)
            .map_err(map_core_error)?,
    })
}

fn upload_r32float_texture(
    context: &GpuContext,
    texture: &wgpu::Texture,
    terrain: &forge3d_core::terrain::TerrainHeightmapInput,
) {
    let row_bytes = terrain.width * std::mem::size_of::<f32>() as u32;
    let padded_row_bytes = align_copy_bytes_per_row(row_bytes);
    let source = bytemuck::cast_slice::<f32, u8>(&terrain.heights);
    let upload: std::borrow::Cow<'_, [u8]> = if padded_row_bytes == row_bytes {
        std::borrow::Cow::Borrowed(source)
    } else {
        let mut padded = vec![0u8; (padded_row_bytes * terrain.height) as usize];
        for y in 0..terrain.height {
            let source_start = (y * row_bytes) as usize;
            let source_end = source_start + row_bytes as usize;
            let destination_start = (y * padded_row_bytes) as usize;
            let destination_end = destination_start + row_bytes as usize;
            padded[destination_start..destination_end]
                .copy_from_slice(&source[source_start..source_end]);
        }
        std::borrow::Cow::Owned(padded)
    };

    context.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &upload,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(padded_row_bytes),
            rows_per_image: Some(terrain.height),
        },
        wgpu::Extent3d {
            width: terrain.width,
            height: terrain.height,
            depth_or_array_layers: 1,
        },
    );
}

fn align_copy_bytes_per_row(value: u32) -> u32 {
    let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    value.div_ceil(alignment) * alignment
}

pub(super) const TERRAIN_SHADER: &str = r#"
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
};

struct CameraUniform {
    view_projection: mat4x4<f32>,
};

struct ColorRampUniform {
    stops: array<vec4<f32>, 8>,
    stop_count: u32,
    clear_color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) height: f32,
    @location(1) uv: vec2<f32>,
};

@group(0) @binding(0) var heightmap: texture_2d<f32>;
@group(0) @binding(1) var nearest_sampler: sampler;
@group(0) @binding(2) var<uniform> camera: CameraUniform;
@group(0) @binding(3) var<uniform> color_ramp: ColorRampUniform;

const TERRAIN_HEIGHT_SCALE: f32 = 0.7;

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    let height = textureSampleLevel(heightmap, nearest_sampler, input.uv, 0.0).r;
    let edge_fade = terrain_edge_fade(input.uv);
    let height_scale = TERRAIN_HEIGHT_SCALE * mix(0.08, 1.0, edge_fade);
    let world_position = vec3<f32>(
        input.position.x,
        input.position.y + height * height_scale,
        input.position.z,
    );
    var output: VertexOutput;
    output.position = camera.view_projection * vec4<f32>(world_position, 1.0);
    output.height = height;
    output.uv = input.uv;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let t = clamp(input.height, 0.0, 1.0);
    let base_color = sample_color_ramp(t);
    let normal = terrain_normal(input.uv);
    let shaded = shade_relief(base_color, normal);
    let edge_fade = terrain_edge_fade(input.uv);
    return vec4<f32>(mix(color_ramp.clear_color.xyz, shaded, edge_fade), 1.0);
}

fn sample_color_ramp(t: f32) -> vec3<f32> {
    var previous = color_ramp.stops[0];
    for (var i: u32 = 1u; i < 8u; i = i + 1u) {
        if (i >= color_ramp.stop_count) {
            return previous.xyz;
        }
        let next = color_ramp.stops[i];
        if (t <= next.w) {
            let span = max(next.w - previous.w, 0.0001);
            let local_t = clamp((t - previous.w) / span, 0.0, 1.0);
            return mix(previous.xyz, next.xyz, smoothstep(0.0, 1.0, local_t));
        }
        previous = next;
    }
    return previous.xyz;
}

fn terrain_normal(uv: vec2<f32>) -> vec3<f32> {
    let dimensions = textureDimensions(heightmap);
    let max_texel = vec2<i32>(i32(dimensions.x) - 1, i32(dimensions.y) - 1);
    let scaled_uv = uv * vec2<f32>(f32(dimensions.x - 1u), f32(dimensions.y - 1u));
    let center = vec2<i32>(i32(round(scaled_uv.x)), i32(round(scaled_uv.y)));
    let left = height_at(center + vec2<i32>(-1, 0), max_texel);
    let right = height_at(center + vec2<i32>(1, 0), max_texel);
    let up = height_at(center + vec2<i32>(0, -1), max_texel);
    let down = height_at(center + vec2<i32>(0, 1), max_texel);
    let x_spacing = 2.0 / max(f32(dimensions.x - 1u), 1.0);
    let z_spacing = 2.0 / max(f32(dimensions.y - 1u), 1.0);
    let tangent_x = vec3<f32>(2.0 * x_spacing, (right - left) * TERRAIN_HEIGHT_SCALE, 0.0);
    let tangent_z = vec3<f32>(0.0, (down - up) * TERRAIN_HEIGHT_SCALE, 2.0 * z_spacing);
    return normalize(cross(tangent_z, tangent_x));
}

fn height_at(texel: vec2<i32>, max_texel: vec2<i32>) -> f32 {
    return textureLoad(heightmap, clamp(texel, vec2<i32>(0, 0), max_texel), 0).r;
}

fn terrain_edge_fade(uv: vec2<f32>) -> f32 {
    let edge_distance = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
    return smoothstep(0.0, 0.35, edge_distance);
}

fn shade_relief(color: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
    let key_light = normalize(vec3<f32>(-0.48, 0.78, 0.40));
    let fill_light = normalize(vec3<f32>(0.55, 0.45, -0.35));
    let diffuse = max(dot(normal, key_light), 0.0);
    let fill = max(dot(normal, fill_light), 0.0) * 0.12;
    let slope = clamp(1.0 - normal.y, 0.0, 1.0);
    let shade = clamp(0.50 + diffuse * 0.56 + fill + slope * 0.12, 0.42, 1.22);
    let highlight = vec3<f32>(1.0, 0.94, 0.82) * max(diffuse - 0.72, 0.0) * 0.08;
    return clamp(color * shade + highlight, vec3<f32>(0.0), vec3<f32>(1.0));
}
"#;
