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
            material_slot: "default".to_string(),
        },
        ParsedNode {
            id: 0,
            parent: None,
            visible: true,
            kind: ParsedNodeKind::Group,
            transform: ParsedTransform::default(),
            material_slot: "default".to_string(),
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
            material_slot: "default".to_string(),
        },
        ParsedNode {
            id: 1,
            parent: Some(0),
            visible: true,
            kind: ParsedNodeKind::Group,
            transform: ParsedTransform::default(),
            material_slot: "default".to_string(),
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
        material_slot: "default".to_string(),
    };
    let nodes = vec![node.clone(), node];
    assert!(validate_node_topology(&nodes).is_err());
}

#[test]
fn empty_scene_retains_parsed_lighting_state() {
    let lighting = forge3d_core::lighting::default_state()
        .validated()
        .expect("default lighting is valid");
    let parsed = ParsedScene {
        nodes: Vec::new(),
        passes: Vec::new(),
        lighting: lighting.clone(),
        materials: forge3d_core::materials::default_state(),
        texture_sets: std::collections::BTreeMap::new(),
        ibl: None,
        light_ids: Vec::new(),
        shadows: crate::runtime::shadows::ParsedShadows::default(),
    };
    assert!(parsed.nodes.is_empty());
    assert!(parsed.passes.is_empty());
    assert_eq!(parsed.lighting, lighting);
    assert_eq!(parsed.lighting.lights.len(), 2);
}

#[test]
fn malformed_lighting_snapshot_is_rejected() {
    let value = serde_json::json!({
        "revision": 0,
        "maxLights": 64,
        "exposure": 1.0,
        "debugBounds": false,
        "areaLights": { "mode": "ltc", "sampleCount": 2, "lutSize": 64 },
        "lights": [],
    });
    let error = crate::runtime::lighting::lighting_state_from_json(&value).unwrap_err();
    assert_eq!(error.code(), Forge3DErrorCode::InvalidInput);
}
