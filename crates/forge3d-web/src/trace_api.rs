//! W17 stateless CPU/WASM builder and signed-distance reference.
use crate::error::{to_js_error, Forge3DErrorCode, WebError};
use forge3d_core::accel::{Bvh, Triangle};
use forge3d_core::sdf::{CsgNode, CsgTree, SdfPrimitive};
use serde::Deserialize;
use wasm_bindgen::prelude::*;
fn invalid(message: impl Into<String>) -> JsValue {
    to_js_error(WebError::new(Forge3DErrorCode::InvalidInput, message))
}
#[wasm_bindgen(js_name = buildTraceBvh)]
pub fn build_trace_bvh(input: JsValue, leaf_size: u32, budget: f64) -> Result<JsValue, JsValue> {
    if !budget.is_finite() || budget < 1. {
        return Err(invalid("Invalid BVH budget"));
    }
    let triangles: Vec<Triangle> =
        serde_wasm_bindgen::from_value(input).map_err(|e| invalid(e.to_string()))?;
    if triangles.len() as f64 * 256. > budget {
        return Err(to_js_error(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            "BVH budget exceeded",
        )));
    }
    let tree = Bvh::build(triangles, leaf_size).map_err(invalid)?;
    serde_wasm_bindgen::to_value(&tree).map_err(|e| invalid(e.to_string()))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrimitiveInput {
    #[serde(rename = "type")]
    kind: u32,
    material_id: u32,
    params: Vec<f32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeInput {
    operation: u32,
    left: u32,
    right: u32,
    smoothing: f32,
    material_id: u32,
    leaf: bool,
}
#[derive(Deserialize)]
struct SceneInput {
    version: u32,
    primitives: Vec<PrimitiveInput>,
    nodes: Vec<NodeInput>,
}
#[wasm_bindgen(js_name = evaluateTraceSdf)]
pub fn evaluate_trace_sdf(
    input: JsValue,
    points: js_sys::Float32Array,
) -> Result<JsValue, JsValue> {
    let input: SceneInput =
        serde_wasm_bindgen::from_value(input).map_err(|e| invalid(e.to_string()))?;
    if input.version != 1 || input.nodes.len() > 4096 || input.primitives.len() > 4096 {
        return Err(invalid("Invalid SDF version or node limit"));
    }
    let mut tree = CsgTree::new();
    for p in input.primitives {
        if p.kind > 5 || p.params.len() != 16 || p.params.iter().any(|v| !v.is_finite()) {
            return Err(invalid("Invalid SDF primitive"));
        }
        let nonnegative = match p.kind {
            1 => p.params[4..7].iter().all(|v| *v >= 0.),
            2 | 4 => p.params[3] >= 0. && p.params[4] >= 0.,
            3 => p.params[..3].iter().map(|v| v * v).sum::<f32>() > 1e-20,
            _ => p.params[3] >= 0.,
        };
        if !nonnegative {
            return Err(invalid("Invalid SDF dimensions or plane normal"));
        }
        let mut params = [0.; 16];
        params.copy_from_slice(&p.params);
        tree.primitives.push(SdfPrimitive {
            primitive_type: p.kind,
            material_id: p.material_id,
            _pad: [0; 2],
            params,
        });
    }
    for (i, n) in input.nodes.into_iter().enumerate() {
        if n.operation > 5
            || !n.smoothing.is_finite()
            || n.smoothing < 0.
            || (n.leaf && n.left as usize >= tree.primitives.len())
            || (!n.leaf && (n.left as usize >= i || n.right as usize >= i))
        {
            return Err(invalid("Invalid SDF DAG"));
        }
        tree.nodes.push(CsgNode {
            operation: n.operation,
            left_child: n.left,
            right_child: n.right,
            smoothing: n.smoothing,
            material_id: n.material_id,
            is_leaf: u32::from(n.leaf),
            _pad: [0; 2],
        });
    }
    let points = points.to_vec();
    if !points.len().is_multiple_of(3) || points.iter().any(|p| !p.is_finite()) {
        return Err(invalid("Points must be finite xyz triples"));
    }
    let mut distances = Vec::with_capacity(points.len() / 3);
    let mut materials = Vec::with_capacity(points.len() / 3);
    for p in points.chunks_exact(3) {
        let result = tree.evaluate(
            glam::Vec3::new(p[0], p[1], p[2]),
            tree.root_node().unwrap_or(u32::MAX),
        );
        distances.push(result.distance);
        materials.push(result.material_id);
    }
    let result = js_sys::Object::new();
    js_sys::Reflect::set(
        &result,
        &"distances".into(),
        &js_sys::Float32Array::from(distances.as_slice()),
    )
    .map_err(|_| invalid("Cannot serialize SDF"))?;
    js_sys::Reflect::set(
        &result,
        &"materials".into(),
        &js_sys::Uint32Array::from(materials.as_slice()),
    )
    .map_err(|_| invalid("Cannot serialize SDF"))?;
    Ok(result.into())
}
