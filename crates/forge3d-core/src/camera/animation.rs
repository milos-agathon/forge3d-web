//! Target-aware camera keyframe animation with Catmull-Rom (cubic Hermite)
//! interpolation. A line-for-line f32 port of the native
//! `animation::CameraAnimation`, so sampled paths match the native oracle.

use super::projection::invalid;
use crate::error::Result;

/// Catmull-Rom basis evaluated between `p1` (t = 0) and `p2` (t = 1).
pub fn cubic_hermite(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    let h1 = -0.5 * t3 + t2 - 0.5 * t;
    let h2 = 1.5 * t3 - 2.5 * t2 + 1.0;
    let h3 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
    let h4 = 0.5 * t3 - 0.5 * t2;
    h1 * p0 + h2 * p1 + h3 * p2 + h4 * p3
}

pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

pub fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

pub fn smootherstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// One keyframe: time in seconds, azimuth `phi`, polar angle `theta` measured
/// down from +Y, orbit radius, vertical FOV and an optional world target.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraKeyframe {
    pub time: f32,
    pub phi_deg: f32,
    pub theta_deg: f32,
    pub radius: f32,
    pub fov_deg: f32,
    pub target: Option<[f32; 3]>,
}

impl CameraKeyframe {
    pub fn new(
        time: f32,
        phi_deg: f32,
        theta_deg: f32,
        radius: f32,
        fov_deg: f32,
        target: Option<[f32; 3]>,
    ) -> Result<Self> {
        let keyframe = Self {
            time,
            phi_deg,
            theta_deg,
            radius,
            fov_deg,
            target,
        };
        keyframe.validate()?;
        Ok(keyframe)
    }

    fn validate(&self) -> Result<()> {
        for (field, value) in [
            ("time", self.time),
            ("phiDeg", self.phi_deg),
            ("thetaDeg", self.theta_deg),
            ("radius", self.radius),
            ("fovDeg", self.fov_deg),
        ] {
            if !value.is_finite() {
                return Err(invalid(field, format!("keyframe {field} must be finite")));
            }
        }
        if let Some(target) = self.target {
            if target.iter().any(|value| !value.is_finite()) {
                return Err(invalid(
                    "target",
                    "keyframe target components must be finite",
                ));
            }
        }
        Ok(())
    }
}

/// Interpolated camera state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraState {
    pub phi_deg: f32,
    pub theta_deg: f32,
    pub radius: f32,
    pub fov_deg: f32,
    pub target: Option<[f32; 3]>,
}

impl CameraState {
    /// Eye position for this state around `target` (or `fallback_target`).
    /// Uses the rig convention: `x = r sinθ cosφ`, `y = r cosθ`,
    /// `z = r sinθ sinφ` (computed in f64 like the native rig helpers).
    pub fn eye(&self, fallback_target: [f32; 3]) -> [f64; 3] {
        let target = self.target.unwrap_or(fallback_target);
        orbit_eye(
            [target[0] as f64, target[1] as f64, target[2] as f64],
            self.radius as f64,
            self.phi_deg as f64,
            self.theta_deg as f64,
        )
    }
}

pub(crate) fn orbit_eye(target: [f64; 3], radius: f64, phi_deg: f64, theta_deg: f64) -> [f64; 3] {
    let phi = phi_deg.to_radians();
    let theta = theta_deg.to_radians();
    let sin_theta = theta.sin();
    [
        target[0] + radius * sin_theta * phi.cos(),
        target[1] + radius * theta.cos(),
        target[2] + radius * sin_theta * phi.sin(),
    ]
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CameraAnimation {
    keyframes: Vec<CameraKeyframe>,
}

impl CameraAnimation {
    pub fn new() -> Self {
        Self::default()
    }

    /// Inserts a keyframe; keyframes stay sorted by time (stable for ties).
    pub fn add_keyframe(&mut self, keyframe: CameraKeyframe) -> Result<()> {
        keyframe.validate()?;
        self.keyframes.push(keyframe);
        sort_keyframes(&mut self.keyframes);
        Ok(())
    }

    pub fn replace_keyframes(&mut self, mut keyframes: Vec<CameraKeyframe>) -> Result<()> {
        for keyframe in &keyframes {
            keyframe.validate()?;
        }
        sort_keyframes(&mut keyframes);
        self.keyframes = keyframes;
        Ok(())
    }

    pub fn clear_keyframes(&mut self) {
        self.keyframes.clear();
    }

    pub fn keyframes(&self) -> &[CameraKeyframe] {
        &self.keyframes
    }

    pub fn keyframe_count(&self) -> usize {
        self.keyframes.len()
    }

    /// Time of the last keyframe (animations implicitly start at `0`).
    pub fn duration(&self) -> f32 {
        self.keyframes.last().map(|k| k.time).unwrap_or(0.0)
    }

    /// Inclusive frame count `ceil(duration * fps) + 1`, or `0`.
    pub fn frame_count(&self, fps: u32) -> u32 {
        let duration = self.duration();
        if duration <= 0.0 || fps == 0 {
            return 0;
        }
        (duration * fps as f32).ceil() as u32 + 1
    }

    pub fn evaluate(&self, time: f32) -> Option<CameraState> {
        if self.keyframes.is_empty() {
            return None;
        }
        let first_time = self.keyframes.first().map(|k| k.time).unwrap_or(0.0);
        let last_time = self.keyframes.last().map(|k| k.time).unwrap_or(0.0);
        let time = time.clamp(first_time, last_time);
        let (k0, k1, k2, k3, t) = self.find_keyframes_for_time(time);
        Some(CameraState {
            phi_deg: cubic_hermite(k0.phi_deg, k1.phi_deg, k2.phi_deg, k3.phi_deg, t),
            theta_deg: cubic_hermite(k0.theta_deg, k1.theta_deg, k2.theta_deg, k3.theta_deg, t),
            radius: cubic_hermite(k0.radius, k1.radius, k2.radius, k3.radius, t),
            fov_deg: cubic_hermite(k0.fov_deg, k1.fov_deg, k2.fov_deg, k3.fov_deg, t),
            target: interpolate_target(k0, k1, k2, k3, t),
        })
    }

    fn find_keyframes_for_time(
        &self,
        time: f32,
    ) -> (
        CameraKeyframe,
        CameraKeyframe,
        CameraKeyframe,
        CameraKeyframe,
        f32,
    ) {
        let n = self.keyframes.len();
        if n == 1 {
            let k = self.keyframes[0];
            return (k, k, k, k, 0.0);
        }
        let mut idx = 0;
        for (i, keyframe) in self.keyframes.iter().enumerate() {
            if keyframe.time > time {
                idx = i.saturating_sub(1);
                break;
            }
            idx = i;
        }
        if idx >= n - 1 {
            idx = n - 2;
        }
        let k1 = self.keyframes[idx];
        let k2 = self.keyframes[idx + 1];
        let k0 = if idx > 0 { self.keyframes[idx - 1] } else { k1 };
        let k3 = if idx + 2 < n {
            self.keyframes[idx + 2]
        } else {
            k2
        };
        let segment_duration = k2.time - k1.time;
        let t = if segment_duration > 0.0 {
            (time - k1.time) / segment_duration
        } else {
            0.0
        };
        (k0, k1, k2, k3, t)
    }
}

fn sort_keyframes(keyframes: &mut [CameraKeyframe]) {
    keyframes.sort_by(|a, b| a.time.total_cmp(&b.time));
}

fn interpolate_target(
    k0: CameraKeyframe,
    k1: CameraKeyframe,
    k2: CameraKeyframe,
    k3: CameraKeyframe,
    t: f32,
) -> Option<[f32; 3]> {
    let p1 = k1.target?;
    let p2 = k2.target?;
    let p0 = k0.target.unwrap_or(p1);
    let p3 = k3.target.unwrap_or(p2);
    Some([
        cubic_hermite(p0[0], p1[0], p2[0], p3[0], t),
        cubic_hermite(p0[1], p1[1], p2[1], p3[1], t),
        cubic_hermite(p0[2], p1[2], p2[2], p3[2], t),
    ])
}

/// Offline frame-sequence naming (`{prefix}_{frame:0digits}.png`).
#[derive(Debug, Clone, PartialEq)]
pub struct RenderConfig {
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub filename_prefix: String,
    pub frame_digits: usize,
}

impl Default for RenderConfig {
    fn default() -> Self {
        Self {
            fps: 30,
            width: 1920,
            height: 1080,
            filename_prefix: "frame".to_string(),
            frame_digits: 4,
        }
    }
}

impl RenderConfig {
    pub fn frame_file_name(&self, frame: u32) -> String {
        format!(
            "{}_{:0width$}.png",
            self.filename_prefix,
            frame,
            width = self.frame_digits
        )
    }
}

/// Fraction complete (`0..1`) for a render progress callback.
pub fn render_progress_percent(frame: u32, total_frames: u32) -> f32 {
    if total_frames == 0 {
        0.0
    } else {
        frame as f32 / total_frames as f32
    }
}
