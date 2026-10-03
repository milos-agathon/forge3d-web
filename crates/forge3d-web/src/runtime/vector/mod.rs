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
pub(super) use picking::{read_pick_map, read_projection};
pub(super) use render::{encode, encode_capture};
use serde::Deserialize;
use wgpu::BindingResource as B;
pub(super) const KEY: &str = "vectors:textures";
pub(super) const BUFFER_KEY: &str = "vectors:buffers";
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Packet {
    vertices: Vec<Vec<f64>>,
    oit: String,
    culling: String,
    feature_count: u32,
    atlas: Atlas,
    highlights: Vec<Vec<f64>>,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
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
    scan_triangles: wgpu::ComputePipeline,
    scan_blocks: wgpu::ComputePipeline,
    scan_supers: wgpu::ComputePipeline,
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
    opaque_pipeline: wgpu::RenderPipeline,
    pick_pipeline: wgpu::RenderPipeline,
    aov_pipeline: wgpu::RenderPipeline,
    surface_pipeline: wgpu::RenderPipeline,
    accum: Target,
    opaque: Target,
    reveal: Target,
    id: Target,
    depth: Target,
    world: Target,
    background: Target,
    background16: Target,
    highlights: wgpu::Buffer,
    highlight_overlay: Target,
    highlight_tint: Target,
    highlight_layout: wgpu::BindGroupLayout,
    highlight_pipeline: wgpu::RenderPipeline,
    highlight_bounds: wgpu::Buffer,
    highlight_bounds_dirty: std::cell::Cell<bool>,
    bounds_layout: wgpu::BindGroupLayout,
    bounds_reset: wgpu::ComputePipeline,
    bounds_reduce: wgpu::ComputePipeline,
    highlight_count: u32,
    highlight_radius: u32,
    highlight_bound: f32,
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
    pick_dirty: std::cell::Cell<bool>,
    pick_renders: std::cell::Cell<u64>,
    pick_readback_peak: std::cell::Cell<u64>,
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
    if !p.vertices.len().is_multiple_of(3) || p.vertices.len() > 3_000_000 {
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
    validate_highlights(&p.highlights)
}
fn validate_highlights(highlights: &[Vec<f64>]) -> Result<(), WebError> {
    for h in highlights {
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
fn command_bytes(triangles: usize) -> u64 {
    let blocks = triangles.div_ceil(256);
    let supers = blocks.div_ceil(256);
    (16 + triangles * 8 + blocks * 8 + supers * 4) as u64
}
pub(super) fn planned_bytes(packet: Option<&Packet>, width: u32, height: u32) -> u64 {
    packet.map_or(0, |p| {
        p.vertices.len().max(1) as u64 * (128 + 80 + 80)
            + command_bytes(p.vertices.len() / 3)
            + 144
            + p.highlights.len().max(1) as u64 * 48
            // Resolve uniform (32) and highlight bounds (16).
            + 48
            + p.atlas.rgba.len() as u64
            + u64::from(width) * u64::from(height) * 82
    })
}
pub(super) fn texture_bytes(packet: Option<&Packet>, width: u32, height: u32) -> u64 {
    packet.map_or(0, |p| {
        p.atlas.rgba.len() as u64 + u64::from(width) * u64::from(height) * 82
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
    if let Some(next) = packet.as_ref().filter(|next| same_geometry(runtime, next)) {
        return update_highlights(runtime, next.highlights.clone());
    }
    let mut memory = runtime.memory.clone();
    let resources = prepare(runtime, packet, &mut memory, runtime.width, runtime.height)?;
    runtime.memory = memory;
    runtime.vectors = resources;
    super::postfx::invalidate(runtime, "scene", true);
    Ok(())
}
pub(super) fn same_geometry(runtime: &Forge3DRuntime, next: &Packet) -> bool {
    runtime.vectors.as_ref().is_some_and(|current| {
        current.packet.vertices == next.vertices
            && current.packet.atlas == next.atlas
            && current.packet.oit == next.oit
            && current.packet.culling == next.culling
            && current.packet.feature_count == next.feature_count
            && current.width == runtime.width
            && current.height == runtime.height
    })
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

fn highlight_values(highlights: &[Vec<f64>]) -> Vec<Highlight> {
    // Last set (including hover) wins for a repeated feature, then sort once
    // on the CPU so the fragment shader can use binary search.
    let mut sorted = std::collections::BTreeMap::new();
    for h in highlights {
        sorted.insert(
            h[0] as u32,
            Highlight {
                ids: [h[0] as u32, h[1] as u32, h[2] as u32, 0],
                color: [h[4] as f32, h[5] as f32, h[6] as f32, h[7] as f32],
                options: [h[8] as f32, h[9] as f32, h[10] as f32, h[11] as f32],
            },
        );
    }
    sorted.into_values().collect()
}
fn highlight_settings(values: &[Highlight]) -> (u32, u32, f32) {
    let radius = values
        .iter()
        .map(|h| {
            (if h.ids[1] != 0 { h.options[0] } else { 0. })
                .max(if h.ids[2] != 0 { h.options[2] } else { 0. })
                .ceil() as u32
        })
        .max()
        .unwrap_or(0)
        .min(32);
    let bound = values
        .iter()
        .map(|h| {
            (if h.ids[1] != 0 { h.color[3] } else { 0. }).max(if h.ids[2] != 0 {
                h.options[1]
            } else {
                0.
            }) * h.options[3]
        })
        .fold(0.0_f32, f32::max);
    (values.len() as u32, radius, bound)
}
pub(super) fn update_highlights_js(
    runtime: &mut Forge3DRuntime,
    value: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let highlights: Vec<Vec<f64>> =
        serde_wasm_bindgen::from_value(value).map_err(|e| invalid(e.to_string()))?;
    update_highlights(runtime, highlights)
}
fn update_highlights(
    runtime: &mut Forge3DRuntime,
    highlights: Vec<Vec<f64>>,
) -> Result<(), WebError> {
    let mut memory = runtime.memory.clone();
    let update = prepare_highlights(runtime, highlights, &mut memory)?;
    runtime.memory = memory;
    apply_highlights(runtime, update);
    Ok(())
}
pub(super) struct HighlightUpdate {
    highlights: Vec<Vec<f64>>,
    values: Vec<Highlight>,
    count: u32,
    radius: u32,
    bound: f32,
    bytes: u64,
}
pub(super) fn prepare_highlights(
    runtime: &Forge3DRuntime,
    highlights: Vec<Vec<f64>>,
    memory: &mut super::memory::MemoryLedger,
) -> Result<HighlightUpdate, WebError> {
    let Some(v) = runtime.vectors.as_ref() else {
        return Err(invalid("vector layers unavailable"));
    };
    validate_highlights(&highlights)?;
    let values = highlight_values(&highlights);
    let (highlight_count, highlight_radius, highlight_bound) = highlight_settings(&values);
    let values = if values.is_empty() {
        vec![Highlight {
            ids: [0; 4],
            color: [0.; 4],
            options: [0.; 4],
        }]
    } else {
        values
    };
    let size = (values.len() * std::mem::size_of::<Highlight>()) as u64;
    let old_size = v.highlights.size();
    let bytes = v.bytes - old_size + size.max(old_size);
    let textures = texture_bytes(Some(&v.packet), runtime.width, runtime.height);
    memory.replace(BUFFER_KEY, MemoryCategory::Buffers, bytes - textures)?;
    let c = runtime
        .context
        .as_ref()
        .ok_or_else(|| invalid("GPU context unavailable"))?;
    if size > c.device.limits().max_storage_buffer_binding_size || size > runtime.max_buffer_size {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "vector highlight buffer exceeds device limits",
        ));
    }
    Ok(HighlightUpdate {
        highlights,
        values,
        count: highlight_count,
        radius: highlight_radius,
        bound: highlight_bound,
        bytes,
    })
}
pub(super) fn prepare_scene_highlights(
    runtime: &Forge3DRuntime,
    packet: &Packet,
    memory: &mut super::memory::MemoryLedger,
) -> Result<HighlightUpdate, WebError> {
    prepare_highlights(runtime, packet.highlights.clone(), memory)
}
pub(super) fn retained_bytes(runtime: &Forge3DRuntime) -> u64 {
    runtime.vectors.as_ref().map_or(0, |v| v.bytes)
}
pub(super) fn apply_highlights(runtime: &mut Forge3DRuntime, update: HighlightUpdate) {
    let c = runtime.context.as_ref().expect("validated live context");
    let v = runtime.vectors.as_mut().expect("checked resources");
    if update.values.len() as u64 * std::mem::size_of::<Highlight>() as u64 > v.highlights.size() {
        v.highlights = gpu::buffer(
            &c.device,
            "vector:highlights",
            bytemuck::cast_slice(&update.values),
            wgpu::BufferUsages::STORAGE,
        );
    } else {
        c.queue
            .write_buffer(&v.highlights, 0, bytemuck::cast_slice(&update.values));
    }
    v.highlight_bounds_dirty.set(true);
    v.highlight_count = update.count;
    v.highlight_radius = update.radius;
    v.highlight_bound = update.bound;
    v.packet.highlights = update.highlights;
    v.bytes = update.bytes;
    // Selection changes color, but the geometry pick targets stay valid.
    if let Some(fx) = runtime.postfx.as_mut() {
        fx.temporal.reset("vectors-highlight");
    }
}
pub(super) fn invalidate_pick(runtime: &Forge3DRuntime) {
    if let Some(v) = runtime.vectors.as_ref() {
        v.pick_dirty.set(true);
        v.highlight_bounds_dirty.set(true);
    }
}

fn resolve_mode(requested: &str, dual: bool) -> (String, Option<String>) {
    match requested {
        "standard" => ("standard".into(), None),
        "auto" | "dual-source" if dual => ("dual-source".into(), None),
        "auto" | "dual-source" => (
            "wboit".into(),
            Some("dual-source-blending-unavailable".into()),
        ),
        _ => ("wboit".into(), None),
    }
}
pub(super) fn report(runtime: &Forge3DRuntime) -> Result<wasm_bindgen::JsValue, WebError> {
    let counts = runtime
        .context
        .as_ref()
        .map(|c| gpu::counts(&c.device))
        .unwrap_or_default();
    let value = if let Some(v) = &runtime.vectors {
        serde_json::json!({"requestedOit":v.packet.oit,"effectiveOit":v.mode,"fallbackReason":v.reason,"effectiveCulling":if v.gpu{"gpu"}else{"cpu"},"effectiveExtrusion":if v.gpu{"gpu"}else{"cpu"},"featureCount":v.packet.feature_count,"triangleCount":v.vertices.len()/3,"gpuBytes":v.bytes,"width":v.width,"height":v.height,"pipelineCreations":counts.0,"vertexBufferCreations":counts.1,"pickRenderCount":v.pick_renders.get(),"pickReadbackPeakBytes":v.pick_readback_peak.get()})
    } else {
        let dual = runtime.context.as_ref().is_some_and(|c| {
            c.device
                .features()
                .contains(wgpu::Features::DUAL_SOURCE_BLENDING)
        });
        let (mode, reason) = resolve_mode("auto", dual);
        serde_json::json!({"requestedOit":"auto","effectiveOit":mode,"fallbackReason":reason,"effectiveCulling":"cpu","effectiveExtrusion":"cpu","featureCount":0,"triangleCount":0,"gpuBytes":0,"width":runtime.width,"height":runtime.height,"pipelineCreations":counts.0,"vertexBufferCreations":counts.1,"pickRenderCount":0,"pickReadbackPeakBytes":0})
    };
    serde::Serialize::serialize(&value, &serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| invalid(e.to_string()))
}
