//! Depth-of-field helpers ported from the native `camera::dof` bindings.

use super::projection::invalid;
use crate::error::Result;

pub const ERROR_APERTURE: &str = "aperture must be finite and > 0";
pub const ERROR_FOCUS_DISTANCE: &str = "focusDistance must be finite and > 0";
pub const ERROR_FOCAL_LENGTH: &str = "focalLength must be finite and > 0";
pub const ERROR_F_STOP: &str = "fStop must be finite and > 0";
pub const ERROR_COC: &str = "circleOfConfusion must be finite and > 0";
pub const ERROR_AUTO_FOCUS_SPEED: &str = "autoFocusSpeed must be finite and > 0";
pub const ERROR_DEPTH: &str = "depth must be finite and > 0";
pub const ERROR_SENSOR: &str = "sensorSize must be finite and > 0";

/// Default circle of confusion for 35 mm film.
pub const DEFAULT_CIRCLE_OF_CONFUSION: f32 = 0.03;
/// Default full-frame sensor width in millimetres.
pub const DEFAULT_SENSOR_SIZE: f32 = 36.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraDofParams {
    pub aperture: f32,
    pub focus_distance: f32,
    pub focal_length: f32,
    pub auto_focus: bool,
    pub auto_focus_speed: f32,
}

impl CameraDofParams {
    pub fn new(
        aperture: f32,
        focus_distance: f32,
        focal_length: f32,
        auto_focus: bool,
        auto_focus_speed: f32,
    ) -> Result<Self> {
        positive(aperture, "aperture", ERROR_APERTURE)?;
        positive(focus_distance, "focusDistance", ERROR_FOCUS_DISTANCE)?;
        positive(focal_length, "focalLength", ERROR_FOCAL_LENGTH)?;
        positive(auto_focus_speed, "autoFocusSpeed", ERROR_AUTO_FOCUS_SPEED)?;
        Ok(Self {
            aperture,
            focus_distance,
            focal_length,
            auto_focus,
            auto_focus_speed,
        })
    }
}

pub fn f_stop_to_aperture(f_stop: f32) -> Result<f32> {
    positive(f_stop, "fStop", ERROR_F_STOP)?;
    Ok(1.0 / f_stop)
}

pub fn aperture_to_f_stop(aperture: f32) -> Result<f32> {
    positive(aperture, "aperture", ERROR_APERTURE)?;
    Ok(1.0 / aperture)
}

pub fn hyperfocal_distance(
    focal_length: f32,
    f_stop: f32,
    circle_of_confusion: f32,
) -> Result<f32> {
    positive(focal_length, "focalLength", ERROR_FOCAL_LENGTH)?;
    positive(f_stop, "fStop", ERROR_F_STOP)?;
    positive(circle_of_confusion, "circleOfConfusion", ERROR_COC)?;
    Ok((focal_length * focal_length) / (f_stop * circle_of_confusion) + focal_length)
}

/// Near and far limits of acceptable sharpness; the far limit is infinite
/// once the focus distance reaches the hyperfocal distance.
pub fn depth_of_field_range(
    focal_length: f32,
    f_stop: f32,
    focus_distance: f32,
    circle_of_confusion: f32,
) -> Result<(f32, f32)> {
    positive(focal_length, "focalLength", ERROR_FOCAL_LENGTH)?;
    positive(focus_distance, "focusDistance", ERROR_FOCUS_DISTANCE)?;
    positive(f_stop, "fStop", ERROR_F_STOP)?;
    positive(circle_of_confusion, "circleOfConfusion", ERROR_COC)?;
    let h = (focal_length * focal_length) / (f_stop * circle_of_confusion) + focal_length;
    let near = (h * focus_distance) / (h + focus_distance - focal_length);
    let far = if focus_distance < (h - focal_length) {
        (h * focus_distance) / (h - focus_distance + focal_length)
    } else {
        f32::INFINITY
    };
    Ok((near, far))
}

/// Circle of confusion (in sensor millimetres) for an object at `depth`.
pub fn circle_of_confusion(
    depth: f32,
    focal_length: f32,
    aperture: f32,
    focus_distance: f32,
    sensor_size: f32,
) -> Result<f32> {
    positive(depth, "depth", ERROR_DEPTH)?;
    positive(focal_length, "focalLength", ERROR_FOCAL_LENGTH)?;
    positive(aperture, "aperture", ERROR_APERTURE)?;
    positive(focus_distance, "focusDistance", ERROR_FOCUS_DISTANCE)?;
    positive(sensor_size, "sensorSize", ERROR_SENSOR)?;
    let distance_diff = (depth - focus_distance).abs();
    let denominator = depth * (focus_distance + focal_length);
    if denominator < 0.001 {
        return Ok(0.0);
    }
    Ok((aperture * focal_length * distance_diff) / denominator * sensor_size)
}

fn positive(value: f32, field: &str, message: &str) -> Result<()> {
    if !value.is_finite() || value <= 0.0 {
        return Err(invalid(field, message));
    }
    Ok(())
}
