//! W12 reference projection/extrusion and conservative clip-space culling.
use glam::{Mat4, Vec2, Vec3, Vec4};
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
#[cfg_attr(feature = "gpu", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct VectorVertex {
    pub position: [f32; 4],
    pub previous: [f32; 4],
    pub next: [f32; 4],
    pub offset: [f32; 4],
    pub color: [f32; 4],
    pub meta: [u32; 4],
    pub atlas: [f32; 4],
    pub options: [f32; 4],
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
#[cfg_attr(feature = "gpu", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct ProjectedVertex {
    pub clip: [f32; 4],
    pub color: [f32; 4],
    pub uv: [f32; 4],
    pub world: [f32; 4],
    pub meta: [u32; 4],
}
fn direction(a: Vec4, b: Vec4, viewport: Vec2) -> Vec2 {
    let d = (b.truncate().truncate() / b.w.max(1e-6) - a.truncate().truncate() / a.w.max(1e-6))
        * viewport;
    if d.length_squared() < 1e-10 {
        Vec2::X
    } else {
        d.normalize()
    }
}
// Keep the scalar binary32 operation order used by the shader's dynamic
// representation barriers. In particular, preserve residuals after large translations;
// rounding matrix products onto a coarser grid would lose those residuals.
fn projection_transform(vp: Mat4, point: Vec4) -> Vec4 {
    let columns = vp.to_cols_array_2d();
    let point = point.to_array();
    Vec4::from_array(std::array::from_fn(|row| {
        let products: [f32; 4] = std::array::from_fn(|column| columns[column][row] * point[column]);
        ((products[0] + products[1]) + products[2]) + products[3]
    }))
}
pub fn project(vertex: &VectorVertex, vp: Mat4, viewport: Vec2) -> ProjectedVertex {
    let world = Vec3::new(
        vertex.position[0],
        vertex.position[1] + vertex.position[3],
        vertex.position[2],
    );
    let mut clip = projection_transform(vp, world.extend(1.));
    let offset = Vec2::new(vertex.offset[0], vertex.offset[1]);
    let expansion = vertex.previous[3] as u32;
    let screen_offset = if expansion == 1 {
        offset
    } else if expansion >= 2 {
        let a = projection_transform(vp, Vec3::from_slice(&vertex.previous[..3]).extend(1.));
        let b = projection_transform(vp, Vec3::from_slice(&vertex.next[..3]).extend(1.));
        let d = direction(a, b, viewport);
        let normal = Vec2::new(-d.y, d.x);
        if expansion == 3 {
            let d0 = direction(a, clip, viewport);
            let d1 = direction(clip, b, viewport);
            let n0 = Vec2::new(-d0.y, d0.x);
            let n1 = Vec2::new(-d1.y, d1.x);
            let sum = n0 + n1;
            let miter = if sum.length_squared() > 1e-10 {
                sum.normalize()
            } else {
                n1
            };
            let factor = 1. / miter.dot(n1).abs().max(1e-4);
            if factor <= vertex.next[3] {
                miter * offset.x * factor
            } else {
                n1 * offset.x
            }
        } else {
            normal * offset.x + d * offset.y
        }
    } else {
        Vec2::ZERO
    };
    clip.x += screen_offset.x * 2. / viewport.x * clip.w;
    clip.y += screen_offset.y * 2. / viewport.y * clip.w;
    clip.z -= (vertex.options[0] * 1e-5) * clip.w;
    let biased_clip = clip;
    // Canonical clip storage shares the shader's retained subpixel precision.
    // 19 fractional bits are shared with WGSL, well below a raster subpixel.
    clip = Vec4::from_array(
        clip.to_array()
            .map(|v| (v * 524288.).round_ties_even() / 524288.),
    );
    // Direct depth rounding towards the camera: z down and w up ensure that
    // canonicalization never reverses the bias. This is an absolute clip grid,
    // so its NDC error shrinks with distance, retaining far depth precision.
    // Keep the existing storage outside the depth range for clip culling.
    if vertex.options[0] > 0.
        && biased_clip.w > 0.
        && biased_clip.z >= 0.
        && biased_clip.z <= biased_clip.w
    {
        clip.z = (biased_clip.z * 524288.).floor() / 524288.;
        clip.w = (biased_clip.w * 524288.).ceil() / 524288.;
    }
    let uv = Vec2::new(vertex.offset[2], vertex.offset[3]);
    let atlas_origin = Vec2::new(vertex.atlas[0], vertex.atlas[1]);
    let atlas_size = Vec2::new(vertex.atlas[2], vertex.atlas[3]);
    let half_texel = Vec2::new(vertex.options[2], vertex.options[3]);
    let atlas = (atlas_origin + (uv * Vec2::new(0.5, -0.5) + Vec2::splat(0.5)) * atlas_size).clamp(
        atlas_origin + half_texel,
        atlas_origin + atlas_size - half_texel,
    );
    let mut color = vertex.color;
    if expansion == 1
        && offset.abs().max_element() * 2. / uv.abs().max_element().max(1.) < vertex.options[1]
    {
        color[3] = 0.;
    }
    ProjectedVertex {
        clip: clip.to_array(),
        color,
        uv: [uv.x, uv.y, atlas.x, atlas.y],
        world: world.extend(1.).to_array(),
        meta: vertex.meta,
    }
}
pub fn triangle_visible(vertices: &[ProjectedVertex]) -> bool {
    !(0..7).any(|plane| {
        vertices.iter().all(|v| {
            let [x, y, z, w] = v.clip;
            match plane {
                0 => x < -w,
                1 => x > w,
                2 => y < -w,
                3 => y > w,
                4 => z < 0.,
                5 => z > w,
                _ => w <= 0.,
            }
        })
    }) && vertices.iter().any(|v| v.color[3] > 0.)
}
pub fn project_and_cull(
    vertices: &[VectorVertex],
    vp: Mat4,
    viewport: Vec2,
) -> Vec<ProjectedVertex> {
    let mut output = Vec::with_capacity(vertices.len());
    for triangle in vertices.chunks_exact(3) {
        let projected: Vec<_> = triangle.iter().map(|v| project(v, vp, viewport)).collect();
        if triangle_visible(&projected) {
            output.extend(projected);
        }
    }
    output
}
/// Native McGuire/Mara weighted transparency contract.
pub fn oit_weight(depth: f32, alpha: f32) -> f32 {
    alpha * (0.03 / (1e-5 + (depth / 200.).powi(4))).clamp(1e-2, 3e3)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gpu_storage_layouts() {
        assert_eq!(std::mem::size_of::<VectorVertex>(), 128);
        assert_eq!(std::mem::offset_of!(VectorVertex, meta), 80);
        assert_eq!(std::mem::size_of::<ProjectedVertex>(), 80);
        assert_eq!(std::mem::offset_of!(ProjectedVertex, meta), 64);
    }
    #[test]
    fn extrusion_and_billboard_have_pixel_units() {
        let v = VectorVertex {
            position: [0., 0., 0.5, 0.1],
            previous: [0., 0., 0., 1.],
            offset: [10., 20., 1., 1.],
            color: [1.; 4],
            ..Default::default()
        };
        let p = project(&v, Mat4::IDENTITY, Vec2::new(200., 400.));
        assert!((p.clip[0] - 0.1).abs() < 1e-6);
        assert!((p.clip[1] - 0.2).abs() < 1e-6);
        assert_eq!(p.world[1], 0.1);
    }
    #[test]
    fn conservative_culling_keeps_intersecting_triangles() {
        let p = |x| ProjectedVertex {
            clip: [x, 0., 0.5, 1.],
            color: [1.; 4],
            ..Default::default()
        };
        assert!(triangle_visible(&[p(-2.), p(0.), p(2.)]));
        assert!(!triangle_visible(&[p(2.), p(3.), p(4.)]));
    }
    #[test]
    fn near_coplanar_drapes_never_round_behind_the_surface() {
        for height in [0.01, 0.0101, 0.0102, 0.011] {
            let vp = Mat4::perspective_rh(50_f32.to_radians(), 4. / 3., 0.001, 0.03)
                * Mat4::look_at_rh(Vec3::new(0., height, 0.), Vec3::ZERO, -Vec3::Z);
            let surface = vp * Vec4::new(0.002, 0., 0.002, 1.);
            let surface_depth = surface.z / surface.w;
            for bias in [0.01, 0.1, 10.] {
                let vertex = VectorVertex {
                    position: [0.002, 0., 0.002, 0.],
                    color: [1.; 4],
                    options: [bias, 0., 0., 0.],
                    ..Default::default()
                };
                let projected = project(&vertex, vp, Vec2::new(128., 96.));
                let depth = projected.clip[2] / projected.clip[3];
                assert!(
                    depth <= surface_depth,
                    "height={height}, bias={bias}, depth={depth}, surface={surface_depth}"
                );
                let storage_bound = 2. / (524288. * surface.w) + 1e-7;
                assert!(surface_depth - depth < bias * 1e-5 + storage_bound);
                for (axis, pixels) in [(0, 128.), (1, 96.)] {
                    let displacement = (projected.clip[axis] / projected.clip[3]
                        - surface[axis] / surface.w)
                        .abs()
                        * pixels
                        * 0.5;
                    assert!(displacement < 1. / 16.);
                }
            }
        }
    }
    #[test]
    fn projection_preserves_large_coordinate_cancellation() {
        let vp = Mat4::from_translation(Vec3::new(-1048576., 0., 0.));
        let vertex = VectorVertex {
            position: [1048576.125, 0., 0.5, 0.],
            color: [1.; 4],
            ..Default::default()
        };
        let projected = project(&vertex, vp, Vec2::new(128., 96.));
        assert_eq!(projected.clip[0], 0.125);
        assert_eq!(projected.clip[3], 1.);
    }
    #[test]
    fn fused_matrix_control_crosses_the_directed_depth_storage_boundary() {
        let vp = Mat4::perspective_rh(50_f32.to_radians(), 4. / 3., 0.1, 30.)
            * Mat4::look_at_rh(Vec3::new(0., 8., 0.), Vec3::ZERO, -Vec3::Z);
        let height = 0.6692236065864563_f32;
        let vertex = VectorVertex {
            position: [0., height, 0., 0.],
            color: [1.; 4],
            options: [0.01, 0., 0., 0.],
            ..Default::default()
        };
        let split = projection_transform(vp, Vec4::new(0., height, 0., 1.));
        let fused_z = vp.y_axis.z.mul_add(height, vp.w_axis.z);
        assert_eq!(split.z.to_bits().abs_diff(fused_z.to_bits()), 1);
        let bias = (vertex.options[0] * 1e-5) * split.w;
        let fused_storage = ((fused_z - bias) * 524288.).floor() / 524288.;
        let projected = project(&vertex, vp, Vec2::new(128., 96.));
        assert_ne!(projected.clip[2].to_bits(), fused_storage.to_bits());
        assert_eq!(projected.clip[2] - fused_storage, 1. / 524288.);
    }
    #[test]
    fn native_weight_is_alpha_scaled() {
        assert_eq!(oit_weight(0., 0.5), 1500.);
        assert!((oit_weight(200., 0.5) - 0.01499985).abs() < 1e-6);
    }
}
