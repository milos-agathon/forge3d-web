mod device_health;
mod diagnostics;
mod init;
mod readback;
mod render;
mod terrain;

use device_health::{ensure_device_healthy_error, set_js_property};
pub use device_health::{ensure_not_disposed, ensure_not_disposed_error};
use init::create_runtime;
use readback::screenshot_runtime;
use render::render_runtime;
use terrain::{
    resize_runtime, set_camera_runtime, set_terrain_options_runtime, set_terrain_runtime,
    DepthAttachment, TerrainRenderResources,
};

use forge3d_core::gpu::{GpuContext, GpuRuntime, SurfaceState};
use wasm_bindgen::prelude::*;
use web_sys::{Blob, HtmlCanvasElement};

use crate::error::{to_js_error, Forge3DErrorCode, WebError};

#[wasm_bindgen]
pub struct Forge3DRuntime {
    #[allow(dead_code)]
    canvas: HtmlCanvasElement,
    gpu_runtime: Option<GpuRuntime>,
    context: Option<GpuContext>,
    surface_state: Option<SurfaceState>,
    depth_attachment: Option<DepthAttachment>,
    terrain: Option<TerrainRenderResources>,
    camera: forge3d_core::camera::CameraInput,
    width: u32,
    height: u32,
    clear_color: [f32; 4],
    diagnostics_enabled: bool,
    disposed: bool,
    max_texture_dimension_2d: u32,
    max_buffer_size: u64,
    surface_format: String,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    preferred_alpha_mode: wgpu::CompositeAlphaMode,
    device_lost_callback: Option<js_sys::Function>,
    device_health_listener_id: Option<u64>,
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
        if let (Some(context), Some(listener_id)) =
            (self.context.as_ref(), self.device_health_listener_id.take())
        {
            context.health.unsubscribe(listener_id);
        }
        self.device_lost_callback = None;
        self.surface_state = None;
        self.context = None;
        self.gpu_runtime = None;
        self.depth_attachment = None;
        self.terrain = None;
        self.disposed = true;
    }

    #[wasm_bindgen(js_name = render)]
    pub fn render(&mut self) -> Result<bool, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        render_runtime(self).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = screenshot)]
    pub async fn screenshot(&mut self) -> Result<Blob, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        screenshot_runtime(self).await.map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setTerrain)]
    pub fn set_terrain(&mut self, terrain: JsValue) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        set_terrain_runtime(self, terrain).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setTerrainFromSource)]
    pub async fn set_terrain_from_source(&mut self, terrain: JsValue) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        let limits = crate::inputs::TerrainPhysicalLimits {
            max_texture_dimension_2d: self.max_texture_dimension_2d,
            max_buffer_size: self.max_buffer_size,
        };
        let terrain = crate::io::load_terrain_heightmap_source(terrain, limits)
            .await
            .map_err(to_js_error)?;
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        set_terrain_options_runtime(self, terrain).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&mut self, camera: JsValue) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        set_camera_runtime(self, camera).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = resize)]
    pub fn resize(&mut self, size: JsValue) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
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

    #[wasm_bindgen(js_name = getCapabilities)]
    pub fn get_capabilities(&self) -> JsValue {
        let capabilities = js_sys::Object::new();
        let device_state = if self.disposed {
            "disposed"
        } else if self
            .context
            .as_ref()
            .map(|context| {
                context.health.snapshot().state == forge3d_core::gpu::DeviceHealthState::Lost
            })
            .unwrap_or(false)
        {
            "lost"
        } else {
            "ready"
        };
        set_js_property(
            capabilities.as_ref(),
            "deviceState",
            &JsValue::from_str(device_state),
        );
        set_js_property(
            capabilities.as_ref(),
            "maxTextureDimension2D",
            &JsValue::from_f64(self.max_texture_dimension_2d as f64),
        );
        set_js_property(
            capabilities.as_ref(),
            "maxBufferSize",
            &JsValue::from_f64(self.max_buffer_size as f64),
        );
        set_js_property(
            capabilities.as_ref(),
            "surfaceFormat",
            &JsValue::from_str(&self.surface_format),
        );
        capabilities.into()
    }

    #[wasm_bindgen(js_name = setDeviceLostCallback)]
    pub fn set_device_lost_callback(&mut self, callback: Option<js_sys::Function>) {
        if let (Some(context), Some(listener_id)) =
            (self.context.as_ref(), self.device_health_listener_id.take())
        {
            context.health.unsubscribe(listener_id);
        }
        self.device_lost_callback = callback;
        if self.disposed {
            return;
        }
        if let (Some(context), Some(callback)) =
            (self.context.as_ref(), self.device_lost_callback.clone())
        {
            let listener = std::sync::Arc::new(move |message: String| {
                let error = to_js_error(WebError::new(Forge3DErrorCode::DeviceLost, message));
                let _ = callback.call1(&JsValue::UNDEFINED, &error);
            });
            self.device_health_listener_id = Some(context.health.subscribe(listener));
        }
    }

    #[wasm_bindgen(js_name = simulateDeviceLossForTesting)]
    pub fn simulate_device_loss_for_testing(&mut self) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        if !self.diagnostics_enabled {
            return Err(to_js_error(WebError::new(
                Forge3DErrorCode::UnsupportedFeature,
                "Device-loss simulation requires diagnostics: true",
            )));
        }
        let context = self.context.as_ref().ok_or_else(|| {
            to_js_error(WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime GPU context is not available",
            ))
        })?;
        let health = context.health.clone();
        wasm_bindgen_futures::spawn_local(async move {
            health.report_device_lost(
                wgpu::DeviceLostReason::Unknown,
                "diagnostic device-loss simulation",
            );
        });
        Ok(())
    }

    #[wasm_bindgen(js_name = simulateSurfaceFailureForTesting)]
    pub fn simulate_surface_failure_for_testing(
        &mut self,
        failure: String,
        force_format_change: bool,
    ) -> Result<JsValue, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        if !self.diagnostics_enabled {
            return Err(to_js_error(WebError::new(
                Forge3DErrorCode::UnsupportedFeature,
                "Surface-failure simulation requires diagnostics: true",
            )));
        }
        diagnostics::simulate_surface_failure(self, &failure, force_format_change)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = simulateShaderCompilationFailureForTesting)]
    pub async fn simulate_shader_compilation_failure_for_testing(&mut self) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        if !self.diagnostics_enabled {
            return Err(to_js_error(WebError::new(
                Forge3DErrorCode::UnsupportedFeature,
                "Shader-failure simulation requires diagnostics: true",
            )));
        }
        diagnostics::simulate_shader_compilation_failure(self)
            .await
            .map_err(to_js_error)
    }
}

fn install_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

#[cfg(test)]
mod tests {
    use super::ensure_not_disposed_error;

    #[test]
    fn color_ramp_uniform_matches_wgsl_uniform_layout_size() {
        assert_eq!(std::mem::size_of::<super::terrain::ColorRampUniform>(), 160);
    }

    #[test]
    fn terrain_edge_skirts_extend_boundary_vertices_below_surface() {
        let mut vertices = vec![
            super::terrain::TerrainVertex {
                position: [-1.0, 0.0, -1.0],
                uv: [0.0, 0.0],
            },
            super::terrain::TerrainVertex {
                position: [1.0, 0.0, -1.0],
                uv: [1.0, 0.0],
            },
            super::terrain::TerrainVertex {
                position: [-1.0, 0.0, 1.0],
                uv: [0.0, 1.0],
            },
            super::terrain::TerrainVertex {
                position: [1.0, 0.0, 1.0],
                uv: [1.0, 1.0],
            },
        ];
        let mut indices = vec![0, 2, 1, 1, 2, 3];

        super::terrain::append_terrain_edge_skirts(&mut vertices, &mut indices, 2, 2).unwrap();

        assert_eq!(vertices.len(), 12);
        assert_eq!(indices.len(), 30);
        assert!(vertices[4..]
            .iter()
            .all(
                |vertex| (vertex.position[1] + super::terrain::TERRAIN_SKIRT_DEPTH).abs() < 0.0001
            ));
        assert_eq!(vertices[4].uv, [0.0, 0.0]);
    }

    #[test]
    fn runtime_dispose_guard_uses_stable_error_code() {
        let runtime = super::Forge3DRuntime {
            canvas: wasm_bindgen::JsCast::unchecked_into(wasm_bindgen::JsValue::NULL),
            gpu_runtime: None,
            context: None,
            surface_state: None,
            depth_attachment: None,
            terrain: None,
            camera: forge3d_core::camera::CameraInput::default(),
            width: 1,
            height: 1,
            clear_color: [0.0, 0.0, 0.0, 1.0],
            diagnostics_enabled: false,
            disposed: true,
            max_texture_dimension_2d: 8192,
            max_buffer_size: 256 * 1024 * 1024,
            surface_format: "Rgba8UnormSrgb".to_string(),
            preferred_alpha_mode: wgpu::CompositeAlphaMode::PreMultiplied,
            device_lost_callback: None,
            device_health_listener_id: None,
        };

        let error = ensure_not_disposed_error(&runtime).unwrap_err();
        assert_eq!(error.code().as_str(), "RUNTIME_DISPOSED");
    }
}
