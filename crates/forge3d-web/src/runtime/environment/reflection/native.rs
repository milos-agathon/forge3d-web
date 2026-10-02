use glam::{Mat4, Vec3};

pub(super) struct Camera {
    pub sampling_vp: Mat4,
    pub draw_vp: Mat4,
    pub position: Vec3,
    pub forward: Vec3,
}

// Recover the actual orthogonal up axis from an unjittered camera VP. Capture
// jitter belongs to the recovered projection, not to the mirrored view.
pub(super) fn camera_up(unjittered_vp: Mat4) -> Vec3 {
    Vec3::new(
        unjittered_vp.x_axis.y,
        unjittered_vp.y_axis.y,
        unjittered_vp.z_axis.y,
    )
    .normalize()
}

// bf8db932:water_reflection/uniforms.rs multiplies arrays as rows after
// obtaining glam column arrays. Preserve this native screen-path convention:
// rasterization uploads P * mirrored_view, while sampling uploads the array
// product of P and mirrored_view (the reverse order in column-matrix notation).
fn native_array_product(a: [[f32; 4]; 4], b: [[f32; 4]; 4]) -> [[f32; 4]; 4] {
    let mut result = [[0.; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            for k in 0..4 {
                result[i][j] += a[i][k] * b[k][j];
            }
        }
    }
    result
}

pub(super) fn screen_camera(vp: Mat4, eye: Vec3, target: Vec3, up: Vec3, height: f32) -> Camera {
    let view = Mat4::look_at_rh(eye, target, up);
    let projection = vp * view.inverse();
    let reflected_columns = native_array_product(
        view.to_cols_array_2d(),
        [
            [1., 0., 0., 0.],
            [0., 1., 0., 0.],
            [0., 0., -1., 2. * height],
            [0., 0., 0., 1.],
        ],
    );
    let mirrored_view = Mat4::from_cols_array_2d(&reflected_columns);
    let sampling_vp = Mat4::from_cols_array_2d(&native_array_product(
        projection.to_cols_array_2d(),
        reflected_columns,
    ));
    let draw_vp = projection * mirrored_view;
    // Match the native shader's -transpose(rotation) * translation eye
    // extraction, including its reflection-array convention at nonzero height.
    let translation = mirrored_view.w_axis.truncate();
    let position = -Vec3::new(
        mirrored_view.x_axis.truncate().dot(translation),
        mirrored_view.y_axis.truncate().dot(translation),
        mirrored_view.z_axis.truncate().dot(translation),
    );
    let forward = -Vec3::new(
        mirrored_view.x_axis.z,
        mirrored_view.y_axis.z,
        mirrored_view.z_axis.z,
    )
    .normalize();
    Camera {
        sampling_vp,
        draw_vp,
        position,
        forward,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn max_abs(a: Mat4, b: Mat4) -> f32 {
        a.to_cols_array()
            .iter()
            .zip(b.to_cols_array())
            .map(|(x, y)| (x - y).abs())
            .fold(0., f32::max)
    }
    #[test]
    fn native_screen_uses_distinct_noncommuting_raster_and_sampling_products() {
        let eye = Vec3::new(2., 3., 4.);
        let target = Vec3::new(-0.5, 0.25, 0.);
        let up = Vec3::new(0.2, 1., 0.15);
        let view = Mat4::look_at_rh(eye, target, up);
        let projection = Mat4::perspective_rh(0.9, 1.6, 0.1, 6000.);
        let reflect = Mat4::from_scale(Vec3::new(1., 1., -1.));
        let camera = screen_camera(projection * view, eye, target, up, 0.);
        // Direct column-matrix interpretation of bf8db932's array products.
        assert!(max_abs(camera.sampling_vp, reflect * view * projection) < 1e-5);
        assert!(max_abs(camera.draw_vp, projection * reflect * view) < 1e-5);
        assert!(camera.position.distance(eye) < 1e-5);
        // Negative control: conventional world-plane reflection cannot pass.
        assert!(max_abs(camera.sampling_vp, projection * view * reflect) > 0.1);
    }
    #[test]
    fn native_array_fixture_preserves_nonzero_plane_height() {
        // bf8db932 native mul_mat4 output for a noncommuting column-array
        // fixture and the native reflect literal at plane_height=1.5.
        let a = [
            [1., 2., 3., 4.],
            [5., 6., 7., 8.],
            [9., 10., 11., 12.],
            [13., 14., 15., 16.],
        ];
        let reflect = [
            [1., 0., 0., 0.],
            [0., 1., 0., 0.],
            [0., 0., -1., 3.],
            [0., 0., 0., 1.],
        ];
        assert_eq!(
            native_array_product(a, reflect),
            [
                [1., 2., -3., 13.],
                [5., 6., -7., 29.],
                [9., 10., -11., 45.],
                [13., 14., -15., 61.]
            ]
        );
    }
    #[test]
    fn capture_up_recovers_a_rolled_view_from_unjittered_projection() {
        let eye = Vec3::new(2., 3., 4.);
        let target = Vec3::ZERO;
        let view = Mat4::look_at_rh(eye, target, Vec3::new(0.4, 1., 0.2));
        let projection = Mat4::perspective_rh(0.9, 1.6, 0.1, 6000.);
        let recovered = Mat4::look_at_rh(eye, target, camera_up(projection * view));
        assert!(max_abs(view, recovered) < 1e-6);
    }
}
