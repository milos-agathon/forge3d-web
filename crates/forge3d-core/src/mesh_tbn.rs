use crate::error::{Forge3dError, Result};
use glam::Vec3;

fn invalid(field: &str, message: impl Into<String>) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.into(),
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MeshTbnInput<'a> {
    pub positions: &'a [f32],
    pub normals: &'a [f32],
    pub uvs: &'a [f32],
    pub indices: &'a [u32],
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeshTbnResult {
    pub tangents: Vec<f32>,
}

fn vec3_at(data: &[f32], vertex: usize) -> Vec3 {
    Vec3::new(data[vertex * 3], data[vertex * 3 + 1], data[vertex * 3 + 2])
}

fn normalized_or(vector: Vec3, fallback: Vec3) -> Vec3 {
    if vector.length_squared().is_finite() && vector.length_squared() > 1e-12 {
        vector.normalize()
    } else {
        fallback
    }
}

fn perpendicular_axis(normal: Vec3) -> Vec3 {
    let axis = if normal.x.abs() < 0.9 {
        Vec3::X
    } else {
        Vec3::Y
    };
    normalized_or(
        normal.cross(axis).cross(normal).normalize_or_zero(),
        Vec3::X,
    )
}

pub fn generate_mesh_tangents(input: &MeshTbnInput<'_>) -> Result<MeshTbnResult> {
    if input.positions.is_empty() || input.positions.len() % 3 != 0 {
        return Err(invalid(
            "mesh.positions",
            "must contain a nonzero multiple of 3 floats",
        ));
    }
    let vertex_count = input.positions.len() / 3;
    if input.normals.len() != input.positions.len() {
        return Err(invalid(
            "mesh.normals",
            "must contain exactly one normal per position",
        ));
    }
    if input.uvs.len() != vertex_count * 2 {
        return Err(invalid(
            "mesh.uvs",
            "must contain exactly one uv pair per position",
        ));
    }
    if input.indices.is_empty() || input.indices.len() % 3 != 0 {
        return Err(invalid(
            "mesh.indices",
            "must contain a nonzero multiple of 3 indices",
        ));
    }
    for &index in input.indices {
        if index as usize >= vertex_count {
            return Err(invalid(
                "mesh.indices",
                format!("index {index} exceeds vertex count {vertex_count}"),
            ));
        }
    }
    for (field, components) in [
        ("mesh.positions", input.positions),
        ("mesh.normals", input.normals),
        ("mesh.uvs", input.uvs),
    ] {
        if components.iter().any(|component| !component.is_finite()) {
            return Err(invalid(field, "components must be finite"));
        }
    }

    let mut tangent_sums = vec![Vec3::ZERO; vertex_count];
    let mut bitangent_sums = vec![Vec3::ZERO; vertex_count];
    for triangle in input.indices.chunks_exact(3) {
        let (a, b, c) = (
            triangle[0] as usize,
            triangle[1] as usize,
            triangle[2] as usize,
        );
        let p0 = vec3_at(input.positions, a);
        let p1 = vec3_at(input.positions, b);
        let p2 = vec3_at(input.positions, c);
        let uv0 = Vec3::new(input.uvs[a * 2], input.uvs[a * 2 + 1], 0.0);
        let uv1 = Vec3::new(input.uvs[b * 2], input.uvs[b * 2 + 1], 0.0);
        let uv2 = Vec3::new(input.uvs[c * 2], input.uvs[c * 2 + 1], 0.0);
        let edge1 = p1 - p0;
        let edge2 = p2 - p0;
        let duv1 = uv1 - uv0;
        let duv2 = uv2 - uv0;
        let det = duv1.x * duv2.y - duv2.x * duv1.y;
        if !det.is_finite() || det.abs() < 1e-12 {
            continue;
        }
        let area = edge1.cross(edge2).length() * 0.5;
        if !area.is_finite() || area <= 0.0 {
            continue;
        }
        let inv_det = 1.0 / det;
        let tangent = (edge1 * duv2.y - edge2 * duv1.y) * inv_det;
        let bitangent = (edge2 * duv1.x - edge1 * duv2.x) * inv_det;
        for vertex in [a, b, c] {
            tangent_sums[vertex] += tangent * area;
            bitangent_sums[vertex] += bitangent * area;
        }
    }

    let mut tangents = Vec::with_capacity(vertex_count * 4);
    for vertex in 0..vertex_count {
        let normal = normalized_or(vec3_at(input.normals, vertex), Vec3::Y);
        let raw_tangent = tangent_sums[vertex];
        let tangent = if raw_tangent.length_squared() > 1e-12 {
            normalized_or(
                raw_tangent - normal * normal.dot(raw_tangent),
                perpendicular_axis(normal),
            )
        } else {
            perpendicular_axis(normal)
        };
        let bitangent_sum = bitangent_sums[vertex];
        let handedness = normal.cross(tangent).dot(bitangent_sum);
        let w = if handedness.is_finite() && handedness < 0.0 {
            -1.0_f32
        } else {
            1.0
        };
        tangents.extend_from_slice(&[tangent.x, tangent.y, tangent.z, w]);
    }
    Ok(MeshTbnResult { tangents })
}

#[cfg(test)]
mod tests;
