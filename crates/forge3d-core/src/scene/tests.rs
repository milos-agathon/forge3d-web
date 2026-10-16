use super::{NodeId, SceneGraph, SceneNodeKind, Transform};
use crate::error::Forge3dError;

fn translated(x: f32, y: f32, z: f32) -> Transform {
    Transform {
        translation: glam::Vec3::new(x, y, z),
        rotation: glam::Quat::IDENTITY,
        scale: glam::Vec3::ONE,
    }
}

#[test]
fn visible_traversal_orders_parents_before_children_across_kinds() {
    let mut graph = SceneGraph::new();
    let group = graph.create_node("root", SceneNodeKind::Group);
    let terrain = graph.create_node("terrain", SceneNodeKind::Terrain);
    let ground = graph.create_node("ground", SceneNodeKind::GroundPlane);
    let text = graph.create_node("label", SceneNodeKind::TextMesh);
    let overlay = graph.create_node("overlay", SceneNodeKind::Overlay);

    graph.set_parent(terrain, Some(group)).unwrap();
    graph.set_parent(text, Some(terrain)).unwrap();
    graph.set_parent(ground, Some(group)).unwrap();

    let visible = graph.visible_nodes().unwrap();

    assert_eq!(visible, vec![group, terrain, text, ground, overlay]);
}

#[test]
fn world_transform_composes_parent_and_local() {
    let mut graph = SceneGraph::new();
    let parent = graph.create_node("parent", SceneNodeKind::Group);
    let child = graph.create_node("child", SceneNodeKind::Terrain);

    graph.set_parent(child, Some(parent)).unwrap();
    graph.node_mut(parent).unwrap().transform = Transform {
        translation: glam::Vec3::new(10.0, 0.0, 0.0),
        rotation: glam::Quat::IDENTITY,
        scale: glam::Vec3::splat(2.0),
    };
    graph.node_mut(child).unwrap().transform = translated(1.0, 0.0, 0.0);

    graph.update_world_transforms().unwrap();

    let parent_world = graph.node(parent).unwrap().world_transform;
    let child_world = graph.node(child).unwrap().world_transform;
    assert_eq!(
        parent_world.transform_point3(glam::Vec3::ZERO),
        glam::Vec3::new(10.0, 0.0, 0.0)
    );
    assert_eq!(
        child_world.transform_point3(glam::Vec3::ZERO),
        glam::Vec3::new(12.0, 0.0, 0.0)
    );
}

#[test]
fn set_parent_rejects_missing_self_and_ancestor_cycles() {
    let mut graph = SceneGraph::new();
    let a = graph.create_node("a", SceneNodeKind::Group);
    let b = graph.create_node("b", SceneNodeKind::Group);
    let c = graph.create_node("c", SceneNodeKind::Group);
    graph.set_parent(b, Some(a)).unwrap();
    graph.set_parent(c, Some(b)).unwrap();

    let missing = graph.set_parent(a, Some(NodeId(999)));
    assert!(matches!(missing, Err(Forge3dError::InvalidInput { .. })));

    let self_parent = graph.set_parent(a, Some(a));
    assert!(matches!(
        self_parent,
        Err(Forge3dError::InvalidInput { .. })
    ));

    let cycle = graph.set_parent(a, Some(c));
    assert!(matches!(cycle, Err(Forge3dError::InvalidInput { .. })));

    let missing_child = graph.set_parent(NodeId(999), None);
    assert!(matches!(
        missing_child,
        Err(Forge3dError::InvalidInput { .. })
    ));
}

#[test]
fn reparent_updates_roots_and_children_without_duplicates() {
    let mut graph = SceneGraph::new();
    let a = graph.create_node("a", SceneNodeKind::Group);
    let b = graph.create_node("b", SceneNodeKind::Group);
    let c = graph.create_node("c", SceneNodeKind::Overlay);

    graph.set_parent(c, Some(a)).unwrap();
    assert_eq!(graph.roots(), &[a, b]);
    assert_eq!(graph.node(a).unwrap().children, vec![c]);

    graph.set_parent(c, Some(b)).unwrap();
    assert!(graph.node(a).unwrap().children.is_empty());
    assert_eq!(graph.node(b).unwrap().children, vec![c]);
    assert_eq!(graph.node(c).unwrap().parent, Some(b));

    graph.set_parent(c, Some(b)).unwrap();
    assert_eq!(graph.node(b).unwrap().children, vec![c]);

    graph.set_parent(c, None).unwrap();
    assert_eq!(graph.node(c).unwrap().parent, None);
    assert_eq!(graph.roots(), &[a, b, c]);
}

#[test]
fn invisible_parent_suppresses_descendants() {
    let mut graph = SceneGraph::new();
    let parent = graph.create_node("parent", SceneNodeKind::Group);
    let child = graph.create_node("child", SceneNodeKind::TextMesh);
    let grandchild = graph.create_node("grandchild", SceneNodeKind::Overlay);
    let sibling = graph.create_node("sibling", SceneNodeKind::GroundPlane);

    graph.set_parent(child, Some(parent)).unwrap();
    graph.set_parent(grandchild, Some(child)).unwrap();
    graph.node_mut(parent).unwrap().visible = false;

    let visible = graph.visible_nodes().unwrap();

    assert_eq!(visible, vec![sibling]);
}

#[test]
fn remove_deletes_subtree_child_before_parent() {
    let mut graph = SceneGraph::new();
    let a = graph.create_node("a", SceneNodeKind::Group);
    let b = graph.create_node("b", SceneNodeKind::Group);
    let c = graph.create_node("c", SceneNodeKind::Terrain);
    let d = graph.create_node("d", SceneNodeKind::GroundPlane);
    graph.set_parent(b, Some(a)).unwrap();
    graph.set_parent(c, Some(b)).unwrap();
    graph.set_parent(d, Some(b)).unwrap();

    let removed = graph.remove(b).unwrap();

    assert_eq!(removed, vec![c, d, b]);
    assert_eq!(graph.len(), 1);
    assert!(graph.node(b).is_none());
    assert!(graph.node(c).is_none());
    assert!(graph.node(d).is_none());
    assert!(graph.node(a).unwrap().children.is_empty());

    let root_removed = graph.remove(a).unwrap();
    assert_eq!(root_removed, vec![a]);
    assert!(graph.is_empty());
    assert!(graph.roots().is_empty());

    assert!(matches!(
        graph.remove(NodeId(42)),
        Err(Forge3dError::InvalidInput { .. })
    ));
}
