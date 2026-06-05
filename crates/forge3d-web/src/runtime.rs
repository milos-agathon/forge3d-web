#[cfg(target_arch = "wasm32")]
use forge3d_core::gpu::GpuRuntimeOptions;
use forge3d_core::gpu::{GpuContext, GpuRuntime, SurfaceState};
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

#[cfg(target_arch = "wasm32")]
use crate::error::map_core_error;
use crate::error::{to_js_error, Forge3DErrorCode, WebError};
#[cfg(target_arch = "wasm32")]
use crate::inputs::RuntimeOptions;

#[wasm_bindgen]
pub struct Forge3DRuntime {
    #[allow(dead_code)]
    canvas: HtmlCanvasElement,
    gpu_runtime: Option<GpuRuntime>,
    context: Option<GpuContext>,
    surface_state: Option<SurfaceState>,
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
        self.disposed = true;
    }

    #[wasm_bindgen(js_name = render)]
    pub fn render(&mut self) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        render_runtime(self).map_err(to_js_error)
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
        let _clear_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
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
    }

    context.queue.submit(std::iter::once(encoder.finish()));
    frame.present();
    Ok(())
}

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
