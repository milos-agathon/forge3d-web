use std::collections::BTreeMap;
use std::collections::BTreeSet;

use forge3d_core::scene::{NodeId, SceneGraph};

use super::super::timing::{PassDraw, PassGroup};
use super::geometry::{self, ColorVertex};
use super::gpu::{BuiltGeometry, DrawRange, OverlayGeometry};
use super::parse::{ParsedNode, ParsedNodeKind};
use super::Forge3DRuntime;
use crate::error::{Forge3DErrorCode, WebError};

pub(super) fn visible_node_ids(
    graph: &SceneGraph,
    node_map: &BTreeMap<u32, NodeId>,
) -> BTreeSet<u32> {
    let native_to_parsed: BTreeMap<NodeId, u32> = node_map
        .iter()
        .map(|(parsed, native)| (*native, *parsed))
        .collect();
    let mut visible = BTreeSet::new();
    let mut stack: Vec<(NodeId, bool)> = graph.roots().iter().map(|id| (*id, true)).collect();
    while let Some((id, parent_visible)) = stack.pop() {
        let Some(node) = graph.node(id) else {
            continue;
        };
        let visible_here = parent_visible && node.visible;
        if visible_here {
            if let Some(parsed_id) = native_to_parsed.get(&id) {
                visible.insert(*parsed_id);
            }
        }
        for &child in &node.children {
            stack.push((child, visible_here));
        }
    }
    visible
}

pub(super) fn build_geometry(
    graph: &SceneGraph,
    node_map: &BTreeMap<u32, NodeId>,
    nodes: &[ParsedNode],
    width: u32,
    height: u32,
) -> BuiltGeometry {
    let visible = visible_node_ids(graph, node_map);
    let mut geometry = BuiltGeometry::default();
    let mut overlay_nodes = Vec::new();
    for node in nodes {
        if !visible.contains(&node.id) {
            continue;
        }
        let Some(native_id) = node_map.get(&node.id) else {
            continue;
        };
        let world = graph
            .node(*native_id)
            .map(|stored| stored.world_transform)
            .unwrap_or(glam::Mat4::IDENTITY);
        match &node.kind {
            ParsedNodeKind::GroundPlane {
                size,
                height: plane_height,
                color,
            } => {
                let first_vertex = geometry.world_vertices.len() as u32;
                geometry
                    .world_vertices
                    .extend_from_slice(&geometry::ground_plane_vertices(
                        world,
                        *size,
                        *plane_height,
                        *color,
                    ));
                geometry.world_ranges.push(DrawRange {
                    pass: "ground-plane".to_string(),
                    first_vertex,
                    vertex_count: 6,
                    triangles: 2,
                });
            }
            ParsedNodeKind::TextMesh { text, size, color } => {
                let first_vertex = geometry.world_vertices.len() as u32;
                let vertices = geometry::text_mesh_vertices(world, text, *size, *color);
                let vertex_count = vertices.len() as u32;
                geometry.world_vertices.extend(vertices);
                geometry.world_ranges.push(DrawRange {
                    pass: "text-mesh".to_string(),
                    first_vertex,
                    vertex_count,
                    triangles: u64::from(vertex_count) / 3,
                });
            }
            ParsedNodeKind::Overlay {
                bounds,
                color,
                z_index,
            } => {
                overlay_nodes.push((node.id, *z_index, *bounds, *color));
            }
            _ => {}
        }
    }
    overlay_nodes.sort_by_key(|(id, z_index, _, _)| (*z_index, *id));
    for (_id, _z_index, bounds, color) in overlay_nodes {
        let first_vertex = geometry.overlay_vertices.len() as u32;
        geometry
            .overlay_vertices
            .extend_from_slice(&geometry::overlay_vertices(bounds, color, width, height));
        geometry.overlay_ranges.push(DrawRange {
            pass: "overlay".to_string(),
            first_vertex,
            vertex_count: 6,
            triangles: 2,
        });
        geometry.overlays.push(OverlayGeometry { bounds, color });
    }
    geometry
}

pub(super) fn checked_scene_bytes(geometry: &BuiltGeometry) -> Result<u64, WebError> {
    let vertex_len = geometry
        .world_vertices
        .len()
        .checked_add(geometry.overlay_vertices.len())
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "scene vertex count overflowed",
            )
        })? as u64;
    vertex_len
        .checked_mul(std::mem::size_of::<ColorVertex>() as u64)
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "scene vertex bytes overflowed",
            )
        })
}

pub(super) fn bundle_estimate_bytes(geometry: &BuiltGeometry) -> u64 {
    let draws = (geometry.world_ranges.len() + geometry.overlay_ranges.len()) as u64;
    if draws == 0 {
        return 0;
    }
    draws.saturating_mul(128).saturating_add(256)
}

pub(crate) fn scene_pass_draws(runtime: &Forge3DRuntime) -> Vec<PassDraw> {
    let mut passes = Vec::new();
    let Some(scene) = runtime.scene.as_ref() else {
        if let Some(terrain) = runtime.terrain.as_ref() {
            passes.push(PassDraw {
                name: "terrain".to_string(),
                group: PassGroup::World,
                draws: 1,
                triangles: u64::from(terrain.index_count) / 3,
            });
        }
        return passes;
    };
    for name in &scene.pass_names {
        match name.as_str() {
            "terrain" => passes.push(PassDraw {
                name: name.clone(),
                group: PassGroup::World,
                draws: u32::from(runtime.terrain.is_some()),
                triangles: runtime
                    .terrain
                    .as_ref()
                    .map_or(0, |terrain| u64::from(terrain.index_count) / 3),
            }),
            "overlay" => {
                let draws = scene.overlay_ranges.len() as u32;
                let triangles = scene
                    .overlay_ranges
                    .iter()
                    .map(|range| range.triangles)
                    .sum();
                passes.push(PassDraw {
                    name: name.clone(),
                    group: PassGroup::Overlay,
                    draws,
                    triangles,
                });
            }
            other => {
                let ranges: Vec<&DrawRange> = scene
                    .world_ranges
                    .iter()
                    .filter(|range| range.pass == other)
                    .collect();
                let group = if ranges.is_empty() {
                    PassGroup::Noop
                } else {
                    PassGroup::World
                };
                passes.push(PassDraw {
                    name: name.to_string(),
                    group,
                    draws: ranges.len() as u32,
                    triangles: ranges.iter().map(|range| range.triangles).sum(),
                });
            }
        }
    }
    passes
}
