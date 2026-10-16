//! W08/T08 clipmap tests — ports of native `test_clipmap_structure.py`,
//! `test_geomorph_seams.py` and `test_gpu_lod_selection.py` assertions plus
//! crack-free-by-construction verification (A2/A3/A4).

use super::*;

use glam::{Mat4, Vec3};

fn lod_height(x: f32, z: f32, lod: u32) -> f32 {
    // LOD-dependent analytic height: blends between lods must be consistent
    // at shared boundary vertices (both sides evaluate the same LODs).
    (x * 0.01).sin() * 50.0 + (z * 0.02).cos() * 40.0 + lod as f32 * 7.0
}

fn ring_lod(ring: u32) -> u32 {
    ring
}

fn fixture_config() -> ClipmapConfig {
    ClipmapConfig::new(8, 64, 64, 10.0, 0.3).unwrap()
}

fn gen(config: &ClipmapConfig, s0: f32, camera: [f32; 2]) -> (ClipmapLayout, ClipmapMesh) {
    let layout = ClipmapLayout::for_camera(config, s0, [0.0, 0.0], camera);
    let mesh = ClipmapMesh::generate(config, &layout);
    (layout, mesh)
}

// ---------------------------------------------------------------- config --

#[test]
fn test_clipmap_config_valid() {
    let config = ClipmapConfig::default();
    assert_eq!(config.ring_count, 4);
    assert_eq!(config.ring_resolution, 64);
    assert_eq!(config.center_resolution, 64);
    assert_eq!(config.skirt_depth, 10.0);
    assert_eq!(config.morph_range, 0.3);
    assert!(config.validate().is_ok());

    let custom = ClipmapConfig::new(6, 32, 48, 5.0, 0.5).unwrap();
    assert_eq!(custom.ring_count, 6);
    assert_eq!(custom.ring_resolution, 32);
    assert_eq!(custom.center_resolution, 48);
    assert_eq!(custom.skirt_depth, 5.0);
    assert_eq!(custom.morph_range, 0.5);
}

#[test]
fn test_clipmap_config_validation() {
    assert!(ClipmapConfig::new(0, 64, 64, 10.0, 0.3).is_err());
    assert!(ClipmapConfig::new(17, 64, 64, 10.0, 0.3).is_err());
    assert!(ClipmapConfig::new(4, 63, 64, 10.0, 0.3).is_err());
    assert!(ClipmapConfig::new(4, 2, 64, 10.0, 0.3).is_err());
    assert!(ClipmapConfig::new(4, 64, 63, 10.0, 0.3).is_err());
    assert!(ClipmapConfig::new(4, 64, 2, 10.0, 0.3).is_err());
    assert!(ClipmapConfig::new(4, 64, 64, -1.0, 0.3).is_err());
    assert!(ClipmapConfig::new(4, 64, 64, f32::NAN, 0.3).is_err());
    assert!(ClipmapConfig::new(4, 64, 64, 10.0, f32::NAN).is_err());

    // morph_range clamps like native with_morph_range.
    let clamped = ClipmapConfig::new(4, 64, 64, 10.0, 1.5).unwrap();
    assert_eq!(clamped.morph_range, 1.0);
    let clamped = ClipmapConfig::new(4, 64, 64, 10.0, -0.2).unwrap();
    assert_eq!(clamped.morph_range, 0.0);

    // Error kind/field conventions.
    let err = ClipmapConfig::new(0, 64, 64, 10.0, 0.3).unwrap_err();
    match err {
        crate::error::Forge3dError::InvalidInput { field, .. } => {
            assert_eq!(field, "clipmap.ring_count")
        }
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

// ------------------------------------------------------------- geomorph --

#[test]
fn test_morph_weight_native_formula() {
    // Native calculate_morph_weight semantics.
    assert_eq!(calculate_morph_weight(10.0, 0.0, 0.5), 0.0);
    assert_eq!(calculate_morph_weight(10.0, -1.0, 0.5), 0.0);
    assert_eq!(calculate_morph_weight(10.0, 100.0, 0.0), 0.0);
    // t <= 1 - m -> 0.
    assert_eq!(calculate_morph_weight(50.0, 100.0, 0.3), 0.0);
    assert_eq!(calculate_morph_weight(70.0, 100.0, 0.3), 0.0);
    // Transition region.
    let w = calculate_morph_weight(85.0, 100.0, 0.3);
    assert!((w - 0.5).abs() < 1e-6);
    // Outer boundary -> 1.
    assert_eq!(calculate_morph_weight(100.0, 100.0, 0.3), 1.0);
    assert_eq!(calculate_morph_weight(200.0, 100.0, 0.3), 1.0);
    assert_eq!(calculate_morph_weight(0.0, 100.0, 0.3), 0.0);
}

// ------------------------------------------------------------- structure --

#[test]
fn test_generate_terrain_mesh_valid() {
    let config = ClipmapConfig::default();
    let data = clipmap_generate(&config, [0.0, 0.0], 1000.0);
    assert!(data.vertex_count > 0);
    assert!(data.index_count > 0);
    assert_eq!(data.index_count % 3, 0);
    assert_eq!(data.index_count, data.indices.len() as u32);
    assert_eq!(data.vertex_count, data.positions.len() as u32);
    assert!(data
        .indices
        .iter()
        .all(|&i| (i as usize) < data.positions.len()));
}

#[test]
fn test_generate_terrain_mesh_different_centers() {
    let config = ClipmapConfig::default();
    let counts: Vec<(u32, u32)> = [[0.0, 0.0], [100.0, 100.0], [-100.0, -100.0], [500.0, 500.0]]
        .iter()
        .map(|&c| {
            let d = clipmap_generate(&config, c, 1000.0);
            (d.vertex_count, d.index_count)
        })
        .collect();
    assert!(counts.windows(2).all(|w| w[0] == w[1]));
    assert!(counts[0].0 > 0 && counts[0].1 > 0);
}

#[test]
fn test_generate_terrain_mesh_different_extents() {
    let config = ClipmapConfig::default();
    let counts: Vec<u32> = [1000.0, 5000.0, 10000.0]
        .iter()
        .map(|&e| clipmap_generate(&config, [0.0, 0.0], e).vertex_count)
        .collect();
    assert!(counts.windows(2).all(|w| w[0] == w[1]));
}

#[test]
fn test_triangle_reduction() {
    let config = ClipmapConfig::default();
    let data = clipmap_generate(&config, [0.0, 0.0], 1000.0);
    assert!(data.triangle_count > 0);
    assert!(data.triangle_reduction_percent > 40.0);

    assert_eq!(calculate_triangle_reduction(1000, 500), 50.0);
    assert_eq!(calculate_triangle_reduction(1000, 1000), 0.0);
    assert_eq!(calculate_triangle_reduction(0, 100), 0.0);
}

#[test]
fn test_triangle_reduction_across_ring_counts() {
    for rings in [2u32, 6] {
        let config = ClipmapConfig::new(rings, 32, 32, 10.0, 0.3).unwrap();
        let data = clipmap_generate(&config, [0.0, 0.0], 1000.0);
        assert!(
            data.triangle_reduction_percent >= 40.0,
            "rings {rings} reduction {}",
            data.triangle_reduction_percent
        );
    }
    // More rings must never collapse the reduction (>10%/20% drops).
    let r2 = clipmap_generate(
        &ClipmapConfig::new(2, 32, 32, 10.0, 0.3).unwrap(),
        [0.0, 0.0],
        1000.0,
    )
    .triangle_reduction_percent;
    let r6 = clipmap_generate(
        &ClipmapConfig::new(6, 32, 32, 10.0, 0.3).unwrap(),
        [0.0, 0.0],
        1000.0,
    )
    .triangle_reduction_percent;
    assert!(r6 >= r2 * 0.9);
}

#[test]
fn test_ring_vs_center_size() {
    let config = ClipmapConfig::default();
    let extent = 1000.0f32;
    let s0 = extent / (config.center_resolution as f32 * 8.0);
    let data = clipmap_generate(&config, [0.0, 0.0], extent);
    let dist_units = |i: usize| {
        let p = data.positions[i];
        (p[0] * p[0] + p[1] * p[1]).sqrt() / s0
    };
    // Center block: all vertices inside ring-0 hole (|units| <= Hc).
    let center_count = ((config.center_resolution + 1) * (config.center_resolution + 1)) as usize;
    let center_max = (0..center_count).map(dist_units).fold(0.0f32, f32::max);
    let ring0_outer = (config.ring_outer_half_cells(0) * 2) as f32;
    assert!(center_max <= config.center_resolution as f32 * 0.75 + 1.0);
    // Skirt verts of the last ring sit at the outermost footprint.
    let last_ring_skirt_max = data
        .morph_data
        .iter()
        .enumerate()
        .filter(|(_, m)| m[0] == -1.0 && m[1] == config.ring_count as f32 - 1.0)
        .map(|(i, _)| dist_units(i))
        .fold(0.0f32, f32::max);
    assert!(last_ring_skirt_max > ring0_outer);
    assert!(last_ring_skirt_max > center_max * 5.0);
}

#[test]
fn test_uv_bounds() {
    let config = ClipmapConfig::default();
    let data = clipmap_generate(&config, [0.0, 0.0], 1000.0);
    for uv in &data.uvs {
        assert!(uv[0] >= 0.0 && uv[0] <= 1.0);
        assert!(uv[1] >= 0.0 && uv[1] <= 1.0);
    }
}

#[test]
fn test_morph_weights() {
    let config = ClipmapConfig::default();
    let data = clipmap_generate(&config, [0.0, 0.0], 1000.0);
    for m in &data.morph_data {
        if m[0] == -1.0 {
            continue; // skirt
        }
        assert!(m[0] >= 0.0 && m[0] <= 1.0, "morph {}", m[0]);
    }

    let no_morph = ClipmapConfig::new(4, 64, 64, 10.0, 0.0).unwrap();
    let data = clipmap_generate(&no_morph, [0.0, 0.0], 1000.0);
    assert!(data.morph_data.iter().all(|m| m[0] == -1.0 || m[0] == 0.0));

    let full_morph = ClipmapConfig::new(4, 64, 64, 10.0, 1.0).unwrap();
    let data = clipmap_generate(&full_morph, [0.0, 0.0], 1000.0);
    let weights: Vec<f32> = data
        .morph_data
        .iter()
        .filter(|m| m[0] >= 0.0)
        .map(|m| m[0])
        .collect();
    let (lo, hi) = weights
        .iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), &w| (lo.min(w), hi.max(w)));
    assert!(hi - lo > 0.5, "morph range {lo}..{hi}");
    assert!(data.morph_data.iter().any(|m| m[0] < 0.0)); // skirts exist
}

#[test]
fn test_mesh_topology() {
    let config = ClipmapConfig::default();
    let data = clipmap_generate(&config, [500.0, 500.0], 1000.0);
    assert!(data
        .indices
        .iter()
        .all(|&i| (i as usize) < data.positions.len()));
    // Center of mass of non-skirt vertices near the camera.
    let mut sum = [0.0f64; 2];
    let mut count = 0usize;
    for (p, m) in data.positions.iter().zip(&data.morph_data) {
        if m[0] >= 0.0 {
            sum[0] += p[0] as f64;
            sum[1] += p[1] as f64;
            count += 1;
        }
    }
    let com = [sum[0] / count as f64, sum[1] / count as f64];
    assert!((com[0] - 500.0).abs() < 200.0, "com x {}", com[0]);
    assert!((com[1] - 500.0).abs() < 200.0, "com z {}", com[1]);
}

#[test]
fn test_dominant_winding() {
    let config = ClipmapConfig::default();
    let data = clipmap_generate(&config, [0.0, 0.0], 1000.0);
    let mut positive = 0u32;
    let mut negative = 0u32;
    for tri in data.indices.chunks_exact(3) {
        let [a, b, c] = [
            data.positions[tri[0] as usize],
            data.positions[tri[1] as usize],
            data.positions[tri[2] as usize],
        ];
        let cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if cross > 0.0 {
            positive += 1;
        } else if cross < 0.0 {
            negative += 1;
        }
    }
    let dominant = positive.max(negative) as f32 / data.triangle_count as f32;
    assert!(
        dominant >= 0.90,
        "dominant winding {dominant} (pos {positive}, neg {negative})"
    );
    // Cell + zipper construction gives a single orientation everywhere.
    assert_eq!(negative, 0);
}

#[test]
fn test_xz_covers_extent() {
    let config = ClipmapConfig::default();
    let data = clipmap_generate(&config, [0.0, 0.0], 1000.0);
    let (xmin, xmax) = data
        .positions
        .iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), p| {
            (lo.min(p[0]), hi.max(p[0]))
        });
    let (zmin, zmax) = data
        .positions
        .iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), p| {
            (lo.min(p[1]), hi.max(p[1]))
        });
    assert!(xmax - xmin > 500.0);
    assert!(zmax - zmin > 500.0);
}

#[test]
fn test_triangle_count_vs_fullres() {
    let config = ClipmapConfig::default();
    let data = clipmap_generate(&config, [0.0, 0.0], 1000.0);
    assert!(data.triangle_count < 1_000_000);
    assert!(data.triangle_count > 1_000);
}

#[test]
fn test_estimate_triangle_count_matches_generation() {
    for &(rings, rr, cr) in &[
        (1u32, 4u32, 4u32),
        (2, 32, 32),
        (3, 32, 16),
        (4, 64, 64),
        (5, 8, 4),
        (6, 32, 32),
        (8, 64, 64),
        (2, 128, 128),
    ] {
        let config = ClipmapConfig::new(rings, rr, cr, 10.0, 0.3).unwrap();
        for camera in [[0.0f32, 0.0], [37.5, -91.25], [-4096.0, 2048.0]] {
            let (_, mesh) = gen(&config, 1.0, camera);
            assert_eq!(
                estimate_triangle_count(&config) as u32,
                mesh.triangle_count,
                "config ({rings},{rr},{cr}) camera {camera:?}"
            );
        }
    }
}

#[test]
fn test_known_triangle_counts() {
    // Exact counts verified against the closed-form estimate (A3):
    // center 2*C^2, interior 2*((2M-2)^2-(2h)^2), frame/skirt per ring kind.
    let cases: [(u32, u32, u32, u32); 4] = [
        (4, 64, 64, 343_264),
        (8, 64, 64, 737_536),
        (2, 32, 32, 40_000),
        (6, 32, 32, 136_832),
    ];
    for (rings, rr, cr, expected) in cases {
        let config = ClipmapConfig::new(rings, rr, cr, 10.0, 0.3).unwrap();
        let (_, mesh) = gen(&config, 1.0, [0.0, 0.0]);
        assert_eq!(mesh.triangle_count, expected, "({rings},{rr},{cr})");
        assert_eq!(estimate_triangle_count(&config), expected as u64);
    }
}

#[test]
fn test_known_reductions() {
    let cases: [(u32, u32, u32, f32); 4] = [
        (4, 64, 64, 95.64),
        (8, 64, 64, 99.97),
        (2, 32, 32, 60.14),
        (6, 32, 32, 99.59),
    ];
    for (rings, rr, cr, expected) in cases {
        let config = ClipmapConfig::new(rings, rr, cr, 10.0, 0.3).unwrap();
        let (_, mesh) = gen(&config, 1.0, [0.0, 0.0]);
        assert!(
            (mesh.triangle_reduction_percent() - expected).abs() < 0.01,
            "({rings},{rr},{cr}) reduction {}",
            mesh.triangle_reduction_percent()
        );
    }
}

#[test]
fn test_ring_cell_mapping() {
    // Fixture: ringCount 8 / ringResolution 64 / centerResolution 64.
    let config = fixture_config();
    let expected_m = [96, 112, 120, 124, 126, 128, 128, 128];
    let expected_h = [32, 48, 56, 60, 62, 63, 64, 64];
    for r in 0..8u32 {
        assert_eq!(
            config.ring_outer_half_cells(r),
            expected_m[r as usize],
            "M{r}"
        );
        assert_eq!(
            config.ring_hole_half_cells(r),
            expected_h[r as usize],
            "h{r}"
        );
    }
    let layout = ClipmapLayout::for_camera(&config, 1.0, [0.0, 0.0], [0.0, 0.0]);
    for r in 0..8u32 {
        assert_eq!(
            layout.outer_half_units(r),
            expected_m[r as usize] as i64 * (1i64 << r)
        );
        if r > 0 {
            assert_eq!(layout.hole_half_units(r), layout.outer_half_units(r - 1));
        } else {
            assert_eq!(layout.hole_half_units(0), 32);
        }
    }
}

#[test]
fn test_center_snapping() {
    let config = ClipmapConfig::default();
    let layout = ClipmapLayout::for_camera(&config, 1.0, [0.0, 0.0], [5.3, -7.7]);
    for (r, c) in layout.centers.iter().enumerate() {
        let m = 1i32 << (r + 1);
        assert_eq!(c[0] % m, 0, "ring {r} center {} not snapped", c[0]);
        assert_eq!(c[1] % m, 0);
    }
    // round(x) = floor(x + 0.5): 5.3 -> c0 = round(2.65)*2 = 6.
    assert_eq!(layout.centers[0], [6, -8]);

    let moved = ClipmapLayout::for_camera(&config, 1.0, [0.0, 0.0], [5.3, -6.9]);
    assert!(layout.changed(&moved));
    let same = ClipmapLayout::for_camera(&config, 1.0, [0.0, 0.0], [5.4, -7.6]);
    assert!(!layout.changed(&same));
}

// ---------------------------------------------------------------- seams --

#[test]
fn test_seam_free_across_configs_and_cameras() {
    let configs: Vec<ClipmapConfig> = [
        (1u32, 4u32, 4u32),
        (2, 8, 8),
        (2, 32, 32),
        (3, 16, 8),
        (4, 64, 64),
        (6, 32, 32),
        (8, 64, 64),
        (2, 128, 128),
    ]
    .iter()
    .map(|&(r, rr, cr)| ClipmapConfig::new(r, rr, cr, 10.0, 0.3).unwrap())
    .collect();
    let cameras: Vec<[f32; 2]> = vec![
        [0.0, 0.0],
        [1.5, -3.7],
        [-1234.5, 987.25],
        [100_000.0, -55_555.0],
        [std::f64::consts::PI as f32, std::f64::consts::E as f32],
        [-0.5, -0.5],
    ];
    for config in &configs {
        for camera in &cameras {
            let (layout, mesh) = gen(config, 1.0, *camera);
            let report = analyze_seams(&mesh, &layout, config, &lod_height, &ring_lod);
            assert_eq!(
                report.unmatched_boundary_edges,
                0,
                "config {:?} camera {:?}: {:?}",
                (
                    config.ring_count,
                    config.ring_resolution,
                    config.center_resolution
                ),
                camera,
                report
            );
            assert_eq!(report.max_position_gap, 0.0, "camera {camera:?}");
            assert_eq!(report.max_height_discontinuity, 0.0, "camera {camera:?}");
            assert!(report.boundary_edges > 0);
        }
    }
}

#[test]
fn test_seam_free_odd_and_negative_camera_snapping() {
    // Odd unit coords, negative offsets, non-uniform anchor.
    let config = ClipmapConfig::new(3, 32, 32, 10.0, 0.3).unwrap();
    for camera in [[-7.0f32, 13.0], [15.0, -29.0], [-1023.0, 2049.0]] {
        let layout = ClipmapLayout::for_camera(&config, 2.5, [-10.0, 4.0], camera);
        let mesh = ClipmapMesh::generate(&config, &layout);
        let report = analyze_seams(&mesh, &layout, &config, &lod_height, &ring_lod);
        assert_eq!(report.unmatched_boundary_edges, 0);
        assert_eq!(report.max_position_gap, 0.0);
        assert_eq!(report.max_height_discontinuity, 0.0);
    }
}

/// Area coverage: every non-skirt triangle has positive (x, z) area and the
/// total coverage equals the outermost ring's square footprint — no holes
/// and no overlaps inside rings, for the seam test's configs and cameras.
#[test]
fn test_area_coverage_exact_across_configs_and_cameras() {
    let configs: Vec<ClipmapConfig> = [
        (1u32, 4u32, 4u32),
        (2, 8, 8),
        (2, 32, 32),
        (3, 16, 8),
        (4, 64, 64),
        (6, 32, 32),
        (8, 64, 64),
        (2, 128, 128),
    ]
    .iter()
    .map(|&(r, rr, cr)| ClipmapConfig::new(r, rr, cr, 10.0, 0.3).unwrap())
    .collect();
    let cameras: Vec<[f32; 2]> = vec![
        [0.0, 0.0],
        [1.5, -3.7],
        [-1234.5, 987.25],
        [100_000.0, -55_555.0],
        [std::f64::consts::PI as f32, std::f64::consts::E as f32],
        [-0.5, -0.5],
    ];
    for config in &configs {
        // Exact expectation in level-0 grid units: the footprint is the
        // outermost ring's square [-M*2^(N-1), M*2^(N-1)]^2.
        let expected = (2.0
            * config.ring_outer_half_cells(config.ring_count - 1) as f64
            * 2f64.powi(config.ring_count as i32 - 1))
        .powi(2);
        for camera in &cameras {
            let (_, mesh) = gen(config, 1.0, *camera);
            let mut total = 0f64;
            for tri in mesh.indices.chunks_exact(3) {
                let v = [
                    mesh.vertices[tri[0] as usize],
                    mesh.vertices[tri[1] as usize],
                    mesh.vertices[tri[2] as usize],
                ];
                if v.iter().any(|v| v.flags & CLIPMAP_FLAG_SKIRT != 0) {
                    continue;
                }
                let ab = [
                    v[1].grid[0] as i64 - v[0].grid[0] as i64,
                    v[1].grid[1] as i64 - v[0].grid[1] as i64,
                ];
                let ac = [
                    v[2].grid[0] as i64 - v[0].grid[0] as i64,
                    v[2].grid[1] as i64 - v[0].grid[1] as i64,
                ];
                let cross2 = (ab[0] * ac[1] - ab[1] * ac[0]).unsigned_abs();
                assert!(
                    cross2 > 0,
                    "degenerate non-skirt triangle {:?} config {:?} camera {:?}",
                    tri,
                    (
                        config.ring_count,
                        config.ring_resolution,
                        config.center_resolution
                    ),
                    camera
                );
                total += cross2 as f64 * 0.5;
            }
            assert_eq!(
                total,
                expected,
                "coverage mismatch config {:?} camera {:?}",
                (
                    config.ring_count,
                    config.ring_resolution,
                    config.center_resolution
                ),
                camera
            );
        }
    }
}

#[test]
fn test_vertex_position_evaluation() {
    let config = ClipmapConfig::default();
    let (layout, mesh) = gen(&config, 1.0, [0.0, 0.0]);
    let height = |x: f32, z: f32, lod: u32| x + z + lod as f32 * 100.0;

    // Coarse-boundary vertex: snapped position, coarser data LOD height.
    let coarse = mesh
        .vertices
        .iter()
        .find(|v| v.flags & CLIPMAP_FLAG_COARSE_BOUNDARY != 0)
        .expect("coarse boundary vertex");
    let p = clipmap_vertex_position(coarse, &layout, &config, &height, &ring_lod);
    let step = 1i32 << (coarse.ring + 1);
    assert_eq!(coarse.grid[0] % step, 0);
    assert_eq!(coarse.grid[1] % step, 0);
    let expected_h = height(
        coarse.grid[0] as f32,
        coarse.grid[1] as f32,
        ring_lod(coarse.ring + 1),
    );
    assert_eq!(p[1], expected_h);
    assert_eq!(p[0], coarse.grid[0] as f32);

    // Skirt vertex: same xz, height pushed down by skirt_depth.
    let skirt = mesh
        .vertices
        .iter()
        .find(|v| v.flags & CLIPMAP_FLAG_SKIRT != 0)
        .expect("skirt vertex");
    let ps = clipmap_vertex_position(skirt, &layout, &config, &height, &ring_lod);
    let base = ClipmapVertex {
        morph: 0.0,
        flags: skirt.flags & !CLIPMAP_FLAG_SKIRT,
        ..*skirt
    };
    let pb = clipmap_vertex_position(&base, &layout, &config, &height, &ring_lod);
    assert_eq!(ps[0], pb[0]);
    assert_eq!(ps[2], pb[2]);
    assert_eq!(ps[1], pb[1] - config.skirt_depth);

    // Morphed vertex blends between fine and coarse lod heights.
    let morphed = mesh
        .vertices
        .iter()
        .find(|v| v.morph > 0.0 && v.morph < 1.0)
        .expect("morphed vertex");
    let pm = clipmap_vertex_position(morphed, &layout, &config, &height, &ring_lod);
    let step = 1i32 << (morphed.ring + 1);
    let cg = [
        morphed.grid[0] - morphed.grid[0].rem_euclid(step),
        morphed.grid[1] - morphed.grid[1].rem_euclid(step),
    ];
    let k = morphed.morph;
    let px = morphed.grid[0] as f32 * (1.0 - k) + cg[0] as f32 * k;
    let pz = morphed.grid[1] as f32 * (1.0 - k) + cg[1] as f32 * k;
    let hf = height(px, pz, morphed.ring);
    let hc = height(px, pz, morphed.ring + 1);
    assert!((pm[1] - (hf * (1.0 - k) + hc * k)).abs() < 1e-4);
    assert!((pm[0] - px).abs() < 1e-4);
}

// ------------------------------------------------------------ lod select --

fn camera_at(eye: Vec3, target: Vec3) -> LodSelectParams {
    let view = Mat4::look_at_rh(eye, target, Vec3::Y);
    let proj = Mat4::perspective_rh(45.0f32.to_radians(), 16.0 / 9.0, 0.1, 50_000.0);
    let vp = proj * view;
    LodSelectParams::new(vp, eye.to_array(), 1080.0, 45.0f32.to_radians(), 4)
}

#[test]
fn test_pack_tile_id() {
    assert_eq!(
        pack_tile_id(3, 0xABC, 0x00F),
        (3 << 24) | (0xABC << 12) | 0x00F
    );
    assert_eq!(pack_tile_id(255, 0, 0), 255 << 24);
    assert_eq!(
        unpack_tile_id(pack_tile_id(3, 0xABC, 0x00F)),
        (3, 0xABC, 0x00F)
    );
    assert_eq!(unpack_tile_id(pack_tile_id(0, 0, 0)), (0, 0, 0));
    // x/y masked to 12 bits.
    assert_eq!(unpack_tile_id(pack_tile_id(1, 0x1FFF, 0)), (1, 0xFFF, 0));
}

#[test]
fn test_frustum_planes_from_view_proj() {
    let params = camera_at(Vec3::new(0.0, 0.0, 100.0), Vec3::ZERO);
    // Planes are normalized: xyz part has unit length.
    for plane in params.frustum.planes {
        let len = (plane.x * plane.x + plane.y * plane.y + plane.z * plane.z).sqrt();
        assert!((len - 1.0).abs() < 1e-5, "plane len {len}");
    }
    // The look-at target is inside the frustum; behind the camera is not.
    assert!(params
        .frustum
        .test_aabb([-10.0, -10.0], [10.0, 10.0], 0.0, 10.0));
    assert!(!params
        .frustum
        .test_aabb([-10.0, 200.0], [10.0, 220.0], 0.0, 10.0));
}

#[test]
fn test_lod_selection_near_and_far() {
    // Native formula (clipmap_lod_select.wgsl):
    //   error = tile_size * ppu / 2^lod, ppu = (vh/2) / (max(d,0.1) * tan(fov/2))
    //   first lod with error <= 2px, else max_lod.
    // With vh=1080, fov=45: ppu = 1303.9 / d (units of 4px-wide tiles here).
    let params = camera_at(Vec3::new(0.0, 0.0, 100.0), Vec3::ZERO);
    let tiles = vec![
        // Near, projected 4*13.04 = 52.2px -> halvings needed > 4 -> max_lod.
        LodTile::new(0, 0, 0, [-2.0, -2.0], [2.0, 2.0], 0.0, 50.0),
        // Distance 1000 (center z=-900, camera z=100): error0 = 5.2.
        LodTile::new(0, 1, 0, [-2.0, -902.0], [2.0, -898.0], 0.0, 50.0),
        // Distance 2000 (center z=-1900): error0 = 2.6 -> lod 1 (1.3 <= 2).
        LodTile::new(0, 2, 0, [-2.0, -1902.0], [2.0, -1898.0], 0.0, 50.0),
        // Behind the camera -> culled.
        LodTile::new(0, 3, 0, [-10.0, 300.0], [10.0, 400.0], 0.0, 50.0),
    ];
    let sel = select_tiles(&params, &tiles);
    let find = |i: usize| {
        sel.tiles
            .iter()
            .find(|t| t.tile_id == tiles[i].tile_id)
            .unwrap()
    };
    let near = find(0);
    assert!(near.visible);
    assert_eq!(near.selected_lod, 4); // 52.16/16 = 3.26 > 2 -> max_lod
    let mid = find(1);
    assert!(mid.visible);
    // d = 1100 - 100 = 1000: err0 = 4 * 540 / (1000 * tan(22.5)) = 5.216
    // lod1: 2.61 > 2; lod2: 1.30 <= 2 -> lod 2.
    assert_eq!(mid.selected_lod, 2);
    let far = find(2);
    assert!(far.visible);
    // d = 2000: err0 = 2.61 > 2; lod1 = 1.30 <= 2 -> lod 1.
    assert_eq!(far.selected_lod, 1);
    let behind = find(3);
    assert!(!behind.visible);
    assert_eq!(behind.selected_lod, 0);
    assert_eq!(sel.visible_count, 3);
    // Sorted by (distance, tile_id).
    for w in sel.tiles.windows(2) {
        assert!(
            w[0].distance < w[1].distance
                || (w[0].distance == w[1].distance && w[0].tile_id < w[1].tile_id)
        );
    }
    // Triangle budget: 128*128*2 >> (2*lod).
    let expected: u64 = [near, mid, far]
        .iter()
        .map(|t| ((128 * 128 * 2) >> (2 * t.selected_lod)) as u64)
        .sum();
    assert_eq!(sel.total_triangles, expected);
}

#[test]
fn test_lod_selection_monotonic_with_distance() {
    // Native formula semantics: error = projected tile pixels / 2^lod, so the
    // selected lod is the halving count needed to fit the 2px budget —
    // non-increasing with distance (native's own test comment claiming
    // "far = coarser" contradicts the formula; we test the formula).
    let params = camera_at(Vec3::new(0.0, 0.0, 0.0), Vec3::new(0.0, 0.0, -1.0));
    let expected = [4u32, 2, 1, 0]; // computed from the formula below
    let mut prev = u32::MAX;
    for (i, &dist) in [300.0f32, 1000.0, 2000.0, 5000.0].iter().enumerate() {
        let tile = LodTile::new(0, 0, 0, [-2.0, -dist - 2.0], [2.0, -dist + 2.0], 0.0, 50.0);
        let sel = select_tiles(&params, &[tile]);
        let lod = sel.tiles[0].selected_lod;
        // error0 = 4 * (540 / (dist * tan(22.5deg))): 300->17.4, 1000->5.2,
        // 2000->2.6, 5000->1.04.
        assert_eq!(lod, expected[i], "dist {dist}");
        assert!(lod <= prev, "dist {dist} lod {lod} > {prev}");
        prev = lod;
    }
}

#[test]
fn test_fixture_config() {
    // 1f4084a fixture: ringCount 8 / ringResolution 64 / centerResolution 64.
    let config = fixture_config();
    let (layout, mesh) = gen(&config, 1.0, [0.0, 0.0]);
    assert_eq!(config.ring_count, 8);
    assert_eq!(mesh.triangle_count, 737_536);
    let report = analyze_seams(&mesh, &layout, &config, &lod_height, &ring_lod);
    assert_eq!(report.unmatched_boundary_edges, 0);
    assert_eq!(report.max_position_gap, 0.0);
    assert_eq!(report.max_height_discontinuity, 0.0);
    // Large camera sweep on the fixture config.
    for camera in [[-10_000.0f32, 3_333.0], [777_777.0, -1.0]] {
        let (layout, mesh) = gen(&config, 1.0, camera);
        let report = analyze_seams(&mesh, &layout, &config, &lod_height, &ring_lod);
        assert_eq!(report.unmatched_boundary_edges, 0);
        assert_eq!(report.max_position_gap, 0.0);
        assert_eq!(report.max_height_discontinuity, 0.0);
    }
}

/// clipmap-seam-v1 tolerance (`heightDiscontinuityRange` 1e-4 of the
/// elevation range) with a negative control: dropping the coarse-boundary
/// seam rule is a real discontinuity the metric must report above tolerance.
#[test]
fn test_height_discontinuity_tolerance_and_negative_control() {
    let config = ClipmapConfig::new(4, 32, 32, 10.0, 0.0).unwrap();
    let (layout, mesh) = gen(&config, 1.0, [123.0, -77.0]);
    let (mut lo, mut hi) = (f32::MAX, f32::MIN);
    for v in &mesh.vertices {
        if v.flags & CLIPMAP_FLAG_SKIRT == 0 {
            let p = clipmap_vertex_position(v, &layout, &config, &lod_height, &ring_lod);
            lo = lo.min(p[1]);
            hi = hi.max(p[1]);
        }
    }
    let tolerance = 1e-4 * (hi - lo);
    assert!(tolerance > 0.0);
    let report = analyze_seams(&mesh, &layout, &config, &lod_height, &ring_lod);
    assert!(report.max_height_discontinuity <= tolerance, "{report:?}");

    let mut broken = mesh.clone();
    for v in &mut broken.vertices {
        v.flags &= !CLIPMAP_FLAG_COARSE_BOUNDARY;
    }
    let report = analyze_seams(&broken, &layout, &config, &lod_height, &ring_lod);
    assert!(
        report.max_height_discontinuity > tolerance,
        "negative control not detected: {report:?} tolerance {tolerance}"
    );
}
