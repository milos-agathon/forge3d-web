use glam::{Mat4, Vec3};

#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable, PartialEq)]
pub(super) struct ColorVertex {
    pub position: [f32; 3],
    pub color: [f32; 4],
}

impl ColorVertex {
    fn transformed(world: Mat4, point: [f32; 3], color: [f32; 4]) -> Self {
        let position = world.transform_point3(Vec3::from(point));
        Self {
            position: position.into(),
            color,
        }
    }
}

fn quad_vertices(world: Mat4, corners: [[f32; 3]; 4], color: [f32; 4]) -> [ColorVertex; 6] {
    [0, 1, 2, 0, 2, 3].map(|index| ColorVertex::transformed(world, corners[index], color))
}

pub(super) fn ground_plane_vertices(
    world: Mat4,
    size: [f32; 2],
    height: f32,
    color: [f32; 4],
) -> [ColorVertex; 6] {
    let half_width = size[0] * 0.5;
    let half_depth = size[1] * 0.5;
    quad_vertices(
        world,
        [
            [-half_width, height, -half_depth],
            [half_width, height, -half_depth],
            [half_width, height, half_depth],
            [-half_width, height, half_depth],
        ],
        color,
    )
}

pub(super) fn text_mesh_vertices(
    world: Mat4,
    text: &str,
    size: f32,
    color: [f32; 4],
) -> Vec<ColorVertex> {
    let mut vertices = Vec::new();
    for (index, _glyph) in text.chars().enumerate() {
        let x0 = index as f32 * size;
        let x1 = x0 + size;
        vertices.extend_from_slice(&quad_vertices(
            world,
            [
                [x0, 0.0, 0.0],
                [x1, 0.0, 0.0],
                [x1, size, 0.0],
                [x0, size, 0.0],
            ],
            color,
        ));
    }
    vertices
}

pub(super) fn overlay_vertices(
    bounds: [f32; 4],
    color: [f32; 4],
    width: u32,
    height: u32,
) -> [ColorVertex; 6] {
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
    [0, 1, 2, 3, 0, 2].map(|index| ColorVertex::transformed(Mat4::IDENTITY, corners[index], color))
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
    fn ground_plane_emits_six_vertices_with_transform() {
        let world = transform_matrix([1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0]);
        let vertices = ground_plane_vertices(world, [2.0, 4.0], 0.5, WHITE);
        assert_eq!(vertices.len(), 6);
        assert_eq!(vertices[0].position, [0.0, 0.5, -2.0]);
        assert_eq!(vertices[2].position, [2.0, 0.5, 2.0]);
        assert_eq!(vertices[5].position, [0.0, 0.5, 2.0]);
    }

    #[test]
    fn text_mesh_advances_one_quad_per_scalar() {
        let vertices = text_mesh_vertices(Mat4::IDENTITY, "ab\u{1f600}", 1.0, WHITE);
        assert_eq!(vertices.len(), 18);
        assert_eq!(vertices[0].position, [0.0, 0.0, 0.0]);
        assert_eq!(vertices[6].position, [1.0, 0.0, 0.0]);
        assert_eq!(vertices[12].position, [2.0, 0.0, 0.0]);
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
