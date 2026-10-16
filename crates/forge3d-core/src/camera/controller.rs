//! Orbit and FPS (fly) camera controllers with mode switching, ported from the
//! native viewer `camera_controller`.
//!
//! Both controllers use the same direction convention,
//! `dir(yaw, pitch) = (cos p sin y, sin p, cos p cos y)`: the orbit eye is
//! `target + distance * dir(yaw, pitch)` and the FPS forward vector is
//! `dir(yaw, pitch)`. Unlike the native controller (whose sync used
//! `atan2(z, x)` and jumped the view when switching modes), switching keeps
//! the eye and view direction continuous: the FPS camera takes the orbit eye
//! and looks at the orbit target, and the orbit camera re-targets
//! `distance` units ahead of the FPS eye.

use glam::{Mat4, Vec3};

use super::{CameraInput, CameraProjection};
use crate::error::Result;

/// Pitch is kept this far (radians) inside `±π/2` to avoid gimbal lock.
pub const PITCH_MARGIN: f32 = 0.01;
const PITCH_LIMIT: f32 = std::f32::consts::FRAC_PI_2 - PITCH_MARGIN;

pub fn direction(yaw: f32, pitch: f32) -> Vec3 {
    Vec3::new(
        pitch.cos() * yaw.sin(),
        pitch.sin(),
        pitch.cos() * yaw.cos(),
    )
}

/// `(yaw, pitch)` whose `direction` is the normalized `vector`.
pub fn yaw_pitch_from_direction(vector: Vec3) -> (f32, f32) {
    let unit = vector.normalize_or_zero();
    (unit.x.atan2(unit.z), unit.y.clamp(-1.0, 1.0).asin())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraMode {
    Orbit,
    Fps,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrbitCamera {
    pub target: Vec3,
    pub distance: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub up: Vec3,
}

impl OrbitCamera {
    pub fn new(target: Vec3, distance: f32) -> Self {
        Self {
            target,
            distance,
            yaw: 0.0,
            pitch: -0.3,
            up: Vec3::Y,
        }
    }

    pub fn eye(&self) -> Vec3 {
        self.target + direction(self.yaw, self.pitch) * self.distance
    }

    pub fn rotate(&mut self, delta_yaw: f32, delta_pitch: f32) {
        self.yaw += delta_yaw;
        self.pitch = (self.pitch + delta_pitch).clamp(-PITCH_LIMIT, PITCH_LIMIT);
    }

    pub fn zoom(&mut self, delta: f32) {
        self.distance = (self.distance * (1.0 + delta * 0.1)).clamp(0.1, 1000.0);
    }

    pub fn pan(&mut self, delta_x: f32, delta_y: f32) {
        let forward = (self.target - self.eye()).normalize();
        let right = forward.cross(self.up).normalize();
        let up = right.cross(forward).normalize();
        let pan_speed = self.distance * 0.001;
        self.target += right * delta_x * pan_speed;
        self.target += up * delta_y * pan_speed;
    }

    pub fn view_matrix(&self) -> Mat4 {
        Mat4::look_at_rh(self.eye(), self.target, self.up)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FpsCamera {
    pub position: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub up: Vec3,
    /// World units per second at unit input.
    pub speed: f32,
}

impl FpsCamera {
    pub fn new(position: Vec3) -> Self {
        Self {
            position,
            yaw: 0.0,
            pitch: 0.0,
            up: Vec3::Y,
            speed: 5.0,
        }
    }

    pub fn forward(&self) -> Vec3 {
        direction(self.yaw, self.pitch)
    }

    pub fn right(&self) -> Vec3 {
        self.forward().cross(self.up).normalize()
    }

    pub fn rotate(&mut self, delta_yaw: f32, delta_pitch: f32) {
        self.yaw += delta_yaw;
        self.pitch = (self.pitch + delta_pitch).clamp(-PITCH_LIMIT, PITCH_LIMIT);
    }

    pub fn move_forward(&mut self, delta: f32) {
        self.position += self.forward() * delta * self.speed;
    }

    pub fn move_right(&mut self, delta: f32) {
        self.position += self.right() * delta * self.speed;
    }

    pub fn move_up(&mut self, delta: f32) {
        self.position += self.up * delta * self.speed;
    }

    pub fn view_matrix(&self) -> Mat4 {
        Mat4::look_at_rh(self.position, self.position + self.forward(), self.up)
    }
}

/// Held movement keys, mapped to axes by `FlyInput::axes`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FlyInput {
    pub forward: bool,
    pub backward: bool,
    pub left: bool,
    pub right: bool,
    pub up: bool,
    pub down: bool,
    pub boost: bool,
}

impl FlyInput {
    /// `(forward, right, up)` axes; boost doubles every axis (native Shift).
    pub fn axes(&self) -> (f32, f32, f32) {
        let multiplier = if self.boost { 2.0 } else { 1.0 };
        let axis = |positive: bool, negative: bool| {
            (positive as i32 - negative as i32) as f32 * multiplier
        };
        (
            axis(self.forward, self.backward),
            axis(self.right, self.left),
            axis(self.up, self.down),
        )
    }
}

pub struct CameraController {
    mode: CameraMode,
    orbit: OrbitCamera,
    fps: FpsCamera,
    mouse_sensitivity: f32,
    pub last_mouse_pos: Option<(f32, f32)>,
    pub mouse_pressed: bool,
}

impl Default for CameraController {
    fn default() -> Self {
        Self::new()
    }
}

impl CameraController {
    pub fn new() -> Self {
        Self {
            mode: CameraMode::Orbit,
            orbit: OrbitCamera::new(Vec3::ZERO, 10.0),
            fps: FpsCamera::new(Vec3::new(0.0, 5.0, -10.0)),
            mouse_sensitivity: 0.005,
            last_mouse_pos: None,
            mouse_pressed: false,
        }
    }

    pub fn mode(&self) -> CameraMode {
        self.mode
    }

    pub fn orbit(&self) -> &OrbitCamera {
        &self.orbit
    }

    pub fn fps(&self) -> &FpsCamera {
        &self.fps
    }

    pub fn fps_mut(&mut self) -> &mut FpsCamera {
        &mut self.fps
    }

    pub fn set_mode(&mut self, mode: CameraMode) {
        if self.mode == mode {
            return;
        }
        match mode {
            CameraMode::Fps => {
                self.fps.position = self.orbit.eye();
                let (yaw, pitch) = yaw_pitch_from_direction(self.orbit.target - self.orbit.eye());
                self.fps.yaw = yaw;
                self.fps.pitch = pitch;
                self.fps.up = self.orbit.up;
            }
            CameraMode::Orbit => {
                let forward = self.fps.forward();
                self.orbit.target = self.fps.position + forward * self.orbit.distance;
                let (yaw, pitch) = yaw_pitch_from_direction(-forward);
                self.orbit.yaw = yaw;
                self.orbit.pitch = pitch.clamp(-PITCH_LIMIT, PITCH_LIMIT);
                self.orbit.up = self.fps.up;
            }
        }
        self.mode = mode;
    }

    pub fn toggle_mode(&mut self) -> CameraMode {
        let next = match self.mode {
            CameraMode::Orbit => CameraMode::Fps,
            CameraMode::Fps => CameraMode::Orbit,
        };
        self.set_mode(next);
        next
    }

    pub fn handle_mouse_move(&mut self, x: f32, y: f32) {
        if let Some((last_x, last_y)) = self.last_mouse_pos {
            if self.mouse_pressed {
                let delta_yaw = -(x - last_x) * self.mouse_sensitivity;
                let delta_pitch = -(y - last_y) * self.mouse_sensitivity;
                match self.mode {
                    CameraMode::Orbit => self.orbit.rotate(delta_yaw, delta_pitch),
                    CameraMode::Fps => self.fps.rotate(delta_yaw, delta_pitch),
                }
            }
        }
        self.last_mouse_pos = Some((x, y));
    }

    pub fn handle_mouse_scroll(&mut self, delta: f32) {
        if self.mode == CameraMode::Orbit {
            self.orbit.zoom(delta);
        }
    }

    pub fn handle_pan(&mut self, delta_x: f32, delta_y: f32) {
        if self.mode == CameraMode::Orbit {
            self.orbit.pan(delta_x, delta_y);
        }
    }

    pub fn update_fps(&mut self, dt: f32, forward: f32, right: f32, up: f32) {
        if self.mode == CameraMode::Fps {
            self.fps.move_forward(forward * dt);
            self.fps.move_right(right * dt);
            self.fps.move_up(up * dt);
        }
    }

    pub fn update(&mut self, dt: f32, input: FlyInput) {
        let (forward, right, up) = input.axes();
        self.update_fps(dt, forward, right, up);
    }

    pub fn view_matrix(&self) -> Mat4 {
        match self.mode {
            CameraMode::Orbit => self.orbit.view_matrix(),
            CameraMode::Fps => self.fps.view_matrix(),
        }
    }

    pub fn eye(&self) -> Vec3 {
        match self.mode {
            CameraMode::Orbit => self.orbit.eye(),
            CameraMode::Fps => self.fps.position,
        }
    }

    pub fn target(&self) -> Vec3 {
        match self.mode {
            CameraMode::Orbit => self.orbit.target,
            CameraMode::Fps => self.fps.position + self.fps.forward(),
        }
    }

    pub fn up(&self) -> Vec3 {
        match self.mode {
            CameraMode::Orbit => self.orbit.up,
            CameraMode::Fps => self.fps.up,
        }
    }

    pub fn set_orbit_pose_target(&mut self, target: Vec3, distance: f32, yaw: f32, pitch: f32) {
        self.mode = CameraMode::Orbit;
        self.orbit.target = target;
        self.orbit.distance = distance.max(0.01);
        self.orbit.pitch = pitch.clamp(-PITCH_LIMIT, PITCH_LIMIT);
        self.orbit.yaw = yaw;
    }

    /// Sets both controllers from a look-at and switches to orbit mode.
    pub fn set_look_at(&mut self, eye: Vec3, target: Vec3, up: Vec3) {
        let up = up.try_normalize().unwrap_or(Vec3::Y);
        let (orbit_yaw, orbit_pitch) = yaw_pitch_from_direction(eye - target);
        self.mode = CameraMode::Orbit;
        self.orbit.target = target;
        self.orbit.distance = (target - eye).length().max(0.01);
        self.orbit.yaw = orbit_yaw;
        self.orbit.pitch = orbit_pitch.clamp(-PITCH_LIMIT, PITCH_LIMIT);
        self.orbit.up = up;
        let (fps_yaw, fps_pitch) = yaw_pitch_from_direction(target - eye);
        self.fps.position = eye;
        self.fps.yaw = fps_yaw;
        self.fps.pitch = fps_pitch.clamp(-PITCH_LIMIT, PITCH_LIMIT);
        self.fps.up = up;
    }

    pub fn camera_input(
        &self,
        fov_y_degrees: f32,
        near: f32,
        far: f32,
        projection: CameraProjection,
    ) -> Result<CameraInput> {
        CameraInput::with_projection(
            self.eye().to_array(),
            self.target().to_array(),
            self.up().to_array(),
            fov_y_degrees,
            near,
            far,
            projection,
        )
    }
}
