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
                    render_mode: terrain.render_mode,
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
    let features = super::shader_variants::runtime_lighting_features(runtime)?;
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
        runtime.terrain_pipeline_cache.as_mut().ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime terrain pipeline cache is not available",
            )
        })?,
        features,
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
    super::shadows::rebuild_terrain_depth_binding(runtime);
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
    let prepared_shadows = match (runtime.shadows.as_ref(), runtime.lighting.as_ref()) {
        (Some(shadows), Some(lighting)) => {
            let aspect = runtime.width as f32 / runtime.height.max(1) as f32;
            Some(super::shadows::prepare_shadow_state(
                &camera,
                aspect,
                &lighting.state,
                &lighting.light_ids,
                shadows,
                runtime.terrain.as_ref(),
            )?)
        }
        _ => None,
    };
    if let Some(terrain) = runtime.terrain.as_ref() {
        terrain.update_camera(context, &camera, runtime.width, runtime.height)?;
    }
    if let Some(scene) = runtime.scene.as_ref() {
        scene.update_camera(context, &camera, runtime.width, runtime.height)?;
    }
    runtime.camera = camera;
    if let (Some(shadows), Some(prepared)) = (runtime.shadows.as_mut(), prepared_shadows) {
        prepared.write(context, shadows);
    }
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
    let prepared_shadows = match (runtime.shadows.as_ref(), runtime.lighting.as_ref()) {
        (Some(shadows), Some(lighting)) => {
            let aspect = width as f32 / height.max(1) as f32;
            Some(super::shadows::prepare_shadow_state(
                &runtime.camera,
                aspect,
                &lighting.state,
                &lighting.light_ids,
                shadows,
                runtime.terrain.as_ref(),
            )?)
        }
        _ => None,
    };
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
        if let (Some(textures), Some(ibl)) = (runtime.textures.as_ref(), runtime.ibl.as_ref()) {
            scene.rebuild_overlays(context, textures, ibl, width, height);
        }
    }
    if let (Some(shadows), Some(prepared)) = (runtime.shadows.as_mut(), prepared_shadows) {
        prepared.write(context, shadows);
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
    camera_position: [f32; 4],
    camera_forward: [f32; 4],
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
    pub(super) render_mode: u32,
    pub(super) output_srgb: u32,
    pub(super) _padding: [u32; 2],
}

impl TerrainParamsUniform {
    fn from_input(
        terrain: &forge3d_core::terrain::TerrainHeightmapInput,
        debug_view: TerrainDebugView,
        surface_format: wgpu::TextureFormat,
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
            render_mode: match terrain.render_mode {
                forge3d_core::terrain::TerrainRenderMode::Perspective => 0,
                forge3d_core::terrain::TerrainRenderMode::Screen => 1,
            },
            output_srgb: u32::from(matches!(
                surface_format,
                wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
            )),
            _padding: [0; 2],
        }
    }
}

pub(super) struct TerrainAnalysisOutput {
    pub(super) texture: wgpu::Texture,
    pub(super) view: wgpu::TextureView,
    pub(super) width: u32,
    pub(super) height: u32,
}

/// Group-0 layout shared by the init-time validation pipeline and every
/// terrain bind group, so the validated pipeline can be reused as-is.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn terrain_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
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
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
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
    })
}

/// Feature-specialized terrain pipelines for one runtime, keyed by shader
/// features and surface format. Init-time validation compiles the variant for
/// the default state; terrain commits and renders reuse or add variants.
pub(super) struct TerrainPipelineCache {
    pub(super) bind_group_layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
    variants: std::collections::HashMap<(u64, wgpu::TextureFormat), TerrainPipelineVariant>,
}

#[derive(Clone)]
pub(super) struct TerrainPipelineVariant {
    pub(super) features: ShaderFeatures,
    pub(super) pipeline: wgpu::RenderPipeline,
}

impl TerrainPipelineCache {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn new(
        device: &wgpu::Device,
        lighting_layout: &wgpu::BindGroupLayout,
        texture_layout: &wgpu::BindGroupLayout,
        ibl_layout: &wgpu::BindGroupLayout,
    ) -> Self {
        let bind_group_layout = terrain_bind_group_layout(device);
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("forge3d-web-terrain-pipeline-layout"),
            bind_group_layouts: &[
                Some(&bind_group_layout),
                Some(lighting_layout),
                Some(texture_layout),
                Some(ibl_layout),
            ],
            immediate_size: 0,
        });
        Self {
            bind_group_layout,
            pipeline_layout,
            variants: std::collections::HashMap::new(),
        }
    }

    /// Returns the pipeline for `features`, compiling it on first use.
    pub(super) fn variant(
        &mut self,
        device: &wgpu::Device,
        features: ShaderFeatures,
        surface_format: wgpu::TextureFormat,
    ) -> TerrainPipelineVariant {
        let pipeline_layout = &self.pipeline_layout;
        self.variants
            .entry((features.bits(), surface_format))
            .or_insert_with(|| {
                let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("forge3d-web-terrain-shader"),
                    source: wgpu::ShaderSource::Wgsl(specialize(TERRAIN_SHADER, features).into()),
                });
                let pipeline = create_terrain_render_pipeline(
                    device,
                    surface_format,
                    pipeline_layout,
                    &shader,
                );
                TerrainPipelineVariant { features, pipeline }
            })
            .clone()
    }
}

pub(super) struct TerrainRenderResources {
    pub(super) pipeline: wgpu::RenderPipeline,
    /// Shader features the current `pipeline` was specialized for.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) features: ShaderFeatures,
    pub(super) bind_group: wgpu::BindGroup,
    pub(super) vertex_buffer: wgpu::Buffer,
    pub(super) index_buffer: wgpu::Buffer,
    pub(super) index_count: u32,
    pub(super) render_mode: u32,
    camera_buffer: wgpu::Buffer,
    #[allow(dead_code)]
    color_ramp_buffer: wgpu::Buffer,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) params_buffer: wgpu::Buffer,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) params: TerrainParamsUniform,
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
        pipeline_cache: &mut TerrainPipelineCache,
        features: ShaderFeatures,
    ) -> Result<Self, WebError> {
        let (vertex_buffer, index_buffer, index_count) =
            create_terrain_mesh_buffers(context, terrain)?;
        let (height_texture, height_view) = create_height_texture(context, terrain);
        let camera_uniform = create_camera_uniform(camera, width, height)?;
        let color_ramp_uniform = ColorRampUniform::from_options(color_ramp, clear_color);
        let params_uniform = TerrainParamsUniform::from_input(terrain, debug_view, surface_format);
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
        let bind_group_layout = pipeline_cache.bind_group_layout.clone();
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
        let variant = pipeline_cache.variant(
            &context.device,
            features.with_terrain_mode(match terrain.render_mode {
                forge3d_core::terrain::TerrainRenderMode::Perspective => 0,
                forge3d_core::terrain::TerrainRenderMode::Screen => 1,
            }),
            surface_format,
        );

        Ok(Self {
            pipeline: variant.pipeline,
            features: variant.features,
            bind_group,
            vertex_buffer,
            index_buffer,
            index_count,
            render_mode: match terrain.render_mode {
                forge3d_core::terrain::TerrainRenderMode::Perspective => 0,
                forge3d_core::terrain::TerrainRenderMode::Screen => 1,
            },
            camera_buffer,
            color_ramp_buffer,
            params_buffer,
            params: params_uniform,
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

    /// Points `pipeline` at the cached variant for `features` and `surface_format`.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(super) fn use_variant(
        &mut self,
        context: &GpuContext,
        cache: &mut TerrainPipelineCache,
        features: ShaderFeatures,
        surface_format: wgpu::TextureFormat,
    ) {
        let variant = cache.variant(
            &context.device,
            features.with_terrain_mode(self.render_mode),
            surface_format,
        );
        self.pipeline = variant.pipeline;
        self.features = variant.features;
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
    let forward = {
        let direction = [
            camera.target[0] - camera.position[0],
            camera.target[1] - camera.position[1],
            camera.target[2] - camera.position[2],
        ];
        let length = (direction[0] * direction[0]
            + direction[1] * direction[1]
            + direction[2] * direction[2])
            .sqrt();
        if length.is_finite() && length > 0.0 {
            [
                direction[0] / length,
                direction[1] / length,
                direction[2] / length,
            ]
        } else {
            [0.0, 0.0, -1.0]
        }
    };
    Ok(CameraUniform {
        view_projection: camera
            .view_projection_matrix(aspect_ratio)
            .map_err(map_core_error)?,
        camera_position: [
            camera.position[0],
            camera.position[1],
            camera.position[2],
            1.0,
        ],
        camera_forward: [forward[0], forward[1], forward[2], 0.0],
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

use super::shader_variants::{specialize, ShaderFeatures};

/// Terrain WGSL template; compile variants through [`TerrainPipelineCache`].
pub(super) const TERRAIN_SHADER: &str = concat!(
    include_str!("brdf.wgsl"),
    include_str!("ibl_lighting.wgsl"),
    include_str!("shadow_lighting.wgsl"),
    include_str!("lighting.wgsl"),
    r#"
struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
};

struct CameraUniform {
    view_projection: mat4x4<f32>,
    camera_position: vec4<f32>,
    camera_forward: vec4<f32>,
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
    render_mode: u32,
    output_srgb: u32,
    _params_pad: vec2<u32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) height: f32,
    @location(1) uv: vec2<f32>,
    @location(2) world_position: vec3<f32>,
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
    var output: VertexOutput;
    // #if terrain_screen
    if (params.render_mode == 1u) {
        // Screen mode: fullscreen triangle with fixed NDC coverage; the camera
        // uniform stays bound for shading-only view/specular terms.
        let uv = vec2<f32>(
            f32((input.vertex_index << 1u) & 2u),
            f32(input.vertex_index & 2u),
        );
        let uv_clamped = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
        let raw_height = screen_height_sample(uv_clamped);
        let height = select(params.domain_min, raw_height, is_valid_height(raw_height));
        let t = clamp(
            (height - params.domain_min) * params.inv_domain_span,
            0.0,
            1.0,
        );
        let height_display = params.domain_min + t / params.inv_domain_span;
        output.height = raw_height;
        output.uv = uv_clamped;
        output.position = vec4<f32>(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 0.0, 1.0);
        // Native screen frame: XY is the unit tile plane, Z is display height.
        output.world_position = vec3<f32>(
            uv.x - 0.5,
            uv.y - 0.5,
            height_display * params.exaggeration,
        );
        return output;
    }
    // #endif
    // #if terrain_perspective
    let raw_height = textureSampleLevel(heightmap, nearest_sampler, input.uv, 0.0).r;
    let height = select(params.domain_min, raw_height, is_valid_height(raw_height));
    output.height = raw_height;
    output.uv = input.uv;
    let world_position = vec3<f32>(
        input.position.x,
        input.position.y + (height - params.domain_min) * params.exaggeration,
        input.position.z,
    );
    output.position = camera.view_projection * vec4<f32>(world_position, 1.0);
    output.world_position = world_position;
    // #endif
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    if (params.debug_view == 1u) {
        return vec4<f32>(vec3<f32>(analysis_gray(input.uv, 1u)), 1.0);
    }
    if (params.debug_view == 2u) {
        return vec4<f32>(vec3<f32>(analysis_gray(input.uv, 2u)), 1.0);
    }
    // #if terrain_screen
    if (params.render_mode == 1u) {
        return terrain_screen_shade(input);
    }
    // #endif
    // #if terrain_perspective
    let valid_height = is_valid_height(input.height);
    let t = clamp((input.height - params.domain_min) * params.inv_domain_span, 0.0, 1.0);
    let base_color = sample_color_ramp(t);
    let normal = terrain_normal(input.uv);
    let view_direction = forge3d_safe_direction(
        camera.camera_position.xyz - input.world_position,
    );
    var tangent_xyz = vec3<f32>(1.0, 0.0, 0.0)
        - normal * dot(normal, vec3<f32>(1.0, 0.0, 0.0));
    if (dot(tangent_xyz, tangent_xyz) < 1e-8) {
        tangent_xyz = vec3<f32>(0.0, 0.0, 1.0)
            - normal * dot(normal, vec3<f32>(0.0, 0.0, 1.0));
    }
    let tangent = vec4<f32>(forge3d_safe_direction(tangent_xyz), 1.0);
    let view_depth = dot(
        camera.camera_forward.xyz,
        input.world_position - camera.camera_position.xyz,
    );
    var shaded = forge3d_evaluate_lighting(
        base_color,
        input.world_position,
        normal,
        view_direction,
        0u,
        input.uv,
        tangent,
        view_depth,
    );
    shaded = shaded * analysis_shade(input.uv, 1u) * analysis_shade(input.uv, 2u);
    let edge_fade = terrain_edge_fade(input.uv);
    let lit = mix(color_ramp.clear_color.xyz, shaded, edge_fade);
    return vec4<f32>(select(lit, color_ramp.clear_color.xyz, !valid_height), 1.0);
    // #else
    return vec4<f32>(color_ramp.clear_color.xyz, 1.0);
    // #endif
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

// Terrain screen render mode: ports the historical terrain_pbr_pom screen
// path (fullscreen coverage, stylized hillshade composition, filmic tonemap).

fn screen_height_sample(uv_in: vec2<f32>) -> f32 {
    // The historical screen path binds the R32Float heightmap without float
    // filtering, so every height fetch resolves to the nearest texel
    // (clamp-to-edge); normals are piecewise constant per texel.
    let uv = clamp(uv_in, vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0));
    let dims = vec2<f32>(textureDimensions(heightmap, 0));
    let max_texel = vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1);
    return height_at(vec2<i32>(floor(uv * dims)), max_texel);
}

fn screen_height_geom(uv: vec2<f32>) -> f32 {
    let raw = screen_height_sample(uv);
    let span = 1.0 / params.inv_domain_span;
    let t = clamp((raw - params.domain_min) * params.inv_domain_span, 0.0, 1.0);
    return params.domain_min + t * span;
}

fn screen_height_lod(uv: vec2<f32>) -> f32 {
    let dims = vec2<f32>(textureDimensions(heightmap, 0));
    let max_lod = f32(textureNumLevels(heightmap) - 1u);
    let rho = max(length(dpdx(uv) * dims), length(dpdy(uv) * dims));
    return clamp(log2(max(rho, 1.0)), 0.0, max_lod);
}

fn screen_height_normal(uv: vec2<f32>) -> vec3<f32> {
    let dims = vec2<f32>(textureDimensions(heightmap, 0));
    let lod = screen_height_lod(uv);
    let texel_uv = exp2(lod) / dims;
    let offset_x = vec2<f32>(texel_uv.x, 0.0);
    let offset_y = vec2<f32>(0.0, texel_uv.y);
    let tl = screen_height_geom(uv - offset_x - offset_y);
    let t = screen_height_geom(uv - offset_y);
    let tr = screen_height_geom(uv + offset_x - offset_y);
    let l = screen_height_geom(uv - offset_x);
    let r = screen_height_geom(uv + offset_x);
    let bl = screen_height_geom(uv - offset_x + offset_y);
    let b = screen_height_geom(uv + offset_y);
    let br = screen_height_geom(uv + offset_x + offset_y);
    let dx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    let dy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
    // Native screen mode fixes spacing to 1.0 (world tile is a unit square).
    let world_texel = texel_uv;
    let vertical_scale = max(params.exaggeration * 0.5, 1e-3);
    return normalize(
        vec3<f32>(-dx / world_texel.x, vertical_scale, -dy / world_texel.y),
    );
}

fn screen_hue_variation(
    albedo: vec3<f32>,
    slope_factor: f32,
    height_norm: f32,
    hue_shift_strength: f32,
) -> vec3<f32> {
    if (hue_shift_strength <= 0.0) {
        return albedo;
    }
    let max_c = max(max(albedo.r, albedo.g), albedo.b);
    let min_c = min(min(albedo.r, albedo.g), albedo.b);
    let delta = max_c - min_c;
    if (delta < 0.001) {
        return albedo;
    }
    var hue: f32;
    if (max_c == albedo.r) {
        hue = ((albedo.g - albedo.b) / delta) / 6.0;
        if (hue < 0.0) {
            hue = hue + 1.0;
        }
    } else if (max_c == albedo.g) {
        hue = (2.0 + (albedo.b - albedo.r) / delta) / 6.0;
    } else {
        hue = (4.0 + (albedo.r - albedo.g) / delta) / 6.0;
    }
    let saturation = delta / max_c;
    let value = max_c;
    let slope_shift = (slope_factor - 0.5) * hue_shift_strength;
    let elev_shift = (height_norm - 0.5) * hue_shift_strength * 0.4;
    let noise_shift = (saturation - 0.5) * hue_shift_strength * 0.5;
    let new_hue = fract(hue + slope_shift + elev_shift + noise_shift);
    let c = saturation * value;
    let x = c * (1.0 - abs(fract(new_hue * 6.0) * 2.0 - 1.0));
    let m = value - c;
    var rgb: vec3<f32>;
    let h6 = new_hue * 6.0;
    if (h6 < 1.0) {
        rgb = vec3<f32>(c, x, 0.0);
    } else if (h6 < 2.0) {
        rgb = vec3<f32>(x, c, 0.0);
    } else if (h6 < 3.0) {
        rgb = vec3<f32>(0.0, c, x);
    } else if (h6 < 4.0) {
        rgb = vec3<f32>(0.0, x, c);
    } else if (h6 < 5.0) {
        rgb = vec3<f32>(x, 0.0, c);
    } else {
        rgb = vec3<f32>(c, 0.0, x);
    }
    return rgb + vec3<f32>(m, m, m);
}

fn screen_layer_roughness(height_norm: f32, slope_factor: f32) -> f32 {
    // Historical MaterialSet.terrain_default: four layers centered at
    // 0, 1/3, 2/3, 1 with roughness [0.50, 0.85, 0.50, 0.25], blend_half 0.125.
    let centers = vec4<f32>(0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0);
    let roughness = vec4<f32>(0.5, 0.85, 0.5, 0.25);
    let sigma = 0.125 * 1.5;
    var weight_sum = 0.0;
    var blended = 0.0;
    for (var idx = 0u; idx < 4u; idx = idx + 1u) {
        let dist = abs(height_norm - centers[idx]);
        let height_weight = exp(-dist * dist / (2.0 * sigma * sigma));
        var slope_mod = 1.0;
        if (idx == 0u) {
            slope_mod = mix(1.0, 1.5, slope_factor);
        } else if (idx == 1u) {
            slope_mod = mix(1.0, 0.5, slope_factor);
        }
        let weight = height_weight * slope_mod;
        weight_sum = weight_sum + weight;
        blended = blended + roughness[idx] * weight;
    }
    if (weight_sum <= 1e-5) {
        return roughness[0];
    }
    return blended / weight_sum;
}

struct ScreenIblSplit {
    diffuse: vec3<f32>,
    specular: vec3<f32>,
};

fn screen_ibl_split(
    n: vec3<f32>,
    v: vec3<f32>,
    base_color: vec3<f32>,
    roughness: f32,
    f0: vec3<f32>,
) -> ScreenIblSplit {
    let rotation = forge3d_ibl.rotation_radians;
    let rotated_normal = forge3d_ibl_rotate_y(n, rotation);
    let rotated_reflection = forge3d_ibl_rotate_y(reflect(-v, n), rotation);
    let n_dot_v = clamp(dot(n, v), 0.0, 1.0);
    let rough = clamp(roughness, 0.0, 1.0);
    let one_minus_cos = clamp(1.0 - n_dot_v, 0.0, 1.0);
    let pow5 = one_minus_cos * one_minus_cos * one_minus_cos
        * one_minus_cos * one_minus_cos;
    let fresnel = f0 + (max(vec3<f32>(1.0 - rough), f0) - f0) * pow5;
    let k_d = vec3<f32>(1.0) - fresnel;
    let irradiance = textureSampleLevel(
        forge3d_ibl_irradiance,
        forge3d_ibl_sampler,
        rotated_normal,
        0.0,
    ).rgb;
    let diffuse = k_d * base_color * irradiance;
    let mip_count = max(forge3d_ibl.specular_mip_count, 1u);
    let mip_level = min(rough * rough * 9.0, f32(mip_count - 1u));
    let prefiltered = textureSampleLevel(
        forge3d_ibl_specular,
        forge3d_ibl_sampler,
        rotated_reflection,
        mip_level,
    ).rgb;
    let brdf = textureSampleLevel(
        forge3d_ibl_brdf_lut,
        forge3d_ibl_sampler,
        vec2<f32>(n_dot_v, rough),
        0.0,
    ).rg;
    let specular = prefiltered * (fresnel * brdf.x + brdf.y);
    var split: ScreenIblSplit;
    split.diffuse = diffuse;
    split.specular = specular;
    return split;
}

fn tonemap_filmic_terrain(color: vec3<f32>) -> vec3<f32> {
    let a = 0.22;
    let b = 0.30;
    let c = 0.10;
    let d = 0.20;
    let e = 0.01;
    let f = 0.30;
    let w = 11.2;
    let x = max(color, vec3<f32>(0.0));
    let curve = ((x * (a * x + vec3<f32>(c * b)) + vec3<f32>(d * e))
        / (x * (a * x + vec3<f32>(b)) + vec3<f32>(d * f)))
        - vec3<f32>(e / f);
    let white = ((w * (a * w + c * b) + d * e) / (w * (a * w + b) + d * f))
        - e / f;
    return clamp(curve / white, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn srgb_eotf_decode(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

fn screen_output_encode(linear: vec3<f32>) -> vec3<f32> {
    let gamma = pow(
        clamp(linear, vec3<f32>(0.0), vec3<f32>(1.0)),
        vec3<f32>(1.0 / 2.2),
    );
    if (params.output_srgb == 1u) {
        return srgb_eotf_decode(gamma);
    }
    return gamma;
}

// Historical screen-mode comparison sampling: the native shadow sampler was a
// linear comparison sampler, so each requested uv blends four binary
// depth-test results on cascade layer 0.
fn screen_shadow_compare_linear(shadow_uv: vec2<f32>, depth: f32) -> f32 {
    let size = max(forge3d_shadows.params0.x, 1.0);
    let dims = vec2<i32>(i32(size), i32(size));
    let p = shadow_uv * size - vec2<f32>(0.5, 0.5);
    let base = vec2<i32>(floor(p));
    let f = p - floor(p);
    var total = 0.0;
    for (var oy = 0; oy < 2; oy = oy + 1) {
        for (var ox = 0; ox < 2; ox = ox + 1) {
            let texel = clamp(
                base + vec2<i32>(ox, oy),
                vec2<i32>(0, 0),
                dims - vec2<i32>(1, 1),
            );
            let stored = textureLoad(forge3d_shadow_depth, texel, 0, 0);
            let lit = select(0.0, 1.0, depth <= stored);
            let weight = select(1.0 - f.x, f.x, ox == 1)
                * select(1.0 - f.y, f.y, oy == 1);
            total = total + lit * weight;
        }
    }
    return total;
}

fn terrain_screen_shadow(
    uv: vec2<f32>,
    height_norm: f32,
    normal: vec3<f32>,
    light_dir: vec3<f32>,
) -> f32 {
    if (!forge3d_shadow_enabled() || forge3d_shadows.control.z == 0u) {
        return 1.0;
    }
    // Historical screen-mode receiver: native Z-up position on the unit tile.
    let receiver = vec3<f32>(
        uv.x - 0.5,
        uv.y - 0.5,
        height_norm * params.exaggeration,
    );
    let clip = forge3d_shadows.matrices[0] * vec4<f32>(receiver, 1.0);
    let ndc = clip.xyz / clip.w;
    let shadow_uv = vec2<f32>(ndc.x * 0.5 + 0.5, ndc.y * -0.5 + 0.5);
    if (shadow_uv.x < 0.0 || shadow_uv.x > 1.0
        || shadow_uv.y < 0.0 || shadow_uv.y > 1.0
        || ndc.z < 0.0 || ndc.z > 1.0)
    {
        return 1.0;
    }
    let n_dot_l = max(dot(normal, light_dir), 0.0);
    let slope = clamp(1.0 - n_dot_l, 0.0, 1.0);
    let bias = forge3d_shadows.params0.z
        + forge3d_shadows.params1.x * slope
        + forge3d_shadows.params0.w;
    let compare_depth = ndc.z - bias;
    let filter_scale = max(forge3d_shadows.params2.x, 1.0);
    let texel_uv = (1.0 / max(forge3d_shadows.params0.x, 1.0)) * filter_scale;
    var sum = 0.0;
    for (var y = -2; y <= 2; y = y + 1) {
        for (var x = -2; x <= 2; x = x + 1) {
            sum = sum + screen_shadow_compare_linear(
                shadow_uv + vec2<f32>(f32(x), f32(y)) * texel_uv,
                compare_depth,
            );
        }
    }
    return sum / 25.0;
}

fn terrain_screen_shade(input: VertexOutput) -> vec4<f32> {
    let uv = input.uv;
    let h_raw = screen_height_sample(uv);
    let valid_height = is_valid_height(h_raw);
    let height_clamped = clamp(
        select(params.domain_min, h_raw, valid_height),
        params.domain_min,
        params.domain_min + 1.0 / params.inv_domain_span,
    );
    let height_norm = clamp(
        (height_clamped - params.domain_min) * params.inv_domain_span,
        0.0,
        1.0,
    );
    var albedo = sample_color_ramp(height_norm);

    let base_normal = vec3<f32>(0.0, 0.0, 1.0);
    let slope_factor = clamp(1.0 - abs(base_normal.y), 0.04, 1.0);
    albedo = screen_hue_variation(albedo, slope_factor, height_norm, 0.08);

    let lod = screen_height_lod(uv);
    let lod_fade = 1.0 - smoothstep(1.0, 4.0, lod);
    let normal_strength = clamp(1.0, 0.25, 4.0);
    let height_normal = screen_height_normal(uv);
    let amplified = normalize(
        base_normal + (height_normal - base_normal) * normal_strength,
    );
    let shading_normal = normalize(mix(base_normal, amplified, lod_fade));

    // Native screen frame is Z-up; the interpolated vertex position reproduces
    // the historical fullscreen-triangle world position for view/specular terms.
    let world_pos = input.world_position;
    let view_dir = normalize(camera.camera_position.xyz - world_pos);

    // First shadow-casting directional light; fall back to any directional.
    var light_travel = vec3<f32>(0.0, 0.0, 0.0);
    var light_color = vec3<f32>(0.0, 0.0, 0.0);
    var light_found = false;
    let light_total = min(forge3d_lighting.light_count, 64u);
    for (var i = 0u; i < light_total; i = i + 1u) {
        let light = forge3d_lights[i];
        if ((light.enabled & 1u) == 0u || light.kind != 0u) {
            continue;
        }
        if (!light_found || light.casts_shadow != 0u) {
            light_travel = light.direction_inner_cos.xyz;
            light_color = max(light.color_intensity.rgb, vec3<f32>(0.0))
                * max(light.color_intensity.a, 0.0);
            light_found = true;
            if (light.casts_shadow != 0u) {
                break;
            }
        }
    }
    // Map the shared Y-up to-sun direction into the native screen frame.
    let light_dir = forge3d_safe_direction(
        vec3<f32>(-light_travel.x, light_travel.z, -light_travel.y),
    );
    let sun_intensity = length(light_color);

    // Historical screen-mode shadow receiver path: dedicated fixed light
    // matrix and native bias/PCSS; deliberately not the general CSM chain.
    let shadow_visibility = terrain_screen_shadow(
        uv,
        height_norm,
        shading_normal,
        light_dir,
    );
    let shadow_factor = mix(0.8, 1.0, shadow_visibility);
    let shadow_clamped = max(shadow_factor, 0.30);
    let sun_vis = max(analysis_sample(uv, 2u), 0.30);
    let combined_shadow = shadow_clamped * sun_vis;
    let ao_clamped = max(analysis_sample(uv, 1u), 0.65);
    let ao_shadow_factor = ao_clamped * combined_shadow;

    let n_dot_l = max(dot(shading_normal, light_dir), 0.0);
    let ambient_interp = mix(0.32, 0.10, n_dot_l);
    let sun_contrib = (0.36 - 0.10) * n_dot_l * sun_intensity;
    let base_diffuse = ambient_interp + sun_contrib;
    let slope_steepness = 1.0 - abs(shading_normal.y);
    let normal_gradient = length(dpdx(shading_normal)) + length(dpdy(shading_normal));
    let edge_signal = slope_steepness * 0.3 + normal_gradient * 15.0;
    let edge_bright = clamp(edge_signal * (n_dot_l + 0.3), 0.0, 0.25);
    let edge_dark = clamp(edge_signal * (1.0 - n_dot_l) * 0.5, 0.0, 0.15);
    let diffuse_raw = base_diffuse + edge_bright - edge_dark;
    let diffuse_lit = diffuse_raw * ao_shadow_factor;

    let roughness = clamp(
        screen_layer_roughness(height_norm, slope_factor),
        0.25,
        1.0,
    );
    let f0 = vec3<f32>(0.04, 0.04, 0.04);
    let ibl_split = screen_ibl_split(
        shading_normal,
        view_dir,
        albedo,
        roughness,
        f0,
    );
    let ibl_diffuse_factor = length(ibl_split.diffuse) * forge3d_ibl.intensity;
    let ibl_term = ibl_diffuse_factor * 0.18 * 0.35;
    let lighting_factor = diffuse_lit + ibl_term;
    let lit_albedo = albedo * lighting_factor;
    let spec_contrib = ibl_split.specular * forge3d_ibl.intensity * 0.12;
    let spec_capped = min(spec_contrib, albedo * 0.20);

    var shaded = lit_albedo + spec_capped;
    shaded = shaded * max(forge3d_lighting.exposure, 0.0);
    let mapped = tonemap_filmic_terrain(shaded);
    return vec4<f32>(
        select(color_ramp.clear_color.xyz, screen_output_encode(mapped), valid_height),
        1.0,
    );
}

"#,
);
