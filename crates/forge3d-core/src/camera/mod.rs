//! Camera math, transforms, controllers, keyframe animation and terrain rigs.
//!
//! `CameraInput` is the renderer-facing camera (look-at plus a perspective or
//! orthographic projection in WebGPU clip space). The submodules port the
//! native Forge3D camera surface: `projection` (look-at/perspective/
//! orthographic/view-projection with GL or WebGPU clip space), `transforms`
//! (TRS and matrix helpers), `screen` (world/screen conversion and picking
//! rays), `dof` (depth-of-field helpers), `controller` (orbit/FPS controllers
//! with mode switching), `animation` (Catmull-Rom keyframes) and `rigs`
//! (terrain orbit/rail/follow rigs with clearance refinement).

pub mod animation;
pub mod controller;
pub mod dof;
pub mod projection;
pub mod rigs;
pub mod screen;
pub mod transforms;

use crate::error::{Forge3dError, Result};

pub use projection::ClipSpace;

const MIN_VECTOR_LENGTH: f32 = 1.0e-6;

/// Projection model used when a `CameraInput` is rendered.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum CameraProjection {
    /// Vertical field of view from `CameraInput::fov_y_degrees`.
    #[default]
    Perspective,
    /// Parallel projection covering `height` world units vertically; the
    /// horizontal extent follows the viewport aspect ratio.
    Orthographic { height: f32 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraInput {
    pub position: [f32; 3],
    pub target: [f32; 3],
    pub up: [f32; 3],
    pub fov_y_degrees: f32,
    pub near: f32,
    pub far: f32,
    pub projection: CameraProjection,
}

impl CameraInput {
    pub fn new(
        position: [f32; 3],
        target: [f32; 3],
        up: [f32; 3],
        fov_y_degrees: f32,
        near: f32,
        far: f32,
    ) -> Result<Self> {
        Self::with_projection(
            position,
            target,
            up,
            fov_y_degrees,
            near,
            far,
            CameraProjection::Perspective,
        )
    }

    pub fn with_projection(
        position: [f32; 3],
        target: [f32; 3],
        up: [f32; 3],
        fov_y_degrees: f32,
        near: f32,
        far: f32,
        projection: CameraProjection,
    ) -> Result<Self> {
        let input = Self {
            position,
            target,
            up,
            fov_y_degrees,
            near,
            far,
            projection,
        };
        input.validate()?;
        Ok(input)
    }

    pub fn view_matrix(&self) -> Result<glam::Mat4> {
        self.validate()?;
        Ok(glam::Mat4::look_at_rh(
            glam::Vec3::from_array(self.position),
            glam::Vec3::from_array(self.target),
            glam::Vec3::from_array(self.up).normalize(),
        ))
    }

    /// Projection in WebGPU clip space for the given viewport aspect ratio.
    pub fn projection_matrix(&self, aspect_ratio: f32) -> Result<glam::Mat4> {
        self.validate()?;
        if !aspect_ratio.is_finite() || aspect_ratio <= 0.0 {
            return invalid_input(
                "aspectRatio",
                "aspect ratio must be finite and greater than zero",
            );
        }
        Ok(match self.projection {
            CameraProjection::Perspective => glam::Mat4::perspective_rh(
                self.fov_y_degrees.to_radians(),
                aspect_ratio,
                self.near,
                self.far,
            ),
            CameraProjection::Orthographic { height } => {
                let half_height = height * 0.5;
                let half_width = half_height * aspect_ratio;
                projection::gl_to_wgpu()
                    * projection::orthographic_gl_unchecked(
                        -half_width,
                        half_width,
                        -half_height,
                        half_height,
                        self.near,
                        self.far,
                    )
            }
        })
    }

    pub fn view_projection_matrix(&self, aspect_ratio: f32) -> Result<[[f32; 4]; 4]> {
        let projection = self.projection_matrix(aspect_ratio)?;
        Ok((projection * self.view_matrix()?).to_cols_array_2d())
    }

    /// Half extents `(half_width, half_height)` of the view volume slice at
    /// view depth `depth`: they grow with depth for perspective cameras and
    /// are constant for orthographic cameras.
    pub fn half_extents_at(&self, depth: f32, aspect_ratio: f32) -> (f32, f32) {
        let half_height = match self.projection {
            CameraProjection::Perspective => depth * (self.fov_y_degrees.to_radians() * 0.5).tan(),
            CameraProjection::Orthographic { height } => height * 0.5,
        };
        (half_height * aspect_ratio, half_height)
    }

    pub fn is_orthographic(&self) -> bool {
        matches!(self.projection, CameraProjection::Orthographic { .. })
    }

    fn validate(&self) -> Result<()> {
        validate_vector("position", self.position)?;
        validate_vector("target", self.target)?;
        validate_vector("up", self.up)?;
        validate_scalar("fovYDegrees", self.fov_y_degrees)?;
        validate_scalar("near", self.near)?;
        validate_scalar("far", self.far)?;

        let eye = glam::Vec3::from_array(self.position);
        let target = glam::Vec3::from_array(self.target);
        let up = glam::Vec3::from_array(self.up);
        if (target - eye).length() <= MIN_VECTOR_LENGTH {
            return invalid_input("target", "camera target must differ from position");
        }
        if up.length() <= MIN_VECTOR_LENGTH {
            return invalid_input("up", "camera up vector must be non-zero");
        }
        projection::validate_up_not_colinear(eye, target, up)?;
        if !(0.0..180.0).contains(&self.fov_y_degrees) || self.fov_y_degrees == 0.0 {
            return invalid_input("fovYDegrees", "field of view must be in the range (0, 180)");
        }
        if self.near <= 0.0 {
            return invalid_input("near", "near plane must be greater than zero");
        }
        if self.far <= self.near {
            return invalid_input("far", "far plane must be greater than near plane");
        }
        if let CameraProjection::Orthographic { height } = self.projection {
            if !height.is_finite() || height <= 0.0 {
                return invalid_input(
                    "orthographicHeight",
                    "orthographic height must be finite and greater than zero",
                );
            }
        }

        Ok(())
    }
}

impl Default for CameraInput {
    fn default() -> Self {
        Self {
            position: [0.0, 1.3, 2.4],
            target: [0.0, 0.18, 0.0],
            up: [0.0, 1.0, 0.0],
            fov_y_degrees: 46.0,
            near: 0.01,
            far: 100.0,
            projection: CameraProjection::Perspective,
        }
    }
}

fn validate_vector(field: &str, values: [f32; 3]) -> Result<()> {
    for (index, value) in values.iter().copied().enumerate() {
        if !value.is_finite() {
            return invalid_input(field, format!("{field}[{index}] must be finite"));
        }
    }
    Ok(())
}

fn validate_scalar(field: &str, value: f32) -> Result<()> {
    if !value.is_finite() {
        return invalid_input(field, format!("{field} must be finite"));
    }
    Ok(())
}

fn invalid_input<T>(field: &str, message: impl Into<String>) -> Result<T> {
    Err(Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.into(),
    })
}

#[cfg(test)]
mod tests;
