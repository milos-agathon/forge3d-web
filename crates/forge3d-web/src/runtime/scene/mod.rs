#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

mod build;
mod geometry;
mod gpu;
mod parse;
pub(super) mod pipelines;
mod plan;
mod replacement;

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
    vectors: Option<Option<super::vector::Resources>>,
    vector_highlights: Option<super::vector::HighlightUpdate>,
    postfx: Option<super::postfx::Resources>,
    context: forge3d_core::gpu::GpuContext,
    memory: super::memory::MemoryLedger,
    scene: Option<NativeScene>,
    environment: Option<super::environment::EnvironmentResources>,
    scatter: Option<super::scatter::ScatterResources>,
    time_seconds: f32,
    probes: super::probes::Prepared,
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
    let postfx_config = parsed
        .postfx
        .clone()
        .unwrap_or_else(|| runtime.postfx.as_ref().map(|fx| fx.config.clone()));
    let vector_packet = parsed
        .vectors
        .as_ref()
        .map(|packet| packet.as_ref())
        .unwrap_or_else(|| runtime.vectors.as_ref().map(|v| v.packet()));
    let reuse_vectors = parsed.vectors.is_none()
        || vector_packet.is_some_and(|p| super::vector::same_geometry(runtime, p));
    let vector_bytes = if reuse_vectors {
        super::vector::retained_scene_bytes(runtime, vector_packet)?
    } else {
        super::vector::planned_bytes(vector_packet, runtime.width, runtime.height)
    };
    if parsed.environment.as_ref().is_some_and(|e| {
        e.water
            .iter()
            .any(|w| w.terrain_mask && w.mode != "disabled" && w.reflection == "planar")
    }) {
        let textured = super::shader_variants::terrain_texture_flags(&parsed.materials) != 0;
        let required = if textured { 20 } else { 15 };
        if context
            .device
            .limits()
            .max_sampled_textures_per_shader_stage
            < required
        {
            return Err(WebError::new(
                Forge3DErrorCode::UnsupportedFeature,
                format!("masked-terrain reflections require {required} sampled textures"),
            ));
        }
    }
    let built = if parsed.nodes.is_empty() && parsed.passes.is_empty() {
        None
    } else {
        let (graph, node_map) = build_graph(parsed)?;
        let implicit = implicit_passes(runtime, parsed, &graph, &node_map);
        let plan = compile_scene_plan(&implicit, &parsed.passes, runtime.width, runtime.height)?;
        let mut geometry = build::build_geometry(
            &graph,
            &node_map,
            &parsed.nodes,
            &parsed.materials,
            runtime.width,
            runtime.height,
        );
        if let Some(previous) = &runtime.scene {
            previous.prepare_motion(&mut geometry);
        }
        Some((geometry, plan.pass_names))
    };

    let (vertices, bundles) = match &built {
        Some((geometry, _)) => (
            checked_scene_bytes(geometry)?,
            bundle_estimate_bytes(geometry),
        ),
        None => (0, 0),
    };
    let scatter_bytes = super::scatter::planned_bytes(&parsed.scatter)?;
    let probe_bytes = super::probes::planned_bytes(parsed.probes.as_ref())?;
    let texture_bytes = super::vector::texture_bytes(vector_packet, runtime.width, runtime.height);
    let texture_payload = parsed
        .texture_sets
        .values()
        .map(|set| set.payload_bytes())
        .sum();
    let admission = replacement::admit(
        &runtime.memory,
        runtime.width,
        runtime.height,
        runtime.overflow_policy,
        runtime.max_texture_dimension_2d,
        parsed,
        &[
            (super::vector::KEY, MemoryCategory::Textures, texture_bytes),
            (
                super::vector::BUFFER_KEY,
                MemoryCategory::Buffers,
                vector_bytes - texture_bytes,
            ),
            (
                super::postfx::KEY,
                MemoryCategory::Textures,
                postfx_config.as_ref().map_or(0, |config| {
                    super::postfx::planned_bytes(
                        config,
                        runtime.width,
                        runtime.height,
                        parsed.environment.is_some(),
                        parsed
                            .scatter
                            .iter()
                            .any(|s| s.color[3] < 1. || s.terrain_blend.enabled),
                    )
                }),
            ),
            (
                super::scatter::KEY,
                MemoryCategory::Buffers,
                scatter_bytes.saturating_sub(8),
            ),
            (
                super::scatter::TEXTURES_KEY,
                MemoryCategory::Textures,
                if scatter_bytes > 0 { 8 } else { 0 },
            ),
            (
                super::probes::KEY,
                MemoryCategory::Buffers,
                probe_bytes.saturating_sub(64),
            ),
            (
                super::textures::TEXTURE_FALLBACK_KEY,
                MemoryCategory::Textures,
                super::textures::FALLBACK_BYTES,
            ),
            (
                super::textures::TEXTURE_PAYLOAD_KEY,
                MemoryCategory::Textures,
                texture_payload,
            ),
            (SCENE_VERTEX_KEY, MemoryCategory::Buffers, vertices),
            (
                SCENE_UNIFORM_KEY,
                MemoryCategory::Buffers,
                if built.is_some() {
                    SCENE_UNIFORM_BYTES
                } else {
                    0
                },
            ),
            (SCENE_BUNDLE_KEY, MemoryCategory::RenderBundles, bundles),
        ],
    )?;
    let mut planned = admission.memory;
    let ibl_selection = admission.ibl;
    let mut environment = super::environment::materialize(
        runtime,
        super::environment::plan(runtime, admission.environment.as_ref(), &mut planned)?,
    )?;
    if let Some(e) = &mut environment {
        e.original_lighting = Some((
            parsed
                .environment_lighting
                .as_ref()
                .unwrap_or(&parsed.lighting)
                .clone(),
            parsed.light_ids.clone(),
        ));
    }
    let scatter = super::scatter::build(runtime, parsed.scatter.clone(), &mut planned)?;
    let probes = super::probes::prepare(runtime, parsed.probes.as_ref(), &mut planned)?;

    let textures = super::textures::build_texture_resources(
        &context,
        &planned,
        runtime.max_texture_dimension_2d,
        &parsed.texture_sets,
    )?;
    let shadow_resources = super::shadows::materialize_shadow_resources(
        &context,
        &parsed.shadows,
        admission.shadow_size,
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
    debug_assert_eq!(
        planned.admitted_bytes(super::ibl::IBL_TEXTURES_LEDGER_KEY),
        Some(ibl_resources.retained_texture_bytes)
    );

    let scene = match built {
        Some((geometry, pass_names)) => {
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
                super::shader_variants::ShaderFeatures::for_lighting(
                    &lighting_resources.state,
                    &lighting_resources.material_state,
                    ibl_resources.enabled,
                    runtime
                        .shadows
                        .as_ref()
                        .map(|shadows| shadows.control)
                        .unwrap_or([0; 4]),
                )
                .with_probes(runtime.probe_count > 0),
            )?;
            debug_assert_eq!(
                scene.world_vertex_bytes() + scene.overlay_vertex_bytes(),
                vertices
            );
            Some(scene)
        }
        None => {
            for key in scene_memory_keys() {
                planned.release(key);
            }
            None
        }
    };

    let postfx = super::postfx::prepare_scene(
        runtime,
        postfx_config,
        environment.is_some(),
        scatter.as_ref().is_some_and(|s| s.transparent()),
        &mut planned,
    )?;
    let vector_highlights = if parsed.vectors.is_some() && reuse_vectors {
        Some(super::vector::prepare_scene_highlights(
            runtime,
            vector_packet.expect("retained packet"),
            &mut planned,
        )?)
    } else {
        None
    };
    let vectors = if let Some(packet) = &parsed.vectors {
        if reuse_vectors {
            None
        } else {
            Some(super::vector::prepare(
                runtime,
                packet.clone(),
                &mut planned,
                runtime.width,
                runtime.height,
            )?)
        }
    } else {
        None
    };
    Ok(SceneResourcePlan {
        vectors,
        vector_highlights,
        postfx,
        context,
        memory: planned,
        scene,
        environment,
        scatter,
        time_seconds: parsed.time_seconds,
        probes,
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
        vectors,
        vector_highlights,
        postfx,
        context,
        memory,
        scene,
        environment,
        scatter,
        time_seconds,
        probes,
        textures,
        ibl,
        shadows,
        shadow_state,
        lighting,
        light_ids,
        materials,
    } = plan;
    runtime.memory = memory;
    if let Some(update) = vector_highlights {
        super::vector::apply_highlights(runtime, update);
    }
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
    runtime.environment = environment;
    runtime.postfx = postfx;
    if let Some(vectors) = vectors {
        runtime.vectors = vectors;
    }
    runtime.scatter = scatter;
    runtime.time_seconds = time_seconds;
    super::probes::commit(runtime, probes);
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
        graph
            .set_transform(
                id,
                Transform {
                    translation: node.transform.translation.into(),
                    rotation: geometry::normalize_quat(node.transform.rotation),
                    scale: node.transform.scale.into(),
                },
            )
            .map_err(map_core_error)?;
        graph
            .set_visible(id, node.visible)
            .map_err(map_core_error)?;
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
