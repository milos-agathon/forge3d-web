use glam::{Mat4, Vec3};

#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable, PartialEq)]
pub(crate) struct LitVertex {
    pub position: [f32; 3],
    pub color: [f32; 4],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
    pub material_index: u32,
    pub tangent: [f32; 4],
    /// Capture AOV object ID; `build_geometry` assigns one per node.
    pub object_id: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable, PartialEq)]
pub(super) struct OverlayVertex {
    pub position: [f32; 3],
    pub color: [f32; 4],
}

fn world_normal(world: Mat4, local_normal: Vec3) -> [f32; 3] {
    let transformed = world.transform_vector3(local_normal);
    if transformed.length_squared().is_finite() && transformed.length_squared() > 1e-12 {
        transformed.normalize().into()
    } else {
        local_normal.into()
    }
}

fn world_tangent(
    world: Mat4,
    normal: Vec3,
    local_tangent: Vec3,
    local_bitangent: Vec3,
) -> [f32; 4] {
    let tangent_raw = world.transform_vector3(local_tangent);
    let tangent =
        if tangent_raw.length_squared().is_finite() && tangent_raw.length_squared() > 1e-12 {
            tangent_raw.normalize()
        } else {
            local_tangent
        };
    let bitangent_world = world.transform_vector3(local_bitangent);
    let handedness = normal.cross(tangent).dot(bitangent_world);
    let w = if handedness.is_finite() && handedness < 0.0 {
        -1.0
    } else {
        1.0
    };
    [tangent.x, tangent.y, tangent.z, w]
}

impl LitVertex {
    fn transformed(
        world: Mat4,
        point: [f32; 3],
        color: [f32; 4],
        normal: [f32; 3],
        uv: [f32; 2],
        material_index: u32,
        tangent: [f32; 4],
    ) -> Self {
        let position = world.transform_point3(Vec3::from(point));
        Self {
            position: position.into(),
            color,
            normal,
            uv,
            material_index,
            tangent,
            object_id: 0,
        }
    }
}

impl OverlayVertex {
    fn transformed(world: Mat4, point: [f32; 3], color: [f32; 4]) -> Self {
        let position = world.transform_point3(Vec3::from(point));
        Self {
            position: position.into(),
            color,
        }
    }
}

fn lit_quad_vertices(
    world: Mat4,
    corners: [[f32; 3]; 4],
    color: [f32; 4],
    local_normal: Vec3,
    local_tangent: Vec3,
    local_bitangent: Vec3,
    material_index: u32,
) -> [LitVertex; 6] {
    const UV: [[f32; 2]; 4] = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    const ORDER: [usize; 6] = [0, 1, 2, 0, 2, 3];
    let normal = Vec3::from(world_normal(world, local_normal));
    let tangent = world_tangent(world, normal, local_tangent, local_bitangent);
    ORDER.map(|index| {
        LitVertex::transformed(
            world,
            corners[index],
            color,
            normal.into(),
            UV[index],
            material_index,
            tangent,
        )
    })
}

pub(super) fn ground_plane_vertices(
    world: Mat4,
    size: [f32; 2],
    height: f32,
    color: [f32; 4],
    material_index: u32,
) -> [LitVertex; 6] {
    let half_width = size[0] * 0.5;
    let half_depth = size[1] * 0.5;
    lit_quad_vertices(
        world,
        [
            [-half_width, height, -half_depth],
            [half_width, height, -half_depth],
            [half_width, height, half_depth],
            [-half_width, height, half_depth],
        ],
        color,
        Vec3::Y,
        Vec3::X,
        Vec3::Z,
        material_index,
    )
}

pub(super) fn text_mesh_vertices(
    world: Mat4,
    text: &str,
    size: f32,
    color: [f32; 4],
    material_index: u32,
) -> Vec<LitVertex> {
    let mut vertices = Vec::new();
    for (index, _glyph) in text.chars().enumerate() {
        let x0 = index as f32 * size;
        let x1 = x0 + size;
        vertices.extend_from_slice(&lit_quad_vertices(
            world,
            [
                [x0, 0.0, 0.0],
                [x1, 0.0, 0.0],
                [x1, size, 0.0],
                [x0, size, 0.0],
            ],
            color,
            Vec3::Z,
            Vec3::X,
            Vec3::Y,
            material_index,
        ));
    }
    vertices
}

pub(super) fn overlay_vertices(
    bounds: [f32; 4],
    color: [f32; 4],
    width: u32,
    height: u32,
) -> [OverlayVertex; 6] {
    let width = width.max(1) as f32;
    let height = height.max(1) as f32;
    let x0 = bounds[0] / width * 2.0 - 1.0;
    let x1 = (bounds[0] + bounds[2]) / width * 2.0 - 1.0;
    let y_top = 1.0 - bounds[1] / height * 2.0;
    let y_bottom = 1.0 - (bounds[1] + bounds[3]) / height * 2.0;
    let corners = [
        [x0, y_bottom, 0.0],
        [x1, y_bottom, 0.0],
        [x1, y_top, 0.0],
        [x0, y_top, 0.0],
    ];
    [0, 1, 2, 3, 0, 2]
        .map(|index| OverlayVertex::transformed(Mat4::IDENTITY, corners[index], color))
}

pub(super) fn normalize_quat(rotation: [f32; 4]) -> glam::Quat {
    let quat = glam::Quat::from_array(rotation);
    let length_squared = quat.length_squared();
    if length_squared.is_finite() && length_squared > 1e-12 {
        quat.normalize()
    } else {
        glam::Quat::IDENTITY
    }
}

#[cfg(test)]
pub(super) fn transform_matrix(position: [f32; 3], rotation: [f32; 4], scale: [f32; 3]) -> Mat4 {
    Mat4::from_scale_rotation_translation(
        Vec3::from(scale),
        normalize_quat(rotation),
        Vec3::from(position),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHITE: [f32; 4] = [1.0, 1.0, 1.0, 1.0];

    #[test]
    fn lit_vertex_is_72_bytes_and_overlay_vertex_is_28() {
        assert_eq!(std::mem::size_of::<LitVertex>(), 72);
        assert_eq!(std::mem::offset_of!(LitVertex, object_id), 68);
        assert_eq!(std::mem::offset_of!(LitVertex, material_index), 48);
        assert_eq!(std::mem::offset_of!(LitVertex, tangent), 52);
        assert_eq!(std::mem::size_of::<OverlayVertex>(), 28);
    }

    #[test]
    fn ground_plane_emits_six_vertices_with_transform() {
        let world = transform_matrix([1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0]);
        let vertices = ground_plane_vertices(world, [2.0, 4.0], 0.5, WHITE, 0);
        assert_eq!(vertices.len(), 6);
        assert_eq!(vertices[0].position, [0.0, 0.5, -2.0]);
        assert_eq!(vertices[2].position, [2.0, 0.5, 2.0]);
        assert_eq!(vertices[5].position, [0.0, 0.5, 2.0]);
        for vertex in &vertices {
            assert_eq!(vertex.material_index, 0);
        }
    }

    #[test]
    fn ground_plane_emits_unit_normal_and_quad_uvs() {
        let world = transform_matrix([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], [3.0, 5.0, 2.0]);
        let vertices = ground_plane_vertices(world, [2.0, 4.0], 0.0, WHITE, 7);
        for vertex in &vertices {
            assert_eq!(vertex.normal, [0.0, 1.0, 0.0]);
            assert_eq!(vertex.material_index, 7);
            assert_eq!(vertex.tangent, [1.0, 0.0, 0.0, -1.0]);
        }
        assert_eq!(vertices[0].uv, [0.0, 0.0]);
        assert_eq!(vertices[1].uv, [1.0, 0.0]);
        assert_eq!(vertices[2].uv, [1.0, 1.0]);
        assert_eq!(vertices[3].uv, [0.0, 0.0]);
        assert_eq!(vertices[4].uv, [1.0, 1.0]);
        assert_eq!(vertices[5].uv, [0.0, 1.0]);
    }

    #[test]
    fn rotated_ground_plane_transforms_normal() {
        let quarter_turn_z = normalize_quat([
            0.0,
            0.0,
            (std::f32::consts::FRAC_PI_4).sin(),
            (std::f32::consts::FRAC_PI_4).cos(),
        ]);
        let world = Mat4::from_quat(quarter_turn_z);
        let vertices = ground_plane_vertices(world, [2.0, 4.0], 0.0, WHITE, 0);
        let normal = Vec3::from(vertices[0].normal);
        let expected = quarter_turn_z * Vec3::Y;
        assert!((normal - expected).length() < 1e-5);
    }

    #[test]
    fn text_mesh_advances_one_quad_per_scalar() {
        let vertices = text_mesh_vertices(Mat4::IDENTITY, "ab\u{1f600}", 1.0, WHITE, 4);
        assert_eq!(vertices.len(), 18);
        assert_eq!(vertices[0].position, [0.0, 0.0, 0.0]);
        assert_eq!(vertices[6].position, [1.0, 0.0, 0.0]);
        assert_eq!(vertices[12].position, [2.0, 0.0, 0.0]);
        for vertex in &vertices {
            assert_eq!(vertex.normal, [0.0, 0.0, 1.0]);
            assert_eq!(vertex.material_index, 4);
            assert_eq!(vertex.tangent, [1.0, 0.0, 0.0, 1.0]);
        }
        assert_eq!(vertices[0].uv, [0.0, 0.0]);
        assert_eq!(vertices[2].uv, [1.0, 1.0]);
        assert_eq!(vertices[5].uv, [0.0, 1.0]);
    }

    #[test]
    fn overlay_vertices_convert_pixels_to_ndc() {
        let vertices = overlay_vertices([0.0, 0.0, 100.0, 50.0], WHITE, 200, 100);
        assert_eq!(vertices[0].position, [-1.0, 0.0, 0.0]);
        assert_eq!(vertices[2].position, [0.0, 1.0, 0.0]);
        assert_eq!(vertices[3].position, [-1.0, 1.0, 0.0]);
    }

    #[test]
    fn transform_matrix_normalizes_rotation() {
        let matrix = transform_matrix([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 2.0], [2.0, 2.0, 2.0]);
        let vertex = matrix.transform_point3(Vec3::new(1.0, 0.0, 0.0));
        assert!((vertex - Vec3::new(2.0, 0.0, 0.0)).length() < 1e-5);
    }
}
