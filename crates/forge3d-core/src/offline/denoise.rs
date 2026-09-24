//! Edge-aware A-trous denoiser guided by albedo, normal and depth AOVs.
//!
//! The weights port `forge3d.denoise.atrous_denoise` (B3-spline 5x5 kernel,
//! step doubling per iteration, Gaussian guidance terms on albedo, normal angle
//! and depth). Out-of-image taps are skipped like the native
//! `denoise_atrous.wgsl` compute shader instead of the NumPy zero padding, so
//! borders are not darkened.
//!
//! The native `DenoiseSettings.edge_stopping` strength (unused by the NumPy
//! reference) drives an additional luminance edge-stopping term,
//! `exp(-edge_stopping * |L_q - L_p| / sigma_n)`, where `sigma_n` is a robust
//! noise estimate of the input (median absolute Laplacian). It keeps converged
//! frames unchanged while still smoothing sampling noise; `edge_stopping = 0`
//! reproduces the native weights exactly. The WebGPU pass in `forge3d-web`
//! evaluates the same arithmetic and is checked against this reference.

use crate::error::{Forge3dError, Result};

/// B3-spline taps `[1, 4, 6, 4, 1] / 16`.
pub const ATROUS_KERNEL: [f32; 5] = [0.0625, 0.25, 0.375, 0.25, 0.0625];
pub const MAX_ITERATIONS: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AtrousParams {
    pub iterations: u32,
    pub sigma_color: f32,
    pub sigma_albedo: f32,
    pub sigma_normal: f32,
    pub sigma_depth: f32,
    /// Luminance edge-stopping strength (native `edge_stopping`).
    pub edge_stopping: f32,
    /// Noise level for the edge-stopping term; estimated from the input
    /// with [`estimate_noise_sigma`] when `None`.
    pub noise_sigma: Option<f32>,
}

impl Default for AtrousParams {
    /// Native `DenoiseSettings` defaults plus the NumPy `sigma_albedo`.
    fn default() -> Self {
        Self {
            iterations: 3,
            sigma_color: 0.1,
            sigma_albedo: 0.2,
            sigma_normal: 0.1,
            sigma_depth: 0.1,
            edge_stopping: 1.0,
            noise_sigma: None,
        }
    }
}

impl AtrousParams {
    pub fn validate(&self) -> Result<()> {
        if self.iterations < 1 || self.iterations > MAX_ITERATIONS {
            return invalid("iterations", "must be in [1, 10]");
        }
        for (field, value) in [
            ("sigmaColor", self.sigma_color),
            ("sigmaAlbedo", self.sigma_albedo),
            ("sigmaNormal", self.sigma_normal),
            ("sigmaDepth", self.sigma_depth),
            ("edgeStopping", self.edge_stopping),
            ("noiseSigma", self.noise_sigma.unwrap_or(0.0)),
        ] {
            if !value.is_finite() || value < 0.0 {
                return invalid(field, "must be finite and >= 0");
            }
        }
        Ok(())
    }
}

/// Rec. 709 luminance used by the edge-stopping term.
pub fn rgb_luminance(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// Robust per-pixel noise estimate of an image: the median absolute
/// 4-neighbour Laplacian of the luminance, scaled to a Gaussian standard
/// deviation (`/ 0.6745 / sqrt(20)`). `stride` is the number of interleaved
/// lanes (3 or 4); images smaller than 3x3 report zero noise.
pub fn estimate_noise_sigma(color: &[f32], width: u32, height: u32, stride: usize) -> f32 {
    let (w, h) = (width as usize, height as usize);
    if w < 3 || h < 3 || color.len() < w * h * stride {
        return 0.0;
    }
    let lum = |x: usize, y: usize| {
        let i = (y * w + x) * stride;
        rgb_luminance(color[i], color[i + 1], color[i + 2])
    };
    let mut residuals = Vec::with_capacity((w - 2) * (h - 2));
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let laplacian =
                4.0 * lum(x, y) - lum(x - 1, y) - lum(x + 1, y) - lum(x, y - 1) - lum(x, y + 1);
            residuals.push(laplacian.abs());
        }
    }
    let middle = residuals.len() / 2;
    let (_, median, _) = residuals.select_nth_unstable_by(middle, |a, b| {
        a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
    });
    *median / 0.6745 / 20f32.sqrt()
}

/// Guidance planes; every slice is `width * height` pixels.
#[derive(Debug, Clone, Copy, Default)]
pub struct AtrousGuides<'a> {
    /// RGB albedo, three floats per pixel.
    pub albedo: Option<&'a [f32]>,
    /// XYZ normals, three floats per pixel (renormalized internally).
    pub normal: Option<&'a [f32]>,
    /// Scalar depth, one float per pixel.
    pub depth: Option<&'a [f32]>,
}

/// Denoises an RGB image (three floats per pixel).
pub fn atrous_denoise(
    color: &[f32],
    width: u32,
    height: u32,
    guides: AtrousGuides<'_>,
    params: AtrousParams,
) -> Result<Vec<f32>> {
    params.validate()?;
    let pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| Forge3dError::InvalidInput {
            field: "size".to_string(),
            message: "pixel count overflowed".to_string(),
        })?;
    if pixels == 0 {
        return invalid("size", "width and height must be > 0");
    }
    check_len("color", color, pixels * 3)?;
    if let Some(albedo) = guides.albedo {
        check_len("albedo", albedo, pixels * 3)?;
    }
    if let Some(normal) = guides.normal {
        check_len("normal", normal, pixels * 3)?;
    }
    if let Some(depth) = guides.depth {
        check_len("depth", depth, pixels)?;
    }

    // Guidance is the albedo when present, otherwise the input color itself.
    let guide: Vec<f32> = guides.albedo.unwrap_or(color).to_vec();
    let normals: Option<Vec<f32>> = guides.normal.map(|n| {
        n.chunks_exact(3)
            .flat_map(|v| {
                let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-8);
                [v[0] / len, v[1] / len, v[2] / len]
            })
            .collect()
    });
    let albedo_term = guides.albedo.is_some() && params.sigma_albedo > 0.0;
    let inv_color = 1.0 / (2.0 * params.sigma_color * params.sigma_color + 1e-8);
    let inv_albedo = 1.0 / (2.0 * params.sigma_albedo * params.sigma_albedo + 1e-8);
    let inv_normal = 1.0 / (2.0 * params.sigma_normal * params.sigma_normal + 1e-8);
    let inv_depth = 1.0 / (2.0 * params.sigma_depth * params.sigma_depth + 1e-8);
    let edge_scale = if params.edge_stopping > 0.0 {
        let sigma = params
            .noise_sigma
            .unwrap_or_else(|| estimate_noise_sigma(color, width, height, 3));
        Some(params.edge_stopping / (sigma + 1e-6))
    } else {
        None
    };

    let (w, h) = (width as i64, height as i64);
    let mut out = color.to_vec();
    let mut next = vec![0.0f32; out.len()];
    let mut step = 1i64;
    for _ in 0..params.iterations {
        for y in 0..h {
            for x in 0..w {
                let center = (y * w + x) as usize;
                let lum_center =
                    rgb_luminance(out[center * 3], out[center * 3 + 1], out[center * 3 + 2]);
                let mut accum = [0.0f32; 3];
                let mut wsum = 0.0f32;
                for (ky, kwy) in ATROUS_KERNEL.iter().enumerate() {
                    let sy = y + (ky as i64 - 2) * step;
                    if sy < 0 || sy >= h {
                        continue;
                    }
                    for (kx, kwx) in ATROUS_KERNEL.iter().enumerate() {
                        let sx = x + (kx as i64 - 2) * step;
                        if sx < 0 || sx >= w {
                            continue;
                        }
                        let sample = (sy * w + sx) as usize;
                        let guide_diff = dist2(&guide, sample, center);
                        let mut weight = kwy * kwx * (-guide_diff * inv_color).exp();
                        if albedo_term {
                            weight *= (-guide_diff * inv_albedo).exp();
                        }
                        if let Some(n) = normals.as_deref() {
                            let dot = (n[sample * 3] * n[center * 3]
                                + n[sample * 3 + 1] * n[center * 3 + 1]
                                + n[sample * 3 + 2] * n[center * 3 + 2])
                                .clamp(-1.0, 1.0);
                            let angle = dot.acos();
                            weight *= (-(angle * angle) * inv_normal).exp();
                        }
                        if let Some(d) = guides.depth {
                            let dd = d[sample] - d[center];
                            weight *= (-(dd * dd) * inv_depth).exp();
                        }
                        if let Some(scale) = edge_scale {
                            let lum = rgb_luminance(
                                out[sample * 3],
                                out[sample * 3 + 1],
                                out[sample * 3 + 2],
                            );
                            weight *= (-(lum - lum_center).abs() * scale).exp();
                        }
                        for c in 0..3 {
                            accum[c] += out[sample * 3 + c] * weight;
                        }
                        wsum += weight;
                    }
                }
                let norm = wsum.max(1e-8);
                for c in 0..3 {
                    next[center * 3 + c] = accum[c] / norm;
                }
            }
        }
        std::mem::swap(&mut out, &mut next);
        step *= 2;
    }
    Ok(out)
}

fn dist2(values: &[f32], a: usize, b: usize) -> f32 {
    let dx = values[a * 3] - values[b * 3];
    let dy = values[a * 3 + 1] - values[b * 3 + 1];
    let dz = values[a * 3 + 2] - values[b * 3 + 2];
    dx * dx + dy * dy + dz * dz
}

fn check_len(field: &str, values: &[f32], expected: usize) -> Result<()> {
    if values.len() != expected {
        return Err(Forge3dError::InvalidInput {
            field: field.to_string(),
            message: format!("expected {expected} floats, got {}", values.len()),
        });
    }
    if values.iter().any(|v| !v.is_finite()) {
        return Err(Forge3dError::InvalidInput {
            field: field.to_string(),
            message: "values must be finite".to_string(),
        });
    }
    Ok(())
}

fn invalid<T>(field: &str, message: &str) -> Result<T> {
    Err(Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.to_string(),
    })
}
