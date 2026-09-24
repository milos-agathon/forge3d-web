use glam::{Mat4, Vec4};

use super::denoise::{atrous_denoise, AtrousGuides, AtrousParams};
use super::image_metrics::compare_images;
use super::jitter::{halton, halton_2_3, jitter_clip_matrix, JitterSequence};
use super::metrics::{
    downsample_luminance, has_upward_convergence_trend, luminance_dimensions, tile_luminance_means,
    ConvergenceTracker,
};
use super::tonemap::{
    filmic_terrain, linear_to_srgb, quantize_unorm8, tonemap_rgb, DisplayEncode, TonemapOperator,
};

#[test]
fn halton_matches_native_radical_inverse() {
    assert!((halton(1, 2) - 0.5).abs() < 1e-6);
    assert!((halton(2, 2) - 0.25).abs() < 1e-6);
    assert!((halton(3, 2) - 0.75).abs() < 1e-6);
    assert!((halton(1, 3) - 1.0 / 3.0).abs() < 1e-6);
    assert!((halton(3, 3) - 1.0 / 9.0).abs() < 1e-6);
    for i in 0..16 {
        let [x, y] = halton_2_3(i, 8);
        assert!((-0.5..=0.5).contains(&x) && (-0.5..=0.5).contains(&y));
    }
}

#[test]
fn r2_sequence_reproduces_native_offsets() {
    let single = JitterSequence::new(1, Some(9));
    assert_eq!(single.len(), 1);
    assert_eq!(single.get(0), [0.0, 0.0]);

    let unseeded = JitterSequence::new(4, None);
    assert_eq!(unseeded.get(0), [-0.5, -0.5]);
    // n = 1: frac(1 / phi2) - 0.5, frac(1 / phi2^2) - 0.5 (native f64 then f32).
    let [x1, y1] = unseeded.get(1);
    assert!((x1 - (0.754_877_666_246_692_7_f32 - 0.5)).abs() < 1e-7);
    assert!((y1 - (0.569_840_290_998_053_2_f32 - 0.5)).abs() < 1e-7);

    let seeded_a = JitterSequence::new(64, Some(42));
    let seeded_b = JitterSequence::new(64, Some(42));
    assert_eq!(seeded_a, seeded_b);
    assert_ne!(seeded_a.get(0), unseeded.get(0));
    // Seed 42 starts at n = 21.
    let alpha1 = 1.0 / 1.324_717_957_244_746_025_96_f64;
    let expected_x = ((21.0 * alpha1) % 1.0) as f32 - 0.5;
    assert_eq!(seeded_a.get(0)[0], expected_x);
    for offset in seeded_a.offsets() {
        assert!((-0.5..=0.5).contains(&offset[0]));
        assert!((-0.5..=0.5).contains(&offset[1]));
    }

    let mut cursor = JitterSequence::new(3, None);
    let first = cursor.next_offset();
    cursor.next_offset();
    cursor.next_offset();
    assert_eq!(cursor.next_offset(), first, "the sequence wraps");
}

#[test]
fn jitter_matches_native_perspective_formula_and_shifts_orthographic() {
    let perspective = Mat4::perspective_rh(0.9, 1.5, 0.1, 100.0);
    let jittered = jitter_clip_matrix(perspective, [0.25, -0.5], 200, 100);
    let mut native = perspective;
    native.col_mut(2).x += (2.0 * 0.25 / 200.0) * perspective.col(2).w;
    native.col_mut(2).y += (2.0 * -0.5 / 100.0) * perspective.col(2).w;
    assert_eq!(jittered, native);

    let ortho = Mat4::orthographic_rh(-1.0, 1.0, -1.0, 1.0, 0.1, 10.0);
    let shifted = jitter_clip_matrix(ortho, [0.5, 0.5], 100, 50);
    let p = Vec4::new(0.2, -0.3, -2.0, 1.0);
    let delta = shifted * p - ortho * p;
    assert!((delta.x - 2.0 * 0.5 / 100.0).abs() < 1e-6);
    assert!((delta.y - 2.0 * 0.5 / 50.0).abs() < 1e-6);

    // Pixel-space motion: a half-pixel jitter moves NDC by one pixel's width / 2.
    let clip = jittered * Vec4::new(0.0, 0.0, -5.0, 1.0);
    let base = perspective * Vec4::new(0.0, 0.0, -5.0, 1.0);
    let ndc_dx = clip.x / clip.w - base.x / base.w;
    assert!((ndc_dx - 2.0 * 0.25 / 200.0).abs() < 1e-6);
}

#[test]
fn luminance_downsample_and_tile_means_follow_native_blocks() {
    let (w, h) = (6, 5);
    let mut sum = vec![0.0f32; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            // Two accumulated samples of a constant white pixel.
            sum[i] = 2.0;
            sum[i + 1] = 2.0;
            sum[i + 2] = 2.0;
            sum[i + 3] = 2.0;
        }
    }
    let (lw, lh) = luminance_dimensions(w, h);
    assert_eq!((lw, lh), (2, 2));
    let lum = downsample_luminance(&sum, w, h, 2);
    assert_eq!(lum.len(), 4);
    for value in &lum {
        assert!((value - 1.0).abs() < 1e-6);
    }

    let grid = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
    assert_eq!(tile_luminance_means(&grid, 3, 2, 2), vec![3.0, 4.5]);
    assert_eq!(tile_luminance_means(&grid, 3, 2, 8), vec![3.5]);
}

#[test]
fn convergence_tracker_matches_native_history_semantics() {
    let mut tracker = ConvergenceTracker::new();
    let flat = vec![0.5f32; 16];
    let first = tracker.update(&flat, 4, 4, 2, 0.002, 4).unwrap();
    // No history: every tile reports a unit delta.
    assert_eq!(first.converged_tile_ratio, 0.0);
    assert_eq!(first.mean_delta, 1.0);
    assert_eq!(first.p95_delta, 1.0);
    assert_eq!(first.max_tile_delta, 1.0);
    assert_eq!(first.total_samples, 4);

    let second = tracker.update(&flat, 4, 4, 2, 0.002, 8).unwrap();
    assert_eq!(second.converged_tile_ratio, 1.0);
    assert_eq!(second.mean_delta, 0.0);

    // A tile-size change resets comparability.
    let resized = tracker.update(&flat, 4, 4, 4, 0.002, 12).unwrap();
    assert_eq!(resized.converged_tile_ratio, 0.0);

    // Relative delta against the mean of the last three readings.
    let mut tracker = ConvergenceTracker::new();
    tracker.update(&[1.0], 1, 1, 1, 0.1, 1).unwrap();
    tracker.update(&[1.0], 1, 1, 1, 0.1, 2).unwrap();
    tracker.update(&[1.0], 1, 1, 1, 0.1, 3).unwrap();
    let moved = tracker.update(&[1.5], 1, 1, 1, 0.1, 4).unwrap();
    assert!((moved.mean_delta - (0.5 / 1.5)).abs() < 1e-6);
    assert_eq!(moved.converged_tile_ratio, 0.0);

    // p95 index uses round((n - 1) * 0.95).
    let mut tracker = ConvergenceTracker::new();
    let base: Vec<f32> = (0..20).map(|_| 1.0).collect();
    tracker.update(&base, 20, 1, 1, 0.5, 1).unwrap();
    let varied: Vec<f32> = (0..20).map(|i| 1.0 + i as f32 * 0.01).collect();
    let metrics = tracker.update(&varied, 20, 1, 1, 0.05, 2).unwrap();
    let mut deltas: Vec<f32> = varied.iter().map(|v| (v - 1.0).abs() / v).collect();
    deltas.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(metrics.p95_delta, deltas[18]);
    assert_eq!(metrics.max_tile_delta, deltas[19]);

    assert!(tracker.update(&flat, 4, 4, 0, 0.002, 1).is_err());
    assert!(tracker.update(&flat, 4, 4, 2, 0.002, 0).is_err());
    assert!(tracker.update(&flat, 3, 4, 2, 0.002, 1).is_err());
}

#[test]
fn convergence_trend_rule_matches_native_window() {
    assert!(!has_upward_convergence_trend(&[0.0, 0.5]));
    assert!(has_upward_convergence_trend(&[0.0, 0.5, 0.9]));
    assert!(has_upward_convergence_trend(&[0.9, 0.9, 0.9]));
    assert!(!has_upward_convergence_trend(&[0.9, 0.5, 0.2]));
    assert!(has_upward_convergence_trend(&[0.1, 0.9, 0.5, 0.6, 0.7]));
}

#[test]
fn tonemap_operators_match_native_curves() {
    assert!(filmic_terrain(0.0).abs() < 1e-6);
    assert!((filmic_terrain(11.2) - 1.0).abs() < 1e-5);
    assert!((linear_to_srgb(1.0) - 1.0).abs() < 1e-6);
    assert!((linear_to_srgb(0.002) - 0.002 * 12.92).abs() < 1e-7);

    let display = tonemap_rgb(
        [0.25, 1.5, -0.1],
        TonemapOperator::Display,
        4.0,
        DisplayEncode::Linear,
    );
    assert_eq!(display, [0.25, 1.0, 0.0]);
    let screen = tonemap_rgb(
        [0.5, 0.5, 0.5],
        TonemapOperator::Display,
        4.0,
        DisplayEncode::ScreenFilmic,
    );
    assert!((screen[0] - filmic_terrain(0.5).powf(1.0 / 2.2)).abs() < 1e-6);
    let srgb = tonemap_rgb(
        [0.2, 0.2, 0.2],
        TonemapOperator::Display,
        4.0,
        DisplayEncode::LinearSrgb,
    );
    assert!((srgb[0] - linear_to_srgb(0.2)).abs() < 1e-6);

    let reinhard = tonemap_rgb(
        [1.0, 0.0, 3.0],
        TonemapOperator::Reinhard,
        4.0,
        DisplayEncode::Linear,
    );
    assert!((reinhard[0] - linear_to_srgb(0.5)).abs() < 1e-6);
    assert_eq!(reinhard[1], 0.0);
    for name in [
        "display",
        "reinhard",
        "reinhard-extended",
        "aces",
        "uncharted2",
        "exposure",
        "filmic-terrain",
    ] {
        let op = TonemapOperator::parse(name).unwrap();
        assert_eq!(op.name(), name);
    }
    assert!(TonemapOperator::parse("filmic").is_err());
    assert_eq!(quantize_unorm8(0.5), 128);
    assert_eq!(quantize_unorm8(2.0), 255);
    assert_eq!(quantize_unorm8(-1.0), 0);
}

fn lcg(state: &mut u64) -> f32 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    ((*state >> 40) as f32) / ((1u64 << 24) as f32)
}

/// `offline-denoise-v1`-style synthetic scene: two albedo regions split by a
/// hard edge, smooth shading, plus clean albedo/normal guides.
fn synthetic_scene(width: u32, height: u32) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let mut color = Vec::new();
    let mut albedo = Vec::new();
    let mut normal = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let left = x < width / 2;
            let a = if left {
                [0.8, 0.35, 0.2]
            } else {
                [0.15, 0.45, 0.9]
            };
            let shade = 0.6 + 0.4 * (y as f32 / height as f32);
            color.extend(a.iter().map(|c| c * shade * 1.4));
            albedo.extend(a);
            normal.extend(if left {
                [0.0, 1.0, 0.0]
            } else {
                [0.6, 0.8, 0.0]
            });
        }
    }
    (color, albedo, normal)
}

#[test]
fn atrous_denoiser_meets_offline_denoise_acceptance() {
    let (w, h) = (96u32, 64u32);
    let (clean, albedo, normal) = synthetic_scene(w, h);
    let mut state = 0x5eed_u64;
    let noisy: Vec<f32> = clean
        .iter()
        .map(|c| (c + (lcg(&mut state) - 0.5) * 0.3).max(0.0))
        .collect();
    let guides = AtrousGuides {
        albedo: Some(&albedo),
        normal: Some(&normal),
        depth: None,
    };
    let params = AtrousParams::default();
    let range = 1.4;

    let before = compare_images(&noisy, &clean, w, h, 3, 3, range).unwrap();
    let denoised = atrous_denoise(&noisy, w, h, guides, params).unwrap();
    let after = compare_images(&denoised, &clean, w, h, 3, 3, range).unwrap();
    assert!(
        after.ssim - before.ssim >= 0.02,
        "noisy SSIM gain {} -> {}",
        before.ssim,
        after.ssim
    );
    assert!(
        after.mse <= before.mse * 0.8,
        "noisy MSE reduction {} -> {}",
        before.mse,
        after.mse
    );

    let converged = atrous_denoise(&clean, w, h, guides, params).unwrap();
    let regression = compare_images(&converged, &clean, w, h, 3, 3, range).unwrap();
    assert!(
        1.0 - regression.ssim <= 0.005,
        "converged SSIM regression {}",
        1.0 - regression.ssim
    );

    // Edges survive: the albedo guide keeps the two regions apart.
    let row = (h / 2 * w) as usize;
    let left = denoised[(row + (w / 2 - 2) as usize) * 3];
    let right = denoised[(row + (w / 2 + 1) as usize) * 3];
    assert!(left - right > 0.5, "edge collapsed: {left} vs {right}");
}

/// Smooth hillshade-like detail under a constant albedo: the NumPy weights
/// blur it, the edge-stopping term keeps the converged image intact.
#[test]
fn edge_stopping_preserves_converged_detail_and_zero_matches_native_weights() {
    let (w, h) = (80u32, 60u32);
    let mut clean = Vec::new();
    let albedo = vec![0.6f32; (w * h * 3) as usize];
    let normal: Vec<f32> = (0..w * h).flat_map(|_| [0.0f32, 1.0, 0.0]).collect();
    for y in 0..h {
        for x in 0..w {
            let shade = 0.5
                + 0.3 * (x as f32 * 0.35).sin() * (y as f32 * 0.21).cos()
                + 0.1 * (y as f32 / h as f32);
            clean.extend([shade * 0.9, shade * 0.8, shade * 0.6]);
        }
    }
    let guides = AtrousGuides {
        albedo: Some(&albedo),
        normal: Some(&normal),
        depth: None,
    };
    let native = AtrousParams {
        edge_stopping: 0.0,
        ..AtrousParams::default()
    };
    let blurred = atrous_denoise(&clean, w, h, guides, native).unwrap();
    let kept = atrous_denoise(&clean, w, h, guides, AtrousParams::default()).unwrap();
    let native_regression = 1.0
        - compare_images(&blurred, &clean, w, h, 3, 3, 1.0)
            .unwrap()
            .ssim;
    let kept_regression = 1.0 - compare_images(&kept, &clean, w, h, 3, 3, 1.0).unwrap().ssim;
    assert!(
        native_regression > 0.01,
        "native weights blur detail: {native_regression}"
    );
    assert!(
        kept_regression <= 0.005,
        "edge stopping regression {kept_regression}"
    );

    // With noise the edge-stopping denoiser still meets the acceptance.
    let mut state = 0xfeed_u64;
    let noisy: Vec<f32> = clean
        .iter()
        .map(|c| (c + (lcg(&mut state) - 0.5) * 0.25).max(0.0))
        .collect();
    let before = compare_images(&noisy, &clean, w, h, 3, 3, 1.0).unwrap();
    let after = compare_images(
        &atrous_denoise(&noisy, w, h, guides, AtrousParams::default()).unwrap(),
        &clean,
        w,
        h,
        3,
        3,
        1.0,
    )
    .unwrap();
    assert!(
        after.ssim - before.ssim >= 0.02,
        "{} -> {}",
        before.ssim,
        after.ssim
    );
    assert!(after.mse <= before.mse * 0.8);
}

#[test]
fn noise_estimate_tracks_gaussian_like_noise_and_ignores_flat_images() {
    use super::denoise::estimate_noise_sigma;
    let (w, h) = (64u32, 64u32);
    let flat = vec![0.5f32; (w * h * 4) as usize];
    assert_eq!(estimate_noise_sigma(&flat, w, h, 4), 0.0);
    assert_eq!(estimate_noise_sigma(&[0.0; 12], 2, 2, 3), 0.0);
    // Sum of four uniforms approximates a Gaussian with sigma 0.1.
    let mut state = 7u64;
    let mut noisy = Vec::new();
    for _ in 0..w * h {
        let n: f32 =
            (0..4).map(|_| lcg(&mut state) - 0.5).sum::<f32>() * (0.1 / (4.0f32 / 12.0).sqrt());
        noisy.extend([0.5 + n, 0.5 + n, 0.5 + n]);
    }
    let sigma = estimate_noise_sigma(&noisy, w, h, 3);
    assert!((sigma - 0.1).abs() < 0.03, "estimated {sigma}");
}

#[test]
fn atrous_denoiser_validates_inputs_and_uses_depth_guidance() {
    let (w, h) = (8u32, 4u32);
    let color = vec![0.5f32; (w * h * 3) as usize];
    assert!(atrous_denoise(
        &color[1..],
        w,
        h,
        AtrousGuides::default(),
        AtrousParams::default()
    )
    .is_err());
    let bad = AtrousParams {
        iterations: 11,
        ..AtrousParams::default()
    };
    assert!(atrous_denoise(&color, w, h, AtrousGuides::default(), bad).is_err());
    let nan = vec![f32::NAN; (w * h * 3) as usize];
    assert!(atrous_denoise(&nan, w, h, AtrousGuides::default(), AtrousParams::default()).is_err());

    // Depth guidance keeps a depth discontinuity sharp even with a flat guide.
    let mut split = Vec::new();
    let mut depth = Vec::new();
    for _y in 0..h {
        for x in 0..w {
            let near = x < w / 2;
            split.extend(if near {
                [1.0, 1.0, 1.0]
            } else {
                [0.0, 0.0, 0.0]
            });
            depth.push(if near { 0.1 } else { 0.9 });
        }
    }
    let flat = vec![0.5f32; (w * h * 3) as usize];
    let guided = atrous_denoise(
        &split,
        w,
        h,
        AtrousGuides {
            albedo: Some(&flat),
            normal: None,
            depth: Some(&depth),
        },
        AtrousParams::default(),
    )
    .unwrap();
    assert!(guided[0] > 0.99);
    assert!(guided[((w - 1) * 3) as usize] < 0.01);
}

#[test]
fn image_metrics_report_identity_and_known_errors() {
    let a = vec![0.25f32, 0.5, 0.75, 1.0, 0.1, 0.2, 0.3, 1.0];
    let same = compare_images(&a, &a, 2, 1, 4, 3, 1.0).unwrap();
    assert_eq!(same.mse, 0.0);
    assert_eq!(same.psnr, 99.0);
    assert!((same.ssim - 1.0).abs() < 1e-12);
    let mut b = a.clone();
    b[0] += 0.1;
    let diff = compare_images(&a, &b, 2, 1, 4, 3, 1.0).unwrap();
    assert!((diff.mse - 0.01 / 6.0).abs() < 1e-9);
    assert!((diff.max_abs - 0.1).abs() < 1e-6);
    assert!(compare_images(&a, &b[1..], 2, 1, 4, 3, 1.0).is_err());
    assert!(compare_images(&a, &b, 2, 1, 4, 5, 1.0).is_err());
}
