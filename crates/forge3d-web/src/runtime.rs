#[cfg(target_arch = "wasm32")]
use forge3d_core::gpu::GpuRuntimeOptions;
use forge3d_core::gpu::{GpuContext, GpuRuntime, SurfaceState};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;
use wgpu::util::DeviceExt;

#[cfg(target_arch = "wasm32")]
use crate::error::map_core_error;
use crate::error::{to_js_error, Forge3DErrorCode, WebError};
#[cfg(target_arch = "wasm32")]
use crate::inputs::RuntimeOptions;
use crate::inputs::TerrainHeightmapOptions;

#[wasm_bindgen]
pub struct Forge3DRuntime {
    #[allow(dead_code)]
    canvas: HtmlCanvasElement,
    gpu_runtime: Option<GpuRuntime>,
    context: Option<GpuContext>,
    surface_state: Option<SurfaceState>,
    terrain: Option<TerrainRenderResources>,
    width: u32,
    height: u32,
    clear_color: [f32; 4],
    diagnostics_enabled: bool,
    disposed: bool,
}

#[wasm_bindgen]
impl Forge3DRuntime {
    #[wasm_bindgen(js_name = create)]
    pub async fn create(
        canvas: HtmlCanvasElement,
        options: JsValue,
    ) -> Result<Forge3DRuntime, JsValue> {
        install_panic_hook();
        create_runtime(canvas, options).await.map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = dispose)]
    pub fn dispose(&mut self) {
        self.surface_state = None;
        self.context = None;
        self.gpu_runtime = None;
        self.terrain = None;
        self.disposed = true;
    }

    #[wasm_bindgen(js_name = render)]
    pub fn render(&mut self) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        render_runtime(self).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setTerrain)]
    pub fn set_terrain(&mut self, terrain: JsValue) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        set_terrain_runtime(self, terrain).map_err(to_js_error)
    }

    #[wasm_bindgen(getter)]
    pub fn disposed(&self) -> bool {
        self.disposed
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[wasm_bindgen(js_name = clearColor)]
    pub fn clear_color(&self) -> js_sys::Array {
        self.clear_color
            .iter()
            .map(|channel| JsValue::from_f64(*channel as f64))
            .collect()
    }

    #[wasm_bindgen(getter, js_name = diagnosticsEnabled)]
    pub fn diagnostics_enabled(&self) -> bool {
        self.diagnostics_enabled
    }
}

#[cfg(target_arch = "wasm32")]
async fn create_runtime(
    canvas: HtmlCanvasElement,
    options: JsValue,
) -> Result<Forge3DRuntime, WebError> {
    if web_sys::window()
        .and_then(|window| {
            js_sys::Reflect::get(&window.navigator(), &JsValue::from_str("gpu")).ok()
        })
        .filter(|gpu| !gpu.is_undefined() && !gpu.is_null())
        .is_none()
    {
        return Err(WebError::new(
            Forge3DErrorCode::WebGpuUnavailable,
            "navigator.gpu is not available",
        ));
    }

    let options = RuntimeOptions::from_js_value(options)?;
    let (width, height) = options.pixel_size(canvas.width(), canvas.height())?;
    canvas.set_width(width);
    canvas.set_height(height);

    let mut instance_descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    instance_descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
    let instance = wgpu::Instance::new(instance_descriptor);
    let gpu_runtime = GpuRuntime::new(instance);
    let surface = gpu_runtime
        .instance
        .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
        .map_err(|error| {
            WebError::new(
                Forge3DErrorCode::SurfaceCreateFailed,
                format!("Failed to create WebGPU surface: {error}"),
            )
        })?;

    let context_options = GpuRuntimeOptions {
        power_preference: options.power_preference.to_wgpu(),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::downlevel_webgl2_defaults(),
        label: Some("forge3d-web-device".to_string()),
    };
    let context = gpu_runtime
        .request_context(Some(&surface), &context_options)
        .await
        .map_err(map_core_error)?;

    let descriptor = surface_descriptor(&surface, &context, &options, width, height)?;
    let surface_state = SurfaceState::new(surface, &context, descriptor).map_err(map_core_error)?;

    Ok(Forge3DRuntime {
        canvas,
        gpu_runtime: Some(gpu_runtime),
        context: Some(context),
        surface_state: Some(surface_state),
        terrain: None,
        width,
        height,
        clear_color: options.clear_color(),
        diagnostics_enabled: options.diagnostics,
        disposed: false,
    })
}

#[cfg(not(target_arch = "wasm32"))]
async fn create_runtime(
    canvas: HtmlCanvasElement,
    options: JsValue,
) -> Result<Forge3DRuntime, WebError> {
    let _ = (canvas, options);
    Err(WebError::new(
        Forge3DErrorCode::WebGpuUnavailable,
        "forge3d-web runtime creation is only available for wasm32 browser builds",
    ))
}

#[cfg(target_arch = "wasm32")]
fn surface_descriptor(
    surface: &wgpu::Surface<'static>,
    context: &GpuContext,
    options: &RuntimeOptions,
    width: u32,
    height: u32,
) -> Result<forge3d_core::gpu::SurfaceStateDescriptor, WebError> {
    let caps = surface.get_capabilities(&context.adapter);
    let format = caps
        .formats
        .iter()
        .copied()
        .find(|format| format.is_srgb())
        .or_else(|| caps.formats.first().copied())
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::SurfaceCreateFailed,
                "WebGPU surface reported no texture formats",
            )
        })?;
    let present_mode = caps
        .present_modes
        .iter()
        .copied()
        .find(|mode| *mode == wgpu::PresentMode::Fifo)
        .or_else(|| caps.present_modes.first().copied())
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::SurfaceCreateFailed,
                "WebGPU surface reported no present modes",
            )
        })?;
    let preferred_alpha = options.alpha_mode.preferred_wgpu();
    let alpha_mode = caps
        .alpha_modes
        .iter()
        .copied()
        .find(|mode| *mode == preferred_alpha)
        .or_else(|| caps.alpha_modes.first().copied())
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::SurfaceCreateFailed,
                "WebGPU surface reported no alpha modes",
            )
        })?;

    let mut descriptor = forge3d_core::gpu::SurfaceStateDescriptor::new(width, height, format);
    descriptor.present_mode = present_mode;
    descriptor.alpha_mode = alpha_mode;
    descriptor.view_formats = vec![format];
    Ok(descriptor)
}

fn render_runtime(runtime: &mut Forge3DRuntime) -> Result<(), WebError> {
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

    let frame = {
        let surface = &surface_state.surface;
        surface.get_current_texture()
    };
    let frame = match frame {
        wgpu::CurrentSurfaceTexture::Success(frame) => frame,
        wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
        wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
            return Err(WebError::new(
                Forge3DErrorCode::RequestCancelled,
                "Surface texture is not currently available",
            ));
        }
        wgpu::CurrentSurfaceTexture::Outdated => {
            surface_state.configure(context);
            return Err(WebError::new(
                Forge3DErrorCode::SurfaceOutdated,
                "Surface outdated",
            ));
        }
        wgpu::CurrentSurfaceTexture::Lost => {
            surface_state.configure(context);
            return Err(WebError::new(Forge3DErrorCode::SurfaceLost, "Surface lost"));
        }
        wgpu::CurrentSurfaceTexture::Validation => {
            return Err(WebError::new(
                Forge3DErrorCode::SurfaceCreateFailed,
                "Surface texture validation failed",
            ));
        }
    };
    let view = frame
        .texture
        .create_view(&wgpu::TextureViewDescriptor::default());
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("forge3d-web-clear-encoder"),
        });

    {
        let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("forge3d-web-clear-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
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
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });

        if let Some(terrain) = runtime.terrain.as_ref() {
            render_pass.set_pipeline(&terrain.pipeline);
            render_pass.set_bind_group(0, &terrain.bind_group, &[]);
            render_pass.set_vertex_buffer(0, terrain.vertex_buffer.slice(..));
            render_pass.set_index_buffer(terrain.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            render_pass.draw_indexed(0..terrain.index_count, 0, 0..1);
        }
    }

    context.queue.submit(std::iter::once(encoder.finish()));
    frame.present();
    Ok(())
}

fn set_terrain_runtime(runtime: &mut Forge3DRuntime, terrain: JsValue) -> Result<(), WebError> {
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

    let terrain = TerrainHeightmapOptions::from_js_value(terrain)?.validate()?;
    runtime.terrain = Some(TerrainRenderResources::new(
        context,
        surface_state.config.format,
        &terrain,
    )?);
    Ok(())
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct TerrainVertex {
    position: [f32; 2],
    uv: [f32; 2],
}

struct TerrainRenderResources {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    index_count: u32,
    #[allow(dead_code)]
    height_texture: wgpu::Texture,
    #[allow(dead_code)]
    sampler: wgpu::Sampler,
}

impl TerrainRenderResources {
    fn new(
        context: &GpuContext,
        surface_format: wgpu::TextureFormat,
        terrain: &forge3d_core::terrain::TerrainHeightmapInput,
    ) -> Result<Self, WebError> {
        let (vertex_buffer, index_buffer, index_count) =
            create_terrain_mesh_buffers(context, terrain)?;
        let (height_texture, height_view) = create_height_texture(context, terrain);
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
                                format: wgpu::VertexFormat::Float32x2,
                            },
                            wgpu::VertexAttribute {
                                offset: std::mem::size_of::<[f32; 2]>() as wgpu::BufferAddress,
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
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });

        Ok(Self {
            pipeline,
            bind_group,
            vertex_buffer,
            index_buffer,
            index_count,
            height_texture,
            sampler,
        })
    }
}

fn create_terrain_mesh_buffers(
    context: &GpuContext,
    terrain: &forge3d_core::terrain::TerrainHeightmapInput,
) -> Result<(wgpu::Buffer, wgpu::Buffer, u32), WebError> {
    if terrain.width < 2 || terrain.height < 2 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "terrain width and height must be at least 2 to draw a mesh",
        ));
    }

    let width = terrain.width as usize;
    let height = terrain.height as usize;
    let mut vertices = Vec::with_capacity(width * height);
    for y in 0..height {
        let v = y as f32 / (height - 1) as f32;
        for x in 0..width {
            let u = x as f32 / (width - 1) as f32;
            vertices.push(TerrainVertex {
                position: [u * 1.8 - 0.9, 0.78 - v * 1.56],
                uv: [u, v],
            });
        }
    }

    let index_capacity = (width - 1)
        .checked_mul(height - 1)
        .and_then(|count| count.checked_mul(6))
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::InvalidInput,
                "terrain mesh index count overflowed",
            )
        })?;
    if index_capacity > u32::MAX as usize {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "terrain mesh is too large for u32 indices",
        ));
    }

    let mut indices = Vec::with_capacity(index_capacity);
    for y in 0..(height - 1) {
        for x in 0..(width - 1) {
            let top_left = (y * width + x) as u32;
            let top_right = top_left + 1;
            let bottom_left = top_left + width as u32;
            let bottom_right = bottom_left + 1;
            indices.extend_from_slice(&[
                top_left,
                bottom_left,
                top_right,
                top_right,
                bottom_left,
                bottom_right,
            ]);
        }
    }

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

fn upload_r32float_texture(
    context: &GpuContext,
    texture: &wgpu::Texture,
    terrain: &forge3d_core::terrain::TerrainHeightmapInput,
) {
    let row_bytes = terrain.width * std::mem::size_of::<f32>() as u32;
    let padded_row_bytes = align_copy_bytes_per_row(row_bytes);
    let source = bytemuck::cast_slice::<f32, u8>(&terrain.heights);
    let upload = if padded_row_bytes == row_bytes {
        source.to_vec()
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
        padded
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

const TERRAIN_SHADER: &str = r#"
struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) height: f32,
    @location(1) uv: vec2<f32>,
};

@group(0) @binding(0) var heightmap: texture_2d<f32>;
@group(0) @binding(1) var nearest_sampler: sampler;

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    let height = textureSampleLevel(heightmap, nearest_sampler, input.uv, 0.0).r;
    var output: VertexOutput;
    output.position = vec4<f32>(input.position.x, input.position.y + height * 0.34 - 0.12, 0.0, 1.0);
    output.height = height;
    output.uv = input.uv;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let low = vec3<f32>(0.05, 0.22, 0.48);
    let mid = vec3<f32>(0.18, 0.55, 0.28);
    let high = vec3<f32>(0.92, 0.86, 0.56);
    let t = clamp(input.height, 0.0, 1.0);
    let lower = mix(low, mid, smoothstep(0.0, 0.55, t));
    let color = mix(lower, high, smoothstep(0.45, 1.0, t));
    return vec4<f32>(color, 1.0);
}
"#;

fn install_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

pub fn ensure_not_disposed(runtime: &Forge3DRuntime) -> Result<(), JsValue> {
    ensure_not_disposed_error(runtime).map_err(to_js_error)
}

pub fn ensure_not_disposed_error(runtime: &Forge3DRuntime) -> Result<(), WebError> {
    if runtime.disposed {
        return Err(WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime has been disposed",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ensure_not_disposed_error;

    #[test]
    fn runtime_dispose_guard_uses_stable_error_code() {
        let runtime = super::Forge3DRuntime {
            canvas: wasm_bindgen::JsCast::unchecked_into(wasm_bindgen::JsValue::NULL),
            gpu_runtime: None,
            context: None,
            surface_state: None,
            terrain: None,
            width: 1,
            height: 1,
            clear_color: [0.0, 0.0, 0.0, 1.0],
            diagnostics_enabled: false,
            disposed: true,
        };

        let error = ensure_not_disposed_error(&runtime).unwrap_err();
        assert_eq!(error.code().as_str(), "RUNTIME_DISPOSED");
    }
}
