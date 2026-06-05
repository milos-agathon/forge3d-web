use crate::error::{Forge3dError, Result};

const MIN_VECTOR_LENGTH: f32 = 1.0e-6;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraInput {
    pub position: [f32; 3],
    pub target: [f32; 3],
    pub up: [f32; 3],
    pub fov_y_degrees: f32,
    pub near: f32,
    pub far: f32,
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
        let input = Self {
            position,
            target,
            up,
            fov_y_degrees,
            near,
            far,
        };
        input.validate()?;
        Ok(input)
    }

    pub fn view_projection_matrix(&self, aspect_ratio: f32) -> Result<[[f32; 4]; 4]> {
        self.validate()?;
        if !aspect_ratio.is_finite() || aspect_ratio <= 0.0 {
            return invalid_input(
                "aspectRatio",
                "aspect ratio must be finite and greater than zero",
            );
        }

        let eye = glam::Vec3::from_array(self.position);
        let target = glam::Vec3::from_array(self.target);
        let up = glam::Vec3::from_array(self.up).normalize();
        let view = glam::Mat4::look_at_rh(eye, target, up);
        let projection = glam::Mat4::perspective_rh(
            self.fov_y_degrees.to_radians(),
            aspect_ratio,
            self.near,
            self.far,
        );
        Ok((projection * view).to_cols_array_2d())
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
        if !(0.0..180.0).contains(&self.fov_y_degrees) {
            return invalid_input("fovYDegrees", "field of view must be in the range (0, 180)");
        }
        if self.near <= 0.0 {
            return invalid_input("near", "near plane must be greater than zero");
        }
        if self.far <= self.near {
            return invalid_input("far", "far plane must be greater than near plane");
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
mod tests {
    use super::CameraInput;

    #[test]
    fn camera_default_produces_finite_view_projection_matrix() {
        let matrix = CameraInput::default()
            .view_projection_matrix(16.0 / 9.0)
            .unwrap();

        for column in matrix {
            for value in column {
                assert!(value.is_finite());
            }
        }
    }

    #[test]
    fn camera_rejects_non_finite_position() {
        let error = CameraInput::new(
            [0.0, f32::NAN, 2.0],
            [0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            45.0,
            0.01,
            100.0,
        )
        .unwrap_err();

        assert!(error.to_string().contains("position"));
    }

    #[test]
    fn camera_rejects_invalid_clip_planes() {
        let error = CameraInput::new(
            [0.0, 1.0, 2.0],
            [0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            45.0,
            10.0,
            1.0,
        )
        .unwrap_err();

        assert!(error.to_string().contains("far"));
    }
}
