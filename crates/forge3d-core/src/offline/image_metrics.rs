//! Image comparison metrics for offline acceptance: MSE, PSNR (native
//! `test_tv12_offline_quality._psnr`) and Gaussian-window SSIM (11 taps,
//! sigma 1.5, the same estimator as the W04 parity harness).

use crate::error::{Forge3dError, Result};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageMetrics {
    pub mse: f64,
    pub psnr: f64,
    pub ssim: f64,
    pub max_abs: f64,
}

/// Compares two interleaved images channel by channel.
///
/// `compare_channels` of the `channels` interleaved lanes enter the metrics
/// (e.g. 3 of 4 to ignore alpha); `data_range` is the SSIM dynamic range.
pub fn compare_images(
    a: &[f32],
    b: &[f32],
    width: u32,
    height: u32,
    channels: u32,
    compare_channels: u32,
    data_range: f64,
) -> Result<ImageMetrics> {
    let pixels = width as usize * height as usize;
    if pixels == 0 || channels == 0 || compare_channels == 0 || compare_channels > channels {
        return Err(invalid(
            "compare_images requires a non-empty image and 1..=channels compared lanes",
        ));
    }
    let expected = pixels * channels as usize;
    if a.len() != expected || b.len() != expected {
        return Err(invalid(&format!(
            "expected {expected} values per image, got {} and {}",
            a.len(),
            b.len()
        )));
    }
    if !(data_range.is_finite() && data_range > 0.0) {
        return Err(invalid("data_range must be finite and > 0"));
    }
    let mut sum_sq = 0.0f64;
    let mut max_abs = 0.0f64;
    let mut peak = 0.0f64;
    let stride = channels as usize;
    for p in 0..pixels {
        for c in 0..compare_channels as usize {
            let x = f64::from(a[p * stride + c]);
            let y = f64::from(b[p * stride + c]);
            let d = x - y;
            sum_sq += d * d;
            max_abs = max_abs.max(d.abs());
            peak = peak.max(x).max(y);
        }
    }
    let mse = sum_sq / (pixels * compare_channels as usize) as f64;
    let psnr = if mse <= 1e-10 {
        99.0
    } else {
        20.0 * (peak.max(1e-6) / mse.sqrt()).log10()
    };
    let weights = gaussian_window(11, 1.5);
    let mut ssim_total = 0.0f64;
    for c in 0..compare_channels as usize {
        let lane_a: Vec<f64> = (0..pixels).map(|p| f64::from(a[p * stride + c])).collect();
        let lane_b: Vec<f64> = (0..pixels).map(|p| f64::from(b[p * stride + c])).collect();
        ssim_total += ssim_channel(
            &lane_a,
            &lane_b,
            width as usize,
            height as usize,
            &weights,
            data_range,
        );
    }
    Ok(ImageMetrics {
        mse,
        psnr,
        ssim: ssim_total / compare_channels as f64,
        max_abs,
    })
}

pub fn gaussian_window(size: usize, sigma: f64) -> Vec<f64> {
    let half = (size / 2) as i64;
    let raw: Vec<f64> = (-half..=half)
        .map(|k| (-((k * k) as f64) / (2.0 * sigma * sigma)).exp())
        .collect();
    let total: f64 = raw.iter().sum();
    raw.into_iter().map(|w| w / total).collect()
}

fn filter(channel: &[f64], width: usize, height: usize, weights: &[f64]) -> Vec<f64> {
    let half = (weights.len() / 2) as i64;
    let mut temp = vec![0.0; channel.len()];
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0.0;
            for k in -half..=half {
                let sx = x as i64 + k;
                if sx < 0 || sx >= width as i64 {
                    continue;
                }
                sum += channel[y * width + sx as usize] * weights[(k + half) as usize];
            }
            temp[y * width + x] = sum;
        }
    }
    let mut out = vec![0.0; channel.len()];
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0.0;
            for k in -half..=half {
                let sy = y as i64 + k;
                if sy < 0 || sy >= height as i64 {
                    continue;
                }
                sum += temp[sy as usize * width + x] * weights[(k + half) as usize];
            }
            out[y * width + x] = sum;
        }
    }
    out
}

fn ssim_channel(
    a: &[f64],
    b: &[f64],
    width: usize,
    height: usize,
    weights: &[f64],
    range: f64,
) -> f64 {
    let c1 = (0.01 * range).powi(2);
    let c2 = (0.03 * range).powi(2);
    let a_sq: Vec<f64> = a.iter().map(|v| v * v).collect();
    let b_sq: Vec<f64> = b.iter().map(|v| v * v).collect();
    let ab: Vec<f64> = a.iter().zip(b).map(|(x, y)| x * y).collect();
    let mu_a = filter(a, width, height, weights);
    let mu_b = filter(b, width, height, weights);
    let sigma_a = filter(&a_sq, width, height, weights);
    let sigma_b = filter(&b_sq, width, height, weights);
    let sigma_ab = filter(&ab, width, height, weights);
    let mut total = 0.0;
    for i in 0..a.len() {
        let mu_a2 = mu_a[i] * mu_a[i];
        let mu_b2 = mu_b[i] * mu_b[i];
        let var_a = sigma_a[i] - mu_a2;
        let var_b = sigma_b[i] - mu_b2;
        let cov = sigma_ab[i] - mu_a[i] * mu_b[i];
        total += ((2.0 * mu_a[i] * mu_b[i] + c1) * (2.0 * cov + c2))
            / ((mu_a2 + mu_b2 + c1) * (var_a + var_b + c2));
    }
    total / a.len() as f64
}

fn invalid(message: &str) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: "images".to_string(),
        message: message.to_string(),
    }
}
