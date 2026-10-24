#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
use crate::{
    error::{Forge3DErrorCode, WebError},
    runtime::Forge3DRuntime,
};
use serde::Deserialize;
use wgpu::util::DeviceExt;
pub(super) const KEY: &str = "probes:buffers";
const IRRADIANCE_PROBE_LIMIT: u64 = 4096;
const REFLECTION_PROBE_LIMIT: u64 = 256;
const HEADER_VECTORS: usize = 8;
pub(super) fn planned_bytes(snapshot: Option<&Compiled>) -> Result<u64, WebError> {
    Ok(match snapshot {
        Some(s) => s.bytes(),
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
    scene_bounds: Option<forge3d_core::terrain_scatter::Bounds>,
    positions: Vec<f32>,
    coefficients: Vec<f32>,
    reflection_grid: Option<Grid>,
    reflection_positions: Option<Vec<f32>>,
    reflection_resolution: u32,
    reflection_mips: Vec<Vec<f32>>,
    strength: f32,
    reflection_strength: f32,
    debug: String,
}
#[derive(Clone, Debug)]
pub(super) struct Compiled {
    data: std::sync::Arc<[[f32; 4]]>,
    count: u32,
    reflection_count: u32,
    position_bytes: u64,
    coefficient_bytes: u64,
    irradiance_position_bytes: u64,
    reflection_position_bytes: u64,
    reflection_bytes: u64,
}
impl Compiled {
    fn new(snapshot: Snapshot) -> Result<Self, WebError> {
        let data = pack(&snapshot)?.into();
        let count = snapshot.grid.dims[0] * snapshot.grid.dims[1];
        let reflection_count = snapshot
            .reflection_grid
            .as_ref()
            .map_or(count, |grid| grid.dims[0] * grid.dims[1]);
        Ok(Self {
            data,
            count,
            reflection_count,
            position_bytes: (snapshot.positions.len()
                + snapshot.reflection_positions.as_ref().map_or(0, Vec::len))
                as u64
                * 4,
            coefficient_bytes: u64::from(count) * 27 * 4,
            irradiance_position_bytes: u64::from(count) * 3 * 4,
            reflection_position_bytes: u64::from(reflection_count) * 3 * 4,
            reflection_bytes: snapshot
                .reflection_mips
                .iter()
                .map(|m| m.len() as u64 * 4)
                .sum(),
        })
    }
    fn bytes(&self) -> u64 {
        self.data.len() as u64 * 16
    }
}
pub(super) struct Prepared {
    pub buffer: wgpu::Buffer,
    pub layout: wgpu::BindGroupLayout,
    pub group: wgpu::BindGroup,
    pub count: u32,
    pub reflection_count: u32,
    pub bytes: u64,
    pub position_bytes: u64,
    pub coefficient_bytes: u64,
    pub irradiance_position_bytes: u64,
    pub reflection_position_bytes: u64,
    pub reflection_bytes: u64,
    pub enabled: bool,
}
pub(super) fn parse(value: wasm_bindgen::JsValue) -> Result<Option<Compiled>, WebError> {
    if value.is_undefined() || value.is_null() {
        return Ok(None);
    }
    let snapshot: Snapshot = serde_wasm_bindgen::from_value(value)
        .map_err(|e| super::scatter::invalid(format!("probes: {e}")))?;
    Ok(Some(Compiled::new(snapshot)?))
}
fn pack(s: &Snapshot) -> Result<Vec<[f32; 4]>, WebError> {
    if let Some(bounds) = &s.scene_bounds {
        if !(0..3).all(|a| {
            bounds.min[a].is_finite() && bounds.max[a].is_finite() && bounds.min[a] <= bounds.max[a]
        }) {
            return Err(super::scatter::invalid("invalid reflection scene bounds"));
        }
    }

    let irradiance_count = u64::from(s.grid.dims[0]) * u64::from(s.grid.dims[1]);
    let (reflection_grid, reflection_positions) = match (
        s.reflection_grid.as_ref(),
        s.reflection_positions.as_deref(),
    ) {
        (Some(grid), Some(positions)) => (grid, positions),
        (None, None) => (&s.grid, s.positions.as_slice()),
        _ => {
            return Err(super::scatter::invalid(
                "reflectionGrid and reflectionPositions must be provided together",
            ))
        }
    };
    let reflection_count = u64::from(reflection_grid.dims[0]) * u64::from(reflection_grid.dims[1]);
    let size = s.reflection_resolution;
    if irradiance_count == 0
        || irradiance_count > IRRADIANCE_PROBE_LIMIT
        || reflection_count == 0
        || reflection_count > REFLECTION_PROBE_LIMIT
        || !size.is_power_of_two()
        || size > 64
        || s.positions.len() != irradiance_count as usize * 3
        || s.coefficients.len() != irradiance_count as usize * 27
        || reflection_positions.len() != reflection_count as usize * 3
        || s.reflection_mips.len() != size.ilog2() as usize + 1
        || !s
            .grid
            .origin
            .iter()
            .chain(&s.grid.spacing)
            .chain(&s.grid.edge_blend)
            .chain([s.grid.height_offset, s.strength, s.reflection_strength].iter())
            .all(|v| v.is_finite())
        || !reflection_grid
            .origin
            .iter()
            .chain(&reflection_grid.spacing)
            .chain(&reflection_grid.edge_blend)
            .chain([reflection_grid.height_offset].iter())
            .all(|v| v.is_finite())
        || s.grid
            .spacing
            .iter()
            .chain(&s.grid.edge_blend)
            .any(|v| *v <= 0.0)
        || reflection_grid
            .spacing
            .iter()
            .chain(&reflection_grid.edge_blend)
            .any(|v| *v <= 0.0)
        || s.grid.height_offset <= 0.0
        || reflection_grid.height_offset <= 0.0
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
        if mip.len() != reflection_count as usize * 6 * dim as usize * dim as usize * 4
            || mip.iter().any(|v| !v.is_finite())
        {
            return Err(super::scatter::invalid("invalid probe reflection mip"));
        }
    }
    if s.positions
        .iter()
        .chain(reflection_positions)
        .chain(&s.coefficients)
        .any(|v| !v.is_finite())
    {
        return Err(super::scatter::invalid("probe values must be finite"));
    }
    let irradiance_base = HEADER_VECTORS;
    let reflection_position_base = irradiance_base + irradiance_count as usize * 10;
    let reflection_mip_base = reflection_position_base + reflection_count as usize;
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
        [irradiance_count as f32, debug, reflection_count as f32, 2.0],
        [
            reflection_grid.origin[0],
            reflection_grid.origin[1],
            reflection_grid.spacing[0],
            reflection_grid.spacing[1],
        ],
        [
            reflection_grid.dims[0] as f32,
            reflection_grid.dims[1] as f32,
            reflection_grid.edge_blend[0],
            reflection_grid.edge_blend[1],
        ],
        [
            irradiance_base as f32,
            reflection_position_base as f32,
            reflection_mip_base as f32,
            0.0,
        ],
        [0.0; 4],
    ];
    if let Some(b) = &s.scene_bounds {
        data[7] = [b.min[1], b.max[1], b.max[0] - b.min[0], b.max[2] - b.min[2]];
    }
    for p in 0..irradiance_count as usize {
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
    for position in reflection_positions.chunks_exact(3) {
        data.push([position[0], position[1], position[2], 0.0]);
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
    snapshot: Option<&Compiled>,
    memory: &mut super::memory::MemoryLedger,
) -> Result<Prepared, WebError> {
    let context = runtime
        .context
        .as_ref()
        .ok_or_else(|| super::scatter::invalid("probe runtime disposed"))?;
    if snapshot.is_some() {
        if let Some(terrain) = runtime.terrain.as_ref() {
            if terrain.vt.is_some() {
                let scene_textures = terrain.features.samples_scene_textures();
                let slots =
                    super::terrain::W08Slots::of_device(&context.device, scene_textures, true);
                if !slots.vt {
                    return Err(super::terrain::w08_limit_error(
                        "terrain virtual texturing with probes",
                        3,
                        scene_textures,
                        context
                            .device
                            .limits()
                            .max_sampled_textures_per_shader_stage,
                        true,
                    ));
                }
            }
        }
    }
    let data: &[[f32; 4]] = snapshot.map_or(&[[0.0; 4]; 4], |s| s.data.as_ref());
    let bytes = (data.len() * 16) as u64;
    if bytes > context.device.limits().max_storage_buffer_binding_size as u64
        || bytes > context.device.limits().max_buffer_size
    {
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
    let (layout, group) = runtime
        .lighting
        .as_ref()
        .unwrap()
        .bind_group_for_probes(context, snapshot.map(|_| &buffer));
    Ok(Prepared {
        buffer,
        layout,
        group,
        count: snapshot.map_or(0, |s| s.count),
        reflection_count: snapshot.map_or(0, |s| s.reflection_count),
        bytes,
        position_bytes: snapshot.map_or(0, |s| s.position_bytes),
        coefficient_bytes: snapshot.map_or(0, |s| s.coefficient_bytes),
        irradiance_position_bytes: snapshot.map_or(0, |s| s.irradiance_position_bytes),
        reflection_position_bytes: snapshot.map_or(0, |s| s.reflection_position_bytes),
        reflection_bytes: snapshot.map_or(0, |s| s.reflection_bytes),
        enabled: snapshot.is_some(),
    })
}
pub(super) fn commit(runtime: &mut Forge3DRuntime, prepared: Prepared) {
    let lighting = runtime.lighting.as_mut().unwrap();
    lighting.probe_buffer = prepared.buffer;
    lighting.bind_group_layout = prepared.layout.clone();
    lighting.bind_group = prepared.group.clone();
    runtime.probe_count = prepared.count;
    runtime.reflection_probe_count = prepared.reflection_count;
    runtime.probe_bytes = prepared.bytes;
    runtime.probe_position_bytes = prepared.position_bytes;
    runtime.probe_coefficient_bytes = prepared.coefficient_bytes;
    runtime.probe_irradiance_position_bytes = prepared.irradiance_position_bytes;
    runtime.probe_reflection_position_bytes = prepared.reflection_position_bytes;
    runtime.probe_reflection_bytes = prepared.reflection_bytes;
    if let (Some(scene), Some(context), Some(textures), Some(ibl)) = (
        runtime.scene.as_mut(),
        runtime.context.as_ref(),
        runtime.textures.as_ref(),
        runtime.ibl.as_ref(),
    ) {
        scene.set_lighting_binding(
            context,
            prepared.layout,
            prepared.group,
            prepared.enabled,
            textures,
            ibl,
        );
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

#[cfg(test)]
mod compiled_tests {
    use super::*;
    fn snapshot() -> Snapshot {
        Snapshot {
            grid: Grid {
                origin: [0., 0.],
                spacing: [1., 1.],
                dims: [1, 1],
                height_offset: 1.,
                edge_blend: [1., 1.],
            },
            scene_bounds: None,
            positions: vec![0.; 3],
            coefficients: vec![0.; 27],
            reflection_grid: None,
            reflection_positions: None,
            reflection_resolution: 1,
            reflection_mips: vec![vec![0.; 24]],
            strength: 1.,
            reflection_strength: 1.,
            debug: "none".into(),
        }
    }
    #[test]
    fn compiled_payload_is_shared_by_clones_and_planning() {
        let source = snapshot();
        let expected = pack(&source).unwrap();
        let prepared = Compiled::new(source).unwrap();
        let copy = prepared.clone();
        assert!(std::sync::Arc::ptr_eq(&copy.data, &prepared.data));
        assert_eq!(&*prepared.data, expected.as_slice());
        assert_eq!(
            planned_bytes(Some(&prepared)).unwrap(),
            expected.len() as u64 * 16
        );
        assert_eq!(prepared.reflection_count, 1);
    }
    #[test]
    fn invalid_reflection_dimensions_never_produce_payload() {
        let mut source = snapshot();
        source.reflection_grid = Some(Grid {
            dims: [257, 1],
            ..source.grid.clone()
        });
        source.reflection_positions = Some(vec![0.; 771]);
        assert!(Compiled::new(source).is_err());
    }
}
