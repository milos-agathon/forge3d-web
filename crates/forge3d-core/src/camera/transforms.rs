//! Translation/rotation/scale helpers and model-matrix composition, ported
//! from the native `geometry::transforms` bindings (right-handed, degrees).

use glam::{Mat3, Mat4, Quat, Vec3};

use super::projection::invalid;
use crate::error::Result;

pub fn translate(tx: f32, ty: f32, tz: f32) -> Mat4 {
    Mat4::from_translation(Vec3::new(tx, ty, tz))
}

pub fn rotate_x(degrees: f32) -> Mat4 {
    Mat4::from_rotation_x(degrees.to_radians())
}

pub fn rotate_y(degrees: f32) -> Mat4 {
    Mat4::from_rotation_y(degrees.to_radians())
}

pub fn rotate_z(degrees: f32) -> Mat4 {
    Mat4::from_rotation_z(degrees.to_radians())
}

pub fn scale(sx: f32, sy: f32, sz: f32) -> Mat4 {
    Mat4::from_scale(Vec3::new(sx, sy, sz))
}

pub fn scale_uniform(s: f32) -> Mat4 {
    Mat4::from_scale(Vec3::splat(s))
}

/// `T * R * S` with Euler rotation applied X, then Y, then Z (`Rz * Ry * Rx`).
pub fn compose_trs(translation: [f32; 3], rotation_degrees: [f32; 3], scale: [f32; 3]) -> Mat4 {
    let rotation = Quat::from_rotation_z(rotation_degrees[2].to_radians())
        * Quat::from_rotation_y(rotation_degrees[1].to_radians())
        * Quat::from_rotation_x(rotation_degrees[0].to_radians());
    Mat4::from_scale_rotation_translation(
        Vec3::from_array(scale),
        rotation,
        Vec3::from_array(translation),
    )
}

/// Object-to-world transform that points an object's local -Z at `target`.
pub fn look_at_transform(position: [f32; 3], target: [f32; 3], up: [f32; 3]) -> Mat4 {
    let position = Vec3::from_array(position);
    let forward = (Vec3::from_array(target) - position).normalize();
    let right = forward.cross(Vec3::from_array(up)).normalize();
    let corrected_up = right.cross(forward);
    let rotation = Mat4::from_cols(
        right.extend(0.0),
        corrected_up.extend(0.0),
        (-forward).extend(0.0),
        Vec3::ZERO.extend(1.0),
    );
    Mat4::from_translation(position) * rotation
}

pub fn multiply(left: Mat4, right: Mat4) -> Mat4 {
    left * right
}

pub fn invert(matrix: Mat4) -> Result<Mat4> {
    let determinant = matrix.determinant();
    if !determinant.is_finite() || determinant == 0.0 {
        return Err(invalid("matrix", "matrix must be invertible"));
    }
    Ok(matrix.inverse())
}

/// Inverse-transpose of the upper 3x3, returned in a 4x4 with unit `w`.
pub fn normal_matrix(model: Mat4) -> Result<Mat4> {
    let linear = Mat3::from_mat4(model);
    let determinant = linear.determinant();
    if !determinant.is_finite() || determinant == 0.0 {
        return Err(invalid("matrix", "matrix upper 3x3 must be invertible"));
    }
    Ok(Mat4::from_mat3(linear.inverse().transpose()))
}

/// Parses a row-major 4x4 (the native NumPy layout) into a glam matrix.
pub fn from_rows(rows: [[f32; 4]; 4]) -> Mat4 {
    Mat4::from_cols_array_2d(&rows).transpose()
}

/// Serializes a matrix row-major (the native NumPy layout).
pub fn to_rows(matrix: Mat4) -> [[f32; 4]; 4] {
    matrix.transpose().to_cols_array_2d()
}
