#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod allocation;
mod draw;
mod pipeline;
mod prepare;
mod shader;
use crate::error::{Forge3DErrorCode, WebError};
use crate::runtime::{
    offline::CapturePass, scene::LitVertex, shader_variants::ShaderFeatures, Forge3DRuntime,
};
pub(super) use allocation::build;
use draw::{draw, fallback, group, pipelines};
use forge3d_core::{
    gpu::GpuContext,
    memory::MemoryCategory,
    terrain_scatter::{ScatterBatch, ScatterMesh, ScatterStats},
};
use wgpu::util::DeviceExt;
pub(super) const KEY: &str = "scatter:buffers";
pub(super) const TEXTURES_KEY: &str = "scatter:textures";
pub(super) fn planned_bytes(inputs: &[ScatterBatch]) -> Result<u64, WebError> {
    if inputs.is_empty() {
        return Ok(0);
    }
    let mut bytes = 264u64;
    for b in inputs {
        for l in &b.levels {
            bytes = bytes
                .checked_add(
                    (l.mesh.positions.len() / 3 * std::mem::size_of::<LitVertex>()
                        + l.mesh.indices.len() * 4
                        + b.transforms.len() / 16 * 80
                        + std::mem::size_of::<Settings>()) as u64,
                )
                .ok_or_else(|| invalid("scatter accounting overflow"))?;
        }
        for c in &b.clusters {
            bytes = bytes
                .checked_add(
                    (c.mesh.positions.len() / 3 * std::mem::size_of::<LitVertex>()
                        + c.mesh.indices.len() * 4
                        + 80
                        + std::mem::size_of::<Settings>()) as u64,
                )
                .ok_or_else(|| invalid("scatter accounting overflow"))?;
        }
    }
    Ok(bytes)
}
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MemoryReport {
    batch_count: usize,
    level_count: usize,
    total_instances: usize,
    vertex_buffer_bytes: u64,
    index_buffer_bytes: u64,
    instance_buffer_bytes: u64,
    hlod_cluster_count: usize,
    hlod_buffer_bytes: u64,
    total_buffer_bytes: u64,
    uniform_buffer_bytes: u64,
    texture_bytes: u64,
    gpu_bytes: u64,
}
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Instance {
    rows: [f32; 16],
    meta: [f32; 4],
}
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Settings {
    phase: [f32; 4],
    vector: [f32; 4],
    fade: [f32; 4],
    blend: [f32; 4],
    contact: [f32; 4],
    mapping: [f32; 4],
    height: [f32; 4],
    stream: [u32; 4],
    previous_phase: [f32; 4],
}
struct Draw {
    vertex: wgpu::Buffer,
    index: wgpu::Buffer,
    instances: wgpu::Buffer,
    settings: wgpu::Buffer,
    group: wgpu::BindGroup,
    index_count: u32,
    count: u32,
    max_height: f32,
}
struct Batch {
    input: ScatterBatch,
    levels: Vec<Draw>,
    clusters: Vec<Draw>,
    id_start: u32,
}
pub(super) struct ScatterResources {
    previous_time: Option<f32>,
    batches: Vec<Batch>,
    camera: wgpu::Buffer,
    layout: wgpu::BindGroupLayout,
    fallback_height: wgpu::TextureView,
    fallback_pages: wgpu::TextureView,
    features: ShaderFeatures,
    format: wgpu::TextureFormat,
    pipeline: wgpu::RenderPipeline,
    primary: wgpu::RenderPipeline,
    surface: wgpu::RenderPipeline,
    pub stats: ScatterStats,
    pub memory: MemoryReport,
}
pub(super) fn invalid(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message)
}
pub(super) fn parse(value: wasm_bindgen::JsValue) -> Result<Vec<ScatterBatch>, WebError> {
    let batches: Vec<ScatterBatch> =
        serde_wasm_bindgen::from_value(value).map_err(|e| invalid(format!("scatter: {e}")))?;
    if batches.len() > 256 {
        return Err(invalid("scatter batch count exceeds 256"));
    }
    if batches
        .iter()
        .map(|b| b.transforms.len() / 16)
        .sum::<usize>()
        > 15_728_640
    {
        return Err(invalid(
            "scatter population exceeds the exact f32 object-ID range",
        ));
    }
    for b in &batches {
        b.validate().map_err(invalid)?;
    }
    Ok(batches)
}
pub(super) fn set(
    runtime: &mut Forge3DRuntime,
    value: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let inputs = parse(value)?;
    let mut memory = runtime.memory.clone();
    if let Some(fx) = &runtime.postfx {
        let blend = inputs
            .iter()
            .any(|b| b.color[3] < 1. || b.terrain_blend.enabled);
        memory.replace(
            super::postfx::KEY,
            MemoryCategory::Textures,
            super::postfx::planned_bytes(
                &fx.config,
                runtime.width,
                runtime.height,
                runtime.environment.is_some(),
                blend,
            ),
        )?;
    }
    let resources = build(runtime, inputs, &mut memory)?;
    runtime.scatter = resources;
    runtime.memory = memory;
    Ok(())
}
pub(super) fn prepare(
    runtime: &mut Forge3DRuntime,
    uniform: Option<&super::terrain::CaptureCameraUniform>,
) -> Result<(), WebError> {
    let Some(mut scatter) = runtime.scatter.take() else {
        return Ok(());
    };
    let result = (|| {
        let default_uniform = super::terrain::create_capture_camera_uniform(
            &runtime.camera,
            &runtime.camera,
            runtime.width,
            runtime.height,
            [0.0; 2],
            0,
        )?;
        scatter.prepare(runtime, uniform.unwrap_or(&default_uniform))
    })();
    runtime.scatter = Some(scatter);
    result
}
