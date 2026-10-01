#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
use crate::{
    error::{Forge3DErrorCode, WebError},
    runtime::Forge3DRuntime,
};
use serde::Deserialize;
use wgpu::util::DeviceExt;
pub(super) const KEY: &str = "probes:buffers";
pub(super) fn planned_bytes(snapshot: Option<&Snapshot>) -> Result<u64, WebError> {
    Ok(match snapshot {
        Some(s) => (pack(s)?.len() * 16) as u64,
        None => 64,
    })
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Grid {
    origin: [f32; 2],
    spacing: [f32; 2],
    dims: [u32; 2],
    height_offset: f32,
    edge_blend: [f32; 2],
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    grid: Grid,
    positions: Vec<f32>,
    coefficients: Vec<f32>,
    reflection_resolution: u32,
    reflection_mips: Vec<Vec<f32>>,
    strength: f32,
    reflection_strength: f32,
    debug: String,
}
pub(super) struct Prepared {
    pub buffer: wgpu::Buffer,
    pub group: wgpu::BindGroup,
    pub count: u32,
    pub bytes: u64,
}
pub(super) fn parse(value: wasm_bindgen::JsValue) -> Result<Option<Snapshot>, WebError> {
    if value.is_undefined() || value.is_null() {
        return Ok(None);
    }
    let snapshot: Snapshot = serde_wasm_bindgen::from_value(value)
        .map_err(|e| super::scatter::invalid(format!("probes: {e}")))?;
    pack(&snapshot)?;
    Ok(Some(snapshot))
}
fn pack(s: &Snapshot) -> Result<Vec<[f32; 4]>, WebError> {
    let count = u64::from(s.grid.dims[0]) * u64::from(s.grid.dims[1]);
    let size = s.reflection_resolution;
    if count == 0
        || count > 256
        || !size.is_power_of_two()
        || size > 64
        || s.positions.len() != count as usize * 3
        || s.coefficients.len() != count as usize * 27
        || s.reflection_mips.len() != size.ilog2() as usize + 1
        || !s
            .grid
            .origin
            .iter()
            .chain(&s.grid.spacing)
            .chain(&s.grid.edge_blend)
            .chain([s.grid.height_offset, s.strength, s.reflection_strength].iter())
            .all(|v| v.is_finite())
        || s.grid
            .spacing
            .iter()
            .chain(&s.grid.edge_blend)
            .any(|v| *v <= 0.0)
        || s.grid.height_offset <= 0.0
        || !(0.0..=1.0).contains(&s.strength)
        || !(0.0..=1.0).contains(&s.reflection_strength)
    {
        return Err(super::scatter::invalid(
            "invalid probe grid or payload dimensions",
        ));
    }
    let debug = match s.debug.as_str() {
        "none" => 0.0,
        "irradiance" => 1.0,
        "reflections" => 2.0,
        "weight" => 3.0,
        _ => return Err(super::scatter::invalid("invalid probe debug mode")),
    };
    for (level, mip) in s.reflection_mips.iter().enumerate() {
        let dim = size >> level;
        if mip.len() != count as usize * 6 * dim as usize * dim as usize * 4
            || mip.iter().any(|v| !v.is_finite())
        {
            return Err(super::scatter::invalid("invalid probe reflection mip"));
        }
    }
    if s.positions
        .iter()
        .chain(&s.coefficients)
        .any(|v| !v.is_finite())
    {
        return Err(super::scatter::invalid("probe values must be finite"));
    }
    let mut data = vec![
        [
            s.grid.origin[0],
            s.grid.origin[1],
            s.grid.spacing[0],
            s.grid.spacing[1],
        ],
        [
            s.grid.dims[0] as f32,
            s.grid.dims[1] as f32,
            s.strength,
            s.reflection_strength,
        ],
        [
            s.grid.edge_blend[0],
            s.grid.edge_blend[1],
            size as f32,
            s.reflection_mips.len() as f32,
        ],
        [count as f32, debug, 0.0, 0.0],
    ];
    for p in 0..count as usize {
        data.push([
            s.positions[p * 3],
            s.positions[p * 3 + 1],
            s.positions[p * 3 + 2],
            0.0,
        ]);
        for k in 0..9 {
            let i = p * 27 + k * 3;
            data.push([
                s.coefficients[i],
                s.coefficients[i + 1],
                s.coefficients[i + 2],
                0.0,
            ]);
        }
    }
    for mip in &s.reflection_mips {
        for texel in mip.chunks_exact(4) {
            data.push(texel.try_into().unwrap());
        }
    }
    Ok(data)
}
pub(super) fn prepare(
    runtime: &Forge3DRuntime,
    snapshot: Option<&Snapshot>,
    memory: &mut super::memory::MemoryLedger,
) -> Result<Prepared, WebError> {
    let context = runtime
        .context
        .as_ref()
        .ok_or_else(|| super::scatter::invalid("probe runtime disposed"))?;
    let data = match snapshot {
        Some(s) => pack(s)?,
        None => vec![[0.0; 4]; 4],
    };
    let bytes = (data.len() * 16) as u64;
    if bytes > context.device.limits().max_storage_buffer_binding_size as u64 {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "probe storage exceeds device binding limit",
        ));
    }
    memory.replace(
        KEY,
        forge3d_core::memory::MemoryCategory::Buffers,
        bytes.saturating_sub(64),
    )?;
    let buffer = context
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("terrain-local-probes"),
            contents: bytemuck::cast_slice(&data),
            usage: wgpu::BufferUsages::STORAGE,
        });
    let group = runtime
        .lighting
        .as_ref()
        .unwrap()
        .probe_bind_group(context, &buffer);
    Ok(Prepared {
        buffer,
        group,
        count: snapshot.map_or(0, |s| s.grid.dims[0] * s.grid.dims[1]),
        bytes,
    })
}
pub(super) fn commit(runtime: &mut Forge3DRuntime, prepared: Prepared) {
    let lighting = runtime.lighting.as_mut().unwrap();
    lighting.probe_buffer = prepared.buffer;
    lighting.bind_group = prepared.group.clone();
    runtime.probe_count = prepared.count;
    runtime.probe_bytes = prepared.bytes;
    if let (Some(scene), Some(context), Some(textures), Some(ibl)) = (
        runtime.scene.as_mut(),
        runtime.context.as_ref(),
        runtime.textures.as_ref(),
        runtime.ibl.as_ref(),
    ) {
        scene.set_lighting_binding(context, prepared.group, textures, ibl);
    }
}
pub(super) fn set(
    runtime: &mut Forge3DRuntime,
    value: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let snapshot = parse(value)?;
    let mut memory = runtime.memory.clone();
    let prepared = prepare(runtime, snapshot.as_ref(), &mut memory)?;
    commit(runtime, prepared);
    runtime.memory = memory;
    Ok(())
}
