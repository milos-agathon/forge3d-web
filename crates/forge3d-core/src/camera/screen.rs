//! World/screen conversion and picking rays.
//!
//! Screen coordinates are pixels with the origin at the top-left corner and
//! +Y down; screen depth is WebGPU NDC depth (`0` = near plane, `1` = far
//! plane). This matches the native `picking::unproject_cursor` convention.

use glam::{Mat4, Vec3, Vec4};

use super::projection::invalid;
use crate::error::Result;

/// A world-space ray (`direction` is unit length).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ray {
    pub origin: [f32; 3],
    pub direction: [f32; 3],
}

impl Ray {
    pub fn point_at(&self, t: f32) -> [f32; 3] {
        [
            self.origin[0] + self.direction[0] * t,
            self.origin[1] + self.direction[1] * t,
            self.origin[2] + self.direction[2] * t,
        ]
    }
}

/// Projected screen point: pixel `x`/`y` and NDC `depth`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenPoint {
    pub x: f32,
    pub y: f32,
    pub depth: f32,
}

/// Projects a world point; returns `None` when it lies behind the camera
/// (non-positive clip `w`).
pub fn world_to_screen(
    view_projection: Mat4,
    point: [f32; 3],
    width: f32,
    height: f32,
) -> Result<Option<ScreenPoint>> {
    validate_viewport(width, height)?;
    let clip = view_projection * Vec4::new(point[0], point[1], point[2], 1.0);
    if !clip.is_finite() || clip.w <= 0.0 {
        return Ok(None);
    }
    let ndc = clip.truncate() / clip.w;
    Ok(Some(ScreenPoint {
        x: (ndc.x + 1.0) * 0.5 * width,
        y: (1.0 - ndc.y) * 0.5 * height,
        depth: ndc.z,
    }))
}

/// Unprojects a pixel at NDC `depth` back to world space.
pub fn screen_to_world(
    inverse_view_projection: Mat4,
    x: f32,
    y: f32,
    depth: f32,
    width: f32,
    height: f32,
) -> Result<[f32; 3]> {
    validate_viewport(width, height)?;
    if !x.is_finite() || !y.is_finite() || !depth.is_finite() {
        return Err(invalid("screen", "screen coordinates must be finite"));
    }
    let ndc_x = 2.0 * x / width - 1.0;
    let ndc_y = 1.0 - 2.0 * y / height;
    let world = transform_point(inverse_view_projection, Vec3::new(ndc_x, ndc_y, depth))?;
    Ok(world.to_array())
}

/// Ray from the near plane through a pixel toward the far plane.
pub fn screen_ray(
    inverse_view_projection: Mat4,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
) -> Result<Ray> {
    let near = Vec3::from_array(screen_to_world(
        inverse_view_projection,
        x,
        y,
        0.0,
        width,
        height,
    )?);
    let far = Vec3::from_array(screen_to_world(
        inverse_view_projection,
        x,
        y,
        1.0,
        width,
        height,
    )?);
    let direction = (far - near).normalize_or_zero();
    if direction == Vec3::ZERO {
        return Err(invalid("screen", "screen ray is degenerate"));
    }
    Ok(Ray {
        origin: near.to_array(),
        direction: direction.to_array(),
    })
}

fn transform_point(matrix: Mat4, point: Vec3) -> Result<Vec3> {
    let result = matrix * point.extend(1.0);
    if !result.is_finite() || result.w.abs() <= f32::EPSILON {
        return Err(invalid("matrix", "point unprojects to infinity"));
    }
    Ok(result.truncate() / result.w)
}

fn validate_viewport(width: f32, height: f32) -> Result<()> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(invalid(
            "viewport",
            "viewport width and height must be finite and > 0",
        ));
    }
    Ok(())
}
