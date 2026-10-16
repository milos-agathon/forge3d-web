#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod capture;
mod gpu;
mod plan;
mod render;
#[cfg(test)]
mod tests;
use super::{
    offline::gpu::{CaptureTargets, Target},
    Forge3DRuntime,
};
use crate::error::{map_core_error, Forge3DErrorCode, WebError};
use capture::CaptureFrame;
use forge3d_core::{
    gpu::GpuContext,
    memory::MemoryCategory,
    postfx::{hzb_dimensions, PostFxConfig, TemporalState},
};
use wasm_bindgen::JsValue;
use wgpu::util::DeviceExt;
pub(super) const KEY: &str = "postfx:resources";
pub(super) const SHADER: &str = concat!(
    include_str!("common.wgsl"),
    include_str!("screen.wgsl"),
    include_str!("effects.wgsl")
);
pub(super) const HZB_SHADER: &str = include_str!("hzb.wgsl");
pub(super) const OUTPUT_SHADER: &str = include_str!("output.wgsl");
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct Params {
    size: [u32; 4],
    control: [u32; 4],
    parameters: [f32; 16],
    inverse_vp: [[f32; 4]; 4],
    view_projection: [[f32; 4]; 4],
    eye: [f32; 4],
    forward: [f32; 4],
    camera: [f32; 4],
}
pub(super) struct Stage {
    plan: plan::StagePlan,
    output: Target,
    history: Option<Target>,
    uniform: wgpu::Buffer,
    lut: wgpu::Buffer,
}
pub(super) struct Resources {
    capture: Option<CaptureFrame>,
    stages: Vec<Stage>,
    hzb: Target,
    hzb_views: Vec<wgpu::TextureView>,
    old_depth: Target,
    old_id: Target,
    pipelines: gpu::Pipelines,
    output_params: wgpu::Buffer,
    pub config: PostFxConfig,
    pub temporal: TemporalState,
    width: u32,
    height: u32,
    bytes: u64,
    jitter: [f32; 2],
    previous_jitter: [f32; 2],
    last_camera: Option<forge3d_core::camera::CameraInput>,
    last_time: f32,
}
fn invalid(s: impl Into<String>) -> WebError {
    WebError::new(
        Forge3DErrorCode::InvalidInput,
        format!("postFx: {}", s.into()),
    )
}
pub(super) fn parse(value: JsValue) -> Result<Option<PostFxConfig>, WebError> {
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    let config: PostFxConfig =
        serde_wasm_bindgen::from_value(value).map_err(|e| invalid(e.to_string()))?;
    config.validate().map_err(map_core_error)?;
    Ok(config.active().then_some(config))
}
pub(super) fn planned_bytes(
    config: &PostFxConfig,
    width: u32,
    height: u32,
    environment: bool,
    blend: bool,
) -> u64 {
    let pixels = u64::from(width) * u64::from(height);
    let plans = plan::stages(config);
    let capture = CaptureTargets::planned_bytes(width, height, true, true)
        - if blend { pixels * 8 } else { 0 };
    let stage_bytes = plans
        .iter()
        .map(|p| {
            pixels * 8 * (1 + u64::from(p.temporal))
                + 272
                + p.lut.as_ref().map_or(16, |l| u64::from(l.size).pow(3) * 16)
        })
        .sum::<u64>();
    let hzb = hzb_dimensions(width, height)
        .iter()
        .map(|(w, h)| u64::from(*w) * u64::from(*h) * 4)
        .sum::<u64>();
    capture
        + stage_bytes
        + hzb
        + pixels * 8
        + 272
        + if environment {
            pixels * if blend { 8 } else { 16 }
        } else {
            0
        }
}
pub(super) fn set(runtime: &mut Forge3DRuntime, value: JsValue) -> Result<(), WebError> {
    set_config(runtime, parse(value)?, "settings")
}
pub(super) fn set_config(
    runtime: &mut Forge3DRuntime,
    config: Option<PostFxConfig>,
    reason: &'static str,
) -> Result<(), WebError> {
    let Some(config) = config else {
        runtime.postfx = None;
        runtime.memory.release(KEY);
        return Ok(());
    };
    config.validate().map_err(map_core_error)?;
    let context = runtime
        .context
        .clone()
        .ok_or_else(|| invalid("GPU context unavailable"))?;
    let bytes = planned_bytes(
        &config,
        runtime.width,
        runtime.height,
        runtime.environment.is_some(),
        runtime.scatter.as_ref().is_some_and(|s| s.transparent()),
    );
    let mut memory = runtime.memory.clone();
    memory.replace(KEY, MemoryCategory::Textures, bytes)?;
    let resources = Resources::new(runtime, &context, config, bytes, reason)?;
    runtime.memory = memory;
    runtime.postfx = Some(resources);
    Ok(())
}
impl Resources {
    fn new(
        runtime: &Forge3DRuntime,
        context: &GpuContext,
        config: PostFxConfig,
        bytes: u64,
        reason: &'static str,
    ) -> Result<Self, WebError> {
        Self::with_size(
            runtime,
            context,
            config,
            bytes,
            reason,
            runtime.width,
            runtime.height,
        )
    }
    fn with_size(
        runtime: &Forge3DRuntime,
        context: &GpuContext,
        config: PostFxConfig,
        bytes: u64,
        reason: &'static str,
        width: u32,
        height: u32,
    ) -> Result<Self, WebError> {
        let device = &context.device;
        let format = runtime
            .surface_state
            .as_ref()
            .ok_or_else(|| invalid("surface unavailable"))?
            .config
            .format;
        let pipelines = gpu::Pipelines::new(device, format);
        let levels = hzb_dimensions(width, height).len() as u32;
        let hzb = gpu::target(
            device,
            "postfx:hzb",
            wgpu::TextureFormat::R32Float,
            width,
            height,
            levels,
        );
        let hzb_views = (0..levels)
            .map(|mip| {
                hzb.texture.create_view(&wgpu::TextureViewDescriptor {
                    base_mip_level: mip,
                    mip_level_count: Some(1),
                    ..Default::default()
                })
            })
            .collect();
        let old_depth = gpu::target(
            device,
            "postfx:previous-depth",
            wgpu::TextureFormat::R32Float,
            width,
            height,
            1,
        );
        // IDs are copied, not written as storage textures (portable WebGPU).
        let old_id = Target::new(
            device,
            "postfx:previous-id",
            wgpu::TextureFormat::R32Uint,
            width,
            height,
        );
        let stages = plan::stages(&config)
            .into_iter()
            .map(|plan| {
                let output = gpu::target(
                    device,
                    &plan.label,
                    wgpu::TextureFormat::Rgba16Float,
                    width,
                    height,
                    1,
                );
                let history = plan.temporal.then(|| {
                    gpu::target(
                        device,
                        &format!("{}:history", plan.label),
                        wgpu::TextureFormat::Rgba16Float,
                        width,
                        height,
                        1,
                    )
                });
                let uniform =
                    gpu::uniform(device, &format!("{}:params", plan.label), &Params::zero());
                let values: Vec<[f32; 4]> = plan.lut.as_ref().map_or_else(
                    || vec![[0.; 4]],
                    |l| {
                        l.data
                            .chunks_exact(3)
                            .map(|c| [c[0], c[1], c[2], 1.])
                            .collect()
                    },
                );
                let lut = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("postfx:color-lut"),
                    contents: bytemuck::cast_slice(&values),
                    usage: wgpu::BufferUsages::STORAGE,
                });
                Stage {
                    plan,
                    output,
                    history,
                    uniform,
                    lut,
                }
            })
            .collect();
        let output_params = gpu::uniform(device, "postfx:output-params", &[0u32; 4]);
        let mut temporal = TemporalState::default();
        temporal.reset(reason);
        let capture = None;
        Ok(Self {
            capture,
            stages,
            hzb,
            hzb_views,
            old_depth,
            old_id,
            pipelines,
            output_params,
            config,
            temporal,
            width,
            height,
            bytes,
            jitter: [0.; 2],
            previous_jitter: [0.; 2],
            last_camera: None,
            last_time: 0.,
        })
    }
}
impl Params {
    fn zero() -> Self {
        use bytemuck::Zeroable;
        Self::zeroed()
    }
}
pub(super) fn invalidate(runtime: &mut Forge3DRuntime, reason: &'static str, rebuild: bool) {
    super::vector::invalidate_pick(runtime);
    if let Some(fx) = &mut runtime.postfx {
        fx.temporal.reset(reason);
        fx.last_camera = None;
        if rebuild {
            fx.capture = None;
        }
    }
}
pub(super) fn prepare_resize(
    runtime: &Forge3DRuntime,
    width: u32,
    height: u32,
) -> Result<Option<Resources>, WebError> {
    let Some(fx) = &runtime.postfx else {
        return Ok(None);
    };
    let context = runtime
        .context
        .as_ref()
        .ok_or_else(|| invalid("GPU context unavailable"))?;
    let bytes = planned_bytes(
        &fx.config,
        width,
        height,
        runtime.environment.is_some(),
        runtime.scatter.as_ref().is_some_and(|s| s.transparent()),
    );
    Resources::with_size(
        runtime,
        context,
        fx.config.clone(),
        bytes,
        "resize",
        width,
        height,
    )
    .map(Some)
}
pub(super) fn report(runtime: &Forge3DRuntime) -> Result<JsValue, WebError> {
    let fx = runtime.postfx.as_ref();
    let value = serde_json::json!({"enabled":fx.is_some(),"width":runtime.width,"height":runtime.height,"gpuBytes":fx.map_or(0,|x|x.bytes),"passOrder":fx.map_or_else(Vec::new,|x|{
        let mut names=vec!["gbuffer:primary".to_string(),"gbuffer:surface".into(),"hzb".into()];names.extend(x.stages.iter().map(|s|s.plan.label.clone()));names.push("output:srgb".into());names.push("overlay".into());names
    }),"colorFormat":"rgba16float","gbufferFormat":if runtime.scatter.as_ref().is_some_and(|s|s.transparent()) {"rgba16float"} else {"rgba32float"},"depthFormat":"r32float","sampling":"texture-load","outputEncoding":"srgb","historyValid":fx.is_some_and(|x|x.temporal.frames>0),"historyFrames":fx.map_or(0,|x|x.temporal.frames),"historyReason":fx.map_or("first-frame",|x|x.temporal.reason),"jitter":fx.map_or([0.;2],|x|x.jitter),"hzbLevels":fx.map_or(0,|x|x.hzb_views.len())});
    serde::Serialize::serialize(&value, &serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| invalid(e.to_string()))
}
pub(super) fn prepare_scene(
    runtime: &Forge3DRuntime,
    config: Option<PostFxConfig>,
    environment: bool,
    blend: bool,
    memory: &mut super::memory::MemoryLedger,
) -> Result<Option<Resources>, WebError> {
    let Some(config) = config else {
        memory.release(KEY);
        return Ok(None);
    };
    config.validate().map_err(map_core_error)?;
    let bytes = planned_bytes(&config, runtime.width, runtime.height, environment, blend);
    memory.replace(KEY, MemoryCategory::Textures, bytes)?;
    let context = runtime
        .context
        .as_ref()
        .ok_or_else(|| invalid("GPU context unavailable"))?;
    Resources::new(runtime, context, config, bytes, "scene").map(Some)
}
pub(super) use render::{encode, read_intermediate};
