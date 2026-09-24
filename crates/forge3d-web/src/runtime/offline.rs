//! W06 capture and offline quality (R02, C07, C08).
//!
//! A capture session renders the committed scene through feature-specialized
//! capture pipelines into float targets: HDR color, normalized linear depth,
//! object ID and pixel motion (primary pass) plus albedo and shading normal
//! (surface pass), with overlays composited from a premultiplied layer. Each
//! sample uses the native R2 sub-pixel jitter; compute passes accumulate the
//! sums, report native tile-luminance convergence metrics, resolve averages,
//! run the AOV-guided A-trous denoiser and tonemap to RGBA8. Depth, ID and
//! motion come from one unjittered reference pass so they stay exact.
//!
//! The session owns separate capture camera buffers and bind groups, so the
//! display path is untouched; scene mutations are rejected while it is open
//! (the TypeScript facade queues them instead).

mod gpu;
#[cfg(test)]
mod tests;

use forge3d_core::camera::CameraInput;
use forge3d_core::memory::MemoryCategory;
use forge3d_core::offline::denoise::AtrousParams;
use forge3d_core::offline::jitter::JitterSequence;
use forge3d_core::offline::metrics::{luminance_dimensions, ConvergenceTracker, OfflineMetrics};
use forge3d_core::offline::tonemap::TonemapOperator;
use forge3d_core::readback::{decode_float_rows, decode_u32_rows, ReadbackFormat};
use wasm_bindgen::{JsCast, JsValue};

use super::device_health::set_js_property;
use super::Forge3DRuntime;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};
pub(crate) use gpu::OfflinePipelines;
use gpu::{
    bytes_to_f32, check_storage_binding, copy_texture, f32_bytes, read_buffer, read_texture,
    storage_buffer, storage_buffer_init, uniform_buffer, wait_for_queue, CaptureTargets,
};

/// AOV object IDs: `0` background, `1` terrain, then `node.id + 2` per scene
/// node.
pub(crate) const AOV_ID_TERRAIN: u32 = 1;
pub(crate) const AOV_ID_SCENE_NODE_BASE: u32 = 2;

pub(crate) const CAPTURE_COLOR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba32Float;
pub(crate) const CAPTURE_DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R32Float;
pub(crate) const CAPTURE_ID_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R32Uint;
pub(crate) const CAPTURE_MOTION_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rg32Float;
pub(crate) const CAPTURE_SURFACE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba32Float;
pub(crate) const CAPTURE_OVERLAY_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// Upper bound on the jitter sequence of one session.
pub(crate) const MAX_OFFLINE_SAMPLES: u32 = 4096;
/// Upper bound on samples submitted by one `accumulateBatch` call.
pub(crate) const MAX_BATCH_SAMPLES: u32 = 256;
/// Native default white point of the tonemap operators.
pub(crate) const DEFAULT_WHITE_POINT: f32 = 4.0;

const TARGETS_KEY: &str = "offline:targets";
const ACCUMULATION_KEY: &str = "offline:accumulation";
const RESOLVE_KEY: &str = "offline:resolve";
const ACTIVE_MESSAGE: &str = "An offline accumulation session is already active.";
const NO_SESSION_MESSAGE: &str = "No offline accumulation session is active";

/// Capture render pass: primary (color/depth/id/motion) or surface
/// (albedo/normal). Both stay within the default 32-byte color budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum CapturePass {
    Primary,
    Surface,
}

impl CapturePass {
    pub(crate) fn entry_point(self) -> &'static str {
        match self {
            Self::Primary => "fs_capture_primary",
            Self::Surface => "fs_capture_surface",
        }
    }

    pub(crate) fn formats(self) -> &'static [wgpu::TextureFormat] {
        match self {
            Self::Primary => &[
                CAPTURE_COLOR_FORMAT,
                CAPTURE_DEPTH_FORMAT,
                CAPTURE_ID_FORMAT,
                CAPTURE_MOTION_FORMAT,
            ],
            Self::Surface => &[CAPTURE_SURFACE_FORMAT, CAPTURE_SURFACE_FORMAT],
        }
    }

    pub(crate) fn color_targets(self) -> Vec<Option<wgpu::ColorTargetState>> {
        self.formats()
            .iter()
            .map(|format| {
                Some(wgpu::ColorTargetState {
                    format: *format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AovSelection {
    pub albedo: bool,
    pub normal: bool,
    pub depth: bool,
    pub id: bool,
    pub motion: bool,
}

impl AovSelection {
    fn surface(self) -> bool {
        self.albedo || self.normal
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BeginOptions {
    pub samples: u32,
    pub seed: Option<u64>,
    pub aovs: AovSelection,
    pub previous_camera: Option<CameraInput>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DenoiseRequest {
    pub params: AtrousParams,
    pub guide_albedo: bool,
    pub guide_normal: bool,
    pub guide_depth: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ResolveOptions {
    pub operator: TonemapOperator,
    pub white_point: f32,
    pub denoise: Option<DenoiseRequest>,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GridParams {
    width: u32,
    height: u32,
    value: u32,
    flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct TonemapParams {
    pub width: u32,
    pub height: u32,
    pub lane: u32,
    pub flags: u32,
    pub white_point: f32,
    pub terrain_id: u32,
    pub _pad: [u32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct DenoiseParams {
    pub width: u32,
    pub height: u32,
    pub step: u32,
    pub flags: u32,
    pub sigma_color: f32,
    pub sigma_albedo: f32,
    pub sigma_normal: f32,
    pub sigma_depth: f32,
    pub edge_scale: f32,
    pub _pad: [f32; 3],
}

const ACCUMULATE_SURFACE: u32 = 1;
const ACCUMULATE_OVERLAY: u32 = 2;
const ACCUMULATE_RESET: u32 = 4;
const TONEMAP_SCREEN_TERRAIN: u32 = 1;
const TONEMAP_SURFACE_SRGB: u32 = 2;
const DENOISE_ALBEDO_TERM: u32 = 1;
const DENOISE_NORMAL: u32 = 2;
const DENOISE_DEPTH: u32 = 4;
const DENOISE_EDGE: u32 = 8;

struct TerrainCapture {
    bind_group: wgpu::BindGroup,
    primary: wgpu::RenderPipeline,
    surface: Option<wgpu::RenderPipeline>,
}

pub(crate) struct OfflineSession {
    width: u32,
    height: u32,
    aovs: AovSelection,
    surface: bool,
    overlay: bool,
    jitter: JitterSequence,
    total_samples: u32,
    camera: CameraInput,
    previous: CameraInput,
    camera_buffer: wgpu::Buffer,
    terrain: Option<TerrainCapture>,
    scene_camera: Option<wgpu::BindGroup>,
    targets: CaptureTargets,
    accum_color: wgpu::Buffer,
    accum_albedo: wgpu::Buffer,
    accum_normal: wgpu::Buffer,
    accumulate_params: wgpu::Buffer,
    accumulate_bind_group: wgpu::BindGroup,
    tracker: ConvergenceTracker,
    screen_terrain: bool,
}

impl OfflineSession {
    pub(crate) fn total_samples(&self) -> u32 {
        self.total_samples
    }
}

fn prop(value: &JsValue, name: &str) -> JsValue {
    js_sys::Reflect::get(value, &JsValue::from_str(name)).unwrap_or(JsValue::UNDEFINED)
}

fn invalid(field: &str, message: impl Into<String>) -> WebError {
    WebError::new(
        Forge3DErrorCode::InvalidInput,
        format!("{field}: {}", message.into()),
    )
}

fn opt_bool(value: &JsValue, name: &str, field: &str) -> Result<Option<bool>, WebError> {
    let raw = prop(value, name);
    if raw.is_undefined() || raw.is_null() {
        return Ok(None);
    }
    raw.as_bool()
        .map(Some)
        .ok_or_else(|| invalid(field, "must be a boolean"))
}

fn opt_number(value: &JsValue, name: &str, field: &str) -> Result<Option<f64>, WebError> {
    let raw = prop(value, name);
    if raw.is_undefined() || raw.is_null() {
        return Ok(None);
    }
    match raw.as_f64() {
        Some(number) if number.is_finite() => Ok(Some(number)),
        _ => Err(invalid(field, "must be a finite number")),
    }
}

fn integer_in(value: f64, field: &str, min: f64, max: f64) -> Result<u32, WebError> {
    if value.fract() != 0.0 || value < min || value > max {
        return Err(invalid(
            field,
            format!("must be an integer in [{min}, {max}]"),
        ));
    }
    Ok(value as u32)
}

pub(crate) fn parse_aovs(value: &JsValue) -> Result<AovSelection, WebError> {
    if value.is_undefined() || value.is_null() {
        return Ok(AovSelection::default());
    }
    if !value.is_object() {
        return Err(invalid("aovs", "must be an object"));
    }
    Ok(AovSelection {
        albedo: opt_bool(value, "albedo", "aovs.albedo")?.unwrap_or(false),
        normal: opt_bool(value, "normal", "aovs.normal")?.unwrap_or(false),
        depth: opt_bool(value, "depth", "aovs.depth")?.unwrap_or(false),
        id: opt_bool(value, "id", "aovs.id")?.unwrap_or(false),
        motion: opt_bool(value, "motion", "aovs.motion")?.unwrap_or(false),
    })
}

pub(crate) fn parse_begin_options(value: &JsValue) -> Result<BeginOptions, WebError> {
    if !value.is_object() {
        return Err(invalid("offline", "options must be an object"));
    }
    let samples = integer_in(
        opt_number(value, "samples", "samples")?.unwrap_or(1.0),
        "samples",
        1.0,
        f64::from(MAX_OFFLINE_SAMPLES),
    )?;
    let seed = match opt_number(value, "seed", "seed")? {
        None => None,
        Some(seed) if seed.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&seed) => {
            Some(seed as u64)
        }
        Some(_) => return Err(invalid("seed", "must be a non-negative safe integer")),
    };
    let previous = prop(value, "previousCamera");
    let previous_camera = if previous.is_undefined() || previous.is_null() {
        None
    } else {
        Some(crate::inputs::CameraOptions::from_js_value(previous)?.validate()?)
    };
    Ok(BeginOptions {
        samples,
        seed,
        aovs: parse_aovs(&prop(value, "aovs"))?,
        previous_camera,
    })
}

fn parse_atrous(value: &JsValue, field: &str) -> Result<AtrousParams, WebError> {
    let defaults = AtrousParams::default();
    let params = AtrousParams {
        iterations: match opt_number(value, "iterations", &format!("{field}.iterations"))? {
            Some(n) => integer_in(n, &format!("{field}.iterations"), 1.0, 10.0)?,
            None => defaults.iterations,
        },
        sigma_color: opt_number(value, "sigmaColor", &format!("{field}.sigmaColor"))?
            .map_or(defaults.sigma_color, |n| n as f32),
        sigma_albedo: opt_number(value, "sigmaAlbedo", &format!("{field}.sigmaAlbedo"))?
            .map_or(defaults.sigma_albedo, |n| n as f32),
        sigma_normal: opt_number(value, "sigmaNormal", &format!("{field}.sigmaNormal"))?
            .map_or(defaults.sigma_normal, |n| n as f32),
        sigma_depth: opt_number(value, "sigmaDepth", &format!("{field}.sigmaDepth"))?
            .map_or(defaults.sigma_depth, |n| n as f32),
        edge_stopping: opt_number(value, "edgeStopping", &format!("{field}.edgeStopping"))?
            .map_or(defaults.edge_stopping, |n| n as f32),
        noise_sigma: opt_number(value, "noiseSigma", &format!("{field}.noiseSigma"))?
            .map(|n| n as f32),
    };
    params.validate().map_err(map_core_error)?;
    Ok(params)
}

pub(crate) fn parse_resolve_options(value: &JsValue) -> Result<ResolveOptions, WebError> {
    let tonemap = prop(value, "tonemap");
    let (operator, white_point) = if tonemap.is_undefined() || tonemap.is_null() {
        (TonemapOperator::Display, DEFAULT_WHITE_POINT)
    } else {
        let operator = match prop(&tonemap, "operator").as_string() {
            Some(name) => TonemapOperator::parse(&name).map_err(map_core_error)?,
            None if prop(&tonemap, "operator").is_undefined() => TonemapOperator::Display,
            None => return Err(invalid("tonemap.operator", "must be a string")),
        };
        let white_point = opt_number(&tonemap, "whitePoint", "tonemap.whitePoint")?
            .map_or(DEFAULT_WHITE_POINT, |n| n as f32);
        if white_point <= 0.0 {
            return Err(invalid("tonemap.whitePoint", "must be > 0"));
        }
        (operator, white_point)
    };
    let denoise_value = prop(value, "denoise");
    let denoise = if denoise_value.is_undefined() || denoise_value.is_null() {
        None
    } else {
        let guides = prop(&denoise_value, "guides");
        let guide = |name: &str, default: bool| -> Result<bool, WebError> {
            if guides.is_undefined() || guides.is_null() {
                return Ok(default);
            }
            Ok(opt_bool(&guides, name, &format!("denoise.guides.{name}"))?.unwrap_or(default))
        };
        Some(DenoiseRequest {
            params: parse_atrous(&denoise_value, "denoise")?,
            guide_albedo: guide("albedo", true)?,
            guide_normal: guide("normal", true)?,
            guide_depth: guide("depth", false)?,
        })
    };
    Ok(ResolveOptions {
        operator,
        white_point,
        denoise,
    })
}

fn context_of(runtime: &Forge3DRuntime) -> Result<forge3d_core::gpu::GpuContext, WebError> {
    runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })
}

fn pixel_bytes(width: u32, height: u32, per_pixel: u64) -> u64 {
    u64::from(width)
        .saturating_mul(u64::from(height))
        .saturating_mul(per_pixel)
}

pub(crate) fn ensure_no_offline(runtime: &Forge3DRuntime) -> Result<(), WebError> {
    if runtime.offline.is_some() {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "An offline accumulation session is active; end it before mutating or reading the display frame",
        ));
    }
    Ok(())
}

pub(super) fn begin_offline_runtime(
    runtime: &mut Forge3DRuntime,
    options: JsValue,
) -> Result<(), WebError> {
    if runtime.offline.is_some() {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            ACTIVE_MESSAGE,
        ));
    }
    let options = parse_begin_options(&options)?;
    let context = context_of(runtime)?;
    super::shader_variants::sync_pipelines(runtime)?;
    let (width, height) = (runtime.width, runtime.height);
    let surface = options.aovs.surface();
    let overlay = runtime
        .scene
        .as_ref()
        .is_some_and(|scene| !scene.overlay_ranges.is_empty());

    let accum_pixel = pixel_bytes(width, height, 16);
    check_storage_binding(&context, accum_pixel, "offline accumulation")?;
    let target_bytes = CaptureTargets::planned_bytes(width, height, surface, overlay);
    let accum_bytes = if surface {
        accum_pixel.saturating_mul(3)
    } else {
        accum_pixel.saturating_add(32)
    };
    runtime
        .memory
        .replace(TARGETS_KEY, MemoryCategory::Textures, target_bytes)?;
    if let Err(error) =
        runtime
            .memory
            .replace(ACCUMULATION_KEY, MemoryCategory::Buffers, accum_bytes)
    {
        runtime.memory.release(TARGETS_KEY);
        return Err(error);
    }

    let result = create_session(runtime, &context, options, surface, overlay);
    match result {
        Ok(session) => {
            runtime.offline = Some(session);
            Ok(())
        }
        Err(error) => {
            runtime.memory.release(TARGETS_KEY);
            runtime.memory.release(ACCUMULATION_KEY);
            Err(error)
        }
    }
}

fn create_session(
    runtime: &mut Forge3DRuntime,
    context: &forge3d_core::gpu::GpuContext,
    options: BeginOptions,
    surface: bool,
    overlay: bool,
) -> Result<OfflineSession, WebError> {
    let device = &context.device;
    let (width, height) = (runtime.width, runtime.height);
    let camera = runtime.camera;
    let previous = options.previous_camera.unwrap_or(camera);
    let initial = super::terrain::create_capture_camera_uniform(
        &camera,
        &previous,
        width,
        height,
        [0.0, 0.0],
        AOV_ID_TERRAIN,
    )?;
    let camera_buffer = uniform_buffer(
        device,
        "forge3d-web-capture-camera",
        bytemuck::bytes_of(&initial),
    );

    let lighting_features = super::shader_variants::runtime_lighting_features(runtime)?;
    let terrain = match (
        runtime.terrain.as_ref(),
        runtime.terrain_pipeline_cache.as_mut(),
    ) {
        (Some(terrain), Some(cache)) => {
            let features = lighting_features.with_terrain_mode(terrain.render_mode);
            let primary = cache.capture_variant(device, features, CapturePass::Primary);
            let surface_pipeline =
                surface.then(|| cache.capture_variant(device, features, CapturePass::Surface));
            let bind_group =
                terrain.capture_bind_group(device, &cache.bind_group_layout, &camera_buffer);
            Some(TerrainCapture {
                bind_group,
                primary,
                surface: surface_pipeline,
            })
        }
        _ => None,
    };
    let screen_terrain = runtime
        .terrain
        .as_ref()
        .is_some_and(|terrain| terrain.render_mode == 1);
    let scene_camera = match runtime.scene.as_mut() {
        Some(scene) => {
            scene.prepare_capture(context);
            Some(scene.capture_camera_bind_group(device, &camera_buffer))
        }
        None => None,
    };

    let targets = CaptureTargets::new(device, width, height, surface, overlay);
    let accum_bytes = pixel_bytes(width, height, 16);
    let accum_color = storage_buffer(device, "forge3d-web-offline-accum-color", accum_bytes);
    let surface_bytes = if surface { accum_bytes } else { 16 };
    let accum_albedo = storage_buffer(device, "forge3d-web-offline-accum-albedo", surface_bytes);
    let accum_normal = storage_buffer(device, "forge3d-web-offline-accum-normal", surface_bytes);
    let accumulate_params = uniform_buffer(
        device,
        "forge3d-web-offline-accumulate-params",
        bytemuck::bytes_of(&GridParams {
            width,
            height,
            value: 0,
            flags: 0,
        }),
    );
    let pipelines = runtime
        .offline_pipelines
        .get_or_insert_with(|| OfflinePipelines::new(device));
    let accumulate_bind_group = pipelines.accumulate.bind_group(
        device,
        "forge3d-web-offline-accumulate",
        &[
            wgpu::BindingResource::TextureView(&targets.color.view),
            wgpu::BindingResource::TextureView(&targets.overlay.view),
            wgpu::BindingResource::TextureView(&targets.albedo.view),
            wgpu::BindingResource::TextureView(&targets.normal.view),
            accum_color.as_entire_binding(),
            accum_albedo.as_entire_binding(),
            accum_normal.as_entire_binding(),
            accumulate_params.as_entire_binding(),
        ],
    );

    let session = OfflineSession {
        width,
        height,
        aovs: options.aovs,
        surface,
        overlay,
        jitter: JitterSequence::new(options.samples, options.seed),
        total_samples: 0,
        camera,
        previous,
        camera_buffer,
        terrain,
        scene_camera,
        targets,
        accum_color,
        accum_albedo,
        accum_normal,
        accumulate_params,
        accumulate_bind_group,
        tracker: ConvergenceTracker::new(),
        screen_terrain,
    };

    // Unjittered reference pass: depth, ID and motion AOVs.
    super::shadows::refresh_shadow_state(runtime)?;
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("forge3d-web-offline-reference"),
    });
    super::shadows::encode_shadow_passes(runtime, &mut encoder);
    encode_capture(runtime, &session, &mut encoder, false);
    for (source, destination) in [
        (&session.targets.depth, &session.targets.depth_ref),
        (&session.targets.id, &session.targets.id_ref),
        (&session.targets.motion, &session.targets.motion_ref),
    ] {
        copy_texture(
            &mut encoder,
            &source.texture,
            &destination.texture,
            width,
            height,
        );
    }
    context.queue.submit(std::iter::once(encoder.finish()));
    Ok(session)
}

fn color_attachment<'a>(
    view: &'a wgpu::TextureView,
    clear: [f64; 4],
) -> Option<wgpu::RenderPassColorAttachment<'a>> {
    Some(wgpu::RenderPassColorAttachment {
        view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color {
                r: clear[0],
                g: clear[1],
                b: clear[2],
                a: clear[3],
            }),
            store: wgpu::StoreOp::Store,
        },
    })
}

/// Encodes the capture passes for the camera currently in the session
/// camera buffer. `surface` adds the albedo/normal pass.
fn encode_capture(
    runtime: &Forge3DRuntime,
    session: &OfflineSession,
    encoder: &mut wgpu::CommandEncoder,
    surface: bool,
) {
    let (Some(lighting), Some(textures), Some(ibl)) = (
        runtime.lighting.as_ref(),
        runtime.textures.as_ref(),
        runtime.ibl.as_ref(),
    ) else {
        return;
    };
    let targets = &session.targets;
    let clear = runtime.clear_color.map(f64::from);
    let passes: &[CapturePass] = if surface && session.surface {
        &[CapturePass::Primary, CapturePass::Surface]
    } else {
        &[CapturePass::Primary]
    };
    for which in passes {
        let colors = match which {
            CapturePass::Primary => vec![
                color_attachment(&targets.color.view, clear),
                color_attachment(&targets.depth.view, [1.0, 0.0, 0.0, 0.0]),
                color_attachment(&targets.id.view, [0.0; 4]),
                color_attachment(&targets.motion.view, [0.0; 4]),
            ],
            CapturePass::Surface => vec![
                color_attachment(&targets.albedo.view, [0.0; 4]),
                color_attachment(&targets.normal.view, [0.0; 4]),
            ],
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(match which {
                CapturePass::Primary => "forge3d-web-capture-primary",
                CapturePass::Surface => "forge3d-web-capture-surface",
            }),
            color_attachments: &colors,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &targets.depth_stencil.view,
                depth_ops: Some(wgpu::Operations {
                    load: match which {
                        CapturePass::Primary => wgpu::LoadOp::Clear(1.0),
                        CapturePass::Surface => wgpu::LoadOp::Load,
                    },
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        if let (Some(terrain), Some(capture)) = (runtime.terrain.as_ref(), session.terrain.as_ref())
        {
            let pipeline = match which {
                CapturePass::Primary => Some(&capture.primary),
                CapturePass::Surface => capture.surface.as_ref(),
            };
            if let Some(pipeline) = pipeline {
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &capture.bind_group, &[]);
                pass.set_bind_group(1, &lighting.bind_group, &[]);
                pass.set_bind_group(2, textures.bind_group_for(0), &[]);
                pass.set_bind_group(3, &ibl.bind_group, &[]);
                pass.set_vertex_buffer(0, terrain.vertex_buffer.slice(..));
                pass.set_index_buffer(terrain.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                if terrain.render_mode == 1 {
                    pass.draw(0..3, 0..1);
                } else {
                    pass.draw_indexed(0..terrain.index_count, 0, 0..1);
                }
            }
        }
        if let (Some(scene), Some(camera)) = (runtime.scene.as_ref(), session.scene_camera.as_ref())
        {
            scene.draw_capture_world(&mut pass, *which, camera, textures, ibl);
        }
    }
    if session.overlay && surface {
        if let Some(scene) = runtime.scene.as_ref() {
            let colors = [color_attachment(&targets.overlay.view, [0.0; 4])];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("forge3d-web-capture-overlay"),
                color_attachments: &colors,
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });
            scene.draw_capture_overlays(&mut pass);
        }
    }
}

pub(super) async fn accumulate_batch_runtime(
    runtime: &mut Forge3DRuntime,
    count: u32,
) -> Result<JsValue, WebError> {
    if count == 0 || count > MAX_BATCH_SAMPLES {
        return Err(invalid(
            "sampleCount",
            format!("must be an integer in [1, {MAX_BATCH_SAMPLES}]"),
        ));
    }
    let mut session = runtime
        .offline
        .take()
        .ok_or_else(|| WebError::new(Forge3DErrorCode::InvalidInput, NO_SESSION_MESSAGE))?;
    let started = super::timing::now_ms();
    let result = accumulate_samples(runtime, &mut session, count).await;
    runtime.offline = Some(session);
    result?;
    let total = runtime
        .offline
        .as_ref()
        .map_or(0, OfflineSession::total_samples);
    let output = js_sys::Object::new();
    let output_value: JsValue = output.into();
    set_js_property(
        &output_value,
        "totalSamples",
        &JsValue::from_f64(f64::from(total)),
    );
    set_js_property(
        &output_value,
        "batchTimeMs",
        &JsValue::from_f64((super::timing::now_ms() - started).max(0.0)),
    );
    Ok(output_value)
}

async fn accumulate_samples(
    runtime: &mut Forge3DRuntime,
    session: &mut OfflineSession,
    count: u32,
) -> Result<(), WebError> {
    let context = context_of(runtime)?;
    for _ in 0..count {
        let jitter = session.jitter.next_offset();
        let uniform = super::terrain::create_capture_camera_uniform(
            &session.camera,
            &session.previous,
            session.width,
            session.height,
            jitter,
            AOV_ID_TERRAIN,
        )?;
        context
            .queue
            .write_buffer(&session.camera_buffer, 0, bytemuck::bytes_of(&uniform));
        let mut flags = 0;
        if session.surface {
            flags |= ACCUMULATE_SURFACE;
        }
        if session.overlay {
            flags |= ACCUMULATE_OVERLAY;
        }
        if session.total_samples == 0 {
            flags |= ACCUMULATE_RESET;
        }
        context.queue.write_buffer(
            &session.accumulate_params,
            0,
            bytemuck::bytes_of(&GridParams {
                width: session.width,
                height: session.height,
                value: session.total_samples,
                flags,
            }),
        );
        super::shadows::refresh_shadow_state(runtime)?;
        let mut encoder = context
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forge3d-web-offline-sample"),
            });
        super::shadows::encode_shadow_passes(runtime, &mut encoder);
        encode_capture(runtime, session, &mut encoder, true);
        let pipelines = runtime.offline_pipelines.as_ref().ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::InternalError,
                "offline pipelines are missing",
            )
        })?;
        pipelines.accumulate.dispatch(
            &mut encoder,
            "forge3d-web-offline-accumulate",
            &session.accumulate_bind_group,
            session.width,
            session.height,
        );
        context.queue.submit(std::iter::once(encoder.finish()));
        session.total_samples += 1;
    }
    wait_for_queue(&context).await?;
    super::device_health::ensure_device_healthy_error(runtime)
}

pub(super) async fn read_metrics_runtime(
    runtime: &mut Forge3DRuntime,
    target_variance: f64,
    tile_size: u32,
) -> Result<JsValue, WebError> {
    if !target_variance.is_finite() {
        return Err(invalid("targetVariance", "must be finite"));
    }
    if tile_size == 0 {
        return Err(invalid("tileSize", "must be >= 1"));
    }
    let mut session = runtime
        .offline
        .take()
        .ok_or_else(|| WebError::new(Forge3DErrorCode::InvalidInput, NO_SESSION_MESSAGE))?;
    let result = read_metrics(runtime, &mut session, target_variance as f32, tile_size).await;
    runtime.offline = Some(session);
    Ok(metrics_to_js(&result?))
}

async fn read_metrics(
    runtime: &Forge3DRuntime,
    session: &mut OfflineSession,
    target_variance: f32,
    tile_size: u32,
) -> Result<OfflineMetrics, WebError> {
    if session.total_samples == 0 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "Cannot read accumulation metrics before rendering any samples",
        ));
    }
    let context = context_of(runtime)?;
    let pipelines = runtime.offline_pipelines.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::InternalError,
            "offline pipelines are missing",
        )
    })?;
    let (lum_width, lum_height) = luminance_dimensions(session.width, session.height);
    let lum_bytes = pixel_bytes(lum_width, lum_height, 4);
    let luminance = storage_buffer(&context.device, "forge3d-web-offline-luminance", lum_bytes);
    let params = uniform_buffer(
        &context.device,
        "forge3d-web-offline-luminance-params",
        bytemuck::bytes_of(&GridParams {
            width: session.width,
            height: session.height,
            value: session.total_samples,
            flags: 0,
        }),
    );
    let bind_group = pipelines.luminance.bind_group(
        &context.device,
        "forge3d-web-offline-luminance",
        &[
            session.accum_color.as_entire_binding(),
            luminance.as_entire_binding(),
            params.as_entire_binding(),
        ],
    );
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("forge3d-web-offline-metrics"),
        });
    pipelines.luminance.dispatch(
        &mut encoder,
        "forge3d-web-offline-luminance",
        &bind_group,
        lum_width,
        lum_height,
    );
    context.queue.submit(std::iter::once(encoder.finish()));
    let values = bytes_to_f32(&read_buffer(&context, &luminance, lum_bytes).await?);
    session
        .tracker
        .update(
            &values,
            lum_width,
            lum_height,
            tile_size,
            target_variance,
            session.total_samples,
        )
        .map_err(map_core_error)
}

fn metrics_to_js(metrics: &OfflineMetrics) -> JsValue {
    let output: JsValue = js_sys::Object::new().into();
    for (name, value) in [
        ("totalSamples", f64::from(metrics.total_samples)),
        ("meanDelta", f64::from(metrics.mean_delta)),
        ("p95Delta", f64::from(metrics.p95_delta)),
        ("maxTileDelta", f64::from(metrics.max_tile_delta)),
        (
            "convergedTileRatio",
            f64::from(metrics.converged_tile_ratio),
        ),
    ] {
        set_js_property(&output, name, &JsValue::from_f64(value));
    }
    output
}

pub(super) async fn resolve_offline_runtime(
    runtime: &mut Forge3DRuntime,
    options: JsValue,
) -> Result<JsValue, WebError> {
    let options = parse_resolve_options(&options)?;
    let session = runtime
        .offline
        .take()
        .ok_or_else(|| WebError::new(Forge3DErrorCode::InvalidInput, NO_SESSION_MESSAGE))?;
    let result = resolve(runtime, &session, &options).await;
    runtime.memory.release(RESOLVE_KEY);
    runtime.offline = Some(session);
    result
}

fn surface_is_srgb(runtime: &Forge3DRuntime) -> bool {
    runtime.surface_state.as_ref().is_some_and(|state| {
        matches!(
            state.config.format,
            wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
        )
    })
}

async fn resolve(
    runtime: &mut Forge3DRuntime,
    session: &OfflineSession,
    options: &ResolveOptions,
) -> Result<JsValue, WebError> {
    if session.total_samples == 0 {
        return Err(WebError::new(
            Forge3DErrorCode::InvalidInput,
            "Cannot resolve offline accumulation before rendering any samples",
        ));
    }
    let context = context_of(runtime)?;
    let device = &context.device;
    let (width, height) = (session.width, session.height);
    let vec4_bytes = pixel_bytes(width, height, 16);
    let scalar_bytes = pixel_bytes(width, height, 4);
    let denoise = options.denoise;
    let mut planned = vec4_bytes + scalar_bytes * 2;
    if session.surface {
        planned += vec4_bytes * 2;
    }
    if denoise.is_some() {
        planned += vec4_bytes * 2;
    }
    runtime
        .memory
        .replace(RESOLVE_KEY, MemoryCategory::Readback, planned)?;

    let out_color = storage_buffer(device, "forge3d-web-offline-resolved-color", vec4_bytes);
    let surface_bytes = if session.surface { vec4_bytes } else { 16 };
    let out_albedo = storage_buffer(device, "forge3d-web-offline-resolved-albedo", surface_bytes);
    let out_normal = storage_buffer(device, "forge3d-web-offline-resolved-normal", surface_bytes);
    let out_depth = storage_buffer(device, "forge3d-web-offline-resolved-depth", scalar_bytes);
    let ldr = storage_buffer(device, "forge3d-web-offline-ldr", scalar_bytes);
    let pipelines = runtime.offline_pipelines.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::InternalError,
            "offline pipelines are missing",
        )
    })?;
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("forge3d-web-offline-resolve"),
    });

    let resolve_params = uniform_buffer(
        device,
        "forge3d-web-offline-resolve-params",
        bytemuck::bytes_of(&GridParams {
            width,
            height,
            value: session.total_samples,
            flags: u32::from(session.surface),
        }),
    );
    let resolve_group = pipelines.resolve.bind_group(
        device,
        "forge3d-web-offline-resolve",
        &[
            session.accum_color.as_entire_binding(),
            session.accum_albedo.as_entire_binding(),
            session.accum_normal.as_entire_binding(),
            out_color.as_entire_binding(),
            out_albedo.as_entire_binding(),
            out_normal.as_entire_binding(),
            wgpu::BindingResource::TextureView(&session.targets.depth_ref.view),
            out_depth.as_entire_binding(),
            resolve_params.as_entire_binding(),
        ],
    );
    pipelines.resolve.dispatch(
        &mut encoder,
        "forge3d-web-offline-resolve",
        &resolve_group,
        width,
        height,
    );

    let mut guides_used = Vec::new();
    let mut noise_sigma = None;
    if let Some(request) = denoise {
        // The edge-stopping term needs the resolved color's noise level.
        let sigma = match request.params.noise_sigma {
            Some(sigma) => sigma,
            None if request.params.edge_stopping > 0.0 => {
                context.queue.submit(std::iter::once(encoder.finish()));
                let resolved = bytes_to_f32(&read_buffer(&context, &out_color, vec4_bytes).await?);
                encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("forge3d-web-offline-denoise"),
                });
                forge3d_core::offline::denoise::estimate_noise_sigma(&resolved, width, height, 4)
            }
            None => 0.0,
        };
        noise_sigma = Some(sigma);
        let use_albedo = request.guide_albedo && session.surface;
        let albedo_term = use_albedo && request.params.sigma_albedo > 0.0;
        let use_normal = request.guide_normal && session.surface;
        if use_albedo {
            guides_used.push("albedo");
        }
        if use_normal {
            guides_used.push("normal");
        }
        if request.guide_depth {
            guides_used.push("depth");
        }
        let guide_copy;
        let guide = if use_albedo {
            &out_albedo
        } else {
            guide_copy = storage_buffer(device, "forge3d-web-offline-denoise-guide", vec4_bytes);
            encoder.copy_buffer_to_buffer(&out_color, 0, &guide_copy, 0, vec4_bytes);
            &guide_copy
        };
        let dummy = storage_buffer(device, "forge3d-web-offline-denoise-dummy", 16);
        let normals = if use_normal { &out_normal } else { &dummy };
        let depths = if request.guide_depth {
            &out_depth
        } else {
            &dummy
        };
        let flags = (if albedo_term { DENOISE_ALBEDO_TERM } else { 0 })
            | (if use_normal { DENOISE_NORMAL } else { 0 })
            | (if request.guide_depth {
                DENOISE_DEPTH
            } else {
                0
            });
        let temp = storage_buffer(device, "forge3d-web-offline-denoise-temp", vec4_bytes);
        encode_denoise(
            device,
            pipelines,
            &mut encoder,
            [&out_color, &temp],
            guide,
            normals,
            depths,
            flags,
            request.params,
            sigma,
            width,
            height,
        );
    }

    let tonemap_params = TonemapParams {
        width,
        height,
        lane: options.operator.lane(),
        flags: (if session.screen_terrain {
            TONEMAP_SCREEN_TERRAIN
        } else {
            0
        }) | (if surface_is_srgb(runtime) {
            TONEMAP_SURFACE_SRGB
        } else {
            0
        }),
        white_point: options.white_point,
        terrain_id: AOV_ID_TERRAIN,
        _pad: [0; 2],
    };
    let tonemap_uniform = uniform_buffer(
        device,
        "forge3d-web-offline-tonemap-params",
        bytemuck::bytes_of(&tonemap_params),
    );
    let tonemap_group = pipelines.tonemap.bind_group(
        device,
        "forge3d-web-offline-tonemap",
        &[
            out_color.as_entire_binding(),
            wgpu::BindingResource::TextureView(&session.targets.id_ref.view),
            ldr.as_entire_binding(),
            tonemap_uniform.as_entire_binding(),
        ],
    );
    pipelines.tonemap.dispatch(
        &mut encoder,
        "forge3d-web-offline-tonemap",
        &tonemap_group,
        width,
        height,
    );
    context.queue.submit(std::iter::once(encoder.finish()));

    let color = bytes_to_f32(&read_buffer(&context, &out_color, vec4_bytes).await?);
    let rgba8 = read_buffer(&context, &ldr, scalar_bytes).await?;
    let output: JsValue = js_sys::Object::new().into();
    set_js_property(&output, "width", &JsValue::from_f64(f64::from(width)));
    set_js_property(&output, "height", &JsValue::from_f64(f64::from(height)));
    set_js_property(
        &output,
        "totalSamples",
        &JsValue::from_f64(f64::from(session.total_samples)),
    );
    set_js_property(
        &output,
        "near",
        &JsValue::from_f64(f64::from(session.camera.near)),
    );
    set_js_property(
        &output,
        "far",
        &JsValue::from_f64(f64::from(session.camera.far)),
    );
    set_js_property(
        &output,
        "color",
        js_sys::Float32Array::from(color.as_slice()).as_ref(),
    );
    set_js_property(
        &output,
        "rgba8",
        js_sys::Uint8Array::from(rgba8.as_slice()).as_ref(),
    );
    set_js_property(
        &output,
        "tonemapOperator",
        &JsValue::from_str(options.operator.name()),
    );
    set_js_property(&output, "denoised", &JsValue::from_bool(denoise.is_some()));
    let guides = js_sys::Array::new();
    for guide in guides_used {
        guides.push(&JsValue::from_str(guide));
    }
    set_js_property(&output, "denoiseGuides", guides.as_ref());
    set_js_property(
        &output,
        "noiseSigma",
        &noise_sigma.map_or(JsValue::NULL, |sigma| JsValue::from_f64(f64::from(sigma))),
    );
    set_js_property(
        &output,
        "screenTerrain",
        &JsValue::from_bool(session.screen_terrain),
    );

    for (enabled, buffer, name) in [
        (session.aovs.albedo, &out_albedo, "albedo"),
        (session.aovs.normal, &out_normal, "normal"),
    ] {
        if enabled {
            let rgba = bytes_to_f32(&read_buffer(&context, buffer, vec4_bytes).await?);
            let rgb: Vec<f32> = rgba
                .chunks_exact(4)
                .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]])
                .collect();
            set_js_property(
                &output,
                name,
                js_sys::Float32Array::from(rgb.as_slice()).as_ref(),
            );
        }
    }
    if session.aovs.depth {
        let (bytes, layout) = read_texture(
            &context,
            &session.targets.depth_ref.texture,
            ReadbackFormat::R32Float,
            width,
            height,
        )
        .await?;
        let depth =
            decode_float_rows(&bytes, layout, ReadbackFormat::R32Float).map_err(map_core_error)?;
        set_js_property(
            &output,
            "depth",
            js_sys::Float32Array::from(depth.as_slice()).as_ref(),
        );
    }
    if session.aovs.id {
        let (bytes, layout) = read_texture(
            &context,
            &session.targets.id_ref.texture,
            ReadbackFormat::R32Uint,
            width,
            height,
        )
        .await?;
        let ids = decode_u32_rows(&bytes, layout).map_err(map_core_error)?;
        set_js_property(
            &output,
            "id",
            js_sys::Uint32Array::from(ids.as_slice()).as_ref(),
        );
    }
    if session.aovs.motion {
        let (bytes, layout) = read_texture(
            &context,
            &session.targets.motion_ref.texture,
            ReadbackFormat::Rg32Float,
            width,
            height,
        )
        .await?;
        let motion =
            decode_float_rows(&bytes, layout, ReadbackFormat::Rg32Float).map_err(map_core_error)?;
        set_js_property(
            &output,
            "motion",
            js_sys::Float32Array::from(motion.as_slice()).as_ref(),
        );
    }
    super::device_health::ensure_device_healthy_error(runtime)?;
    Ok(output)
}

/// Encodes `params.iterations` A-trous passes ping-ponging between
/// `buffers[0]` and `buffers[1]`; the result always lands in `buffers[0]`.
#[allow(clippy::too_many_arguments)]
fn encode_denoise(
    device: &wgpu::Device,
    pipelines: &OfflinePipelines,
    encoder: &mut wgpu::CommandEncoder,
    buffers: [&wgpu::Buffer; 2],
    guide: &wgpu::Buffer,
    normals: &wgpu::Buffer,
    depths: &wgpu::Buffer,
    flags: u32,
    params: AtrousParams,
    noise_sigma: f32,
    width: u32,
    height: u32,
) {
    let edge = params.edge_stopping > 0.0;
    let flags = if edge { flags | DENOISE_EDGE } else { flags };
    let edge_scale = if edge {
        params.edge_stopping / (noise_sigma + 1e-6)
    } else {
        0.0
    };
    let mut source = 0usize;
    for iteration in 0..params.iterations {
        let uniform = uniform_buffer(
            device,
            "forge3d-web-offline-denoise-params",
            bytemuck::bytes_of(&DenoiseParams {
                width,
                height,
                step: 1 << iteration,
                flags,
                sigma_color: params.sigma_color,
                sigma_albedo: params.sigma_albedo,
                sigma_normal: params.sigma_normal,
                sigma_depth: params.sigma_depth,
                edge_scale,
                _pad: [0.0; 3],
            }),
        );
        let group = pipelines.denoise.bind_group(
            device,
            "forge3d-web-offline-denoise",
            &[
                buffers[source].as_entire_binding(),
                buffers[1 - source].as_entire_binding(),
                guide.as_entire_binding(),
                normals.as_entire_binding(),
                depths.as_entire_binding(),
                uniform.as_entire_binding(),
            ],
        );
        pipelines.denoise.dispatch(
            encoder,
            "forge3d-web-offline-denoise",
            &group,
            width,
            height,
        );
        source = 1 - source;
    }
    if source == 1 {
        encoder.copy_buffer_to_buffer(buffers[1], 0, buffers[0], 0, buffers[0].size());
    }
}

pub(super) fn end_offline_runtime(runtime: &mut Forge3DRuntime) -> bool {
    runtime.memory.release(TARGETS_KEY);
    runtime.memory.release(ACCUMULATION_KEY);
    runtime.memory.release(RESOLVE_KEY);
    runtime.offline.take().is_some()
}

fn float_array(
    value: &JsValue,
    name: &str,
    lanes: &[usize],
    pixels: usize,
) -> Result<Option<(Vec<f32>, usize)>, WebError> {
    let raw = prop(value, name);
    if raw.is_undefined() || raw.is_null() {
        return Ok(None);
    }
    let array: js_sys::Float32Array = raw
        .dyn_into()
        .map_err(|_| invalid(name, "must be a Float32Array"))?;
    let values = array.to_vec();
    let lane = lanes
        .iter()
        .copied()
        .find(|lane| values.len() == pixels * lane)
        .ok_or_else(|| {
            invalid(
                name,
                format!(
                    "length {} does not match {pixels} pixels x {lanes:?} channels",
                    values.len()
                ),
            )
        })?;
    if values.iter().any(|v| !v.is_finite()) {
        return Err(invalid(name, "values must be finite"));
    }
    Ok(Some((values, lane)))
}

fn to_vec4(values: &[f32], lanes: usize, fill_alpha: f32) -> Vec<f32> {
    if lanes == 4 {
        return values.to_vec();
    }
    values
        .chunks_exact(lanes)
        .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], fill_alpha])
        .collect()
}

/// GPU A-trous denoise of caller-supplied HDR color and optional guides.
pub(super) async fn denoise_hdr_runtime(
    runtime: &mut Forge3DRuntime,
    input: JsValue,
) -> Result<js_sys::Float32Array, WebError> {
    if !input.is_object() {
        return Err(invalid("denoise", "input must be an object"));
    }
    let width = integer_in(
        opt_number(&input, "width", "width")?.ok_or_else(|| invalid("width", "is required"))?,
        "width",
        1.0,
        f64::from(runtime.max_texture_dimension_2d),
    )?;
    let height = integer_in(
        opt_number(&input, "height", "height")?.ok_or_else(|| invalid("height", "is required"))?,
        "height",
        1.0,
        f64::from(runtime.max_texture_dimension_2d),
    )?;
    let pixels = width as usize * height as usize;
    let (color, color_lanes) = float_array(&input, "color", &[4, 3], pixels)?
        .ok_or_else(|| invalid("color", "is required"))?;
    let albedo = float_array(&input, "albedo", &[3, 4], pixels)?;
    let normal = float_array(&input, "normal", &[3, 4], pixels)?;
    let depth = float_array(&input, "depth", &[1], pixels)?;
    let params = parse_atrous(&input, "denoise")?;
    let context = context_of(runtime)?;
    let device = &context.device;
    let vec4_bytes = pixel_bytes(width, height, 16);
    check_storage_binding(&context, vec4_bytes, "denoise")?;
    const DENOISE_KEY: &str = "denoise:buffers";
    runtime.memory.replace(
        DENOISE_KEY,
        MemoryCategory::Buffers,
        vec4_bytes * 4 + pixel_bytes(width, height, 4),
    )?;
    let pipelines = runtime
        .offline_pipelines
        .get_or_insert_with(|| OfflinePipelines::new(device));
    let color4 = to_vec4(&color, color_lanes, 1.0);
    let color_buffer = storage_buffer_init(device, "forge3d-web-denoise-color", f32_bytes(&color4));
    let temp = storage_buffer(device, "forge3d-web-denoise-temp", vec4_bytes);
    let guide = match albedo.as_ref() {
        Some((values, lanes)) => storage_buffer_init(
            device,
            "forge3d-web-denoise-albedo",
            f32_bytes(&to_vec4(values, *lanes, 1.0)),
        ),
        None => storage_buffer_init(device, "forge3d-web-denoise-guide", f32_bytes(&color4)),
    };
    let normals = match normal.as_ref() {
        Some((values, lanes)) => storage_buffer_init(
            device,
            "forge3d-web-denoise-normal",
            f32_bytes(&to_vec4(values, *lanes, 0.0)),
        ),
        None => storage_buffer(device, "forge3d-web-denoise-normal", 16),
    };
    let depths = match depth.as_ref() {
        Some((values, _)) => {
            storage_buffer_init(device, "forge3d-web-denoise-depth", f32_bytes(values))
        }
        None => storage_buffer(device, "forge3d-web-denoise-depth", 16),
    };
    let flags = (if albedo.is_some() && params.sigma_albedo > 0.0 {
        DENOISE_ALBEDO_TERM
    } else {
        0
    }) | (if normal.is_some() { DENOISE_NORMAL } else { 0 })
        | (if depth.is_some() { DENOISE_DEPTH } else { 0 });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("forge3d-web-denoise"),
    });
    encode_denoise(
        device,
        pipelines,
        &mut encoder,
        [&color_buffer, &temp],
        &guide,
        &normals,
        &depths,
        flags,
        params,
        params.noise_sigma.unwrap_or_else(|| {
            forge3d_core::offline::denoise::estimate_noise_sigma(&color4, width, height, 4)
        }),
        width,
        height,
    );
    context.queue.submit(std::iter::once(encoder.finish()));
    let result = read_buffer(&context, &color_buffer, vec4_bytes).await;
    runtime.memory.release(DENOISE_KEY);
    let values = bytes_to_f32(&result?);
    super::device_health::ensure_device_healthy_error(runtime)?;
    Ok(js_sys::Float32Array::from(values.as_slice()))
}
