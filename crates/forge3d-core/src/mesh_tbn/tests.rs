use super::{generate_mesh_tangents, MeshTbnInput};
use crate::error::Forge3dError;

fn quad_input(uvs: &[f32]) -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<u32>) {
    let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
    let normals = vec![0.0f32, 0.0, 1.0].repeat(4);
    let indices = vec![0u32, 1, 2, 0, 2, 3];
    (positions, normals, uvs.to_vec(), indices)
}

fn tangents_of(positions: &[f32], normals: &[f32], uvs: &[f32], indices: &[u32]) -> Vec<f32> {
    generate_mesh_tangents(&MeshTbnInput {
        positions,
        normals,
        uvs,
        indices,
    })
    .expect("tangent generation")
    .tangents
}

#[test]
fn flat_quad_produces_unit_x_tangent() {
    let (positions, normals, uvs, indices) = quad_input(&[0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]);
    let tangents = tangents_of(&positions, &normals, &uvs, &indices);
    assert_eq!(tangents.len(), 16);
    for vertex in 0..4 {
        let tangent = &tangents[vertex * 4..vertex * 4 + 4];
        assert!((tangent[0] - 1.0).abs() < 1e-6, "tangent.x {}", tangent[0]);
        assert!(tangent[1].abs() < 1e-6);
        assert!(tangent[2].abs() < 1e-6);
        assert_eq!(tangent[3], 1.0);
    }
}

#[test]
fn mirrored_uv_flips_handedness() {
    let (positions, normals, uvs, indices) = quad_input(&[1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
    let tangents = tangents_of(&positions, &normals, &uvs, &indices);
    for vertex in 0..4 {
        assert_eq!(tangents[vertex * 4 + 3], -1.0);
    }
}

#[test]
fn tangents_are_orthonormal_to_normals() {
    // Tilted triangle with non-axis-aligned normal.
    let positions = [0.0, 0.0, 0.0, 2.0, 0.5, 0.0, 0.25, 1.5, 0.75];
    let normals = [0.0f32, 0.4472136, 0.8944272].repeat(3);
    let uvs = [0.0, 0.0, 1.0, 0.25, 0.5, 1.0];
    let indices = [0u32, 1, 2];
    let tangents = tangents_of(&positions, &normals, &uvs, &indices);
    for vertex in 0..3 {
        let t = &tangents[vertex * 4..vertex * 4 + 4];
        let n = &normals[vertex * 3..vertex * 3 + 3];
        let length = (t[0] * t[0] + t[1] * t[1] + t[2] * t[2]).sqrt();
        let dot = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
        assert!((length - 1.0).abs() < 1e-5, "tangent length {length}");
        assert!(dot.abs() < 1e-5, "tangent.normal dot {dot}");
        assert!(t[3] == 1.0 || t[3] == -1.0);
    }
}

#[test]
fn degenerate_uvs_fall_back_to_finite_perpendicular() {
    let (positions, normals, _uvs, indices) = quad_input(&[0.0; 8]);
    let tangents = tangents_of(&positions, &normals, &[0.0; 8], &indices);
    for vertex in 0..4 {
        let t = &tangents[vertex * 4..vertex * 4 + 4];
        for component in &t[..3] {
            assert!(component.is_finite());
        }
        let length = (t[0] * t[0] + t[1] * t[1] + t[2] * t[2]).sqrt();
        assert!((length - 1.0).abs() < 1e-5);
        // Normals are +Z so the fallback must be perpendicular to +Z.
        assert!(t[2].abs() < 1e-5);
    }
}

#[test]
fn shared_vertex_weights_tangents_by_geometric_area() {
    // Triangle A (area 0.5) contributes tangent +X; triangle B (area 2.0)
    // contributes tangent +Y. The shared vertex 0 must lean +Y:
    // sum = (1,0,0)*0.5 + (0,2,0)*2 = (0.5, 4, 0).
    let positions = vec![
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0, 0.0,
    ];
    let normals = vec![0.0f32, 0.0, 1.0].repeat(5);
    let uvs = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, -1.0, 1.0, 0.0];
    let indices = vec![0u32, 1, 2, 0, 3, 4];
    let tangents = tangents_of(&positions, &normals, &uvs, &indices);
    let t = &tangents[0..4];
    let expected_len = (0.5f32 * 0.5 + 4.0 * 4.0).sqrt();
    assert!(
        (t[0] - 0.5 / expected_len).abs() < 1e-5,
        "tangent.x {}",
        t[0]
    );
    assert!(
        (t[1] - 4.0 / expected_len).abs() < 1e-5,
        "tangent.y {}",
        t[1]
    );
    assert!(t[2].abs() < 1e-5);
    // Vertices unique to triangle B keep the pure +Y tangent.
    let t3 = &tangents[3 * 4..3 * 4 + 4];
    assert!(t3[0].abs() < 1e-5);
    assert!((t3[1] - 1.0).abs() < 1e-5);
}

#[test]
fn validation_rejects_nonfinite_components() {
    let (positions, normals, uvs, indices) = quad_input(&[0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]);
    let reject = |positions: &[f32], normals: &[f32], uvs: &[f32]| {
        let error = generate_mesh_tangents(&MeshTbnInput {
            positions,
            normals,
            uvs,
            indices: &indices,
        })
        .expect_err("must reject");
        match error {
            Forge3dError::InvalidInput { .. } => {}
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    };
    let mut bad_positions = positions.clone();
    bad_positions[0] = f32::NAN;
    reject(&bad_positions, &normals, &uvs);
    let mut bad_normals = normals.clone();
    bad_normals[3] = f32::INFINITY;
    reject(&positions, &bad_normals, &uvs);
    let mut bad_uvs = uvs.clone();
    bad_uvs[2] = f32::NEG_INFINITY;
    reject(&positions, &normals, &bad_uvs);
}

#[test]
fn validation_rejects_malformed_inputs() {
    let (positions, normals, uvs, indices) = quad_input(&[0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]);
    let reject = |positions: &[f32], normals: &[f32], uvs: &[f32], indices: &[u32]| {
        let error = generate_mesh_tangents(&MeshTbnInput {
            positions,
            normals,
            uvs,
            indices,
        })
        .expect_err("must reject");
        match error {
            Forge3dError::InvalidInput { .. } => {}
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    };
    reject(&positions[..5], &normals, &uvs, &indices);
    reject(&positions, &normals[..6], &uvs, &indices);
    reject(&positions, &normals, &uvs[..6], &indices);
    reject(&positions, &normals, &uvs, &indices[..4]);
    reject(&positions, &normals, &uvs, &[0, 1, 9]);
    reject(&[], &[], &[], &[]);
}
