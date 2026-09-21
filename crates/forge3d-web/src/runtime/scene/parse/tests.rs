use super::*;

#[test]
fn topology_requires_parent_before_child() {
    let nodes = vec![
        ParsedNode {
            id: 1,
            parent: Some(0),
            visible: true,
            kind: ParsedNodeKind::Group,
            transform: ParsedTransform::default(),
        },
        ParsedNode {
            id: 0,
            parent: None,
            visible: true,
            kind: ParsedNodeKind::Group,
            transform: ParsedTransform::default(),
        },
    ];
    let error = validate_node_topology(&nodes).unwrap_err();
    assert_eq!(error.code(), Forge3DErrorCode::InvalidInput);
}

#[test]
fn topology_accepts_parent_first_order() {
    let nodes = vec![
        ParsedNode {
            id: 0,
            parent: None,
            visible: true,
            kind: ParsedNodeKind::Group,
            transform: ParsedTransform::default(),
        },
        ParsedNode {
            id: 1,
            parent: Some(0),
            visible: true,
            kind: ParsedNodeKind::Group,
            transform: ParsedTransform::default(),
        },
    ];
    assert!(validate_node_topology(&nodes).is_ok());
}

#[test]
fn topology_rejects_duplicate_ids() {
    let node = ParsedNode {
        id: 0,
        parent: None,
        visible: true,
        kind: ParsedNodeKind::Group,
        transform: ParsedTransform::default(),
    };
    let nodes = vec![node.clone(), node];
    assert!(validate_node_topology(&nodes).is_err());
}
