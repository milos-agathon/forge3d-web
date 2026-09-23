#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

mod build;
mod geometry;
mod gpu;
mod parse;
pub(super) mod pipelines;
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

#[cfg(target_arch = "wasm32")]
pub(super) use geometry::LitVertex;
pub(super) use gpu::NativeScene;

const IMPLICIT_PASS_KINDS: [&str; 4] = ["terrain", "ground-plane", "text-mesh", "overlay"];
const SCENE_VERTEX_KEY: &str = "scene:vertices";
const SCENE_UNIFORM_KEY: &str = "scene:uniforms";
const SCENE_BUNDLE_KEY: &str = "scene:bundles";
const SCENE_UNIFORM_BYTES: u64 = 96;

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

struct SceneResourcePlan {
    context: forge3d_core::gpu::GpuContext,
    memory: super::memory::MemoryLedger,
    scene: Option<NativeScene>,
    textures: super::textures::TextureResources,
    ibl: super::ibl::IblResources,
    shadows: super::shadows::ShadowResources,
    shadow_state: super::shadows::PreparedShadowState,
    lighting: forge3d_core::lighting::LightingState,
    light_ids: Vec<u32>,
    materials: forge3d_core::materials::MaterialState,
}

fn prepare_scene(
    runtime: &Forge3DRuntime,
    parsed: &ParsedScene,
) -> Result<SceneResourcePlan, WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let lighting_resources = runtime.lighting.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime lighting resources are not available",
        )
    })?;
    let ibl_layout = runtime
        .ibl
        .as_ref()
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime IBL resources are not available",
            )
        })?
        .bind_group_layout
        .clone();
    let aspect = runtime.width as f32 / runtime.height.max(1) as f32;
    let mut planned = runtime.memory.clone();

    let built = if parsed.nodes.is_empty() && parsed.passes.is_empty() {
        None
    } else {
        let (graph, node_map) = build_graph(parsed)?;
        let implicit = implicit_passes(runtime, parsed, &graph, &node_map);
        let plan = compile_scene_plan(&implicit, &parsed.passes, runtime.width, runtime.height)?;
        let geometry = build::build_geometry(
            &graph,
            &node_map,
            &parsed.nodes,
            &parsed.materials,
            runtime.width,
            runtime.height,
        );
        Some((geometry, plan.pass_names))
    };

    let textures = super::textures::build_texture_resources(
        &context,
        &planned,
        runtime.max_texture_dimension_2d,
        &parsed.texture_sets,
    )?;
    planned.replace(
        super::textures::TEXTURE_FALLBACK_KEY,
        MemoryCategory::Textures,
        super::textures::FALLBACK_BYTES,
    )?;
    planned.replace(
        super::textures::TEXTURE_PAYLOAD_KEY,
        MemoryCategory::Textures,
        textures.payload_bytes,
    )?;

    let ibl_selection = match &parsed.ibl {
        Some(ibl) if ibl.prepared.is_none() => Some(super::ibl::select_ibl_quality(
            &planned,
            runtime.overflow_policy,
            runtime.max_texture_dimension_2d,
            ibl,
            false,
        )?),
        _ => None,
    };
    if let Some(selection) = &ibl_selection {
        planned.replace(
            super::ibl::IBL_TRANSIENT_LEDGER_KEY,
            MemoryCategory::Textures,
            selection.transient_bytes,
        )?;
    }

    let shadow_resources = super::shadows::build_shadow_resources(
        &context,
        &planned,
        runtime.overflow_policy,
        runtime.max_texture_dimension_2d,
        &parsed.shadows,
    )?;
    let (shadow_depth_bytes, shadow_moment_bytes, shadow_uniform_bytes) =
        shadow_resources.ledger_bytes()?;
    planned.replace(
        super::shadows::SHADOW_DEPTH_KEY,
        MemoryCategory::Textures,
        shadow_depth_bytes,
    )?;
    planned.replace(
        super::shadows::SHADOW_MOMENTS_KEY,
        MemoryCategory::Textures,
        shadow_moment_bytes,
    )?;
    planned.replace(
        super::shadows::SHADOW_UNIFORMS_KEY,
        MemoryCategory::Buffers,
        shadow_uniform_bytes,
    )?;
    let shadow_state = super::shadows::prepare_shadow_state(
        &runtime.camera,
        aspect,
        &parsed.lighting,
        &parsed.light_ids,
        &shadow_resources,
        runtime.terrain.as_ref(),
    )?;

    let ibl_resources = super::ibl::build_ibl_resources(
        &context,
        &ibl_layout,
        parsed.ibl.as_ref(),
        ibl_selection.as_ref(),
        &shadow_resources,
    )?;
    planned.release(super::ibl::IBL_TRANSIENT_LEDGER_KEY);
    super::ibl::admit_ibl_retained(&mut planned, &ibl_resources)?;

    let scene = match built {
        Some((geometry, pass_names)) => {
            let vertex_estimate = checked_scene_bytes(&geometry)?;
            let bundle_bytes = bundle_estimate_bytes(&geometry);
            let total = vertex_estimate
                .checked_add(SCENE_UNIFORM_BYTES)
                .and_then(|value| value.checked_add(bundle_bytes))
                .ok_or_else(|| {
                    WebError::new(
                        Forge3DErrorCode::ResourceLimitExceeded,
                        "scene byte accounting overflowed",
                    )
                })?;
            if !planned.fits_after_release(&scene_memory_keys(), total) {
                return Err(WebError::new(
                    Forge3DErrorCode::ResourceLimitExceeded,
                    format!("scene requires {total} bytes beyond the memory budget"),
                ));
            }
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
            let scene = NativeScene::new(
                &context,
                format,
                geometry,
                &runtime.camera,
                runtime.width,
                runtime.height,
                pass_names,
                lighting_resources,
                &textures,
                &ibl_resources,
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
            planned.replace(SCENE_VERTEX_KEY, MemoryCategory::Buffers, vertex_bytes)?;
            planned.replace(
                SCENE_UNIFORM_KEY,
                MemoryCategory::Buffers,
                SCENE_UNIFORM_BYTES,
            )?;
            planned.replace(
                SCENE_BUNDLE_KEY,
                MemoryCategory::RenderBundles,
                bundle_bytes,
            )?;
            Some(scene)
        }
        None => {
            for key in scene_memory_keys() {
                planned.release(key);
            }
            None
        }
    };

    Ok(SceneResourcePlan {
        context,
        memory: planned,
        scene,
        textures,
        ibl: ibl_resources,
        shadows: shadow_resources,
        shadow_state,
        lighting: parsed.lighting.clone(),
        light_ids: parsed.light_ids.clone(),
        materials: parsed.materials.clone(),
    })
}

fn commit_scene_plan(runtime: &mut Forge3DRuntime, plan: SceneResourcePlan) {
    let SceneResourcePlan {
        context,
        memory,
        scene,
        textures,
        ibl,
        shadows,
        shadow_state,
        lighting,
        light_ids,
        materials,
    } = plan;
    runtime.memory = memory;
    let lighting_resources = runtime
        .lighting
        .as_mut()
        .expect("lighting resources verified during scene preparation");
    lighting_resources.commit_state(&context, &lighting, light_ids);
    lighting_resources.commit_materials(&context, &materials);
    super::textures::commit_textures(runtime, textures);
    let mut shadows = shadows;
    shadow_state.write(&context, &mut shadows);
    super::shadows::commit_shadows(runtime, shadows);
    super::ibl::commit_ibl(runtime, ibl);
    super::shadows::rebuild_terrain_depth_binding(runtime);
    runtime.scene = scene;
}

fn commit_scene(runtime: &mut Forge3DRuntime, parsed: ParsedScene) -> Result<(), WebError> {
    let plan = prepare_scene(runtime, &parsed)?;
    commit_scene_plan(runtime, plan);
    Ok(())
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
