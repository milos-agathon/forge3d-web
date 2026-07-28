#[cfg(target_arch = "wasm32")]
use forge3d_core::gpu::{GpuContext, GpuRuntime, GpuRuntimeOptions, SurfaceState};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

#[cfg(target_arch = "wasm32")]
use super::terrain::{create_terrain_render_pipeline, TERRAIN_SHADER};
#[cfg(target_arch = "wasm32")]
use super::DepthAttachment;
use super::Forge3DRuntime;
#[cfg(target_arch = "wasm32")]
use crate::error::map_core_error;
use crate::error::{Forge3DErrorCode, WebError};
#[cfg(target_arch = "wasm32")]
use crate::inputs::RuntimeOptions;

#[cfg(target_arch = "wasm32")]
pub(super) async fn create_runtime(
    canvas: HtmlCanvasElement,
    options: JsValue,
) -> Result<Forge3DRuntime, WebError> {
    if !web_sys::window()
        .map(|window| window.is_secure_context())
        .unwrap_or(false)
    {
        return Err(WebError::new(
            Forge3DErrorCode::InsecureContext,
            "WebGPU requires a secure browser context",
        ));
    }
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
    let limits = context.device.limits();
    if width > limits.max_texture_dimension_2d || height > limits.max_texture_dimension_2d {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "canvas dimensions {width}x{height} exceed maxTextureDimension2D {}",
                limits.max_texture_dimension_2d
            ),
        ));
    }

    let descriptor = surface_descriptor(&surface, &context, &options, width, height)?;
    let surface_state = SurfaceState::new(surface, &context, descriptor).map_err(map_core_error)?;
    validate_terrain_shader_and_pipeline(&context, surface_state.config.format).await?;
    let depth_attachment = DepthAttachment::new(&context, width, height);
    let surface_format = format!("{:?}", surface_state.config.format);

    Ok(Forge3DRuntime {
        canvas,
        gpu_runtime: Some(gpu_runtime),
        context: Some(context),
        surface_state: Some(surface_state),
        depth_attachment: Some(depth_attachment),
        terrain: None,
        camera: forge3d_core::camera::CameraInput::default(),
        width,
        height,
        clear_color: options.clear_color(),
        diagnostics_enabled: options.diagnostics,
        disposed: false,
        max_texture_dimension_2d: limits.max_texture_dimension_2d,
        max_buffer_size: limits.max_buffer_size,
        surface_format,
        preferred_alpha_mode: options.alpha_mode.preferred_wgpu(),
        device_lost_callback: None,
        device_health_listener_id: None,
    })
}

#[cfg(target_arch = "wasm32")]
async fn validate_terrain_shader_and_pipeline(
    context: &GpuContext,
    surface_format: wgpu::TextureFormat,
) -> Result<(), WebError> {
    let scope = context
        .device
        .push_error_scope(wgpu::ErrorFilter::Validation);
    let bind_group_layout =
        context
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("forge3d-web-terrain-validation-bind-group-layout"),
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
    let pipeline_layout = context
        .device
        .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("forge3d-web-terrain-validation-pipeline-layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
    let shader = context
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("forge3d-web-terrain-shader"),
            source: wgpu::ShaderSource::Wgsl(TERRAIN_SHADER.into()),
        });
    let _pipeline =
        create_terrain_render_pipeline(&context.device, surface_format, &pipeline_layout, &shader);

    if let Some(error) = scope.pop().await {
        return Err(WebError::new(
            Forge3DErrorCode::ShaderCompilationFailed,
            format!("forge3d-web-terrain-shader/pipeline: {error}"),
        ));
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) async fn create_runtime(
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
    surface_descriptor_for_alpha(
        surface,
        context,
        options.alpha_mode.preferred_wgpu(),
        width,
        height,
    )
}

#[cfg(target_arch = "wasm32")]
pub(super) fn surface_descriptor_for_alpha(
    surface: &wgpu::Surface<'static>,
    context: &GpuContext,
    preferred_alpha: wgpu::CompositeAlphaMode,
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
