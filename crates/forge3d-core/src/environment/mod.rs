//! Shared W10 environment contracts. Units are metres, seconds and linear RGB.
pub mod sun;
mod tests;
mod types;
pub use types::*;

fn finite(values: &[f32]) -> bool {
    values.iter().all(|v| v.is_finite())
}
fn range(v: f32, lo: f32, hi: f32) -> bool {
    v.is_finite() && v >= lo && v <= hi
}
fn color(c: &[f32; 3]) -> bool {
    c.iter().all(|v| range(*v, 0.0, 65504.0))
}
impl Environment {
    pub fn validate(&self) -> Result<(), String> {
        let bad = || Err("invalid environment configuration".into());
        if !finite(&self.sun_direction)
            || glam::Vec3::from(self.sun_direction).length() < 0.99
            || (glam::Vec3::from(self.sun_direction).length() - 1.0).abs() > 0.001
            || !color(&self.sun_color)
            || !range(self.sun_intensity, 0.0, 1000.0)
            || ![0.5, 1.0].contains(&self.resolution_scale)
            || !(8..=128).contains(&self.steps)
            || !["raymarch", "froxel"].contains(&self.volumetric_mode.as_str())
            || !range(self.temporal_weight, 0.0, 0.95)
            || !range(self.max_distance, 0.01, 1e7)
            || ![
                "none",
                "transmittance",
                "clouds",
                "water-mask",
                "foam",
                "reflection",
            ]
            .contains(&self.debug.as_str())
            || self.volumes.len() > 8
            || self.water.len() > 4
        {
            return bad();
        }
        if let Some(s) = &self.sun_clock {
            if ![s.latitude, s.longitude, s.unix_seconds, s.time_scale]
                .iter()
                .all(|v| v.is_finite())
                || s.unix_seconds.abs() > 8.64e12
                || s.time_scale.abs() > 1e8
            {
                return bad();
            }
        }
        if let Some(s) = &self.sky {
            if !["preetham", "hosek-wilkie"].contains(&s.model.as_str())
                || !range(s.turbidity, 1.0, 10.0)
                || !range(s.ground_albedo, 0.0, 1.0)
                || !range(s.sun_size, 0.0, 100.0)
                || !range(s.exposure, 0.0, 100.0)
                || !range(s.sun_intensity, 0.0, 1000.0)
                || !range(s.aerial_density, 0.0, 100.0)
            {
                return bad();
            }
        }
        if let Some(f) = &self.fog {
            if !["uniform", "height", "exponential"].contains(&f.mode.as_str())
                || !range(f.scattering, 0.0, 1.0)
                || !range(f.absorption, 0.0, 1.0)
                || !range(f.density, 0.0, 100.0)
                || !f.height.is_finite()
                || !range(f.falloff, 0.0, 100.0)
                || !range(f.shaft_intensity, 0.0, 10.0)
                || !(8..=128).contains(&f.shaft_samples)
                || !color(&f.color)
                || !range(f.anisotropy, -1.0, 1.0)
            {
                return bad();
            }
        }
        if let Some(c) = &self.clouds {
            if !["native", "world"].contains(&c.render_path.as_str())
                || !color(&c.color)
                || !range(c.scatter_strength, 0.0, 100.0)
                || !["billboard", "volumetric", "hybrid"].contains(&c.mode.as_str())
                || !range(c.density, 0.0, 100.0)
                || !range(c.coverage, 0.0, 1.0)
                || !range(c.scale, 0.001, 1e7)
                || !c.height.is_finite()
                || !range(c.thickness, 0.001, 1e7)
                || !finite(&c.wind)
                || !range(c.animation_speed, 0.0, 100.0)
                || !range(c.shadow_strength, 0.0, 1.0)
                || !range(c.absorption, 0.0, 100.0)
                || !range(c.anisotropy, -1.0, 1.0)
                || !range(c.ambient, 0.0, 100.0)
                || !range(c.fade_distance, 0.001, 1e7)
            {
                return bad();
            }
        }
        let mut voxels = 0usize;
        for v in &self.volumes {
            if !finite(&v.bounds)
                || (0..3).any(|i| v.bounds[i] >= v.bounds[i + 3])
                || !range(v.density, 0.0, 100.0)
                || !color(&v.color)
                || !range(v.anisotropy, -1.0, 1.0)
            {
                return bad();
            }
            let n = v
                .dimensions
                .iter()
                .try_fold(1usize, |a, &b| a.checked_mul(b as usize))
                .ok_or("volume size overflow")?;
            if n == 0
                || n > 2_097_152
                || v.data.len() != n
                || v.data.iter().any(|d| !range(*d, 0.0, 1.0))
            {
                return bad();
            }
            voxels += n;
        }
        if voxels > 2_097_152 {
            return bad();
        }
        for w in &self.water {
            if !["disabled", "transparent", "reflective", "animated"].contains(&w.mode.as_str())
                || !range(w.fresnel_power, 0.01, 100.0)
                || !range(w.hue_shift, -100.0, 100.0)
                || !color(&w.tint_color)
                || !range(w.tint_strength, 0.0, 1.0)
                || !range(w.ripple_scale, 0.0, 1e5)
                || !range(w.ripple_speed, -1e5, 1e5)
                || !range(w.refraction_strength, 0.0, 1.0)
                || !range(w.shore_attenuation_width, 0.0, 1e7)
                || !range(w.wave_distortion_strength, 0.0, 100.0)
                || !finite(&w.bounds)
                || w.bounds[0] >= w.bounds[2]
                || w.bounds[1] >= w.bounds[3]
                || !w.height.is_finite()
                || !color(&w.shallow_color)
                || !color(&w.deep_color)
                || !range(w.depth_scale, 0.001, 1e7)
                || !range(w.alpha, 0.0, 1.0)
                || !range(w.wave_amplitude, 0.0, 1e5)
                || !range(w.wave_frequency, 0.0, 1e5)
                || !w.wave_speed.is_finite()
                || !finite(&w.flow)
                || !range(w.roughness, 0.0, 1.0)
                || !["sky", "screen", "planar"].contains(&w.reflection.as_str())
                || !range(w.reflection_strength, 0.0, 1.0)
                || !range(w.foam_width, 0.0, 1e7)
                || !range(w.foam_intensity, 0.0, 1.0)
                || !range(w.foam_noise_scale, 1.0, 1e5)
            {
                return bad();
            }
            let n = u64::from(w.mask_dimensions[0]) * u64::from(w.mask_dimensions[1]);
            if n == 0
                || n > 2_097_152
                || w.mask.len() != n as usize
                || w.mask.iter().any(|d| !range(*d, 0.0, 1.0))
            {
                return bad();
            }
        }
        if self.water.iter().filter(|w| w.terrain_mask).count() > 1 {
            return Err("at most one masked-terrain reflection layer".into());
        }
        Ok(())
    }
    pub fn sun_at(&self, time: f32) -> [f32; 3] {
        self.sun_clock.as_ref().map_or(self.sun_direction, |s| {
            sun::sun_position_unix(
                s.latitude,
                s.longitude,
                s.unix_seconds + f64::from(time) * s.time_scale,
            )
            .to_direction()
        })
    }
    /// Payload buffer stores volume descriptors, voxel samples and explicit masks.
    pub fn payload_floats(&self) -> usize {
        8 * 16
            + 4 * 48
            + self.volumes.iter().map(|v| v.data.len()).sum::<usize>()
            + self.water.iter().map(|w| w.mask.len()).sum::<usize>()
    }
    pub fn gpu_bytes(&self, width: u32, height: u32) -> u64 {
        let (w, h) = self.effect_size(width, height);
        // world RGBA8, effect/history RGBA16F x2, previous depth R32F.
        self.froxel_bytes(width, height)
            + self.reflection_bytes(width, height)
            + u64::from(width) * u64::from(height) * 4
            + u64::from(w) * u64::from(h) * 20
            + self.payload_floats() as u64 * 4
            + 512
    }
    pub fn froxel_bytes(&self, width: u32, height: u32) -> u64 {
        if self.volumetric_mode == "froxel" {
            u64::from(width.div_ceil(8)) * u64::from(height.div_ceil(8)) * u64::from(self.steps) * 8
        } else {
            8
        }
    }
    pub fn reflection_bytes(&self, width: u32, height: u32) -> u64 {
        let n = self
            .water
            .iter()
            .filter(|w| w.reflection == "planar")
            .count() as u64;
        let pixels = if n > 0 {
            u64::from(width) * u64::from(height)
        } else {
            1
        };
        pixels * 4 * (self.water.len().max(1) as u64 + 1)
            + n * 96
            + if self.water.iter().any(|w| w.terrain_mask) {
                96
            } else {
                0
            }
    }
    pub fn effect_size(&self, width: u32, height: u32) -> (u32, u32) {
        let divisor = if self.resolution_scale == 0.5 { 2 } else { 1 };
        (
            width.div_ceil(divisor).max(1),
            height.div_ceil(divisor).max(1),
        )
    }
}
/// Henyey-Greenstein phase, normalized over a sphere.
pub fn hg(cos_theta: f32, g: f32) -> f32 {
    (1.0 - g * g)
        / (4.0 * std::f32::consts::PI * (1.0 + g * g - 2.0 * g * cos_theta).max(1e-6).powf(1.5))
}
/// Slab intersection bounds used by the GPU marcher; no contribution outside the box.
pub fn ray_box(origin: glam::Vec3, dir: glam::Vec3, bounds: [f32; 6]) -> Option<(f32, f32)> {
    let mut near = 0.0f32;
    let mut far = f32::INFINITY;
    for i in 0..3 {
        if dir[i].abs() < 1e-8 {
            if origin[i] < bounds[i] || origin[i] > bounds[i + 3] {
                return None;
            }
        } else {
            let a = (bounds[i] - origin[i]) / dir[i];
            let b = (bounds[i + 3] - origin[i]) / dir[i];
            near = near.max(a.min(b));
            far = far.min(a.max(b));
        }
    }
    (near < far).then_some((near, far))
}
