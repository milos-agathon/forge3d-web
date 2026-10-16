//! Terrain camera rigs that bake to `CameraAnimation`.
//!
//! A port of the native `forge3d.camera_rigs` module. Rig math runs in f64
//! (the native Python floats) while keyframes are stored and evaluated in f32
//! (the native `CameraAnimation`), so baked keyframes and sampled paths match
//! the native oracle. Baking is deterministic: the same rig and terrain always
//! produce the same keyframes. After the initial bake every rig verifies the
//! Catmull-Rom path at `max(32 * samplesPerSecond, 240)` Hz and inserts extra
//! keyframes wherever the eye would dip below `terrain + minimumHeight` or
//! leave the terrain, repeating up to `maxRefinePasses` times; a rig that still
//! violates its clearance is rejected rather than returned.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

use super::animation::{orbit_eye, CameraAnimation, CameraKeyframe};
use super::projection::invalid;
use crate::error::Result;

const EPSILON: f64 = 1e-6;
const CLEARANCE_EPSILON: f64 = 1e-4;

/// Height sampler matching the native `TerrainScatterSource` contract: the
/// terrain spans `[0, terrainWidth]` on both X and Z, heights are rebased so
/// the lowest finite sample is `0` and scaled by `zScale`, and non-finite
/// samples are filled with the lowest finite sample.
#[derive(Debug, Clone, PartialEq)]
pub struct TerrainRigSource {
    width: usize,
    height: usize,
    terrain_width: f64,
    z_scale: f64,
    min_height: f64,
    max_height: f64,
    scaled_heights: Vec<f32>,
}

impl TerrainRigSource {
    /// `heights` is row-major with `height` rows of `width` samples.
    pub fn new(
        heights: &[f32],
        width: usize,
        height: usize,
        z_scale: f64,
        terrain_width: Option<f64>,
    ) -> Result<Self> {
        if width == 0 || height == 0 {
            return Err(invalid("heightmap", "heightmap must not be empty"));
        }
        let expected = width
            .checked_mul(height)
            .ok_or_else(|| invalid("heightmap", "heightmap dimensions overflow"))?;
        if heights.len() != expected {
            return Err(invalid(
                "heightmap",
                format!("heightmap must contain width * height = {expected} samples"),
            ));
        }
        if !z_scale.is_finite() || z_scale <= 0.0 {
            return Err(invalid("zScale", "zScale must be a positive finite float"));
        }
        let terrain_width = terrain_width.unwrap_or(width.max(height) as f64);
        if !terrain_width.is_finite() || terrain_width <= 0.0 {
            return Err(invalid(
                "terrainWidth",
                "terrainWidth must be a positive finite float",
            ));
        }
        let fill = heights
            .iter()
            .copied()
            .filter(|value| value.is_finite())
            .reduce(f32::min)
            .ok_or_else(|| {
                invalid(
                    "heightmap",
                    "heightmap must contain at least one finite sample",
                )
            })?;
        let filled: Vec<f32> = heights
            .iter()
            .map(|value| if value.is_finite() { *value } else { fill })
            .collect();
        let min = filled.iter().copied().fold(f32::INFINITY, f32::min);
        let max = filled.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        // NumPy float32 arithmetic with the scalars cast to float32.
        let z_scale_f32 = z_scale as f32;
        let scaled_heights: Vec<f32> = filled
            .iter()
            .map(|value| (*value - min) * z_scale_f32)
            .collect();
        if scaled_heights.iter().any(|value| !value.is_finite()) {
            return Err(invalid(
                "zScale",
                "zScale produces non-finite scaled heights",
            ));
        }
        Ok(Self {
            width,
            height,
            terrain_width,
            z_scale,
            min_height: min as f64,
            max_height: max as f64,
            scaled_heights,
        })
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn terrain_width(&self) -> f64 {
        self.terrain_width
    }

    pub fn z_scale(&self) -> f64 {
        self.z_scale
    }

    pub fn min_height(&self) -> f64 {
        self.min_height
    }

    pub fn max_height(&self) -> f64 {
        self.max_height
    }

    /// Fractional `(row, col)` for a contract-space `(x, z)` position.
    pub fn contract_to_pixel(&self, x: f64, z: f64) -> (f64, f64) {
        let span = self.terrain_width.max(1e-6);
        let row = (z / span) * (self.height.saturating_sub(1).max(1)) as f64;
        let col = (x / span) * (self.width.saturating_sub(1).max(1)) as f64;
        (row, col)
    }

    /// Bilinear scaled height at fractional pixel coordinates (clamped).
    pub fn sample_scaled_height(&self, row: f64, col: f64) -> f64 {
        let max_row = self.height.saturating_sub(1);
        let max_col = self.width.saturating_sub(1);
        let row = row.clamp(0.0, max_row as f64);
        let col = col.clamp(0.0, max_col as f64);
        let row0 = row.floor() as usize;
        let col0 = col.floor() as usize;
        let row1 = (row0 + 1).min(max_row);
        let col1 = (col0 + 1).min(max_col);
        let tr = row - row0 as f64;
        let tc = col - col0 as f64;
        let v00 = self.scaled_at(row0, col0);
        let v01 = self.scaled_at(row0, col1);
        let v10 = self.scaled_at(row1, col0);
        let v11 = self.scaled_at(row1, col1);
        let top = (1.0 - tc) * v00 + tc * v01;
        let bottom = (1.0 - tc) * v10 + tc * v11;
        (1.0 - tr) * top + tr * bottom
    }

    /// Scaled terrain height under contract-space `(x, z)`.
    pub fn height_at(&self, x: f64, z: f64) -> f64 {
        let (row, col) = self.contract_to_pixel(x, z);
        self.sample_scaled_height(row, col)
    }

    /// Playback pose at `time`. With `minimum_height`, the eye is lifted to
    /// terrain + minimum: baked keyframes are verified on a dense grid like
    /// native, and the clamp also removes Catmull-Rom dips between
    /// verification samples.
    pub fn eye_at(
        &self,
        animation: &CameraAnimation,
        time: f32,
        minimum_height: Option<f64>,
    ) -> Result<Option<RigPose>> {
        let Some(state) = animation.evaluate(time) else {
            return Ok(None);
        };
        let target = state
            .target
            .ok_or_else(|| invalid("animation", "rig playback requires target-aware keyframes"))?;
        let target = [target[0] as f64, target[1] as f64, target[2] as f64];
        let mut eye = orbit_eye(
            target,
            state.radius as f64,
            state.phi_deg as f64,
            state.theta_deg as f64,
        );
        if let Some(minimum) = minimum_height {
            non_negative(minimum, "minimumHeight")?;
            eye[1] = eye[1].max(self.height_at(eye[0], eye[2]) + minimum);
        }
        Ok(Some(RigPose {
            eye,
            target,
            fov_deg: state.fov_deg,
        }))
    }

    fn scaled_at(&self, row: usize, col: usize) -> f64 {
        self.scaled_heights[row * self.width + col] as f64
    }

    fn validate_point(&self, point: (f64, f64), name: &str) -> Result<(f64, f64)> {
        let (x, z) = point;
        let width = self.terrain_width;
        if x < 0.0 || x > width || z < 0.0 || z > width {
            return Err(invalid(
                name,
                format!(
                    "{name} must stay within [0, {}] terrain bounds, got ({}, {})",
                    py_float(width),
                    py_float(x),
                    py_float(z)
                ),
            ));
        }
        Ok(point)
    }
}

/// Contract-space camera pose produced by rig playback.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RigPose {
    pub eye: [f64; 3],
    pub target: [f64; 3],
    pub fov_deg: f32,
}

/// Terrain-width-relative orbit radius used by terrain viewers.
pub fn viewer_orbit_radius(terrain_width: f64, scale: f64, minimum: f64) -> Result<f64> {
    if !terrain_width.is_finite() || terrain_width <= 0.0 {
        return Err(invalid(
            "terrainWidth",
            "terrainWidth must be a positive finite float",
        ));
    }
    if !scale.is_finite() || scale <= 0.0 {
        return Err(invalid("scale", "scale must be a positive finite float"));
    }
    if !minimum.is_finite() || minimum < 0.0 {
        return Err(invalid(
            "minimum",
            "minimum must be a non-negative finite float",
        ));
    }
    Ok((terrain_width * scale).max(minimum))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TerrainClearance {
    pub minimum_height: f64,
    pub max_refine_passes: u32,
}

impl Default for TerrainClearance {
    fn default() -> Self {
        Self {
            minimum_height: 0.0,
            max_refine_passes: 8,
        }
    }
}

impl TerrainClearance {
    pub fn new(minimum_height: f64, max_refine_passes: u32) -> Result<Self> {
        non_negative(minimum_height, "minimumHeight")?;
        Ok(Self {
            minimum_height,
            max_refine_passes,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainOrbitRig {
    pub target_xz: (f64, f64),
    pub duration: f64,
    pub radius: f64,
    pub phi_start_deg: f64,
    pub phi_end_deg: f64,
    pub theta_start_deg: f64,
    pub theta_end_deg: Option<f64>,
    pub radius_end: Option<f64>,
    pub fov_start_deg: f64,
    pub fov_end_deg: Option<f64>,
    pub target_height_offset: f64,
    pub clearance: TerrainClearance,
}

impl TerrainOrbitRig {
    /// Validated orbit rig; `None` end values hold the start value.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        target_xz: (f64, f64),
        duration: f64,
        radius: f64,
        phi_start_deg: f64,
        phi_end_deg: f64,
        theta_start_deg: f64,
        theta_end_deg: Option<f64>,
        radius_end: Option<f64>,
        fov_start_deg: f64,
        fov_end_deg: Option<f64>,
        target_height_offset: f64,
        clearance: TerrainClearance,
    ) -> Result<Self> {
        finite(target_xz.0, "targetXZ[0]")?;
        finite(target_xz.1, "targetXZ[1]")?;
        positive(duration, "duration")?;
        positive(radius, "radius")?;
        validate_clearance(&clearance)?;
        finite(phi_start_deg, "phiStartDeg")?;
        finite(phi_end_deg, "phiEndDeg")?;
        polar(theta_start_deg, "thetaStartDeg")?;
        if let Some(value) = theta_end_deg {
            polar(value, "thetaEndDeg")?;
        }
        if let Some(value) = radius_end {
            positive(value, "radiusEnd")?;
        }
        positive(fov_start_deg, "fovStartDeg")?;
        if let Some(value) = fov_end_deg {
            positive(value, "fovEndDeg")?;
        }
        finite(target_height_offset, "targetHeightOffset")?;
        Ok(Self {
            target_xz,
            duration,
            radius,
            phi_start_deg,
            phi_end_deg,
            theta_start_deg,
            theta_end_deg,
            radius_end,
            fov_start_deg,
            fov_end_deg,
            target_height_offset,
            clearance,
        })
    }

    pub fn bake(
        &self,
        source: &TerrainRigSource,
        samples_per_second: u32,
    ) -> Result<CameraAnimation> {
        bake(self, source, samples_per_second)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainRailRig {
    pub path_xz: Vec<(f64, f64)>,
    pub duration: f64,
    pub camera_height_offset: f64,
    pub look_ahead_distance: f64,
    pub lateral_offset: f64,
    pub target_height_offset: f64,
    pub fov_deg: f64,
    pub clearance: TerrainClearance,
}

impl TerrainRailRig {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        path_xz: &[(f64, f64)],
        duration: f64,
        camera_height_offset: f64,
        look_ahead_distance: f64,
        lateral_offset: f64,
        target_height_offset: f64,
        fov_deg: f64,
        clearance: TerrainClearance,
    ) -> Result<Self> {
        let path_xz = coerce_path(path_xz, "pathXZ")?;
        positive(duration, "duration")?;
        finite(camera_height_offset, "cameraHeightOffset")?;
        non_negative(look_ahead_distance, "lookAheadDistance")?;
        finite(lateral_offset, "lateralOffset")?;
        finite(target_height_offset, "targetHeightOffset")?;
        positive(fov_deg, "fovDeg")?;
        validate_clearance(&clearance)?;
        Ok(Self {
            path_xz,
            duration,
            camera_height_offset,
            look_ahead_distance,
            lateral_offset,
            target_height_offset,
            fov_deg,
            clearance,
        })
    }

    pub fn bake(
        &self,
        source: &TerrainRigSource,
        samples_per_second: u32,
    ) -> Result<CameraAnimation> {
        bake(self, source, samples_per_second)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainTargetFollowRig {
    pub target_path_xz: Vec<(f64, f64)>,
    pub duration: f64,
    pub radius: f64,
    pub theta_deg: f64,
    pub heading_offset_deg: f64,
    pub target_height_offset: f64,
    pub fov_deg: f64,
    pub clearance: TerrainClearance,
}

impl TerrainTargetFollowRig {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        target_path_xz: &[(f64, f64)],
        duration: f64,
        radius: f64,
        theta_deg: f64,
        heading_offset_deg: f64,
        target_height_offset: f64,
        fov_deg: f64,
        clearance: TerrainClearance,
    ) -> Result<Self> {
        let target_path_xz = coerce_path(target_path_xz, "targetPathXZ")?;
        positive(duration, "duration")?;
        positive(radius, "radius")?;
        polar(theta_deg, "thetaDeg")?;
        finite(heading_offset_deg, "headingOffsetDeg")?;
        finite(target_height_offset, "targetHeightOffset")?;
        positive(fov_deg, "fovDeg")?;
        validate_clearance(&clearance)?;
        Ok(Self {
            target_path_xz,
            duration,
            radius,
            theta_deg,
            heading_offset_deg,
            target_height_offset,
            fov_deg,
            clearance,
        })
    }

    pub fn bake(
        &self,
        source: &TerrainRigSource,
        samples_per_second: u32,
    ) -> Result<CameraAnimation> {
        bake(self, source, samples_per_second)
    }
}

trait Rig {
    fn duration(&self) -> f64;
    fn clearance(&self) -> TerrainClearance;
    fn sample_keyframe(&self, source: &TerrainRigSource, time: f64) -> Result<CameraKeyframe>;
    fn normalize_keyframes(&self, keyframes: Vec<CameraKeyframe>) -> Vec<CameraKeyframe> {
        unwrap_keyframes(keyframes)
    }
}

impl Rig for TerrainOrbitRig {
    fn duration(&self) -> f64 {
        self.duration
    }

    fn clearance(&self) -> TerrainClearance {
        self.clearance
    }

    fn normalize_keyframes(&self, keyframes: Vec<CameraKeyframe>) -> Vec<CameraKeyframe> {
        let mut ordered = keyframes;
        ordered.sort_by(|a, b| a.time.total_cmp(&b.time));
        ordered
            .into_iter()
            .map(|keyframe| {
                let alpha = alpha_for(keyframe.time as f64, self.duration);
                let reference = lerp(self.phi_start_deg, self.phi_end_deg, alpha);
                let phi = align_angle(keyframe.phi_deg as f64, reference);
                CameraKeyframe {
                    phi_deg: phi as f32,
                    ..keyframe
                }
            })
            .collect()
    }

    fn sample_keyframe(&self, source: &TerrainRigSource, time: f64) -> Result<CameraKeyframe> {
        let target_xz = source.validate_point(self.target_xz, "targetXZ")?;
        let alpha = alpha_for(time, self.duration);
        let radius_end = self.radius_end.unwrap_or(self.radius);
        let theta_end = self.theta_end_deg.unwrap_or(self.theta_start_deg);
        let fov_end = self.fov_end_deg.unwrap_or(self.fov_start_deg);
        let target = [
            target_xz.0,
            source.height_at(target_xz.0, target_xz.1) + self.target_height_offset,
            target_xz.1,
        ];
        let eye = orbit_eye(
            target,
            lerp(self.radius, radius_end, alpha),
            lerp(self.phi_start_deg, self.phi_end_deg, alpha),
            lerp(self.theta_start_deg, theta_end, alpha),
        );
        let eye = apply_clearance(source, eye, &self.clearance)?;
        keyframe_from_eye(time, eye, target, lerp(self.fov_start_deg, fov_end, alpha))
    }
}

impl Rig for TerrainRailRig {
    fn duration(&self) -> f64 {
        self.duration
    }

    fn clearance(&self) -> TerrainClearance {
        self.clearance
    }

    fn sample_keyframe(&self, source: &TerrainRigSource, time: f64) -> Result<CameraKeyframe> {
        for (index, point) in self.path_xz.iter().enumerate() {
            source.validate_point(*point, &format!("pathXZ[{index}]"))?;
        }
        let path = PolylinePath::new(&self.path_xz)?;
        let alpha = alpha_for(time, self.duration);
        let distance = path.total_length * alpha;
        let eye_sample = path.sample_distance(distance, false)?;
        let (mut eye_x, mut eye_z) = offset_path_sample(&eye_sample, self.lateral_offset);
        source.validate_point((eye_x, eye_z), "rail camera eye")?;

        let terrain_width = source.terrain_width();
        let target_sample = path.sample_distance(distance + self.look_ahead_distance, true)?;
        let mut target_x = target_sample.x.clamp(0.0, terrain_width);
        let mut target_z = target_sample.z.clamp(0.0, terrain_width);
        if (target_x - eye_x).hypot(target_z - eye_z) <= EPSILON {
            let cell_size =
                terrain_width / (source.height().max(source.width()) as f64 - 1.0).max(1.0);
            let fallback_distance = self
                .look_ahead_distance
                .max(path.total_length / (path.points.len() as f64 - 1.0).max(1.0))
                .max(cell_size);
            let forward = path.sample_distance(distance + fallback_distance, true)?;
            target_x = forward.x.clamp(0.0, terrain_width);
            target_z = forward.z.clamp(0.0, terrain_width);
            if (target_x - eye_x).hypot(target_z - eye_z) <= EPSILON {
                // Keep the forward boundary target and back the eye off rather
                // than flipping the shot back toward the start of the rail.
                let eye_backoff = distance.min(cell_size);
                if eye_backoff > 0.0 {
                    let candidate = offset_path_sample(
                        &path.sample_distance(distance - eye_backoff, false)?,
                        self.lateral_offset,
                    );
                    source.validate_point(candidate, "rail camera eye")?;
                    if (target_x - candidate.0).hypot(target_z - candidate.1) > EPSILON {
                        eye_x = candidate.0;
                        eye_z = candidate.1;
                    }
                }
            }
            if (target_x - eye_x).hypot(target_z - eye_z) <= EPSILON {
                return Err(invalid(
                    "pathXZ",
                    "rail camera target collapsed onto the camera eye; adjust the path or height offsets",
                ));
            }
        }
        source.validate_point((target_x, target_z), "rail camera target")?;

        let target = [
            target_x,
            source.height_at(target_x, target_z) + self.target_height_offset,
            target_z,
        ];
        let eye = [
            eye_x,
            source.height_at(eye_x, eye_z) + self.camera_height_offset,
            eye_z,
        ];
        let eye = apply_clearance(source, eye, &self.clearance)?;
        keyframe_from_eye(time, eye, target, self.fov_deg)
    }
}

impl Rig for TerrainTargetFollowRig {
    fn duration(&self) -> f64 {
        self.duration
    }

    fn clearance(&self) -> TerrainClearance {
        self.clearance
    }

    fn sample_keyframe(&self, source: &TerrainRigSource, time: f64) -> Result<CameraKeyframe> {
        for (index, point) in self.target_path_xz.iter().enumerate() {
            source.validate_point(*point, &format!("targetPathXZ[{index}]"))?;
        }
        let path = PolylinePath::new(&self.target_path_xz)?;
        let alpha = alpha_for(time, self.duration);
        let sample = path.sample_distance(path.total_length * alpha, false)?;
        let target = [
            sample.x,
            source.height_at(sample.x, sample.z) + self.target_height_offset,
            sample.z,
        ];
        let heading_deg = sample.tangent_z.atan2(sample.tangent_x).to_degrees();
        let eye = orbit_eye(
            target,
            self.radius,
            heading_deg + self.heading_offset_deg,
            self.theta_deg,
        );
        source.validate_point((eye[0], eye[2]), "follow camera eye")?;
        let eye = apply_clearance(source, eye, &self.clearance)?;
        keyframe_from_eye(time, eye, target, self.fov_deg)
    }
}

fn bake<R: Rig>(
    rig: &R,
    source: &TerrainRigSource,
    samples_per_second: u32,
) -> Result<CameraAnimation> {
    if samples_per_second == 0 {
        return Err(invalid("samplesPerSecond", "samplesPerSecond must be > 0"));
    }
    let mut keyframes = Vec::new();
    for time in sample_times(rig.duration(), samples_per_second) {
        keyframes.push(rig.sample_keyframe(source, time)?);
    }
    let mut animation = CameraAnimation::new();
    animation.replace_keyframes(rig.normalize_keyframes(keyframes))?;
    refine(rig, animation, source, samples_per_second)
}

fn refine<R: Rig>(
    rig: &R,
    mut animation: CameraAnimation,
    source: &TerrainRigSource,
    samples_per_second: u32,
) -> Result<CameraAnimation> {
    for _ in 0..=rig.clearance().max_refine_passes {
        let failing = failing_times(rig, &animation, source, samples_per_second);
        if failing.is_empty() {
            return Ok(animation);
        }
        let mut existing: HashSet<i64> = animation
            .keyframes()
            .iter()
            .map(|keyframe| round_key(keyframe.time as f64))
            .collect();
        let mut keyframes = animation.keyframes().to_vec();
        let mut inserted = false;
        for time in &failing {
            if !existing.insert(round_key(*time)) {
                continue;
            }
            keyframes.push(rig.sample_keyframe(source, *time)?);
            inserted = true;
        }
        if !inserted {
            return Err(sample_violation(rig, &animation, source, failing[0]));
        }
        animation.replace_keyframes(rig.normalize_keyframes(keyframes))?;
    }
    let failing = failing_times(rig, &animation, source, samples_per_second);
    match failing.first() {
        None => Ok(animation),
        Some(time) => Err(sample_violation(rig, &animation, source, *time)),
    }
}

fn failing_times<R: Rig>(
    rig: &R,
    animation: &CameraAnimation,
    source: &TerrainRigSource,
    samples_per_second: u32,
) -> Vec<f64> {
    verification_times(rig.duration(), animation, samples_per_second)
        .into_iter()
        .filter(|time| validate_sample(rig, animation, source, *time).is_some())
        .collect()
}

fn sample_violation<R: Rig>(
    rig: &R,
    animation: &CameraAnimation,
    source: &TerrainRigSource,
    time: f64,
) -> crate::error::Forge3dError {
    let message = validate_sample(rig, animation, source, time)
        .unwrap_or_else(|| "failed to satisfy clearance constraints after refinement".to_string());
    invalid("clearance", message)
}

/// Dense verification grid (at least 240 Hz) plus every keyframe time.
fn verification_times(
    duration: f64,
    animation: &CameraAnimation,
    samples_per_second: u32,
) -> Vec<f64> {
    let verify_sps = (samples_per_second.saturating_mul(32)).max(240);
    // Python dict semantics: a repeated key keeps its slot, the last value wins.
    let mut slots: HashMap<i64, usize> = HashMap::new();
    let mut values: Vec<f64> = Vec::new();
    for time in sample_times(duration, verify_sps) {
        match slots.entry(round_key(time)) {
            Entry::Occupied(slot) => values[*slot.get()] = time,
            Entry::Vacant(slot) => {
                slot.insert(values.len());
                values.push(time);
            }
        }
    }
    for keyframe in animation.keyframes() {
        let time = keyframe.time as f64;
        if let Entry::Vacant(slot) = slots.entry(round_key(time)) {
            slot.insert(values.len());
            values.push(time);
        }
    }
    values.sort_by(f64::total_cmp);
    values
}

fn validate_sample<R: Rig>(
    rig: &R,
    animation: &CameraAnimation,
    source: &TerrainRigSource,
    time: f64,
) -> Option<String> {
    let state = match animation.evaluate(time as f32) {
        Some(state) => state,
        None => return Some("animation evaluation returned None".to_string()),
    };
    let target = match state.target {
        Some(target) => [target[0] as f64, target[1] as f64, target[2] as f64],
        None => {
            return Some("target-aware rig animation lost its target during evaluation".to_string())
        }
    };
    let width = source.terrain_width();
    let outside = |value: f64| value < -CLEARANCE_EPSILON || value > width + CLEARANCE_EPSILON;
    if outside(target[0]) || outside(target[2]) {
        return Some(format!(
            "camera target left terrain bounds at time={time:.3}"
        ));
    }
    let eye = orbit_eye(
        target,
        state.radius as f64,
        state.phi_deg as f64,
        state.theta_deg as f64,
    );
    if outside(eye[0]) || outside(eye[2]) {
        return Some(format!("camera eye left terrain bounds at time={time:.3}"));
    }
    let safe_height = source.height_at(eye[0], eye[2]) + rig.clearance().minimum_height;
    if eye[1] + CLEARANCE_EPSILON < safe_height {
        return Some(format!("camera eye violated clearance at time={time:.3}"));
    }
    None
}

/// Clearance margin tolerance used by verification (world units).
pub const CLEARANCE_TOLERANCE: f64 = CLEARANCE_EPSILON;

fn sample_times(duration: f64, samples_per_second: u32) -> Vec<f64> {
    let sps = samples_per_second as f64;
    let total_frames = (duration * sps).ceil() as usize + 1;
    (0..total_frames)
        .map(|frame| duration.min(frame as f64 / sps))
        .collect()
}

fn apply_clearance(
    source: &TerrainRigSource,
    eye: [f64; 3],
    clearance: &TerrainClearance,
) -> Result<[f64; 3]> {
    source.validate_point((eye[0], eye[2]), "camera eye")?;
    let safe_height = source.height_at(eye[0], eye[2]) + clearance.minimum_height;
    if eye[1] < safe_height {
        return Ok([eye[0], safe_height, eye[2]]);
    }
    Ok(eye)
}

fn keyframe_from_eye(
    time: f64,
    eye: [f64; 3],
    target: [f64; 3],
    fov_deg: f64,
) -> Result<CameraKeyframe> {
    let (phi, theta, radius) = orbit_from_eye_target(eye, target)?;
    CameraKeyframe::new(
        time as f32,
        phi as f32,
        theta as f32,
        radius as f32,
        fov_deg as f32,
        Some([target[0] as f32, target[1] as f32, target[2] as f32]),
    )
}

fn orbit_from_eye_target(eye: [f64; 3], target: [f64; 3]) -> Result<(f64, f64, f64)> {
    let dx = eye[0] - target[0];
    let dy = eye[1] - target[1];
    let dz = eye[2] - target[2];
    let radius = (dx * dx + dy * dy + dz * dz).sqrt();
    if radius <= EPSILON {
        return Err(invalid("eye", "camera eye and target must not coincide"));
    }
    let phi = dz.atan2(dx).to_degrees();
    let theta = (dy / radius).clamp(-1.0, 1.0).acos().to_degrees();
    Ok((phi, theta, radius))
}

fn unwrap_keyframes(keyframes: Vec<CameraKeyframe>) -> Vec<CameraKeyframe> {
    let mut ordered = keyframes;
    ordered.sort_by(|a, b| a.time.total_cmp(&b.time));
    let mut result = Vec::with_capacity(ordered.len());
    let mut previous_phi = match ordered.first() {
        Some(first) => first.phi_deg as f64,
        None => return result,
    };
    result.push(ordered[0]);
    for keyframe in ordered.into_iter().skip(1) {
        let phi = align_angle(keyframe.phi_deg as f64, previous_phi);
        result.push(CameraKeyframe {
            phi_deg: phi as f32,
            ..keyframe
        });
        previous_phi = phi;
    }
    result
}

fn align_angle(angle: f64, reference: f64) -> f64 {
    let mut aligned = angle;
    while aligned - reference > 180.0 {
        aligned -= 360.0;
    }
    while aligned - reference < -180.0 {
        aligned += 360.0;
    }
    aligned
}

#[derive(Debug, Clone, Copy)]
struct PathSample {
    x: f64,
    z: f64,
    tangent_x: f64,
    tangent_z: f64,
}

struct PolylinePath {
    points: Vec<(f64, f64)>,
    lengths: Vec<f64>,
    segment_lengths: Vec<f64>,
    total_length: f64,
}

impl PolylinePath {
    fn new(points: &[(f64, f64)]) -> Result<Self> {
        let mut lengths = vec![0.0];
        let mut segment_lengths = Vec::with_capacity(points.len().saturating_sub(1));
        for pair in points.windows(2) {
            let length = (pair[1].0 - pair[0].0).hypot(pair[1].1 - pair[0].1);
            segment_lengths.push(length);
            let last = *lengths.last().unwrap_or(&0.0);
            lengths.push(last + length);
        }
        let total_length = *lengths.last().unwrap_or(&0.0);
        if total_length <= EPSILON {
            return Err(invalid("path", "path length must be > 0"));
        }
        Ok(Self {
            points: points.to_vec(),
            lengths,
            segment_lengths,
            total_length,
        })
    }

    fn sample_distance(&self, distance: f64, extrapolate: bool) -> Result<PathSample> {
        let clamped = distance.clamp(0.0, self.total_length);
        let n = self.points.len();
        if clamped <= 0.0 {
            let start = self.points[0];
            let (tx, tz) = segment_tangent(start, self.points[1])?;
            if extrapolate && distance < 0.0 {
                return Ok(PathSample {
                    x: start.0 + tx * distance,
                    z: start.1 + tz * distance,
                    tangent_x: tx,
                    tangent_z: tz,
                });
            }
            return Ok(PathSample {
                x: start.0,
                z: start.1,
                tangent_x: tx,
                tangent_z: tz,
            });
        }
        if clamped >= self.total_length {
            let end = self.points[n - 1];
            let (tx, tz) = segment_tangent(self.points[n - 2], end)?;
            if extrapolate && distance > self.total_length {
                let extension = distance - self.total_length;
                return Ok(PathSample {
                    x: end.0 + tx * extension,
                    z: end.1 + tz * extension,
                    tangent_x: tx,
                    tangent_z: tz,
                });
            }
            return Ok(PathSample {
                x: end.0,
                z: end.1,
                tangent_x: tx,
                tangent_z: tz,
            });
        }
        let last_segment = self.segment_lengths.len() - 1;
        for (index, segment_length) in self.segment_lengths.iter().copied().enumerate() {
            let start_distance = self.lengths[index];
            let end_distance = self.lengths[index + 1];
            if clamped <= end_distance || index == last_segment {
                let start = self.points[index];
                let end = self.points[index + 1];
                let alpha = if segment_length <= EPSILON {
                    0.0
                } else {
                    (clamped - start_distance) / segment_length
                };
                let (tx, tz) = segment_tangent(start, end)?;
                return Ok(PathSample {
                    x: lerp(start.0, end.0, alpha),
                    z: lerp(start.1, end.1, alpha),
                    tangent_x: tx,
                    tangent_z: tz,
                });
            }
        }
        let end = self.points[n - 1];
        let (tx, tz) = segment_tangent(self.points[n - 2], end)?;
        Ok(PathSample {
            x: end.0,
            z: end.1,
            tangent_x: tx,
            tangent_z: tz,
        })
    }
}

fn segment_tangent(start: (f64, f64), end: (f64, f64)) -> Result<(f64, f64)> {
    let dx = end.0 - start.0;
    let dz = end.1 - start.1;
    let length = dx.hypot(dz);
    if length <= EPSILON {
        return Err(invalid("path", "path contains a degenerate segment"));
    }
    Ok((dx / length, dz / length))
}

fn offset_path_sample(sample: &PathSample, lateral_offset: f64) -> (f64, f64) {
    (
        sample.x + -sample.tangent_z * lateral_offset,
        sample.z + sample.tangent_x * lateral_offset,
    )
}

fn coerce_path(points: &[(f64, f64)], name: &str) -> Result<Vec<(f64, f64)>> {
    if points.len() < 2 {
        return Err(invalid(
            name,
            format!("{name} must contain at least 2 points"),
        ));
    }
    let mut collapsed: Vec<(f64, f64)> = Vec::with_capacity(points.len());
    for (index, point) in points.iter().enumerate() {
        finite(point.0, &format!("{name}[{index}][0]"))?;
        finite(point.1, &format!("{name}[{index}][1]"))?;
        match collapsed.last() {
            Some(last) if (point.0 - last.0).hypot(point.1 - last.1) <= EPSILON => {}
            _ => collapsed.push(*point),
        }
    }
    if collapsed.len() < 2 {
        return Err(invalid(
            name,
            format!("{name} must contain at least 2 unique points"),
        ));
    }
    Ok(collapsed)
}

fn alpha_for(time: f64, duration: f64) -> f64 {
    if duration <= EPSILON {
        0.0
    } else {
        (time / duration).clamp(0.0, 1.0)
    }
}

fn lerp(start: f64, end: f64, alpha: f64) -> f64 {
    start + (end - start) * alpha
}

/// Key equivalent to Python's `round(value, 9)` for de-duplicating times.
fn round_key(value: f64) -> i64 {
    (value * 1e9).round() as i64
}

fn validate_clearance(clearance: &TerrainClearance) -> Result<()> {
    non_negative(clearance.minimum_height, "minimumHeight")
}

fn finite(value: f64, name: &str) -> Result<()> {
    if !value.is_finite() {
        return Err(invalid(name, format!("{name} must be finite")));
    }
    Ok(())
}

fn positive(value: f64, name: &str) -> Result<()> {
    finite(value, name)?;
    if value <= 0.0 {
        return Err(invalid(name, format!("{name} must be > 0")));
    }
    Ok(())
}

fn non_negative(value: f64, name: &str) -> Result<()> {
    finite(value, name)?;
    if value < 0.0 {
        return Err(invalid(name, format!("{name} must be >= 0")));
    }
    Ok(())
}

fn polar(value: f64, name: &str) -> Result<()> {
    finite(value, name)?;
    if !(0.0..180.0).contains(&value) {
        return Err(invalid(name, format!("{name} must be in [0, 180)")));
    }
    Ok(())
}

/// Python `repr(float)` style: integral values keep a trailing `.0`.
fn py_float(value: f64) -> String {
    format!("{value:?}")
}
