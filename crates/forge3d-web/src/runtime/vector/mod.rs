#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod gpu;
mod picking;
mod render;
mod resources;
#[cfg(test)]
mod tests;
use super::{offline::gpu::Target, Forge3DRuntime};
use crate::error::{Forge3DErrorCode, WebError};
use forge3d_core::{gpu::GpuContext, memory::MemoryCategory, vector::VectorVertex};
pub(super) use picking::read_pick_map;
pub(super) use render::{encode, encode_capture};
use serde::Deserialize;
use wgpu::BindingResource as B;
pub(super) const KEY: &str = "vectors:textures";
pub(super) const BUFFER_KEY: &str = "vectors:buffers";
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Packet {
    vertices: Vec<Vec<f64>>,
    oit: String,
    culling: String,
    feature_count: u32,
    atlas: Atlas,
    highlights: Vec<Vec<f64>>,
}
#[derive(Clone, Debug, Deserialize)]
struct Atlas {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    vp: [[f32; 4]; 4],
    viewport: [f32; 4],
    eye: [f32; 4],
    forward: [f32; 4],
    camera: [f32; 4],
}
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Highlight {
    ids: [u32; 4],
    color: [f32; 4],
    options: [f32; 4],
}
struct Compute {
    group: wgpu::BindGroup,
    expand: wgpu::ComputePipeline,
    compact: wgpu::ComputePipeline,
}
pub(super) struct Resources {
    packet: Packet,
    vertices: Vec<VectorVertex>,
    uniform: wgpu::Buffer,
    projected: wgpu::Buffer,
    commands: wgpu::Buffer,
    compute: Option<Compute>,
    _source: wgpu::Buffer,
    _scratch: wgpu::Buffer,
    draw_group: wgpu::BindGroup,
    color_pipeline: wgpu::RenderPipeline,
    pick_pipeline: wgpu::RenderPipeline,
    aov_pipeline: wgpu::RenderPipeline,
    surface_pipeline: wgpu::RenderPipeline,
    accum: Target,
    reveal: Target,
    id: Target,
    depth: Target,
    world: Target,
    background: Target,
    background16: Target,
    highlights: wgpu::Buffer,
    resolve_layout: wgpu::BindGroupLayout,
    resolve_shader: wgpu::ShaderModule,
    resolve_pipelines: std::cell::RefCell<
        std::collections::HashMap<(wgpu::TextureFormat, bool), wgpu::RenderPipeline>,
    >,
    mode: String,
    reason: Option<String>,
    gpu: bool,
    bytes: u64,
    width: u32,
    height: u32,
}
fn invalid(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message.into())
}
pub(super) fn parse(value: wasm_bindgen::JsValue) -> Result<Option<Packet>, WebError> {
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    let packet: Packet =
        serde_wasm_bindgen::from_value(value).map_err(|e| invalid(e.to_string()))?;
    validate(&packet)?;
    Ok(Some(packet))
}
fn validate(p: &Packet) -> Result<(), WebError> {
    if !["auto", "standard", "wboit", "dual-source"].contains(&p.oit.as_str())
        || !["auto", "cpu", "gpu"].contains(&p.culling.as_str())
    {
        return Err(invalid("invalid vector mode"));
    }
    if !p.vertices.len().is_multiple_of(3)
        || p.vertices.len() > 3_000_000
        || p.highlights.len() > 4096
    {
        return Err(invalid("invalid vector geometry or highlight count"));
    }
    for v in &p.vertices {
        if v.len() != 32
            || v.iter().any(|x| !x.is_finite() || x.abs() > 1e12)
            || v[20] < 1.
            || v[20] > u32::MAX as f64
            || v[20].fract() != 0.
            || v[21] < 0.
            || v[21] > 7.
            || v[3] < 0.
        {
            return Err(invalid("invalid vector vertex"));
        }
    }
    if p.atlas.width == 0
        || p.atlas.height == 0
        || p.atlas.width > 4096
        || p.atlas.height > 4096
        || p.atlas.rgba.len() != p.atlas.width as usize * p.atlas.height as usize * 4
    {
        return Err(invalid("invalid vector atlas"));
    }
    for h in &p.highlights {
        if h.len() != 12
            || h.iter().any(|x| !x.is_finite())
            || h[0] < 1.
            || h[0] > u32::MAX as f64
            || h[0].fract() != 0.
        {
            return Err(invalid("invalid vector highlight"));
        }
    }
    Ok(())
}
pub(super) fn planned_bytes(packet: Option<&Packet>, width: u32, height: u32) -> u64 {
    packet.map_or(0, |p| {
        p.vertices.len().max(1) as u64 * (128 + 80 + 80)
            + 16
            + (p.vertices.len() / 3) as u64 * 4
            + 144
            + p.highlights.len().max(1) as u64 * 48
            + 16
            + p.atlas.rgba.len() as u64
            + u64::from(width) * u64::from(height) * (8 + 2 + 4 + 4 + 16 + 16 + 8)
    })
}
pub(super) fn texture_bytes(packet: Option<&Packet>, width: u32, height: u32) -> u64 {
    packet.map_or(0, |p| {
        p.atlas.rgba.len() as u64 + u64::from(width) * u64::from(height) * 58
    })
}
pub(super) fn prepare(
    runtime: &Forge3DRuntime,
    packet: Option<Packet>,
    memory: &mut super::memory::MemoryLedger,
    width: u32,
    height: u32,
) -> Result<Option<Resources>, WebError> {
    let bytes = planned_bytes(packet.as_ref(), width, height);
    let textures = texture_bytes(packet.as_ref(), width, height);
    memory.replace_all(&[
        (KEY, MemoryCategory::Textures, textures),
        (BUFFER_KEY, MemoryCategory::Buffers, bytes - textures),
    ])?;
    let Some(packet) = packet else {
        return Ok(None);
    };
    validate(&packet)?;
    let context = runtime
        .context
        .as_ref()
        .ok_or_else(|| invalid("GPU context unavailable"))?;
    let binding = packet.vertices.len().max(1) as u64 * 128;
    if binding > context.device.limits().max_storage_buffer_binding_size
        || binding > runtime.max_buffer_size
    {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "vector buffer exceeds device limits",
        ));
    }
    Ok(Some(Resources::new(context, packet, width, height, bytes)))
}
pub(super) fn set(
    runtime: &mut Forge3DRuntime,
    value: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let packet = parse(value)?;
    let mut memory = runtime.memory.clone();
    let resources = prepare(runtime, packet, &mut memory, runtime.width, runtime.height)?;
    runtime.memory = memory;
    runtime.vectors = resources;
    super::postfx::invalidate(runtime, "scene", true);
    Ok(())
}
pub(super) fn prepare_resize(
    runtime: &Forge3DRuntime,
    memory: &mut super::memory::MemoryLedger,
    width: u32,
    height: u32,
) -> Result<Option<Resources>, WebError> {
    prepare(
        runtime,
        runtime.vectors.as_ref().map(|v| v.packet.clone()),
        memory,
        width,
        height,
    )
}
impl Resources {
    pub(super) fn packet(&self) -> &Packet {
        &self.packet
    }
}

fn resolve_mode(requested: &str, dual: bool) -> (String, Option<String>) {
    match requested {
        "standard" => ("standard".into(), None),
        "dual-source" if dual => ("dual-source".into(), None),
        "dual-source" => (
            "wboit".into(),
            Some("dual-source-blending-unavailable".into()),
        ),
        _ => ("wboit".into(), None),
    }
}
pub(super) fn report(runtime: &Forge3DRuntime) -> Result<wasm_bindgen::JsValue, WebError> {
    let value = if let Some(v) = &runtime.vectors {
        serde_json::json!({"requestedOit":v.packet.oit,"effectiveOit":v.mode,"fallbackReason":v.reason,"effectiveCulling":if v.gpu{"gpu"}else{"cpu"},"effectiveExtrusion":if v.gpu{"gpu"}else{"cpu"},"featureCount":v.packet.feature_count,"triangleCount":v.vertices.len()/3,"gpuBytes":v.bytes,"width":v.width,"height":v.height})
    } else {
        serde_json::json!({"requestedOit":"auto","effectiveOit":"wboit","fallbackReason":null,"effectiveCulling":"cpu","effectiveExtrusion":"cpu","featureCount":0,"triangleCount":0,"gpuBytes":0,"width":runtime.width,"height":runtime.height})
    };
    serde::Serialize::serialize(&value, &serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| invalid(e.to_string()))
}
