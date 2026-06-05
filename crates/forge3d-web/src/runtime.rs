#[cfg(target_arch = "wasm32")]
use forge3d_core::gpu::GpuRuntimeOptions;
use forge3d_core::gpu::{GpuContext, GpuRuntime, SurfaceState};
use wasm_bindgen::{closure::Closure, prelude::*, Clamped, JsCast};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Blob, CanvasRenderingContext2d, HtmlCanvasElement, ImageData};
use wgpu::util::DeviceExt;

use crate::error::{map_core_error, to_js_error, Forge3DErrorCode, WebError};
#[cfg(target_arch = "wasm32")]
use crate::inputs::RuntimeOptions;
use crate::inputs::{CameraOptions, ResizeOptions, TerrainHeightmapOptions};

#[wasm_bindgen]
pub struct Forge3DRuntime {
    #[allow(dead_code)]
    canvas: HtmlCanvasElement,
    gpu_runtime: Option<GpuRuntime>,
    context: Option<GpuContext>,
    surface_state: Option<SurfaceState>,
    terrain: Option<TerrainRenderResources>,
    camera: forge3d_core::camera::CameraInput,
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

    #[wasm_bindgen(js_name = screenshot)]
    pub async fn screenshot(&mut self) -> Result<Blob, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        screenshot_runtime(self).await.map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setTerrain)]
    pub fn set_terrain(&mut self, terrain: JsValue) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        set_terrain_runtime(self, terrain).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setTerrainFromSource)]
    pub async fn set_terrain_from_source(&mut self, terrain: JsValue) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        let terrain = crate::io::load_terrain_heightmap_source(terrain)
            .await
            .map_err(to_js_error)?;
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        set_terrain_options_runtime(self, terrain).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&mut self, camera: JsValue) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        set_camera_runtime(self, camera).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = resize)]
    pub fn resize(&mut self, size: JsValue) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        resize_runtime(self, size).map_err(to_js_error)
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
        camera: forge3d_core::camera::CameraInput::default(),
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

    encode_scene_render_pass(runtime, &mut encoder, &view, "forge3d-web-clear-pass");

    context.queue.submit(std::iter::once(encoder.finish()));
    frame.present();
    Ok(())
}

async fn screenshot_runtime(runtime: &mut Forge3DRuntime) -> Result<Blob, WebError> {
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
    let format = surface_state.config.format;
    let layout = forge3d_core::readback::rgba8_layout(runtime.width, runtime.height)
        .map_err(map_core_error)?;

    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-web-screenshot-texture"),
        size: wgpu::Extent3d {
            width: runtime.width,
            height: runtime.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let readback = context.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("forge3d-web-screenshot-readback"),
        size: layout.buffer_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("forge3d-web-screenshot-encoder"),
        });

    encode_scene_render_pass(runtime, &mut encoder, &view, "forge3d-web-screenshot-pass");
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(layout.padded_bytes_per_row),
                rows_per_image: Some(runtime.height),
            },
        },
        wgpu::Extent3d {
            width: runtime.width,
            height: runtime.height,
            depth_or_array_layers: 1,
        },
    );

    context.queue.submit(std::iter::once(encoder.finish()));
    let padded = map_readback_buffer(context, &readback, layout.buffer_size).await?;
    let rgba = forge3d_core::readback::unpad_rows(&padded, layout).map_err(map_core_error)?;
    let rgba = normalize_readback_to_rgba(rgba, format)?;
    png_blob_from_rgba(runtime.width, runtime.height, rgba).await
}

fn encode_scene_render_pass(
    runtime: &Forge3DRuntime,
    encoder: &mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    label: &'static str,
) {
    let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
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

async fn map_readback_buffer(
    context: &GpuContext,
    buffer: &wgpu::Buffer,
    size: u64,
) -> Result<Vec<u8>, WebError> {
    let slice = buffer.slice(..);
    let promise = js_sys::Promise::new(&mut |resolve, reject| {
        slice.map_async(wgpu::MapMode::Read, move |result| match result {
            Ok(()) => {
                let _ = resolve.call0(&JsValue::NULL);
            }
            Err(error) => {
                let _ = reject.call1(&JsValue::NULL, &JsValue::from_str(&error.to_string()));
            }
        });
    });
    let _ = context.device.poll(wgpu::PollType::Poll);

    JsFuture::from(promise).await.map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Screenshot readback mapping failed",
            error,
        )
    })?;

    let data = {
        let mapped = buffer.slice(0..size).get_mapped_range();
        mapped.to_vec()
    };
    buffer.unmap();
    Ok(data)
}

fn normalize_readback_to_rgba(
    mut pixels: Vec<u8>,
    format: wgpu::TextureFormat,
) -> Result<Vec<u8>, WebError> {
    match format {
        wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba8UnormSrgb => Ok(pixels),
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => {
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            Ok(pixels)
        }
        _ => Err(WebError::new(
            Forge3DErrorCode::UnsupportedFeature,
            format!("Screenshots do not support surface format {format:?}"),
        )),
    }
}

async fn png_blob_from_rgba(width: u32, height: u32, rgba: Vec<u8>) -> Result<Blob, WebError> {
    let document = web_sys::window()
        .and_then(|window| window.document())
        .ok_or_else(|| WebError::new(Forge3DErrorCode::IoError, "Document is not available"))?;
    let canvas = document
        .create_element("canvas")
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Failed to create screenshot encoding canvas",
                error,
            )
        })?
        .dyn_into::<HtmlCanvasElement>()
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Created element is not a canvas",
                error.into(),
            )
        })?;
    canvas.set_width(width);
    canvas.set_height(height);

    let context = canvas
        .get_context("2d")
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Failed to request 2D canvas context",
                error,
            )
        })?
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::IoError,
                "2D canvas context is unavailable",
            )
        })?
        .dyn_into::<CanvasRenderingContext2d>()
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Canvas context is not CanvasRenderingContext2D",
                error.into(),
            )
        })?;
    let image_data = ImageData::new_with_u8_clamped_array_and_sh(Clamped(&rgba), width, height)
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Failed to create ImageData for screenshot",
                error,
            )
        })?;
    context
        .put_image_data(&image_data, 0.0, 0.0)
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Failed to write screenshot pixels to canvas",
                error,
            )
        })?;

    let promise = js_sys::Promise::new(&mut |resolve, reject| {
        let reject_for_callback = reject.clone();
        let callback = Closure::once(move |blob: Option<Blob>| match blob {
            Some(blob) => {
                let _ = resolve.call1(&JsValue::NULL, &blob);
            }
            None => {
                let _ = reject_for_callback.call1(
                    &JsValue::NULL,
                    &JsValue::from_str("Browser returned no PNG Blob"),
                );
            }
        });

        if let Err(error) = canvas.to_blob_with_type(callback.as_ref().unchecked_ref(), "image/png")
        {
            let _ = reject.call1(&JsValue::NULL, &error);
        } else {
            callback.forget();
        }
    });

    let blob = JsFuture::from(promise).await.map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Browser PNG encoding failed",
            error,
        )
    })?;
    blob.dyn_into::<Blob>().map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Browser PNG encoder did not return a Blob",
            error,
        )
    })
}

fn set_terrain_runtime(runtime: &mut Forge3DRuntime, terrain: JsValue) -> Result<(), WebError> {
    let terrain = TerrainHeightmapOptions::from_js_value(terrain)?;
    set_terrain_options_runtime(runtime, terrain)
}

fn set_terrain_options_runtime(
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

    let terrain = terrain.validate()?;
    runtime.terrain = Some(TerrainRenderResources::new(
        context,
        surface_state.config.format,
        &terrain,
        &runtime.camera,
        runtime.width,
        runtime.height,
    )?);
    Ok(())
}

fn set_camera_runtime(runtime: &mut Forge3DRuntime, camera: JsValue) -> Result<(), WebError> {
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

fn resize_runtime(runtime: &mut Forge3DRuntime, size: JsValue) -> Result<(), WebError> {
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
    runtime.canvas.set_width(width);
    runtime.canvas.set_height(height);
    surface_state
        .resize(context, width, height)
        .map_err(map_core_error)?;
    runtime.width = width;
    runtime.height = height;

    if let Some(terrain) = runtime.terrain.as_ref() {
        terrain.update_camera(context, &runtime.camera, width, height)?;
    }
    Ok(())
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct TerrainVertex {
    position: [f32; 3],
    uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CameraUniform {
    view_projection: [[f32; 4]; 4],
}

struct TerrainRenderResources {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    index_count: u32,
    camera_buffer: wgpu::Buffer,
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
        camera: &forge3d_core::camera::CameraInput,
        width: u32,
        height: u32,
    ) -> Result<Self, WebError> {
        let (vertex_buffer, index_buffer, index_count) =
            create_terrain_mesh_buffers(context, terrain)?;
        let (height_texture, height_view) = create_height_texture(context, terrain);
        let camera_uniform = create_camera_uniform(camera, width, height)?;
        let camera_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("forge3d-web-terrain-camera-uniform"),
                contents: bytemuck::bytes_of(&camera_uniform),
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
            camera_buffer,
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
}

fn create_terrain_mesh_buffers(
    context: &GpuContext,
    terrain: &forge3d_core::terrain::TerrainHeightmapInput,
) -> Result<(wgpu::Buffer, wgpu::Buffer, u32), WebError> {
    let mesh = terrain.mesh_descriptor().map_err(map_core_error)?;
    let vertices = mesh
        .vertices
        .iter()
        .map(|vertex| TerrainVertex {
            position: vertex.position,
            uv: vertex.uv,
        })
        .collect::<Vec<_>>();

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
            contents: bytemuck::cast_slice(&mesh.indices),
            usage: wgpu::BufferUsages::INDEX,
        });

    Ok((vertex_buffer, index_buffer, mesh.indices.len() as u32))
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
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
};

struct CameraUniform {
    view_projection: mat4x4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) height: f32,
    @location(1) uv: vec2<f32>,
};

@group(0) @binding(0) var heightmap: texture_2d<f32>;
@group(0) @binding(1) var nearest_sampler: sampler;
@group(0) @binding(2) var<uniform> camera: CameraUniform;

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    let height = textureSampleLevel(heightmap, nearest_sampler, input.uv, 0.0).r;
    let world_position = vec3<f32>(
        input.position.x,
        input.position.y + height * 0.7,
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
            camera: forge3d_core::camera::CameraInput::default(),
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
