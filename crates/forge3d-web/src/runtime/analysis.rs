use forge3d_core::gpu::GpuContext;
use forge3d_core::memory::MemoryCategory;
use forge3d_core::terrain::{HeightfieldAoConfig, SunVisibilityConfig, TerrainHeightmapInput};
use serde::Deserialize;
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

use super::readback::map_readback_buffer;
use super::terrain::{align_copy_bytes_per_row, TerrainAnalysisOutput};
use super::Forge3DRuntime;
use crate::error::{Forge3DErrorCode, WebError};
use crate::inputs::{HeightAoJsOptions, SunVisibilityJsOptions, TerrainHeightmapOptions};

pub(super) const TERRAIN_ANALYSIS_INPUT_KEY: &str = "terrain:analysis-input";
pub(super) const TERRAIN_ANALYSIS_OUTPUT_KEY: &str = "terrain:analysis-output";
pub(super) const TERRAIN_ANALYSIS_READBACK_KEY: &str = "terrain:analysis-readback";

const F32_BYTES: u64 = 4;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct AnalysisParamsUniform {
    dims: [f32; 4],
    spacing: [f32; 2],
    exaggeration: f32,
    domain_min: f32,
    nodata_value: f32,
    has_nodata: f32,
    strength: f32,
    bias: f32,
    counts: [u32; 4],
    direction: [f32; 4],
}

impl AnalysisParamsUniform {
    fn base(terrain: &TerrainHeightmapInput, out_w: u32, out_h: u32) -> Self {
        Self {
            dims: [
                terrain.width as f32,
                terrain.height as f32,
                out_w as f32,
                out_h as f32,
            ],
            spacing: terrain.spacing,
            exaggeration: terrain.exaggeration,
            domain_min: terrain.domain[0],
            nodata_value: terrain.nodata.unwrap_or(f32::NAN),
            has_nodata: if terrain.nodata.is_some_and(|value| !value.is_nan()) {
                1.0
            } else {
                0.0
            },
            strength: 0.0,
            bias: 0.0,
            counts: [0, 0, 0x7fc0_0000, 0],
            direction: [0.0; 4],
        }
    }

    fn for_ao(
        terrain: &TerrainHeightmapInput,
        config: &HeightfieldAoConfig,
        out_w: u32,
        out_h: u32,
    ) -> Self {
        let mut params = Self::base(terrain, out_w, out_h);
        params.strength = config.strength;
        params.counts[0] = config.directions;
        params.counts[1] = config.steps;
        params.counts[3] = u32::from(config.enabled);
        params.bias = config.max_distance;
        params
    }

    fn for_sun(
        terrain: &TerrainHeightmapInput,
        config: &SunVisibilityConfig,
        out_w: u32,
        out_h: u32,
    ) -> Self {
        let mut params = Self::base(terrain, out_w, out_h);
        params.strength = config.softness;
        params.bias = config.bias;
        params.counts[0] = config.samples;
        params.counts[1] = config.steps;
        params.counts[3] = u32::from(config.enabled);
        params.direction = [
            config.direction[0],
            config.direction[1],
            config.direction[2],
            config.max_distance,
        ];
        params
    }
}

fn create_analysis_output_texture(
    context: &GpuContext,
    label: &str,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

#[allow(clippy::too_many_arguments)]
fn dispatch_analysis_pass(
    context: &GpuContext,
    shader_source: &str,
    label: &str,
    params: &AnalysisParamsUniform,
    height_view: &wgpu::TextureView,
    output_view: &wgpu::TextureView,
    storage_format: wgpu::TextureFormat,
    out_w: u32,
    out_h: u32,
) {
    let params_buffer = context
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("forge3d-web-analysis-params"),
            contents: bytemuck::bytes_of(params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
    let layout = context
        .device
        .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge3d-web-analysis-layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: storage_format,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
            ],
        });
    let bind_group = context
        .device
        .create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge3d-web-analysis-bind-group"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(height_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(output_view),
                },
            ],
        });
    let pipeline_layout = context
        .device
        .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("forge3d-web-analysis-pipeline-layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
    let shader = context
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(label),
            source: wgpu::ShaderSource::Wgsl(shader_source.into()),
        });
    let pipeline = context
        .device
        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(label),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("forge3d-web-analysis-encoder"),
        });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some(label),
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(out_w.div_ceil(8), out_h.div_ceil(8), 1);
    }
    context.queue.submit(std::iter::once(encoder.finish()));
}

pub(super) fn run_height_ao_pass(
    context: &GpuContext,
    height_view: &wgpu::TextureView,
    terrain: &TerrainHeightmapInput,
    config: &HeightfieldAoConfig,
) -> Result<TerrainAnalysisOutput, WebError> {
    let (out_w, out_h) = config.output_dimensions(terrain.width, terrain.height);
    let (texture, view) = create_analysis_output_texture(
        context,
        "forge3d-web-terrain-ao-output",
        out_w,
        out_h,
        wgpu::TextureFormat::R32Float,
    );
    let params = AnalysisParamsUniform::for_ao(terrain, config, out_w, out_h);
    dispatch_analysis_pass(
        context,
        &analysis_shader("r32float", AO_BODY),
        "forge3d-web-terrain-ao-compute",
        &params,
        height_view,
        &view,
        wgpu::TextureFormat::R32Float,
        out_w,
        out_h,
    );
    Ok(TerrainAnalysisOutput {
        texture,
        view,
        width: out_w,
        height: out_h,
    })
}

pub(super) fn run_sun_visibility_pass(
    context: &GpuContext,
    height_view: &wgpu::TextureView,
    terrain: &TerrainHeightmapInput,
    config: &SunVisibilityConfig,
) -> Result<TerrainAnalysisOutput, WebError> {
    let (out_w, out_h) = config.output_dimensions(terrain.width, terrain.height);
    let (texture, view) = create_analysis_output_texture(
        context,
        "forge3d-web-terrain-sun-output",
        out_w,
        out_h,
        wgpu::TextureFormat::R32Float,
    );
    let params = AnalysisParamsUniform::for_sun(terrain, config, out_w, out_h);
    dispatch_analysis_pass(
        context,
        &analysis_shader("r32float", SUN_BODY),
        "forge3d-web-terrain-sun-compute",
        &params,
        height_view,
        &view,
        wgpu::TextureFormat::R32Float,
        out_w,
        out_h,
    );
    Ok(TerrainAnalysisOutput {
        texture,
        view,
        width: out_w,
        height: out_h,
    })
}

fn run_slope_aspect_pass(
    context: &GpuContext,
    height_view: &wgpu::TextureView,
    terrain: &TerrainHeightmapInput,
) -> TerrainAnalysisOutput {
    let (texture, view) = create_analysis_output_texture(
        context,
        "forge3d-web-terrain-slope-aspect-output",
        terrain.width,
        terrain.height,
        wgpu::TextureFormat::Rg32Float,
    );
    let params = AnalysisParamsUniform::base(terrain, terrain.width, terrain.height);
    dispatch_analysis_pass(
        context,
        &analysis_shader("rg32float", SLOPE_ASPECT_BODY),
        "forge3d-web-terrain-slope-aspect-compute",
        &params,
        height_view,
        &view,
        wgpu::TextureFormat::Rg32Float,
        terrain.width,
        terrain.height,
    );
    TerrainAnalysisOutput {
        texture,
        view,
        width: terrain.width,
        height: terrain.height,
    }
}

fn create_height_input_texture(
    context: &GpuContext,
    terrain: &TerrainHeightmapInput,
) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-web-analysis-height-input"),
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
    super::terrain::upload_r32float_texture(context, &texture, terrain);
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn readback_buffer_bytes(width: u32, height: u32, bytes_per_texel: u32) -> Result<u64, WebError> {
    let row_bytes = u64::from(width) * u64::from(bytes_per_texel);
    let padded = u64::from(align_copy_bytes_per_row(row_bytes as u32));
    padded.checked_mul(u64::from(height)).ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "terrain analysis readback byte accounting overflowed",
        )
    })
}

async fn read_texture_f32(
    context: &GpuContext,
    texture: &wgpu::Texture,
    width: u32,
    height: u32,
    bytes_per_texel: u32,
) -> Result<Vec<f32>, WebError> {
    let row_bytes = width * bytes_per_texel;
    let padded_row_bytes = align_copy_bytes_per_row(row_bytes);
    let buffer_size = u64::from(padded_row_bytes) * u64::from(height);
    let buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("forge3d-web-analysis-readback"),
        size: buffer_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("forge3d-web-analysis-readback-encoder"),
        });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_row_bytes),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    context.queue.submit(std::iter::once(encoder.finish()));
    let padded = map_readback_buffer(context, &buffer, buffer_size).await?;
    let tight_row = row_bytes as usize;
    let padded_row = padded_row_bytes as usize;
    let mut values = Vec::with_capacity((width * height * (bytes_per_texel / 4)) as usize);
    for y in 0..height as usize {
        let row = &padded[y * padded_row..y * padded_row + tight_row];
        values.extend_from_slice(bytemuck::cast_slice::<u8, f32>(row));
    }
    Ok(values)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ComputeRequestJs {
    kind: String,
    #[serde(default)]
    options: Option<serde_json::Value>,
}

fn set_js(target: &js_sys::Object, name: &str, value: &JsValue) -> Result<(), WebError> {
    js_sys::Reflect::set(target, &JsValue::from_str(name), value)
        .map(|_| ())
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::InternalError,
                format!("Failed to create terrain analysis property {name}"),
                error,
            )
        })
}

fn scalar_field_to_js(
    kind: &str,
    output: &TerrainAnalysisOutput,
    values: Vec<f32>,
) -> Result<JsValue, WebError> {
    let result = js_sys::Object::new();
    set_js(&result, "kind", &JsValue::from_str(kind))?;
    set_js(&result, "width", &JsValue::from_f64(output.width as f64))?;
    set_js(&result, "height", &JsValue::from_f64(output.height as f64))?;
    let array = js_sys::Float32Array::from(values.as_slice());
    set_js(&result, "values", array.as_ref())?;
    Ok(result.into())
}

pub(super) async fn read_terrain_heights_runtime(
    runtime: &mut Forge3DRuntime,
) -> Result<js_sys::Float32Array, WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let terrain = runtime.terrain.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::UnsupportedFeature,
            "No terrain has been committed to the runtime",
        )
    })?;
    let width = terrain.height_width;
    let height = terrain.height_height;
    let total_bytes = readback_buffer_bytes(width, height, F32_BYTES as u32)?;
    if total_bytes > runtime.max_buffer_size {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "terrain readback buffer of {total_bytes} bytes exceeds maxBufferSize {}",
                runtime.max_buffer_size
            ),
        ));
    }
    runtime.memory.replace(
        TERRAIN_ANALYSIS_READBACK_KEY,
        MemoryCategory::Readback,
        total_bytes,
    )?;
    let result = read_texture_f32(&context, &terrain.height_texture, width, height, 4).await;
    runtime.memory.release(TERRAIN_ANALYSIS_READBACK_KEY);
    let values = result?;
    Ok(js_sys::Float32Array::from(values.as_slice()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnalysisRequestKind {
    SlopeAspect,
    HeightAo,
    SunVisibility,
}

pub(super) async fn compute_terrain_analysis_runtime(
    runtime: &mut Forge3DRuntime,
    terrain: JsValue,
    request: JsValue,
) -> Result<JsValue, WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let limits = crate::inputs::TerrainPhysicalLimits {
        max_texture_dimension_2d: runtime.max_texture_dimension_2d,
        max_buffer_size: runtime.max_buffer_size,
    };
    let options = TerrainHeightmapOptions::from_js_value_with_limits(terrain, limits)?;
    let validated = options.validate()?;

    let request: ComputeRequestJs = serde_wasm_bindgen::from_value(request).map_err(|error| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            format!("Invalid terrain compute request: {error}"),
        )
    })?;
    let (kind, ao_config, sun_config) = match request.kind.as_str() {
        "slope-aspect" => (AnalysisRequestKind::SlopeAspect, None, None),
        "height-ao" => {
            let options: HeightAoJsOptions = match request.options {
                Some(value) => serde_json::from_value(value).map_err(|error| {
                    WebError::new(
                        Forge3DErrorCode::InvalidInput,
                        format!("Invalid heightAo options: {error}"),
                    )
                })?,
                None => HeightAoJsOptions::default(),
            };
            (
                AnalysisRequestKind::HeightAo,
                Some(options.to_config()?),
                None,
            )
        }
        "sun-visibility" => {
            let options: SunVisibilityJsOptions = match request.options {
                Some(value) => serde_json::from_value(value).map_err(|error| {
                    WebError::new(
                        Forge3DErrorCode::InvalidInput,
                        format!("Invalid sunVisibility options: {error}"),
                    )
                })?,
                None => SunVisibilityJsOptions::default(),
            };
            (
                AnalysisRequestKind::SunVisibility,
                None,
                Some(options.to_config()?),
            )
        }
        other => {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                format!("Unknown terrain compute request kind {other}"),
            ))
        }
    };

    let input_bytes = u64::from(validated.input.width)
        .checked_mul(u64::from(validated.input.height))
        .and_then(|pixels| pixels.checked_mul(F32_BYTES))
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "terrain analysis input byte accounting overflowed",
            )
        })?;
    let (out_w, out_h, out_texel_bytes) = match kind {
        AnalysisRequestKind::SlopeAspect => (validated.input.width, validated.input.height, 8u32),
        AnalysisRequestKind::HeightAo => {
            let config = ao_config.expect("ao config");
            let (w, h) = config.output_dimensions(validated.input.width, validated.input.height);
            (w, h, 4)
        }
        AnalysisRequestKind::SunVisibility => {
            let config = sun_config.expect("sun config");
            let (w, h) = config.output_dimensions(validated.input.width, validated.input.height);
            (w, h, 4)
        }
    };
    let output_bytes = u64::from(out_w)
        .checked_mul(u64::from(out_h))
        .and_then(|pixels| pixels.checked_mul(u64::from(out_texel_bytes)))
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "terrain analysis output byte accounting overflowed",
            )
        })?;
    let readback_bytes = readback_buffer_bytes(out_w, out_h, out_texel_bytes)?;
    if readback_bytes > runtime.max_buffer_size {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "terrain analysis readback buffer of {readback_bytes} bytes exceeds maxBufferSize {}",
                runtime.max_buffer_size
            ),
        ));
    }
    if let Err(error) = runtime.memory.replace(
        TERRAIN_ANALYSIS_INPUT_KEY,
        MemoryCategory::Textures,
        input_bytes,
    ) {
        return Err(error);
    }
    if let Err(error) = runtime.memory.replace(
        TERRAIN_ANALYSIS_OUTPUT_KEY,
        MemoryCategory::Textures,
        output_bytes,
    ) {
        runtime.memory.release(TERRAIN_ANALYSIS_INPUT_KEY);
        return Err(error);
    }
    if let Err(error) = runtime.memory.replace(
        TERRAIN_ANALYSIS_READBACK_KEY,
        MemoryCategory::Readback,
        readback_bytes,
    ) {
        runtime.memory.release(TERRAIN_ANALYSIS_INPUT_KEY);
        runtime.memory.release(TERRAIN_ANALYSIS_OUTPUT_KEY);
        return Err(error);
    }

    let result = compute_analysis_gpu(
        &context,
        &validated.input,
        kind,
        ao_config.as_ref(),
        sun_config.as_ref(),
        out_w,
        out_h,
        out_texel_bytes,
    )
    .await;
    runtime.memory.release(TERRAIN_ANALYSIS_INPUT_KEY);
    runtime.memory.release(TERRAIN_ANALYSIS_OUTPUT_KEY);
    runtime.memory.release(TERRAIN_ANALYSIS_READBACK_KEY);
    result
}

async fn compute_analysis_gpu(
    context: &GpuContext,
    terrain: &TerrainHeightmapInput,
    kind: AnalysisRequestKind,
    ao_config: Option<&HeightfieldAoConfig>,
    sun_config: Option<&SunVisibilityConfig>,
    out_w: u32,
    out_h: u32,
    out_texel_bytes: u32,
) -> Result<JsValue, WebError> {
    let (_height_texture, height_view) = create_height_input_texture(context, terrain);
    let output = match kind {
        AnalysisRequestKind::SlopeAspect => run_slope_aspect_pass(context, &height_view, terrain),
        AnalysisRequestKind::HeightAo => run_height_ao_pass(
            context,
            &height_view,
            terrain,
            ao_config.expect("ao config"),
        )?,
        AnalysisRequestKind::SunVisibility => run_sun_visibility_pass(
            context,
            &height_view,
            terrain,
            sun_config.expect("sun config"),
        )?,
    };
    let values = read_texture_f32(
        context,
        &output.texture,
        output.width,
        output.height,
        out_texel_bytes,
    )
    .await?;
    debug_assert_eq!(output.width, out_w);
    debug_assert_eq!(output.height, out_h);

    match kind {
        AnalysisRequestKind::SlopeAspect => {
            let count = (output.width * output.height) as usize;
            let mut slope = Vec::with_capacity(count);
            let mut aspect = Vec::with_capacity(count);
            for pair in values.chunks_exact(2) {
                slope.push(pair[0]);
                aspect.push(pair[1]);
            }
            let result = js_sys::Object::new();
            set_js(&result, "width", &JsValue::from_f64(output.width as f64))?;
            set_js(&result, "height", &JsValue::from_f64(output.height as f64))?;
            set_js(
                &result,
                "slopeRadians",
                js_sys::Float32Array::from(slope.as_slice()).as_ref(),
            )?;
            set_js(
                &result,
                "aspectRadians",
                js_sys::Float32Array::from(aspect.as_slice()).as_ref(),
            )?;
            Ok(result.into())
        }
        AnalysisRequestKind::HeightAo => scalar_field_to_js("height-ao", &output, values),
        AnalysisRequestKind::SunVisibility => scalar_field_to_js("sun-visibility", &output, values),
    }
}

pub(super) async fn read_terrain_analysis_runtime(
    runtime: &mut Forge3DRuntime,
    kind: JsValue,
) -> Result<JsValue, WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let kind_name = kind.as_string().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::InvalidInput,
            "terrain analysis kind must be a string",
        )
    })?;
    let terrain = runtime.terrain.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::UnsupportedFeature,
            "No terrain has been committed to the runtime",
        )
    })?;
    let output = match kind_name.as_str() {
        "height-ao" => terrain.ao_output.as_ref(),
        "sun-visibility" => terrain.sun_output.as_ref(),
        other => {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                format!("Unknown terrain analysis kind {other}"),
            ))
        }
    };
    let output = output.ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::UnsupportedFeature,
            format!("terrain analysis {kind_name} was not enabled for the committed terrain"),
        )
    })?;
    let total_bytes = readback_buffer_bytes(output.width, output.height, F32_BYTES as u32)?;
    if total_bytes > runtime.max_buffer_size {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "terrain analysis readback buffer of {total_bytes} bytes exceeds maxBufferSize {}",
                runtime.max_buffer_size
            ),
        ));
    }
    runtime.memory.replace(
        TERRAIN_ANALYSIS_READBACK_KEY,
        MemoryCategory::Readback,
        total_bytes,
    )?;
    let result = read_texture_f32(&context, &output.texture, output.width, output.height, 4).await;
    runtime.memory.release(TERRAIN_ANALYSIS_READBACK_KEY);
    let values = result?;
    scalar_field_to_js(&kind_name, output, values)
}

fn analysis_shader(format: &str, body: &str) -> String {
    format!(
        r#"
struct AnalysisParams {{
    dims: vec4<f32>,
    spacing: vec2<f32>,
    exaggeration: f32,
    domain_min: f32,
    nodata_value: f32,
    has_nodata: f32,
    strength: f32,
    bias: f32,
    counts: vec4<u32>,
    direction: vec4<f32>,
}};

@group(0) @binding(0) var<uniform> params: AnalysisParams;
@group(0) @binding(1) var heightmap: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<{format}, write>;

fn qnan() -> f32 {{
    return bitcast<f32>(params.counts.z);
}}

fn is_valid_height(value: f32) -> bool {{
    if (value != value) {{
        return false;
    }}
    if (params.has_nodata > 0.5 && value == params.nodata_value) {{
        return false;
    }}
    return true;
}}

fn height_texel_at_uv(uv: vec2<f32>) -> vec2<i32> {{
    let dims = vec2<i32>(i32(params.dims.x), i32(params.dims.y));
    return clamp(
        vec2<i32>(uv * params.dims.xy),
        vec2<i32>(0, 0),
        dims - vec2<i32>(1, 1),
    );
}}

fn world_height_at_uv(uv: vec2<f32>) -> f32 {{
    let texel = height_texel_at_uv(uv);
    let raw = textureLoad(heightmap, texel, 0).r;
    if (!is_valid_height(raw)) {{
        return qnan();
    }}
    return (raw - params.domain_min) * params.exaggeration;
}}

{body}
"#
    )
}

const AO_BODY: &str = r#"
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let out_w = u32(params.dims.z);
    let out_h = u32(params.dims.w);
    if (gid.x >= out_w || gid.y >= out_h) {
        return;
    }
    if (params.counts.w == 0u) {
        textureStore(output, vec2<i32>(gid.xy), vec4<f32>(1.0, 0.0, 0.0, 0.0));
        return;
    }
    let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5)) / params.dims.zw;
    let extent = params.spacing * params.dims.xy;
    let max_uv = params.bias / max(extent.x, extent.y);
    let directions = params.counts.x;
    let steps = params.counts.y;
    let step_uv = max_uv / f32(steps);
    let center = world_height_at_uv(uv);
    if (center != center) {
        textureStore(output, vec2<i32>(gid.xy), vec4<f32>(qnan(), 0.0, 0.0, 0.0));
        return;
    }
    var occlusion = 0.0;
    for (var d = 0u; d < directions; d = d + 1u) {
        let angle = 6.283185307179586 * f32(d) / f32(directions);
        let dir = vec2<f32>(cos(angle), sin(angle));
        var max_tangent = -1.0e30;
        for (var s = 1u; s <= steps; s = s + 1u) {
            let sample_uv = uv + dir * (step_uv * f32(s));
            if (sample_uv.x < 0.0 || sample_uv.x >= 1.0 || sample_uv.y < 0.0 || sample_uv.y >= 1.0) {
                break;
            }
            let sample_height = world_height_at_uv(sample_uv);
            if (sample_height != sample_height) {
                continue;
            }
            let offset = (sample_uv - uv) * extent;
            let distance = length(offset);
            if (distance > 0.001) {
                max_tangent = max(max_tangent, (sample_height - center) / distance);
            }
        }
        if (max_tangent > -1.0e30) {
            occlusion = occlusion + clamp(atan(max_tangent) / 1.5707963267948966, 0.0, 1.0);
        }
    }
    let ao = 1.0 - occlusion / f32(directions);
    let result = 1.0 + (ao - 1.0) * params.strength;
    textureStore(output, vec2<i32>(gid.xy), vec4<f32>(result, 0.0, 0.0, 0.0));
}
"#;

const SUN_BODY: &str = r#"
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let out_w = u32(params.dims.z);
    let out_h = u32(params.dims.w);
    if (gid.x >= out_w || gid.y >= out_h) {
        return;
    }
    let texel = vec2<i32>(gid.xy);
    if (params.counts.w == 0u) {
        textureStore(output, texel, vec4<f32>(1.0, 0.0, 0.0, 0.0));
        return;
    }
    let horizontal = params.direction.xz;
    let horizontal_length = length(horizontal);
    if (horizontal_length < 0.001) {
        textureStore(output, texel, vec4<f32>(1.0, 0.0, 0.0, 0.0));
        return;
    }
    let march_dir = horizontal / horizontal_length;
    let sun_tan = params.direction.y / horizontal_length;
    let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5)) / params.dims.zw;
    let extent = params.spacing * params.dims.xy;
    let samples = params.counts.x;
    let steps = params.counts.y;
    let softness = params.strength;
    let soft = softness > 0.0;
    let max_uv = params.direction.w / max(extent.x, extent.y);
    let step_uv = max_uv / f32(steps);
    let center = world_height_at_uv(uv);
    if (center != center) {
        textureStore(output, texel, vec4<f32>(qnan(), 0.0, 0.0, 0.0));
        return;
    }
    var total = 0.0;
    for (var i = 0u; i < samples; i = i + 1u) {
        let jitter = (f32(i) - (f32(samples) - 1.0) * 0.5) * 0.1;
        let jittered = march_dir + vec2<f32>(jitter, -jitter);
        let dir = normalize(jittered);
        var visibility = 1.0;
        var occlusion = 0.0;
        for (var s = 1u; s <= steps; s = s + 1u) {
            let sample_uv = uv + dir * (step_uv * f32(s));
            if (sample_uv.x < 0.0 || sample_uv.x >= 1.0 || sample_uv.y < 0.0 || sample_uv.y >= 1.0) {
                break;
            }
            let sample_height = world_height_at_uv(sample_uv);
            if (sample_height != sample_height) {
                continue;
            }
            let offset = (sample_uv - uv) * extent;
            let distance = length(offset);
            if (distance <= 0.001) {
                continue;
            }
            let expected = center + params.bias + distance * sun_tan;
            let diff = sample_height - expected;
            if (diff > 0.0) {
                if (soft) {
                    let t = clamp(diff / softness, 0.0, 1.0);
                    occlusion = max(occlusion, t * t * (3.0 - 2.0 * t));
                } else {
                    visibility = 0.0;
                    break;
                }
            }
        }
        if (soft) {
            visibility = 1.0 - occlusion;
        }
        total = total + visibility;
    }
    textureStore(output, texel, vec4<f32>(total / f32(samples), 0.0, 0.0, 0.0));
}
"#;

const SLOPE_ASPECT_BODY: &str = r#"
fn height_or_center(texel: vec2<i32>, center_height: f32) -> f32 {
    let dims = vec2<i32>(i32(params.dims.x), i32(params.dims.y));
    let clamped = clamp(texel, vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
    let raw = textureLoad(heightmap, clamped, 0).r;
    return select(center_height, raw, is_valid_height(raw));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let out_w = u32(params.dims.z);
    let out_h = u32(params.dims.w);
    if (gid.x >= out_w || gid.y >= out_h) {
        return;
    }
    let texel = vec2<i32>(gid.xy);
    let dims = vec2<i32>(i32(params.dims.x), i32(params.dims.y));
    let center_raw = textureLoad(heightmap, texel, 0).r;
    if (!is_valid_height(center_raw)) {
        textureStore(output, texel, vec4<f32>(qnan(), qnan(), 0.0, 0.0));
        return;
    }
    let xm = max(texel.x - 1, 0);
    let xp = min(texel.x + 1, dims.x - 1);
    let ym = max(texel.y - 1, 0);
    let yp = min(texel.y + 1, dims.y - 1);
    let left = (height_or_center(vec2<i32>(xm, texel.y), center_raw) - params.domain_min)
        * params.exaggeration;
    let right = (height_or_center(vec2<i32>(xp, texel.y), center_raw) - params.domain_min)
        * params.exaggeration;
    let below = (height_or_center(vec2<i32>(texel.x, ym), center_raw) - params.domain_min)
        * params.exaggeration;
    let above = (height_or_center(vec2<i32>(texel.x, yp), center_raw) - params.domain_min)
        * params.exaggeration;
    let dzdx = (right - left) / (f32(xp - xm) * params.spacing.x);
    let dzdz = (above - below) / (f32(yp - ym) * params.spacing.y);
    let slope = atan(sqrt(dzdx * dzdx + dzdz * dzdz));
    var aspect = 0.0;
    if (dzdx != 0.0 || dzdz != 0.0) {
        aspect = atan2(-dzdx, -dzdz);
        if (aspect < 0.0) {
            aspect = aspect + 6.283185307179586;
        }
    }
    textureStore(output, texel, vec4<f32>(slope, aspect, 0.0, 0.0));
}
"#;
