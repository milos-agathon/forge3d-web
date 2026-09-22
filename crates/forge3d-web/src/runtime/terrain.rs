use forge3d_core::gpu::GpuContext;
use forge3d_core::memory::{MemoryCategory, OverflowPolicy, QualityLevel};
use forge3d_core::terrain::{HeightfieldAoConfig, SunVisibilityConfig, TerrainDebugView};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

use super::memory::{
    downscaled_dimension, quality_ladder_from, quality_scale_percent, resample_heightmap,
    LedgerDowngrade,
};
use super::Forge3DRuntime;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};
use crate::inputs::{
    CameraOptions, ResizeOptions, TerrainColorRampOptions, TerrainHeightmapOptions,
    TerrainPhysicalLimits,
};

pub(super) const TERRAIN_MESH_KEY: &str = "terrain:mesh";
pub(super) const TERRAIN_HEIGHTMAP_KEY: &str = "terrain:heightmap";
pub(super) const TERRAIN_UNIFORMS_KEY: &str = "terrain:uniforms";
pub(super) const TERRAIN_AO_KEY: &str = "terrain:height-ao";
pub(super) const TERRAIN_SUN_KEY: &str = "terrain:sun-visibility";
pub(super) const TERRAIN_ANALYSIS_FALLBACK_KEY: &str = "terrain:analysis-fallback";
pub(super) const TERRAIN_ANALYSIS_FALLBACK_BYTES: u64 = 4;
pub(super) const DEPTH_TEXTURE_KEY: &str = "depth";
pub(super) const TERRAIN_UNIFORM_BYTES: u64 = (std::mem::size_of::<CameraUniform>()
    + std::mem::size_of::<ColorRampUniform>()
    + std::mem::size_of::<TerrainParamsUniform>())
    as u64;
pub(super) const DEPTH_BYTES_PER_PIXEL: u64 = 4;

pub(super) fn depth_texture_bytes(width: u32, height: u32) -> Option<u64> {
    u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(DEPTH_BYTES_PER_PIXEL))
}

pub(super) fn analysis_texture_bytes(
    width: u32,
    height: u32,
    resolution_scale: f32,
) -> Option<u64> {
    let out_w = (width as f64 * resolution_scale as f64).round().max(1.0) as u64;
    let out_h = (height as f64 * resolution_scale as f64).round().max(1.0) as u64;
    out_w
        .checked_mul(out_h)
        .and_then(|pixels| pixels.checked_mul(4))
}

pub(super) fn terrain_memory_keys() -> [&'static str; 6] {
    [
        TERRAIN_MESH_KEY,
        TERRAIN_HEIGHTMAP_KEY,
        TERRAIN_UNIFORMS_KEY,
        TERRAIN_AO_KEY,
        TERRAIN_SUN_KEY,
        TERRAIN_ANALYSIS_FALLBACK_KEY,
    ]
}

fn terrain_gpu_bytes(
    allocation: &crate::inputs::TerrainAllocation,
) -> Result<(u64, u64, u64), WebError> {
    let mesh = allocation
        .vertex_bytes
        .checked_add(allocation.index_bytes)
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "terrain mesh byte accounting overflowed",
            )
        })?;
    Ok((mesh, allocation.sample_bytes, TERRAIN_UNIFORM_BYTES))
}

fn terrain_total_bytes(
    allocation: &crate::inputs::TerrainAllocation,
    ao_bytes: u64,
    sun_bytes: u64,
) -> Result<u64, WebError> {
    let (mesh, texture, uniforms) = terrain_gpu_bytes(allocation)?;
    mesh.checked_add(texture)
        .and_then(|value| value.checked_add(uniforms))
        .and_then(|value| value.checked_add(ao_bytes))
        .and_then(|value| value.checked_add(sun_bytes))
        .and_then(|value| value.checked_add(TERRAIN_ANALYSIS_FALLBACK_BYTES))
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "terrain byte accounting overflowed",
            )
        })
}

fn analysis_output_bytes(
    config_enabled: bool,
    resolution_scale: f32,
    width: u32,
    height: u32,
) -> Result<u64, WebError> {
    if !config_enabled {
        return Ok(0);
    }
    analysis_texture_bytes(width, height, resolution_scale).ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "terrain analysis byte accounting overflowed",
        )
    })
}

struct TerrainCandidate {
    options: TerrainHeightmapOptions,
    allocation: crate::inputs::TerrainAllocation,
    total_bytes: u64,
    ao_bytes: u64,
    sun_bytes: u64,
    effective_quality: QualityLevel,
    requested_bytes: u64,
}

fn select_terrain_candidate(
    runtime: &Forge3DRuntime,
    mut terrain: TerrainHeightmapOptions,
    height_ao: &HeightfieldAoConfig,
    sun_visibility: &SunVisibilityConfig,
) -> Result<TerrainCandidate, WebError> {
    let limits = TerrainPhysicalLimits {
        max_texture_dimension_2d: runtime.max_texture_dimension_2d,
        max_buffer_size: runtime.max_buffer_size,
    };
    let requested = runtime.requested_quality;
    let requested_allocation = crate::inputs::validate_terrain_allocation(
        terrain.width,
        terrain.height,
        terrain.heights.len(),
        limits,
    )?;
    let requested_bytes = terrain_total_bytes(
        &requested_allocation,
        analysis_output_bytes(
            height_ao.enabled,
            height_ao.resolution_scale,
            terrain.width,
            terrain.height,
        )?,
        analysis_output_bytes(
            sun_visibility.enabled,
            sun_visibility.resolution_scale,
            terrain.width,
            terrain.height,
        )?,
    )?;
    let ladder = quality_ladder_from(requested);
    let levels: &[QualityLevel] = match runtime.overflow_policy {
        OverflowPolicy::Reject => &ladder[..1],
        OverflowPolicy::Downscale => ladder,
    };
    for level in levels {
        let relative =
            quality_scale_percent(*level) as f64 / quality_scale_percent(requested) as f64;
        let (width, height) = if relative >= 1.0 {
            (terrain.width, terrain.height)
        } else {
            (
                downscaled_dimension(terrain.width, relative),
                downscaled_dimension(terrain.height, relative),
            )
        };
        let allocation = crate::inputs::validate_terrain_allocation(
            width,
            height,
            (width * height) as usize,
            limits,
        )?;
        let ao_bytes =
            analysis_output_bytes(height_ao.enabled, height_ao.resolution_scale, width, height)?;
        let sun_bytes = analysis_output_bytes(
            sun_visibility.enabled,
            sun_visibility.resolution_scale,
            width,
            height,
        )?;
        let total = terrain_total_bytes(&allocation, ao_bytes, sun_bytes)?;
        if runtime
            .memory
            .fits_after_release(&terrain_memory_keys(), total)
        {
            let (heights, spacing) = if relative >= 1.0 {
                (std::mem::take(&mut terrain.heights), terrain.spacing)
            } else {
                let scale_x = if terrain.width > 1 && width > 1 {
                    (terrain.width - 1) as f32 / (width - 1) as f32
                } else {
                    1.0
                };
                let scale_z = if terrain.height > 1 && height > 1 {
                    (terrain.height - 1) as f32 / (height - 1) as f32
                } else {
                    1.0
                };
                (
                    resample_heightmap(
                        &terrain.heights,
                        terrain.width,
                        terrain.height,
                        width,
                        height,
                    ),
                    terrain
                        .spacing
                        .map(|spacing| [spacing[0] * scale_x, spacing[1] * scale_z]),
                )
            };
            return Ok(TerrainCandidate {
                options: TerrainHeightmapOptions {
                    width,
                    height,
                    heights,
                    color_ramp: terrain.color_ramp.clone(),
                    spacing,
                    exaggeration: terrain.exaggeration,
                    domain: terrain.domain,
                    nodata: terrain.nodata,
                    crs: terrain.crs.clone(),
                    height_ao: terrain.height_ao.clone(),
                    sun_visibility: terrain.sun_visibility.clone(),
                    debug_view: terrain.debug_view,
                },
                allocation,
                total_bytes: total,
                ao_bytes,
                sun_bytes,
                effective_quality: *level,
                requested_bytes,
            });
        }
    }
    Err(WebError::new(
        Forge3DErrorCode::ResourceLimitExceeded,
        format!(
            "terrain requires {requested_bytes} bytes beyond the memory budget even at the lowest quality level"
        ),
    ))
}

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
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let surface_format = runtime
        .surface_state
        .as_ref()
        .map(|state| state.config.format)
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime surface state is not available",
            )
        })?;

    let height_ao = terrain.height_ao.to_config()?;
    let sun_visibility = terrain.sun_visibility.to_config()?;
    let debug_view = terrain
        .debug_view
        .map(crate::inputs::TerrainDebugViewOption::to_core)
        .unwrap_or(TerrainDebugView::None);
    let candidate = select_terrain_candidate(runtime, terrain, &height_ao, &sun_visibility)?;
    let color_ramp = candidate.options.color_ramp.clone();
    let validated = candidate.options.validate()?;
    let resources = TerrainRenderResources::new(
        &context,
        surface_format,
        &validated.input,
        &color_ramp,
        &height_ao,
        &sun_visibility,
        debug_view,
        runtime.clear_color,
        &runtime.camera,
        runtime.width,
        runtime.height,
    )?;
    let (mesh_bytes, texture_bytes, uniform_bytes) = terrain_gpu_bytes(&candidate.allocation)?;
    runtime
        .memory
        .replace(TERRAIN_MESH_KEY, MemoryCategory::Buffers, mesh_bytes)?;
    runtime.memory.replace(
        TERRAIN_HEIGHTMAP_KEY,
        MemoryCategory::Textures,
        texture_bytes,
    )?;
    runtime
        .memory
        .replace(TERRAIN_UNIFORMS_KEY, MemoryCategory::Buffers, uniform_bytes)?;
    runtime
        .memory
        .replace(TERRAIN_AO_KEY, MemoryCategory::Textures, candidate.ao_bytes)?;
    runtime.memory.replace(
        TERRAIN_SUN_KEY,
        MemoryCategory::Textures,
        candidate.sun_bytes,
    )?;
    runtime.memory.replace(
        TERRAIN_ANALYSIS_FALLBACK_KEY,
        MemoryCategory::Textures,
        TERRAIN_ANALYSIS_FALLBACK_BYTES,
    )?;
    if candidate.effective_quality != runtime.requested_quality {
        runtime.memory.record_downgrade(LedgerDowngrade {
            requested: runtime.requested_quality,
            effective: candidate.effective_quality,
            requested_bytes: candidate.requested_bytes,
            admitted_bytes: candidate.total_bytes,
        });
    }
    runtime.terrain = Some(resources);
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
    if let Some(scene) = runtime.scene.as_ref() {
        scene.update_camera(context, &camera, runtime.width, runtime.height)?;
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
    let depth_bytes = depth_texture_bytes(width, height).ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "depth texture byte accounting overflowed",
        )
    })?;
    if !runtime
        .memory
        .fits_after_release(&[DEPTH_TEXTURE_KEY], depth_bytes)
    {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!("resized depth texture of {depth_bytes} bytes exceeds the memory budget"),
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
    runtime
        .memory
        .replace(DEPTH_TEXTURE_KEY, MemoryCategory::Textures, depth_bytes)?;

    if let Some(terrain) = runtime.terrain.as_ref() {
        terrain.update_camera(context, &runtime.camera, width, height)?;
    }
    if let Some(scene) = runtime.scene.as_mut() {
        scene.update_camera(context, &runtime.camera, width, height)?;
        scene.rebuild_overlays(context, width, height);
    }
    Ok(())
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct TerrainVertex {
    pub(super) position: [f32; 3],
    pub(super) uv: [f32; 2],
}

pub(super) const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;

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
pub(super) struct CameraUniform {
    view_projection: [[f32; 4]; 4],
}

const MAX_COLOR_RAMP_STOPS: usize = 8;
pub(super) const TERRAIN_SKIRT_DEPTH: f32 = 0.24;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct ColorRampUniform {
    pub(super) stops: [[f32; 4]; MAX_COLOR_RAMP_STOPS],
    pub(super) stop_count: u32,
    // WGSL uniform layout aligns the following vec3<u32> member to 16 bytes:
    // 128 bytes of stops + 4 stop-count bytes + 12 padding bytes + 16 clear-color bytes.
    pub(super) _stop_count_alignment_padding: [u32; 3],
    pub(super) clear_color: [f32; 4],
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

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct TerrainParamsUniform {
    pub(super) spacing: [f32; 2],
    pub(super) exaggeration: f32,
    pub(super) domain_min: f32,
    pub(super) inv_domain_span: f32,
    pub(super) nodata_value: f32,
    pub(super) has_nodata: f32,
    pub(super) debug_view: u32,
}

impl TerrainParamsUniform {
    fn from_input(
        terrain: &forge3d_core::terrain::TerrainHeightmapInput,
        debug_view: TerrainDebugView,
    ) -> Self {
        Self {
            spacing: terrain.spacing,
            exaggeration: terrain.exaggeration,
            domain_min: terrain.domain[0],
            inv_domain_span: 1.0 / (terrain.domain[1] - terrain.domain[0]),
            nodata_value: terrain.nodata.unwrap_or(f32::NAN),
            has_nodata: if terrain.nodata.is_some_and(|value| !value.is_nan()) {
                1.0
            } else {
                0.0
            },
            debug_view: match debug_view {
                TerrainDebugView::None => 0,
                TerrainDebugView::HeightAo => 1,
                TerrainDebugView::SunVisibility => 2,
            },
        }
    }
}

pub(super) struct TerrainAnalysisOutput {
    pub(super) texture: wgpu::Texture,
    pub(super) view: wgpu::TextureView,
    pub(super) width: u32,
    pub(super) height: u32,
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
    params_buffer: wgpu::Buffer,
    pub(super) height_texture: wgpu::Texture,
    pub(super) height_width: u32,
    pub(super) height_height: u32,
    pub(super) ao_output: Option<TerrainAnalysisOutput>,
    pub(super) sun_output: Option<TerrainAnalysisOutput>,
    #[allow(dead_code)]
    analysis_fallback_view: wgpu::TextureView,
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
        height_ao: &HeightfieldAoConfig,
        sun_visibility: &SunVisibilityConfig,
        debug_view: TerrainDebugView,
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
        let params_uniform = TerrainParamsUniform::from_input(terrain, debug_view);
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
        let params_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("forge3d-web-terrain-params-uniform"),
                contents: bytemuck::bytes_of(&params_uniform),
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
        let fallback = create_analysis_fallback_texture(context);
        let analysis_fallback_view = fallback.create_view(&wgpu::TextureViewDescriptor::default());
        let ao_output = if height_ao.enabled {
            Some(super::analysis::run_height_ao_pass(
                context,
                &height_view,
                terrain,
                height_ao,
            )?)
        } else {
            None
        };
        let sun_output = if sun_visibility.enabled {
            Some(super::analysis::run_sun_visibility_pass(
                context,
                &height_view,
                terrain,
                sun_visibility,
            )?)
        } else {
            None
        };
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
                        wgpu::BindGroupLayoutEntry {
                            binding: 4,
                            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Uniform,
                                has_dynamic_offset: false,
                                min_binding_size: None,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 5,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 6,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                    ],
                });
        let ao_view = ao_output
            .as_ref()
            .map(|output| &output.view)
            .unwrap_or(&analysis_fallback_view);
        let sun_view = sun_output
            .as_ref()
            .map(|output| &output.view)
            .unwrap_or(&analysis_fallback_view);
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
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: params_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: wgpu::BindingResource::TextureView(ao_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 6,
                        resource: wgpu::BindingResource::TextureView(sun_view),
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
            params_buffer,
            height_texture,
            height_width: terrain.width,
            height_height: terrain.height,
            ao_output,
            sun_output,
            analysis_fallback_view,
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
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    upload_r32float_texture(context, &texture, terrain);
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn create_analysis_fallback_texture(context: &GpuContext) -> wgpu::Texture {
    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-web-terrain-analysis-fallback"),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    context.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        bytemuck::bytes_of(&1.0f32),
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT),
            rows_per_image: Some(1),
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
    );
    texture
}

pub(super) fn create_camera_uniform(
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

pub(super) enum R32FloatUploadPlan {
    Tight { bytes_per_row: u32 },
    RowWise { row_bytes: u32 },
}

pub(super) fn r32float_upload_plan(width: u32) -> R32FloatUploadPlan {
    let row_bytes = width * std::mem::size_of::<f32>() as u32;
    if row_bytes % wgpu::COPY_BYTES_PER_ROW_ALIGNMENT == 0 {
        R32FloatUploadPlan::Tight {
            bytes_per_row: row_bytes,
        }
    } else {
        R32FloatUploadPlan::RowWise { row_bytes }
    }
}

pub(super) fn upload_r32float_texture(
    context: &GpuContext,
    texture: &wgpu::Texture,
    terrain: &forge3d_core::terrain::TerrainHeightmapInput,
) {
    let source = bytemuck::cast_slice::<f32, u8>(&terrain.heights);
    match r32float_upload_plan(terrain.width) {
        R32FloatUploadPlan::Tight { bytes_per_row } => {
            context.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                source,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(terrain.height),
                },
                wgpu::Extent3d {
                    width: terrain.width,
                    height: terrain.height,
                    depth_or_array_layers: 1,
                },
            );
        }
        R32FloatUploadPlan::RowWise { row_bytes } => {
            for y in 0..terrain.height {
                let start = (y * row_bytes) as usize;
                let row = &source[start..start + row_bytes as usize];
                context.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d { x: 0, y, z: 0 },
                        aspect: wgpu::TextureAspect::All,
                    },
                    row,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: None,
                        rows_per_image: None,
                    },
                    wgpu::Extent3d {
                        width: terrain.width,
                        height: 1,
                        depth_or_array_layers: 1,
                    },
                );
            }
        }
    }
}

pub(super) fn align_copy_bytes_per_row(value: u32) -> u32 {
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

struct TerrainParamsUniform {
    spacing: vec2<f32>,
    exaggeration: f32,
    domain_min: f32,
    inv_domain_span: f32,
    nodata_value: f32,
    has_nodata: f32,
    debug_view: u32,
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
@group(0) @binding(4) var<uniform> params: TerrainParamsUniform;
@group(0) @binding(5) var ao_texture: texture_2d<f32>;
@group(0) @binding(6) var sun_texture: texture_2d<f32>;

fn is_nan_height(value: f32) -> bool {
    let bits = bitcast<u32>(value);
    return (bits & 0x7f800000u) == 0x7f800000u && (bits & 0x007fffffu) != 0u;
}

fn is_valid_height(value: f32) -> bool {
    if (is_nan_height(value)) {
        return false;
    }
    if (params.has_nodata > 0.5 && value == params.nodata_value) {
        return false;
    }
    return true;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    let raw_height = textureSampleLevel(heightmap, nearest_sampler, input.uv, 0.0).r;
    let height = select(params.domain_min, raw_height, is_valid_height(raw_height));
    let world_position = vec3<f32>(
        input.position.x,
        input.position.y + (height - params.domain_min) * params.exaggeration,
        input.position.z,
    );
    var output: VertexOutput;
    output.position = camera.view_projection * vec4<f32>(world_position, 1.0);
    output.height = raw_height;
    output.uv = input.uv;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    if (!is_valid_height(input.height)) {
        return vec4<f32>(color_ramp.clear_color.xyz, 1.0);
    }
    if (params.debug_view == 1u) {
        return vec4<f32>(vec3<f32>(analysis_gray(input.uv, 1u)), 1.0);
    }
    if (params.debug_view == 2u) {
        return vec4<f32>(vec3<f32>(analysis_gray(input.uv, 2u)), 1.0);
    }
    let t = clamp((input.height - params.domain_min) * params.inv_domain_span, 0.0, 1.0);
    let base_color = sample_color_ramp(t);
    let normal = terrain_normal(input.uv);
    var shaded = shade_relief(base_color, normal);
    shaded = shaded * analysis_shade(input.uv, 1u) * analysis_shade(input.uv, 2u);
    let edge_fade = terrain_edge_fade(input.uv);
    return vec4<f32>(mix(color_ramp.clear_color.xyz, shaded, edge_fade), 1.0);
}

fn analysis_shade(uv: vec2<f32>, channel: u32) -> f32 {
    let raw = analysis_sample(uv, channel);
    return select(1.0, raw, raw == raw);
}

fn analysis_gray(uv: vec2<f32>, channel: u32) -> f32 {
    let raw = analysis_sample(uv, channel);
    return clamp(select(0.0, raw, raw == raw), 0.0, 1.0);
}

fn analysis_sample(uv: vec2<f32>, channel: u32) -> f32 {
    if (channel == 1u) {
        let dims = textureDimensions(ao_texture);
        let texel = clamp(
            vec2<i32>(uv * vec2<f32>(dims)),
            vec2<i32>(0, 0),
            vec2<i32>(dims) - vec2<i32>(1, 1),
        );
        return textureLoad(ao_texture, texel, 0).r;
    }
    let dims = textureDimensions(sun_texture);
    let texel = clamp(
        vec2<i32>(uv * vec2<f32>(dims)),
        vec2<i32>(0, 0),
        vec2<i32>(dims) - vec2<i32>(1, 1),
    );
    return textureLoad(sun_texture, texel, 0).r;
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
            return mix(previous.xyz, next.xyz, local_t);
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
    let center_height = height_at(center, max_texel);
    let left = height_or_center(center + vec2<i32>(-1, 0), max_texel, center_height);
    let right = height_or_center(center + vec2<i32>(1, 0), max_texel, center_height);
    let up = height_or_center(center + vec2<i32>(0, -1), max_texel, center_height);
    let down = height_or_center(center + vec2<i32>(0, 1), max_texel, center_height);
    let tangent_x = vec3<f32>(2.0 * params.spacing.x, (right - left) * params.exaggeration, 0.0);
    let tangent_z = vec3<f32>(0.0, (down - up) * params.exaggeration, 2.0 * params.spacing.y);
    return normalize(cross(tangent_z, tangent_x));
}

fn height_at(texel: vec2<i32>, max_texel: vec2<i32>) -> f32 {
    return textureLoad(heightmap, clamp(texel, vec2<i32>(0, 0), max_texel), 0).r;
}

fn height_or_center(texel: vec2<i32>, max_texel: vec2<i32>, center_height: f32) -> f32 {
    let value = height_at(texel, max_texel);
    return select(center_height, value, is_valid_height(value));
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
