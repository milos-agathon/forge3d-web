use std::collections::BTreeSet;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsValue;

use crate::error::{Forge3DErrorCode, WebError};

#[cfg(target_arch = "wasm32")]
mod fields;

#[cfg(test)]
mod tests;

#[cfg(target_arch = "wasm32")]
use fields::{
    finite_number, get_property, number_tuple, optional_number, optional_string,
    optional_string_array, parse_transform, required_string,
};

#[derive(Debug, Clone, PartialEq)]
pub(super) enum ParsedNodeKind {
    Group,
    Terrain,
    GroundPlane {
        size: [f32; 2],
        height: f32,
        color: [f32; 4],
    },
    TextMesh {
        text: String,
        mesh: Option<Vec<[f32; 3]>>,
        size: f32,
        color: [f32; 4],
    },
    Overlay {
        bounds: [f32; 4],
        mesh: Option<Vec<[f32; 3]>>,
        color: [f32; 4],
        z_index: i32,
    },
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct ParsedTransform {
    pub translation: [f32; 3],
    pub rotation: [f32; 4],
    pub scale: [f32; 3],
}

impl Default for ParsedTransform {
    fn default() -> Self {
        Self {
            translation: [0.0; 3],
            rotation: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0; 3],
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct ParsedNode {
    pub id: u32,
    pub parent: Option<u32>,
    pub visible: bool,
    pub kind: ParsedNodeKind,
    pub transform: ParsedTransform,
    pub material_slot: String,
}

#[derive(Debug, Clone)]
pub(super) struct ParsedPass {
    pub name: String,
    pub kind: forge3d_core::render_graph::PassKind,
    pub reads: Vec<String>,
    pub writes: Vec<String>,
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone)]
pub(super) struct ParsedScene {
    pub postfx: Option<Option<forge3d_core::postfx::PostFxConfig>>,
    pub vectors: Option<Option<crate::runtime::vector::Packet>>,
    pub environment: Option<forge3d_core::environment::Environment>,
    pub environment_lighting: Option<forge3d_core::lighting::LightingState>,
    pub scatter: Vec<forge3d_core::terrain_scatter::ScatterBatch>,
    pub time_seconds: f32,
    pub probes: Option<crate::runtime::probes::Snapshot>,
    pub nodes: Vec<ParsedNode>,
    pub passes: Vec<ParsedPass>,
    pub lighting: forge3d_core::lighting::LightingState,
    pub light_ids: Vec<u32>,
    pub materials: forge3d_core::materials::MaterialState,
    pub texture_sets: std::collections::BTreeMap<u32, crate::runtime::textures::ParsedTextureSet>,
    pub ibl: Option<crate::runtime::ibl::ParsedIbl>,
    pub shadows: crate::runtime::shadows::ParsedShadows,
}

pub(super) fn invalid(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message.into())
}

pub(super) fn validate_node_topology(nodes: &[ParsedNode]) -> Result<(), WebError> {
    let mut seen = BTreeSet::new();
    for node in nodes {
        if node.id
            >= crate::runtime::offline::AOV_ID_VECTOR
                - crate::runtime::offline::AOV_ID_SCENE_NODE_BASE
        {
            return Err(invalid("scene node ID overlaps the reserved AOV namespace"));
        }
        if !seen.insert(node.id) {
            return Err(invalid(format!("duplicate scene node id {}", node.id)));
        }
        if let Some(parent) = node.parent {
            if !seen.contains(&parent) {
                return Err(invalid(format!(
                    "scene node {} references a parent that does not precede it",
                    node.id
                )));
            }
        }
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
pub(super) fn parse_snapshot(value: &JsValue) -> Result<ParsedScene, WebError> {
    if !value.is_object() {
        return Err(invalid("scene snapshot must be an object"));
    }
    let nodes_value = get_property(value, "nodes")?;
    if !js_sys::Array::is_array(&nodes_value) {
        return Err(invalid("scene snapshot nodes must be an array"));
    }
    let nodes_array = js_sys::Array::from(&nodes_value);
    let mut nodes = Vec::with_capacity(nodes_array.length() as usize);
    for entry in nodes_array.iter() {
        nodes.push(parse_node(&entry)?);
    }
    validate_node_topology(&nodes)?;

    let passes_value = get_property(value, "passes")?;
    let mut passes = Vec::new();
    if passes_value.is_object() && js_sys::Array::is_array(&passes_value) {
        for entry in js_sys::Array::from(&passes_value).iter() {
            passes.push(parse_pass(&entry)?);
        }
    }
    let lighting_value = get_property(value, "lighting")?;
    let lighting = crate::runtime::lighting::lighting_state_from_js(&lighting_value)?;
    let light_ids = crate::runtime::lighting::lighting_light_ids_from_js(&lighting_value)?;
    let parsed_materials = crate::runtime::textures::materials_and_textures_from_js(
        &get_property(value, "materials")?,
    )?;
    let materials = parsed_materials.state;
    let material_slots: BTreeSet<&str> = materials
        .slots
        .iter()
        .map(|slot| slot.slot.as_str())
        .collect();
    for node in &nodes {
        if !material_slots.contains(node.material_slot.as_str()) {
            return Err(invalid(format!(
                "scene node {} references unknown material slot '{}'",
                node.id, node.material_slot
            )));
        }
    }
    let ibl_value = get_property(value, "ibl")?;
    if ibl_value.is_undefined() {
        return Err(invalid("scene snapshot ibl is required"));
    }
    let ibl = crate::runtime::ibl::ibl_from_js(&ibl_value)?;
    let shadows_value = get_property(value, "shadows")?;
    if shadows_value.is_undefined() {
        return Err(invalid("scene snapshot shadows is required"));
    }
    let shadows = crate::runtime::shadows::shadows_from_js(&shadows_value)?;
    let scatter_value = get_property(value, "scatter")?;
    let scatter = if scatter_value.is_undefined() {
        Vec::new()
    } else {
        crate::runtime::scatter::parse(scatter_value)?
    };
    let time_seconds = optional_number(&get_property(value, "timeSeconds")?, "timeSeconds", 0.0)?;
    let probes = crate::runtime::probes::parse(get_property(value, "probes")?)?;
    Ok(ParsedScene {
        vectors: {
            let vectors = get_property(value, "vectorPacket")?;
            if vectors.is_undefined() {
                None
            } else {
                Some(crate::runtime::vector::parse(vectors)?)
            }
        },
        postfx: {
            let fx = get_property(value, "postFx")?;
            if fx.is_undefined() {
                None
            } else {
                Some(crate::runtime::postfx::parse(fx)?)
            }
        },
        environment: crate::runtime::environment::parse(get_property(value, "environment")?)?,
        environment_lighting: {
            let value = get_property(value, "environmentLighting")?;
            if value.is_null() || value.is_undefined() {
                None
            } else {
                Some(crate::runtime::lighting::lighting_state_from_js(&value)?)
            }
        },
        scatter,
        time_seconds,
        probes,
        nodes,
        passes,
        lighting,
        light_ids,
        materials,
        texture_sets: parsed_materials.texture_sets,
        ibl,
        shadows,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_node(value: &JsValue) -> Result<ParsedNode, WebError> {
    if !value.is_object() {
        return Err(invalid("scene node snapshot must be an object"));
    }
    let id = get_property(value, "id")?
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| invalid("node.id must be finite"))?;
    if id < 0.0
        || id.fract() != 0.0
        || id
            >= f64::from(
                crate::runtime::offline::AOV_ID_VECTOR
                    - crate::runtime::offline::AOV_ID_SCENE_NODE_BASE,
            )
    {
        return Err(invalid("scene node id must be a nonnegative integer"));
    }
    let parent_value = get_property(value, "parent")?;
    let parent = if parent_value.is_null() || parent_value.is_undefined() {
        None
    } else {
        let parent = finite_number(&parent_value, "node.parent")?;
        if parent < 0.0 || parent.fract() != 0.0 {
            return Err(invalid("scene node parent must be a nonnegative integer"));
        }
        Some(parent as u32)
    };
    let visible_value = get_property(value, "visible")?;
    let visible = if visible_value.is_undefined() || visible_value.is_null() {
        true
    } else {
        visible_value
            .as_bool()
            .ok_or_else(|| invalid("scene node visible must be a boolean"))?
    };
    let node = get_property(value, "node")?;
    let kind_text = required_string(&get_property(&node, "kind")?, "node.kind")?;
    let kind = match kind_text.as_str() {
        "group" => ParsedNodeKind::Group,
        "terrain" => ParsedNodeKind::Terrain,
        "ground-plane" => ParsedNodeKind::GroundPlane {
            size: {
                let pair = number_tuple::<2>(&get_property(&node, "size")?, "node.size")?;
                if pair.iter().any(|component| *component <= 0.0) {
                    return Err(invalid("ground-plane size must be positive"));
                }
                pair
            },
            height: optional_number(&get_property(&node, "height")?, "node.height", 0.0)?,
            color: number_tuple::<4>(&get_property(&node, "color")?, "node.color")?,
        },
        "text-mesh" => ParsedNodeKind::TextMesh {
            mesh: parse_glyph_mesh(&node)?,
            text: required_string(&get_property(&node, "text")?, "node.text")?,
            size: {
                let size = finite_number(&get_property(&node, "size")?, "node.size")?;
                if size <= 0.0 {
                    return Err(invalid("text-mesh size must be positive"));
                }
                size
            },
            color: number_tuple::<4>(&get_property(&node, "color")?, "node.color")?,
        },
        "overlay" => ParsedNodeKind::Overlay {
            mesh: parse_glyph_mesh(&node)?,
            bounds: number_tuple::<4>(&get_property(&node, "bounds")?, "node.bounds")?,
            color: number_tuple::<4>(&get_property(&node, "color")?, "node.color")?,
            z_index: optional_number(&get_property(&node, "zIndex")?, "node.zIndex", 0.0)? as i32,
        },
        "custom" => ParsedNodeKind::Custom,
        other => {
            return Err(invalid(format!("unknown scene node kind {other}")));
        }
    };
    Ok(ParsedNode {
        id: id as u32,
        parent,
        visible,
        kind,
        transform: parse_transform(&get_property(value, "transform")?)?,
        material_slot: optional_string(
            &get_property(&node, "materialSlot")?,
            "node.materialSlot",
            "default",
        )?,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_pass(value: &JsValue) -> Result<ParsedPass, WebError> {
    if !value.is_object() {
        return Err(invalid("scene pass must be an object"));
    }
    let name = required_string(&get_property(value, "name")?, "pass.name")?;
    let kind = match required_string(&get_property(value, "kind")?, "pass.kind")?.as_str() {
        "render" => forge3d_core::render_graph::PassKind::Render,
        "compute" => forge3d_core::render_graph::PassKind::Compute,
        "copy" => forge3d_core::render_graph::PassKind::Copy,
        other => return Err(invalid(format!("unknown scene pass kind {other}"))),
    };
    Ok(ParsedPass {
        name,
        kind,
        reads: optional_string_array(&get_property(value, "reads")?, "pass.reads")?,
        writes: optional_string_array(&get_property(value, "writes")?, "pass.writes")?,
        depends_on: optional_string_array(&get_property(value, "dependsOn")?, "pass.dependsOn")?,
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_glyph_mesh(node: &JsValue) -> Result<Option<Vec<[f32; 3]>>, WebError> {
    use wasm_bindgen::JsCast;
    let value = get_property(node, "vertices")?;
    if value.is_undefined() {
        return Ok(None);
    }
    if !value.is_instance_of::<js_sys::Float32Array>() {
        return Err(invalid("glyph vertices must be Float32Array"));
    }
    let array = js_sys::Float32Array::from(value);
    let count = array.length();
    if !(9..=9_000_000).contains(&count) || !count.is_multiple_of(9) {
        return Err(invalid(
            "glyph vertices must contain XYZ triangles within one million triangles",
        ));
    }
    let values = array.to_vec();
    if values.iter().any(|v| !v.is_finite()) {
        return Err(invalid("glyph vertices must be finite"));
    }
    Ok(Some(
        values.chunks_exact(3).map(|v| [v[0], v[1], v[2]]).collect(),
    ))
}
