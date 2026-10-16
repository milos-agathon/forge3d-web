use super::testkit::{buffer, pass, transient_buffer, transient_texture};
use super::{RenderGraph, ResourceDescriptor, ResourceKind};
use crate::error::Forge3dError;

#[test]
fn disjoint_compatible_transients_alias_to_one_physical() {
    let mut graph = RenderGraph::new();
    let first = graph.add_resource(transient_buffer("first", 64));
    let second = graph.add_resource(transient_buffer("second", 64));

    let p0 = graph.add_pass(pass("p0", &[], &[first], &[])).unwrap();
    let p1 = graph.add_pass(pass("p1", &[first], &[], &[])).unwrap();
    let p2 = graph.add_pass(pass("p2", &[], &[second], &[])).unwrap();
    let p3 = graph.add_pass(pass("p3", &[second], &[], &[])).unwrap();

    let plan = graph.compile().unwrap();

    assert_eq!(plan.passes, vec![p0, p1, p2, p3]);
    assert_eq!(plan.aliases.len(), 1);
    assert_eq!(plan.aliases[0].logical, second);
    assert_eq!(plan.aliases[0].physical, first);
    assert_eq!(plan.metrics.alias_count, 1);
    assert_eq!(plan.metrics.logical_bytes, 128);
    assert_eq!(plan.metrics.physical_bytes, 64);
}

#[test]
fn overlapping_lifetimes_do_not_alias() {
    let mut graph = RenderGraph::new();
    let first = graph.add_resource(transient_buffer("first", 64));
    let second = graph.add_resource(transient_buffer("second", 64));

    graph
        .add_pass(pass("both", &[first, second], &[], &[]))
        .unwrap();

    let plan = graph.compile().unwrap();

    assert!(plan.aliases.is_empty());
    assert_eq!(plan.metrics.physical_bytes, 128);
}

#[test]
fn incompatible_kinds_and_non_transients_do_not_alias() {
    let mut graph = RenderGraph::new();
    let tex = graph.add_resource(transient_texture("tex", 8, 8, 4));
    let buf = graph.add_resource(transient_buffer("buf", 64));
    let persistent = graph.add_resource(ResourceDescriptor {
        name: "persistent".to_string(),
        kind: ResourceKind::Buffer { size: 64 },
        transient: false,
        aliasable: true,
    });
    let persistent2 = graph.add_resource(ResourceDescriptor {
        name: "persistent2".to_string(),
        kind: ResourceKind::Buffer { size: 64 },
        transient: true,
        aliasable: false,
    });

    graph.add_pass(pass("p0", &[], &[tex], &[])).unwrap();
    graph.add_pass(pass("p1", &[tex], &[], &[])).unwrap();
    graph.add_pass(pass("p2", &[], &[buf], &[])).unwrap();
    graph.add_pass(pass("p3", &[buf], &[], &[])).unwrap();
    graph.add_pass(pass("p4", &[], &[persistent], &[])).unwrap();
    graph
        .add_pass(pass("p5", &[], &[persistent2], &[]))
        .unwrap();

    let plan = graph.compile().unwrap();

    assert!(plan.aliases.is_empty());
    assert_eq!(plan.metrics.transient_count, 3);
    assert_eq!(plan.metrics.logical_bytes, 256 + 64 + 64 + 64);
    assert_eq!(plan.metrics.physical_bytes, 256 + 64 + 64 + 64);
}

#[test]
fn logical_and_physical_bytes_account_aliases_once() {
    let mut graph = RenderGraph::new();
    let persistent = graph.add_resource(buffer("frame", 100));
    let first = graph.add_resource(transient_buffer("a", 60));
    let second = graph.add_resource(transient_buffer("b", 60));
    let third = graph.add_resource(transient_buffer("c", 60));

    graph
        .add_pass(pass("p0", &[persistent], &[first], &[]))
        .unwrap();
    graph.add_pass(pass("p1", &[], &[second], &[])).unwrap();
    graph.add_pass(pass("p2", &[], &[third], &[])).unwrap();

    let plan = graph.compile().unwrap();

    assert_eq!(plan.metrics.logical_bytes, 280);
    assert_eq!(plan.metrics.alias_count, 2);
    assert_eq!(plan.metrics.physical_bytes, 160);
}

#[test]
fn byte_totals_overflow_is_an_error() {
    let mut graph = RenderGraph::new();
    graph.add_resource(buffer("huge-a", u64::MAX));
    graph.add_resource(buffer("huge-b", u64::MAX));
    graph.add_pass(pass("noop", &[], &[], &[])).unwrap();

    assert!(matches!(
        graph.compile(),
        Err(Forge3dError::ResourceLimitExceeded { .. })
    ));
}

#[test]
fn texture_byte_size_uses_checked_arithmetic() {
    let small = ResourceKind::Texture {
        width: 4,
        height: 4,
        depth_or_layers: 1,
        bytes_per_texel: 4,
    };
    assert_eq!(small.byte_size().unwrap(), 64);

    let huge = ResourceKind::Texture {
        width: u32::MAX,
        height: u32::MAX,
        depth_or_layers: u32::MAX,
        bytes_per_texel: 4,
    };
    assert!(matches!(
        huge.byte_size(),
        Err(Forge3dError::InvalidInput { .. })
    ));

    let empty = ResourceKind::Buffer { size: 0 };
    assert!(matches!(
        empty.byte_size(),
        Err(Forge3dError::InvalidInput { .. })
    ));

    let zero = ResourceKind::Texture {
        width: 0,
        height: 4,
        depth_or_layers: 1,
        bytes_per_texel: 4,
    };
    assert!(matches!(
        zero.byte_size(),
        Err(Forge3dError::InvalidInput { .. })
    ));
}
