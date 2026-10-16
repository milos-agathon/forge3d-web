//! Offline convergence metrics: native tile-luminance deltas over a short
//! history window (`read_accumulation_metrics`) and the adaptive trend rule of
//! `forge3d.offline.render_offline`.

use std::collections::VecDeque;

use crate::error::{Forge3dError, Result};

/// Native `DEFAULT_METRIC_TILE_SIZE`.
pub const DEFAULT_METRIC_TILE_SIZE: u32 = 16;
/// Native `DEFAULT_METRIC_HISTORY_WINDOW`.
pub const METRIC_HISTORY_WINDOW: usize = 3;
/// Native `_CONVERGENCE_TREND_WINDOW`.
pub const CONVERGENCE_TREND_WINDOW: usize = 3;
/// Native `OFFLINE_LUMINANCE_EPSILON`.
pub const LUMINANCE_EPSILON: f32 = 1e-4;
/// Side of the GPU luminance downsample block (native `offline_luminance.wgsl`).
pub const LUMINANCE_BLOCK: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OfflineMetrics {
    pub total_samples: u32,
    pub mean_delta: f32,
    pub p95_delta: f32,
    pub max_tile_delta: f32,
    pub converged_tile_ratio: f32,
}

/// Rec. 709 luminance used by the native luminance pass.
pub fn luminance(rgb: [f32; 3]) -> f32 {
    rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}

/// Dimensions of the 4x4 luminance downsample.
pub fn luminance_dimensions(width: u32, height: u32) -> (u32, u32) {
    (
        width.div_ceil(LUMINANCE_BLOCK),
        height.div_ceil(LUMINANCE_BLOCK),
    )
}

/// CPU reference of the luminance pass: the mean luminance of each 4x4 block of
/// the averaged accumulation (`sum / samples`), clipped at the image edge.
pub fn downsample_luminance(sum_rgba: &[f32], width: u32, height: u32, samples: u32) -> Vec<f32> {
    let (out_w, out_h) = luminance_dimensions(width, height);
    let inv = 1.0 / samples.max(1) as f32;
    let mut out = Vec::with_capacity((out_w * out_h) as usize);
    for by in 0..out_h {
        for bx in 0..out_w {
            let mut sum = 0.0f32;
            let mut count = 0u32;
            for dy in 0..LUMINANCE_BLOCK {
                for dx in 0..LUMINANCE_BLOCK {
                    let x = bx * LUMINANCE_BLOCK + dx;
                    let y = by * LUMINANCE_BLOCK + dy;
                    if x < width && y < height {
                        let i = ((y * width + x) * 4) as usize;
                        sum += luminance([
                            sum_rgba[i] * inv,
                            sum_rgba[i + 1] * inv,
                            sum_rgba[i + 2] * inv,
                        ]);
                        count += 1;
                    }
                }
            }
            out.push(sum / count.max(1) as f32);
        }
    }
    out
}

/// Native `tile_luminance_means` over the downsampled luminance grid.
pub fn tile_luminance_means(
    luminance: &[f32],
    width: u32,
    height: u32,
    tile_size: u32,
) -> Vec<f32> {
    let tile = tile_size.max(1) as usize;
    let (w, h) = (width as usize, height as usize);
    let mut means = Vec::new();
    for y0 in (0..h).step_by(tile) {
        for x0 in (0..w).step_by(tile) {
            let y1 = (y0 + tile).min(h);
            let x1 = (x0 + tile).min(w);
            let mut sum = 0.0f32;
            let mut count = 0u32;
            for y in y0..y1 {
                for x in x0..x1 {
                    sum += luminance[y * w + x];
                    count += 1;
                }
            }
            means.push(sum / count.max(1) as f32);
        }
    }
    means
}

/// Relative tile-mean deltas against the mean of the last three readings.
#[derive(Debug, Clone, Default)]
pub struct ConvergenceTracker {
    history: VecDeque<Vec<f32>>,
    tile_size: u32,
}

impl ConvergenceTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.history.clear();
        self.tile_size = 0;
    }

    /// Records one metrics reading (native `read_accumulation_metrics`).
    pub fn update(
        &mut self,
        luminance: &[f32],
        lum_width: u32,
        lum_height: u32,
        tile_size: u32,
        target_variance: f32,
        total_samples: u32,
    ) -> Result<OfflineMetrics> {
        if tile_size == 0 {
            return Err(Forge3dError::InvalidInput {
                field: "tileSize".to_string(),
                message: "must be >= 1".to_string(),
            });
        }
        if !target_variance.is_finite() {
            return Err(Forge3dError::InvalidInput {
                field: "targetVariance".to_string(),
                message: "must be finite".to_string(),
            });
        }
        if total_samples == 0 {
            return Err(Forge3dError::InvalidInput {
                field: "totalSamples".to_string(),
                message: "Cannot read accumulation metrics before rendering any samples"
                    .to_string(),
            });
        }
        let expected = (lum_width as usize) * (lum_height as usize);
        if luminance.len() != expected {
            return Err(Forge3dError::InvalidInput {
                field: "luminance".to_string(),
                message: format!("expected {expected} samples, got {}", luminance.len()),
            });
        }
        let means = tile_luminance_means(luminance, lum_width, lum_height, tile_size);
        let compatible = self.tile_size == tile_size
            && !self.history.is_empty()
            && self.history.iter().all(|entry| entry.len() == means.len());
        let deltas: Vec<f32> = if compatible {
            means
                .iter()
                .enumerate()
                .map(|(index, current)| {
                    let baseline = self.history.iter().map(|entry| entry[index]).sum::<f32>()
                        / self.history.len() as f32;
                    let denom = current.abs().max(baseline.abs()).max(LUMINANCE_EPSILON);
                    (current - baseline).abs() / denom
                })
                .collect()
        } else {
            vec![1.0; means.len()]
        };
        self.history.push_back(means);
        if self.history.len() > METRIC_HISTORY_WINDOW {
            self.history.pop_front();
        }
        self.tile_size = tile_size;
        Ok(summarize_deltas(&deltas, target_variance, total_samples))
    }
}

fn summarize_deltas(deltas: &[f32], target_variance: f32, total_samples: u32) -> OfflineMetrics {
    let mut sorted = deltas.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mean_delta = if deltas.is_empty() {
        0.0
    } else {
        deltas.iter().sum::<f32>() / deltas.len() as f32
    };
    let p95_index = if sorted.is_empty() {
        0
    } else {
        ((sorted.len() - 1) as f32 * 0.95).round() as usize
    };
    let threshold = target_variance.max(0.0);
    let converged = deltas.iter().filter(|delta| **delta < threshold).count();
    OfflineMetrics {
        total_samples,
        mean_delta,
        p95_delta: sorted.get(p95_index).copied().unwrap_or(0.0),
        max_tile_delta: sorted.last().copied().unwrap_or(0.0),
        converged_tile_ratio: if deltas.is_empty() {
            1.0
        } else {
            converged as f32 / deltas.len() as f32
        },
    }
}

/// Native `_has_upward_convergence_trend` over the converged-tile ratios.
pub fn has_upward_convergence_trend(ratios: &[f32]) -> bool {
    if ratios.len() < CONVERGENCE_TREND_WINDOW {
        return false;
    }
    let window = &ratios[ratios.len() - CONVERGENCE_TREND_WINDOW..];
    let rising: f32 = window.windows(2).map(|pair| pair[1] - pair[0]).sum();
    window[window.len() - 1] >= window[0] - 1e-3 && rising >= -1e-3
}
