use super::compile::topological_order;
use super::testkit::{buffer, pass};
use super::{PassId, RenderGraph, ResourceAccess, ResourceId};
use crate::error::Forge3dError;
use std::collections::BTreeSet;

#[test]
fn hazard_edges_compile_terrain_ground_text_overlay_order() {
    let mut graph = RenderGraph::new();
    let scene = graph.add_resource(buffer("scene", 64));
    let ui = graph.add_resource(buffer("ui", 32));

    let terrain = graph.add_pass(pass("terrain", &[], &[scene], &[])).unwrap();
    let ground = graph
        .add_pass(pass("ground", &[scene], &[ui], &[]))
        .unwrap();
    let text = graph.add_pass(pass("text", &[ui], &[], &[])).unwrap();
    let overlay = graph.add_pass(pass("overlay", &[ui], &[], &[])).unwrap();

    let plan = graph.compile().unwrap();

    assert_eq!(plan.passes, vec![terrain, ground, text, overlay]);
    assert!(plan.barriers.iter().any(|barrier| barrier.resource == scene
        && barrier.before_pass == ground
        && barrier.from == ResourceAccess::Write
        && barrier.to == ResourceAccess::Read));
    assert!(plan.barriers.iter().any(|barrier| barrier.resource == ui
        && barrier.before_pass == text
        && barrier.from == ResourceAccess::Write
        && barrier.to == ResourceAccess::Read));
    assert_eq!(plan.metrics.pass_count, 4);
    assert_eq!(plan.metrics.resource_count, 2);
    assert_eq!(plan.metrics.barrier_count, 2);
}

#[test]
fn explicit_dependencies_order_independent_passes() {
    let mut graph = RenderGraph::new();
    let overlay = graph.add_pass(pass("overlay", &[], &[], &[])).unwrap();
    let main = graph.add_pass(pass("main", &[], &[], &[])).unwrap();
    let combine = graph
        .add_pass(pass("combine", &[], &[], &[main, overlay]))
        .unwrap();

    let plan = graph.compile().unwrap();

    assert_eq!(plan.passes, vec![overlay, main, combine]);
}

#[test]
fn add_pass_rejects_invalid_handles() {
    let mut graph = RenderGraph::new();
    let resource = graph.add_resource(buffer("target", 16));

    assert!(matches!(
        graph.add_pass(pass("bad-read", &[ResourceId(9)], &[], &[])),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        graph.add_pass(pass("bad-write", &[], &[ResourceId(9)], &[])),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        graph.add_pass(pass("bad-dep", &[resource], &[], &[PassId(9)])),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        graph.add_pass(pass("self-dep", &[], &[], &[PassId(0)])),
        Err(Forge3dError::InvalidInput { .. })
    ));
}

#[test]
fn add_pass_rejects_read_write_conflicts() {
    let mut graph = RenderGraph::new();
    let resource = graph.add_resource(buffer("target", 16));

    assert!(matches!(
        graph.add_pass(pass("both", &[resource], &[resource], &[])),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        graph.add_pass(pass("dup", &[resource, resource], &[], &[])),
        Err(Forge3dError::InvalidInput { .. })
    ));
}

#[test]
fn topological_order_rejects_cycles() {
    let edges = BTreeSet::from([(0usize, 1usize), (1, 0)]);
    assert!(matches!(
        topological_order(2, &edges),
        Err(Forge3dError::InvalidInput { .. })
    ));
}

#[test]
fn add_dependency_seam_can_create_rejected_cycles() {
    let mut graph = RenderGraph::new();
    let first = graph.add_pass(pass("a", &[], &[], &[])).unwrap();
    let second = graph.add_pass(pass("b", &[], &[], &[])).unwrap();

    graph.add_dependency(second, first).unwrap();
    graph.add_dependency(first, second).unwrap();

    assert!(matches!(
        graph.compile(),
        Err(Forge3dError::InvalidInput { .. })
    ));

    assert!(matches!(
        graph.add_dependency(PassId(9), first),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        graph.add_dependency(first, PassId(9)),
        Err(Forge3dError::InvalidInput { .. })
    ));
}
