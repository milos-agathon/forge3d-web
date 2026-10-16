//! Look-at, perspective, orthographic and view-projection matrices.
//!
//! Right-handed, Y-up, -Z forward (GL-style look-at). Projections are built in
//! GL clip space and optionally remapped to WebGPU clip space (depth `0..1`),
//! exactly as the native `camera_perspective`/`camera_orthographic` bindings.
//! Validation messages keep the native wording but name the browser API
//! parameters (`fovYDegrees`, `near`, `far`, `clipSpace`).

use glam::{Mat4, Vec3};

use crate::error::{Forge3dError, Result};

pub const ERROR_FOVY: &str = "fovYDegrees must be finite and in (0, 180)";
pub const ERROR_NEAR: &str = "near must be finite and > 0";
pub const ERROR_FAR: &str = "far must be finite and > near";
pub const ERROR_ASPECT: &str = "aspect must be finite and > 0";
pub const ERROR_VECFINITE: &str = "eye/target/up components must be finite";
pub const ERROR_UPCOLINEAR: &str = "up vector must not be colinear with view direction";
pub const ERROR_CLIP: &str = "clipSpace must be 'wgpu' or 'gl'";
pub const ERROR_ORTHO_LEFT_RIGHT: &str = "left must be finite and < right";
pub const ERROR_ORTHO_BOTTOM_TOP: &str = "bottom must be finite and < top";

/// Target clip-space depth convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ClipSpace {
    /// WebGPU/Vulkan/Metal depth `0..1` (the native default).
    #[default]
    Wgpu,
    /// OpenGL depth `-1..1`.
    Gl,
}

impl ClipSpace {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "wgpu" => Ok(Self::Wgpu),
            "gl" => Ok(Self::Gl),
            _ => Err(invalid("clipSpace", ERROR_CLIP)),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wgpu => "wgpu",
            Self::Gl => "gl",
        }
    }
}

/// Maps GL clip-space depth `[-1, 1]` to WebGPU `[0, 1]`.
pub fn gl_to_wgpu() -> Mat4 {
    Mat4::from_cols_array(&[
        1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 0.5, 0.0, //
        0.0, 0.0, 0.5, 1.0, //
    ])
}

pub fn validate_vec3_finite(value: Vec3, field: &str) -> Result<()> {
    if !value.is_finite() {
        return Err(invalid(field, ERROR_VECFINITE));
    }
    Ok(())
}

pub fn validate_fovy(fovy_deg: f32) -> Result<()> {
    if !fovy_deg.is_finite() || fovy_deg <= 0.0 || fovy_deg >= 180.0 {
        return Err(invalid("fovYDegrees", ERROR_FOVY));
    }
    Ok(())
}

pub fn validate_near(znear: f32) -> Result<()> {
    if !znear.is_finite() || znear <= 0.0 {
        return Err(invalid("near", ERROR_NEAR));
    }
    Ok(())
}

pub fn validate_far(zfar: f32, znear: f32) -> Result<()> {
    if !zfar.is_finite() || zfar <= znear {
        return Err(invalid("far", ERROR_FAR));
    }
    Ok(())
}

pub fn validate_aspect(aspect: f32) -> Result<()> {
    if !aspect.is_finite() || aspect <= 0.0 {
        return Err(invalid("aspect", ERROR_ASPECT));
    }
    Ok(())
}

/// Rejects an up vector parallel to the view direction (the look-at basis
/// would be degenerate). Mirrors the native squared-cross threshold.
pub fn validate_up_not_colinear(eye: Vec3, target: Vec3, up: Vec3) -> Result<()> {
    let view_dir = (target - eye).normalize_or_zero();
    let up_norm = up.normalize_or_zero();
    if view_dir.cross(up_norm).length_squared() < 1e-6 {
        return Err(invalid("up", ERROR_UPCOLINEAR));
    }
    Ok(())
}

pub fn validate_ortho_left_right(left: f32, right: f32) -> Result<()> {
    if !left.is_finite() || !right.is_finite() || left >= right {
        return Err(invalid("left", ERROR_ORTHO_LEFT_RIGHT));
    }
    Ok(())
}

pub fn validate_ortho_bottom_top(bottom: f32, top: f32) -> Result<()> {
    if !bottom.is_finite() || !top.is_finite() || bottom >= top {
        return Err(invalid("bottom", ERROR_ORTHO_BOTTOM_TOP));
    }
    Ok(())
}

/// View matrix (right-handed, Y-up, -Z forward).
pub fn look_at(eye: [f32; 3], target: [f32; 3], up: [f32; 3]) -> Result<Mat4> {
    let eye = Vec3::from_array(eye);
    let target = Vec3::from_array(target);
    let up = Vec3::from_array(up);
    validate_vec3_finite(eye, "eye")?;
    validate_vec3_finite(target, "target")?;
    validate_vec3_finite(up, "up")?;
    validate_up_not_colinear(eye, target, up)?;
    Ok(Mat4::look_at_rh(eye, target, up))
}

/// Perspective projection built from the GL matrix, remapped for `clip`.
pub fn perspective(
    fovy_deg: f32,
    aspect: f32,
    znear: f32,
    zfar: f32,
    clip: ClipSpace,
) -> Result<Mat4> {
    validate_fovy(fovy_deg)?;
    validate_aspect(aspect)?;
    validate_near(znear)?;
    validate_far(zfar, znear)?;
    Ok(apply_clip(
        Mat4::perspective_rh_gl(fovy_deg.to_radians(), aspect, znear, zfar),
        clip,
    ))
}

/// Orthographic projection with explicit bounds, remapped for `clip`.
pub fn orthographic(
    left: f32,
    right: f32,
    bottom: f32,
    top: f32,
    znear: f32,
    zfar: f32,
    clip: ClipSpace,
) -> Result<Mat4> {
    validate_ortho_left_right(left, right)?;
    validate_ortho_bottom_top(bottom, top)?;
    validate_near(znear)?;
    validate_far(zfar, znear)?;
    Ok(apply_clip(
        orthographic_gl_unchecked(left, right, bottom, top, znear, zfar),
        clip,
    ))
}

/// Combined perspective view-projection (`projection * view`).
#[allow(clippy::too_many_arguments)]
pub fn view_projection(
    eye: [f32; 3],
    target: [f32; 3],
    up: [f32; 3],
    fovy_deg: f32,
    aspect: f32,
    znear: f32,
    zfar: f32,
    clip: ClipSpace,
) -> Result<Mat4> {
    let view = look_at(eye, target, up)?;
    let projection = perspective(fovy_deg, aspect, znear, zfar, clip)?;
    Ok(projection * view)
}

/// Camera world position recovered from a view matrix.
pub fn camera_world_position_from_view(view: Mat4) -> Vec3 {
    view.inverse().w_axis.truncate()
}

pub(crate) fn orthographic_gl_unchecked(
    left: f32,
    right: f32,
    bottom: f32,
    top: f32,
    znear: f32,
    zfar: f32,
) -> Mat4 {
    let w = right - left;
    let h = top - bottom;
    let d = zfar - znear;
    Mat4::from_cols_array(&[
        2.0 / w,
        0.0,
        0.0,
        0.0,
        0.0,
        2.0 / h,
        0.0,
        0.0,
        0.0,
        0.0,
        -2.0 / d,
        0.0,
        -(right + left) / w,
        -(top + bottom) / h,
        -(zfar + znear) / d,
        1.0,
    ])
}

fn apply_clip(projection_gl: Mat4, clip: ClipSpace) -> Mat4 {
    match clip {
        ClipSpace::Gl => projection_gl,
        ClipSpace::Wgpu => gl_to_wgpu() * projection_gl,
    }
}

pub(crate) fn invalid(field: &str, message: impl Into<String>) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.into(),
    }
}
