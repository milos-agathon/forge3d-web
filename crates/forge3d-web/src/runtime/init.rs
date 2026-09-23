#[cfg(target_arch = "wasm32")]
use forge3d_core::gpu::{
    GpuContext, GpuRuntime, GpuRuntimeOptions, SurfaceState, SurfaceStateDescriptor,
};
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use super::canvas::RuntimeCanvas;
#[cfg(target_arch = "wasm32")]
use super::diagnostics::AdapterDiagnostics;
#[cfg(target_arch = "wasm32")]
use super::memory::MemoryLedger;
#[cfg(target_arch = "wasm32")]
use super::terrain::{create_terrain_render_pipeline, TERRAIN_SHADER};
#[cfg(target_arch = "wasm32")]
use super::timing::TimestampRing;
#[cfg(target_arch = "wasm32")]
use super::DepthAttachment;
use super::Forge3DRuntime;
#[cfg(target_arch = "wasm32")]
use crate::error::map_core_error;
use crate::error::{Forge3DErrorCode, WebError};
#[cfg(target_arch = "wasm32")]
use crate::inputs::RuntimeOptions;
#[cfg(target_arch = "wasm32")]
use forge3d_core::memory::MemoryCategory;

#[cfg(target_arch = "wasm32")]
fn check_webgpu_environment() -> Result<(), WebError> {
    let global = js_sys::global();
    let is_secure = js_sys::Reflect::get(&global, &JsValue::from_str("isSecureContext"))
        .ok()
        .and_then(|value| value.as_bool());
    if is_secure != Some(true) {
        return Err(WebError::new(
            Forge3DErrorCode::InsecureContext,
            "WebGPU requires a secure browser context",
        ));
    }
    let navigator = js_sys::Reflect::get(&global, &JsValue::from_str("navigator"))
        .ok()
        .filter(|value| !value.is_undefined() && !value.is_null())
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::WebGpuUnavailable,
                "navigator is not available",
            )
        })?;
    let gpu = js_sys::Reflect::get(&navigator, &JsValue::from_str("gpu"))
        .ok()
        .filter(|value| !value.is_undefined() && !value.is_null());
    if gpu.is_none() {
        return Err(WebError::new(
            Forge3DErrorCode::WebGpuUnavailable,
            "navigator.gpu is not available",
        ));
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
pub(super) async fn create_runtime(
    canvas: RuntimeCanvas,
    options: JsValue,
) -> Result<Forge3DRuntime, WebError> {
    check_webgpu_environment()?;

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
        .create_surface(canvas.surface_target())
        .map_err(|error| {
            WebError::new(
                Forge3DErrorCode::SurfaceCreateFailed,
                format!("Failed to create WebGPU surface: {error}"),
            )
        })?;

    let context_options = GpuRuntimeOptions {
        power_preference: options.power_preference.to_wgpu(),
        required_features: wgpu::Features::empty(),
        optional_features: {
            let mut features = wgpu::Features::TEXTURE_COMPRESSION_BC
                | wgpu::Features::TEXTURE_COMPRESSION_ETC2
                | wgpu::Features::TEXTURE_COMPRESSION_ASTC;
            if options.timestamp_mode.timestamp_queries_requested() {
                features |= wgpu::Features::TIMESTAMP_QUERY;
            }
            features
        },
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
    let mut memory = MemoryLedger::new(options.memory_budget_bytes(), options.quality.to_core())?;
    let lighting_state = forge3d_core::lighting::default_state()
        .validated()
        .map_err(map_core_error)?;
    let material_state = forge3d_core::materials::default_state()
        .validated()
        .map_err(map_core_error)?;
    let lighting = super::lighting::LightingResources::new(
        &context,
        &mut memory,
        &lighting_state,
        &material_state,
        Vec::new(),
    )?;
    let textures = super::textures::TextureResources::new(
        &context,
        &std::collections::BTreeMap::new(),
        &memory,
        limits.max_texture_dimension_2d,
    )?;
    let ibl_layout = super::ibl::create_ibl_bind_group_layout(&context.device);
    let shadows = super::shadows::ShadowResources::disabled(&context);
    let (shadow_depth_bytes, shadow_moment_bytes, shadow_uniform_bytes) =
        super::shadows::shadow_ledger_bytes(
            &forge3d_core::shadowing::ShadowConfig::default(),
            1,
            1,
        )?;
    memory.replace(
        super::shadows::SHADOW_DEPTH_KEY,
        MemoryCategory::Textures,
        shadow_depth_bytes,
    )?;
    memory.replace(
        super::shadows::SHADOW_MOMENTS_KEY,
        MemoryCategory::Textures,
        shadow_moment_bytes,
    )?;
    memory.replace(
        super::shadows::SHADOW_UNIFORMS_KEY,
        MemoryCategory::Buffers,
        shadow_uniform_bytes,
    )?;
    let ibl = super::ibl::IblResources::disabled(&context, &ibl_layout, &shadows);
    memory.replace(
        super::ibl::IBL_TEXTURES_LEDGER_KEY,
        MemoryCategory::Textures,
        ibl.retained_texture_bytes,
    )?;
    memory.replace(
        super::ibl::IBL_UNIFORM_LEDGER_KEY,
        MemoryCategory::Buffers,
        super::ibl::IBL_UNIFORM_BYTES,
    )?;
    validate_terrain_shader_and_pipeline(&context, surface_state.config.format, &ibl_layout)
        .await?;
    let depth_attachment = DepthAttachment::new(&context, width, height);
    let surface_format = format!("{:?}", surface_state.config.format);
    let surface_formats = surface_state
        .surface
        .get_capabilities(&context.adapter)
        .formats;
    let adapter_diagnostics = AdapterDiagnostics::capture(&context, surface_formats);
    let query_ring = if context
        .device
        .features()
        .contains(wgpu::Features::TIMESTAMP_QUERY)
    {
        Some(TimestampRing::new(&context.device, &context.queue))
    } else {
        None
    };

    Ok(Forge3DRuntime {
        canvas,
        gpu_runtime: Some(gpu_runtime),
        context: Some(context),
        surface_state: Some(surface_state),
        depth_attachment: Some(depth_attachment),
        terrain: None,
        scene: None,
        lighting: Some(lighting),
        textures: Some(textures),
        ibl: Some(ibl),
        shadows: Some(shadows),
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
        memory,
        overflow_policy: options.overflow_policy.to_core(),
        requested_quality: options.quality.to_core(),
        adapter_diagnostics,
        query_ring,
        timer: forge3d_core::timing::FrameTimer::new(true),
        last_stats: forge3d_core::timing::RenderStats {
            frame_index: 0,
            frame_time_ms: 0.0,
            draw_calls: 0,
            triangles: 0,
            passes: Vec::new(),
        },
    })
}

#[cfg(target_arch = "wasm32")]
async fn validate_terrain_shader_and_pipeline(
    context: &GpuContext,
    surface_format: wgpu::TextureFormat,
    ibl_layout: &wgpu::BindGroupLayout,
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
            });
    let lighting_layout =
        context
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("forge3d-web-lighting-validation-bind-group-layout"),
                entries: &super::lighting::lighting_layout_entries(),
            });
    let texture_layout =
        context
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("forge3d-web-texture-validation-bind-group-layout"),
                entries: &super::textures::texture_layout_entries(),
            });
    let pipeline_layout = context
        .device
        .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("forge3d-web-terrain-validation-pipeline-layout"),
            bind_group_layouts: &[
                Some(&bind_group_layout),
                Some(&lighting_layout),
                Some(&texture_layout),
                Some(ibl_layout),
            ],
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
    canvas: super::canvas::RuntimeCanvas,
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
) -> Result<SurfaceStateDescriptor, WebError> {
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
) -> Result<SurfaceStateDescriptor, WebError> {
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
    let alpha_mode = select_surface_alpha_mode(&caps.alpha_modes, preferred_alpha, true)
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::SurfaceCreateFailed,
                "WebGPU surface reported no alpha modes",
            )
        })?;

    let mut descriptor = SurfaceStateDescriptor::new(width, height, format);
    descriptor.present_mode = present_mode;
    descriptor.alpha_mode = alpha_mode;
    descriptor.view_formats = vec![format];
    Ok(descriptor)
}

#[cfg(any(target_arch = "wasm32", test))]
fn select_surface_alpha_mode(
    reported_modes: &[wgpu::CompositeAlphaMode],
    preferred: wgpu::CompositeAlphaMode,
    browser_webgpu: bool,
) -> Option<wgpu::CompositeAlphaMode> {
    // wgpu 29's WebGPU backend reports only Opaque even though its configure
    // implementation supports both core GPUCanvasAlphaMode values.
    if browser_webgpu
        && matches!(
            preferred,
            wgpu::CompositeAlphaMode::Opaque | wgpu::CompositeAlphaMode::PreMultiplied
        )
    {
        return Some(preferred);
    }
    reported_modes
        .iter()
        .copied()
        .find(|mode| *mode == preferred)
        .or_else(|| reported_modes.first().copied())
}

#[cfg(test)]
mod tests {
    use super::select_surface_alpha_mode;
    use wgpu::CompositeAlphaMode::{Opaque, PostMultiplied, PreMultiplied};

    #[test]
    fn browser_webgpu_selects_both_core_canvas_alpha_modes() {
        let incomplete_backend_report = [Opaque];
        assert_eq!(
            select_surface_alpha_mode(&incomplete_backend_report, Opaque, true),
            Some(Opaque)
        );
        assert_eq!(
            select_surface_alpha_mode(&incomplete_backend_report, PreMultiplied, true),
            Some(PreMultiplied)
        );
    }

    #[test]
    fn alpha_selection_preserves_reported_capability_fallback_elsewhere() {
        let reported = [Opaque];
        assert_eq!(
            select_surface_alpha_mode(&reported, PreMultiplied, false),
            Some(Opaque)
        );
        assert_eq!(
            select_surface_alpha_mode(&reported, PostMultiplied, true),
            Some(Opaque)
        );
        assert_eq!(select_surface_alpha_mode(&[], PostMultiplied, true), None);
    }
}
