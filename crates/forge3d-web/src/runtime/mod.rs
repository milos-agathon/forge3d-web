mod analysis;
mod canvas;
mod device_health;
mod diagnostics;
mod ibl;
mod init;
mod lighting;
mod memory;
pub(crate) mod offline;
mod readback;
mod render;
mod scene;
mod shader_variants;
mod shadows;
mod terrain;
mod textures;
mod timing;

use canvas::RuntimeCanvas;
use device_health::{ensure_device_healthy_error, set_js_property};
pub use device_health::{ensure_not_disposed, ensure_not_disposed_error};
use diagnostics::AdapterDiagnostics;
use init::create_runtime;
use memory::MemoryLedger;
use readback::screenshot_runtime;
use render::render_runtime;
use terrain::{
    resize_runtime, set_camera_runtime, set_terrain_options_runtime, set_terrain_runtime,
    DepthAttachment, TerrainRenderResources,
};
use timing::TimestampRing;

use forge3d_core::gpu::{GpuContext, GpuRuntime, SurfaceState};
use forge3d_core::memory::QualityLevel;
use forge3d_core::timing::{FrameTimer, RenderStats};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{Blob, HtmlCanvasElement};

use crate::error::{to_js_error, Forge3DErrorCode, WebError};

#[wasm_bindgen]
pub struct Forge3DRuntime {
    canvas: RuntimeCanvas,
    gpu_runtime: Option<GpuRuntime>,
    context: Option<GpuContext>,
    surface_state: Option<SurfaceState>,
    depth_attachment: Option<DepthAttachment>,
    terrain: Option<TerrainRenderResources>,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    terrain_pipeline_cache: Option<terrain::TerrainPipelineCache>,
    scene: Option<scene::NativeScene>,
    lighting: Option<lighting::LightingResources>,
    textures: Option<textures::TextureResources>,
    ibl: Option<ibl::IblResources>,
    shadows: Option<shadows::ShadowResources>,
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
    memory: MemoryLedger,
    overflow_policy: forge3d_core::memory::OverflowPolicy,
    requested_quality: QualityLevel,
    adapter_diagnostics: AdapterDiagnostics,
    query_ring: Option<TimestampRing>,
    timer: FrameTimer,
    last_stats: RenderStats,
    offline: Option<offline::OfflineSession>,
    offline_pipelines: Option<offline::OfflinePipelines>,
}

impl Forge3DRuntime {
    fn guard_mutation(&mut self) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        offline::ensure_no_offline(self).map_err(to_js_error)
    }
}

#[wasm_bindgen]
impl Forge3DRuntime {
    #[wasm_bindgen(js_name = create)]
    pub async fn create(
        canvas: HtmlCanvasElement,
        options: JsValue,
    ) -> Result<Forge3DRuntime, JsValue> {
        install_panic_hook();
        create_runtime(RuntimeCanvas::Html(canvas), options)
            .await
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = createOffscreen)]
    pub async fn create_offscreen(
        canvas: web_sys::OffscreenCanvas,
        options: JsValue,
    ) -> Result<Forge3DRuntime, JsValue> {
        install_panic_hook();
        create_runtime(RuntimeCanvas::Offscreen(canvas), options)
            .await
            .map_err(to_js_error)
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
        self.terrain_pipeline_cache = None;
        self.scene = None;
        self.lighting = None;
        self.textures = None;
        self.ibl = None;
        self.shadows = None;
        self.query_ring = None;
        self.offline = None;
        self.offline_pipelines = None;
        self.disposed = true;
        self.memory.clear();
    }

    /// Renders one display frame. While an offline session is open the display
    /// frame is skipped (returns `false`) like the native session guard.
    #[wasm_bindgen(js_name = render)]
    pub fn render(&mut self) -> Result<bool, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        if self.offline.is_some() {
            return Ok(false);
        }
        render_runtime(self).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = screenshot)]
    pub async fn screenshot(&mut self) -> Result<Blob, JsValue> {
        self.guard_mutation()?;
        screenshot_runtime(self).await.map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = readRgba)]
    pub async fn read_rgba(&mut self) -> Result<js_sys::Uint8Array, JsValue> {
        self.guard_mutation()?;
        let rgba = readback::read_rgba_runtime(self)
            .await
            .map_err(to_js_error)?;
        Ok(js_sys::Uint8Array::from(rgba.as_slice()))
    }

    #[wasm_bindgen(js_name = setScene)]
    pub fn set_scene(&mut self, snapshot: JsValue) -> Result<(), JsValue> {
        self.guard_mutation()?;
        scene::set_scene_runtime(self, snapshot).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setLighting)]
    pub fn set_lighting(&mut self, snapshot: JsValue) -> Result<(), JsValue> {
        self.guard_mutation()?;
        lighting::set_lighting_runtime(self, snapshot).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setMaterials)]
    pub fn set_materials(&mut self, snapshot: JsValue) -> Result<(), JsValue> {
        self.guard_mutation()?;
        lighting::set_materials_runtime(self, snapshot).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setIbl)]
    pub fn set_ibl(&mut self, input: JsValue) -> Result<(), JsValue> {
        self.guard_mutation()?;
        ibl::set_ibl_runtime(self, input).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = precomputeIbl)]
    pub async fn precompute_ibl(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
        self.guard_mutation()?;
        ibl::precompute_ibl_runtime(self, input)
            .await
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setShadows)]
    pub fn set_shadows(&mut self, snapshot: JsValue) -> Result<(), JsValue> {
        self.guard_mutation()?;
        shadows::set_shadows_runtime(self, snapshot).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getShadowReport)]
    pub fn get_shadow_report(&mut self) -> JsValue {
        shadows::shadow_report_js(self)
    }

    #[wasm_bindgen(js_name = setTerrain)]
    pub fn set_terrain(&mut self, terrain: JsValue) -> Result<(), JsValue> {
        self.guard_mutation()?;
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
        self.guard_mutation()?;
        set_terrain_options_runtime(self, terrain).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = readTerrainHeights)]
    pub async fn read_terrain_heights(&mut self) -> Result<js_sys::Float32Array, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        analysis::read_terrain_heights_runtime(self)
            .await
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = computeTerrainAnalysis)]
    pub async fn compute_terrain_analysis(
        &mut self,
        terrain: JsValue,
        request: JsValue,
    ) -> Result<JsValue, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        analysis::compute_terrain_analysis_runtime(self, terrain, request)
            .await
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = readTerrainAnalysis)]
    pub async fn read_terrain_analysis(&mut self, kind: JsValue) -> Result<JsValue, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        analysis::read_terrain_analysis_runtime(self, kind)
            .await
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&mut self, camera: JsValue) -> Result<(), JsValue> {
        self.guard_mutation()?;
        set_camera_runtime(self, camera).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = resize)]
    pub fn resize(&mut self, size: JsValue) -> Result<(), JsValue> {
        self.guard_mutation()?;
        resize_runtime(self, size).map_err(to_js_error)
    }

    /// Opens an offline accumulation session (native
    /// `begin_offline_accumulation`) for the committed scene and camera.
    #[wasm_bindgen(js_name = beginOffline)]
    pub fn begin_offline(&mut self, options: JsValue) -> Result<(), JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        offline::begin_offline_runtime(self, options).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = accumulateBatch)]
    pub async fn accumulate_batch(&mut self, sample_count: u32) -> Result<JsValue, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        offline::accumulate_batch_runtime(self, sample_count)
            .await
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = readAccumulationMetrics)]
    pub async fn read_accumulation_metrics(
        &mut self,
        target_variance: f64,
        tile_size: u32,
    ) -> Result<JsValue, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        offline::read_metrics_runtime(self, target_variance, tile_size)
            .await
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = resolveOffline)]
    pub async fn resolve_offline(&mut self, options: JsValue) -> Result<JsValue, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        offline::resolve_offline_runtime(self, options)
            .await
            .map_err(to_js_error)
    }

    /// Ends the offline session; returns whether one was open.
    #[wasm_bindgen(js_name = endOffline)]
    pub fn end_offline(&mut self) -> bool {
        offline::end_offline_runtime(self)
    }

    #[wasm_bindgen(getter, js_name = offlineActive)]
    pub fn offline_active(&self) -> bool {
        self.offline.is_some()
    }

    /// WebGPU A-trous denoise of caller-supplied HDR color and guides.
    #[wasm_bindgen(js_name = denoiseHdr)]
    pub async fn denoise_hdr(&mut self, input: JsValue) -> Result<js_sys::Float32Array, JsValue> {
        ensure_not_disposed_error(self).map_err(to_js_error)?;
        ensure_device_healthy_error(self).map_err(to_js_error)?;
        offline::denoise_hdr_runtime(self, input)
            .await
            .map_err(to_js_error)
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
        let capabilities_value: JsValue = capabilities.clone().into();
        set_js_property(
            &capabilities_value,
            "deviceState",
            &JsValue::from_str(device_state),
        );
        set_js_property(
            &capabilities_value,
            "maxTextureDimension2D",
            &JsValue::from_f64(self.max_texture_dimension_2d as f64),
        );
        set_js_property(
            &capabilities_value,
            "maxBufferSize",
            &JsValue::from_f64(self.max_buffer_size as f64),
        );
        set_js_property(
            &capabilities_value,
            "surfaceFormat",
            &JsValue::from_str(&self.surface_format),
        );
        set_js_property(
            &capabilities_value,
            "preferredCanvasFormat",
            &JsValue::from_str(&self.surface_format),
        );
        self.adapter_diagnostics
            .populate_capabilities(&capabilities_value);
        capabilities_value
    }

    #[wasm_bindgen(js_name = getMemoryReport)]
    pub fn get_memory_report(&self) -> JsValue {
        self.memory.report_js()
    }

    #[wasm_bindgen(js_name = getRenderStats)]
    pub fn get_render_stats(&self) -> JsValue {
        timing::stats_to_js(&self.last_stats)
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

    #[wasm_bindgen(js_name = registerDeviceLostCallback)]
    pub fn register_device_lost_callback(
        &mut self,
        callback: js_sys::Function,
    ) -> js_sys::Function {
        self.set_device_lost_callback(Some(callback));
        let Some(context) = self.context.as_ref() else {
            return js_sys::Function::new_no_args("");
        };
        let Some(listener_id) = self.device_health_listener_id else {
            return js_sys::Function::new_no_args("");
        };
        let health = context.health.clone();
        let listener_id = std::rc::Rc::new(std::cell::Cell::new(Some(listener_id)));
        let disposer_listener_id = listener_id.clone();
        let disposer = Closure::wrap(Box::new(move || {
            if let Some(listener_id) = disposer_listener_id.take() {
                health.unsubscribe(listener_id);
            }
        }) as Box<dyn FnMut()>);
        disposer.into_js_value().unchecked_into()
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
        assert_eq!(
            std::mem::offset_of!(super::terrain::ColorRampUniform, stop_count),
            128
        );
        assert_eq!(
            std::mem::offset_of!(super::terrain::ColorRampUniform, clear_color),
            144
        );
        assert_eq!(std::mem::size_of::<super::terrain::CameraUniform>(), 96);
        assert_eq!(std::mem::size_of::<super::terrain::TerrainVertex>(), 20);
        assert_eq!(
            std::mem::offset_of!(super::terrain::TerrainVertex, position),
            0
        );
        assert_eq!(std::mem::offset_of!(super::terrain::TerrainVertex, uv), 12);
    }

    #[test]
    fn screenshot_normalization_covers_all_supported_surface_formats() {
        let rgba = vec![1, 2, 3, 4, 10, 20, 30, 40, 90, 80, 70, 60];
        for format in [
            wgpu::TextureFormat::Rgba8Unorm,
            wgpu::TextureFormat::Rgba8UnormSrgb,
        ] {
            assert_eq!(
                super::readback::normalize_readback_to_rgba(rgba.clone(), format).unwrap(),
                rgba
            );
        }
        let bgra = vec![3, 2, 1, 4, 30, 20, 10, 40, 70, 80, 90, 60];
        for format in [
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Bgra8UnormSrgb,
        ] {
            assert_eq!(
                super::readback::normalize_readback_to_rgba(bgra.clone(), format).unwrap(),
                rgba
            );
        }
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
            canvas: super::RuntimeCanvas::Html(wasm_bindgen::JsCast::unchecked_into(
                wasm_bindgen::JsValue::NULL,
            )),
            gpu_runtime: None,
            context: None,
            surface_state: None,
            depth_attachment: None,
            terrain: None,
            terrain_pipeline_cache: None,
            scene: None,
            lighting: None,
            textures: None,
            ibl: None,
            shadows: None,
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
            memory: super::MemoryLedger::new(
                forge3d_core::memory::DEFAULT_MEMORY_BUDGET_BYTES,
                forge3d_core::memory::QualityLevel::High,
            )
            .unwrap(),
            overflow_policy: forge3d_core::memory::OverflowPolicy::Downscale,
            requested_quality: forge3d_core::memory::QualityLevel::High,
            adapter_diagnostics: super::AdapterDiagnostics::default(),
            query_ring: None,
            timer: forge3d_core::timing::FrameTimer::new(false),
            last_stats: forge3d_core::timing::RenderStats {
                frame_index: 0,
                frame_time_ms: 0.0,
                draw_calls: 0,
                triangles: 0,
                passes: Vec::new(),
            },
            offline: None,
            offline_pipelines: None,
        };

        let error = ensure_not_disposed_error(&runtime).unwrap_err();
        assert_eq!(error.code().as_str(), "RUNTIME_DISPOSED");
    }

    #[test]
    fn r32float_upload_plan_selects_tight_or_rowwise_by_alignment() {
        use super::terrain::{r32float_upload_plan, R32FloatUploadPlan};
        match r32float_upload_plan(64) {
            R32FloatUploadPlan::Tight { bytes_per_row } => {
                assert_eq!(bytes_per_row, 256);
            }
            _ => panic!("64-wide rows are aligned"),
        }
        match r32float_upload_plan(257) {
            R32FloatUploadPlan::RowWise { row_bytes } => {
                assert_eq!(row_bytes, 1028);
            }
            _ => panic!("257-wide rows must use per-row writes"),
        }
    }
}
