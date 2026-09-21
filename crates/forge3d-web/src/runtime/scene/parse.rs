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
    finite_number, get_property, number_tuple, optional_number, optional_string_array,
    parse_transform, required_string,
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
        size: f32,
        color: [f32; 4],
    },
    Overlay {
        bounds: [f32; 4],
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
    pub nodes: Vec<ParsedNode>,
    pub passes: Vec<ParsedPass>,
}

pub(super) fn invalid(message: impl Into<String>) -> WebError {
    WebError::new(Forge3DErrorCode::InvalidInput, message.into())
}

pub(super) fn validate_node_topology(nodes: &[ParsedNode]) -> Result<(), WebError> {
    let mut seen = BTreeSet::new();
    for node in nodes {
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
    Ok(ParsedScene { nodes, passes })
}

#[cfg(target_arch = "wasm32")]
fn parse_node(value: &JsValue) -> Result<ParsedNode, WebError> {
    if !value.is_object() {
        return Err(invalid("scene node snapshot must be an object"));
    }
    let id = finite_number(&get_property(value, "id")?, "node.id")?;
    if id < 0.0 || id.fract() != 0.0 {
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
