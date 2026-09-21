#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

mod build;
mod geometry;
mod gpu;
mod parse;
mod pipelines;
mod plan;

use std::collections::BTreeMap;

use forge3d_core::memory::MemoryCategory;
use forge3d_core::scene::{NodeId, SceneGraph, SceneNodeKind, Transform};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsValue;

use super::Forge3DRuntime;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};
use build::{bundle_estimate_bytes, checked_scene_bytes};
use parse::{ParsedNodeKind, ParsedScene};
use plan::compile_scene_plan;

pub(super) use gpu::NativeScene;

const IMPLICIT_PASS_KINDS: [&str; 4] = ["terrain", "ground-plane", "text-mesh", "overlay"];
const SCENE_VERTEX_KEY: &str = "scene:vertices";
const SCENE_UNIFORM_KEY: &str = "scene:uniforms";
const SCENE_BUNDLE_KEY: &str = "scene:bundles";
const SCENE_UNIFORM_BYTES: u64 = 64;

pub(super) use build::scene_pass_draws;

pub(super) fn scene_memory_keys() -> [&'static str; 3] {
    [SCENE_VERTEX_KEY, SCENE_UNIFORM_KEY, SCENE_BUNDLE_KEY]
}

#[cfg(target_arch = "wasm32")]
pub(super) fn set_scene_runtime(
    runtime: &mut Forge3DRuntime,
    snapshot: JsValue,
) -> Result<(), WebError> {
    let parsed = parse::parse_snapshot(&snapshot)?;
    commit_scene(runtime, parsed)
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn set_scene_runtime(
    runtime: &mut Forge3DRuntime,
    snapshot: wasm_bindgen::JsValue,
) -> Result<(), WebError> {
    let _ = (runtime, snapshot);
    Err(WebError::new(
        Forge3DErrorCode::UnsupportedFeature,
        "Scene commits are only available in wasm32 browser builds",
    ))
}

fn commit_scene(runtime: &mut Forge3DRuntime, parsed: ParsedScene) -> Result<(), WebError> {
    if parsed.nodes.is_empty() && parsed.passes.is_empty() {
        clear_scene(runtime);
        return Ok(());
    }
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let format = runtime
        .surface_state
        .as_ref()
        .map(|state| state.config.format)
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime surface state is not available",
            )
        })?;

    let (graph, node_map) = build_graph(&parsed)?;
    let implicit = implicit_passes(runtime, &parsed, &graph, &node_map);
    let plan = compile_scene_plan(&implicit, &parsed.passes, runtime.width, runtime.height)?;
    let geometry = build::build_geometry(
        &graph,
        &node_map,
        &parsed.nodes,
        runtime.width,
        runtime.height,
    );

    let vertex_bytes = checked_scene_bytes(&geometry)?;
    let bundle_bytes = bundle_estimate_bytes(&geometry);
    let total = vertex_bytes
        .checked_add(SCENE_UNIFORM_BYTES)
        .and_then(|value| value.checked_add(bundle_bytes))
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "scene byte accounting overflowed",
            )
        })?;
    if !runtime
        .memory
        .fits_after_release(&scene_memory_keys(), total)
    {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!("scene requires {total} bytes beyond the memory budget"),
        ));
    }

    let scene = NativeScene::new(
        &context,
        format,
        geometry,
        &runtime.camera,
        runtime.width,
        runtime.height,
        plan.pass_names,
    )?;
    let vertex_bytes = scene
        .world_vertex_bytes()
        .checked_add(scene.overlay_vertex_bytes())
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "scene vertex byte accounting overflowed",
            )
        })?;
    runtime
        .memory
        .replace(SCENE_VERTEX_KEY, MemoryCategory::Buffers, vertex_bytes)?;
    runtime.memory.replace(
        SCENE_UNIFORM_KEY,
        MemoryCategory::Buffers,
        SCENE_UNIFORM_BYTES,
    )?;
    runtime.memory.replace(
        SCENE_BUNDLE_KEY,
        MemoryCategory::RenderBundles,
        bundle_bytes,
    )?;
    runtime.scene = Some(scene);
    Ok(())
}

fn clear_scene(runtime: &mut Forge3DRuntime) {
    runtime.scene = None;
    for key in scene_memory_keys() {
        runtime.memory.release(key);
    }
}

fn build_graph(parsed: &ParsedScene) -> Result<(SceneGraph, BTreeMap<u32, NodeId>), WebError> {
    let mut graph = SceneGraph::new();
    let mut node_map = BTreeMap::new();
    for node in &parsed.nodes {
        let kind = match &node.kind {
            ParsedNodeKind::Group => SceneNodeKind::Group,
            ParsedNodeKind::Terrain => SceneNodeKind::Terrain,
            ParsedNodeKind::GroundPlane { .. } => SceneNodeKind::GroundPlane,
            ParsedNodeKind::TextMesh { .. } => SceneNodeKind::TextMesh,
            ParsedNodeKind::Overlay { .. } => SceneNodeKind::Overlay,
            ParsedNodeKind::Custom => SceneNodeKind::Custom("generic".to_string()),
        };
        let id = graph.create_node(node.id.to_string(), kind);
        {
            let stored = graph.node_mut(id).ok_or_else(|| {
                WebError::new(
                    Forge3DErrorCode::InternalError,
                    "scene node was not created",
                )
            })?;
            stored.transform = Transform {
                translation: node.transform.translation.into(),
                rotation: geometry::normalize_quat(node.transform.rotation),
                scale: node.transform.scale.into(),
            };
            stored.visible = node.visible;
        }
        if let Some(parent) = node.parent {
            let native_parent = node_map.get(&parent).copied().ok_or_else(|| {
                WebError::new(
                    Forge3DErrorCode::InvalidInput,
                    format!("scene node {} references an unknown parent", node.id),
                )
            })?;
            graph
                .set_parent(id, Some(native_parent))
                .map_err(map_core_error)?;
        }
        node_map.insert(node.id, id);
    }
    graph.update_world_transforms().map_err(map_core_error)?;
    Ok((graph, node_map))
}

fn implicit_passes(
    runtime: &Forge3DRuntime,
    parsed: &ParsedScene,
    graph: &SceneGraph,
    node_map: &BTreeMap<u32, NodeId>,
) -> Vec<&'static str> {
    let visible = build::visible_node_ids(graph, node_map);
    let has_kind = |target: &str| {
        parsed.nodes.iter().any(|node| {
            visible.contains(&node.id)
                && matches!(
                    (&node.kind, target),
                    (ParsedNodeKind::Terrain, "terrain")
                        | (ParsedNodeKind::GroundPlane { .. }, "ground-plane")
                        | (ParsedNodeKind::TextMesh { .. }, "text-mesh")
                        | (ParsedNodeKind::Overlay { .. }, "overlay")
                )
        })
    };
    let mut passes = Vec::new();
    for kind in IMPLICIT_PASS_KINDS {
        if kind == "terrain" {
            if has_kind("terrain") || runtime.terrain.is_some() {
                passes.push("terrain");
            }
            continue;
        }
        if has_kind(kind) {
            passes.push(kind);
        }
    }
    passes
}
