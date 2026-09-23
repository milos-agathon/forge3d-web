use super::*;
use crate::camera::CameraInput;
use crate::error::Forge3dError;

fn assert_invalid<T>(result: Result<T>, needle: &str) {
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("expected invalid input containing {needle}"),
    };
    match error {
        Forge3dError::InvalidInput { field, message } => {
            let combined = format!("{field}: {message}");
            assert!(
                combined.contains(needle),
                "error {combined:?} missing {needle:?}"
            );
        }
        other => panic!("expected invalid input, got {other:?}"),
    }
}

#[test]
fn filter_names_parse_case_insensitively() {
    assert_eq!(ShadowFilter::from_name("HARD").unwrap(), ShadowFilter::Hard);
    assert_eq!(ShadowFilter::from_name("pcf").unwrap(), ShadowFilter::Pcf);
    assert_eq!(ShadowFilter::from_name("Pcss").unwrap(), ShadowFilter::Pcss);
    assert_eq!(ShadowFilter::from_name("vsm").unwrap(), ShadowFilter::Vsm);
    assert_eq!(ShadowFilter::from_name("eVSM").unwrap(), ShadowFilter::Evsm);
    assert_eq!(ShadowFilter::from_name("msm").unwrap(), ShadowFilter::Msm);
    assert_invalid(
        ShadowFilter::from_name("csm"),
        "csm is a cascade pipeline, not a shadow filter",
    );
    assert_invalid(ShadowFilter::from_name("CSM"), "cascade pipeline");
    assert_invalid(ShadowFilter::from_name("none"), "unknown shadow filter");
    assert_invalid(ShadowFilter::from_name("bloom"), "unknown shadow filter");
}

#[test]
fn moment_filters_are_vsm_evsm_msm() {
    assert!(!ShadowFilter::Hard.requires_moments());
    assert!(!ShadowFilter::Pcf.requires_moments());
    assert!(!ShadowFilter::Pcss.requires_moments());
    assert!(ShadowFilter::Vsm.requires_moments());
    assert!(ShadowFilter::Evsm.requires_moments());
    assert!(ShadowFilter::Msm.requires_moments());
}

#[test]
fn debug_view_names_are_exact() {
    assert_eq!(
        ShadowDebugView::from_name("none").unwrap(),
        ShadowDebugView::None
    );
    assert_eq!(
        ShadowDebugView::from_name("cascades").unwrap(),
        ShadowDebugView::Cascades
    );
    assert_eq!(
        ShadowDebugView::from_name("shadow-factor").unwrap(),
        ShadowDebugView::ShadowFactor
    );
    assert_invalid(
        ShadowDebugView::from_name("Cascades"),
        "unknown shadow debug view",
    );
}

#[test]
fn default_config_is_disabled_pcf() {
    let config = ShadowConfig::default().validated().unwrap();
    assert!(!config.enabled);
    assert_eq!(config.filter, ShadowFilter::Pcf);
    assert_eq!(config.map_size, 2048);
    assert_eq!(config.depth_bias, 0.002);
    assert_eq!(config.normal_bias, 0.02);
    assert_eq!(config.slope_bias, 0.01);
    assert_eq!(config.softness, 1.0);
    assert_eq!(config.pcss_blocker_radius, 2.0);
    assert_eq!(config.pcss_filter_radius, 4.0);
    assert_eq!(config.light_size, 0.25);
    assert_eq!(config.moment_bias, 0.0005);
    assert_eq!(config.light_bleed_reduction, 0.2);
    assert_eq!(config.evsm_positive_exponent, 5.0);
    assert_eq!(config.evsm_negative_exponent, 5.0);
    assert_eq!(config.peter_panning_offset, 0.001);
}

#[test]
fn config_validation_rejects_bad_values() {
    let default = ShadowConfig::default;
    assert_invalid(
        {
            let mut c = default();
            c.map_size = 1000;
            c.validated()
        },
        "power of two",
    );
    assert_invalid(
        {
            let mut c = default();
            c.map_size = 128;
            c.validated()
        },
        "power of two",
    );
    assert_invalid(
        {
            let mut c = default();
            c.map_size = 8192;
            c.validated()
        },
        "power of two",
    );
    assert_invalid(
        {
            let mut c = default();
            c.depth_bias = -0.1;
            c.validated()
        },
        "depthBias",
    );
    assert_invalid(
        {
            let mut c = default();
            c.light_size = 0.0;
            c.validated()
        },
        "lightSize",
    );
    assert_invalid(
        {
            let mut c = default();
            c.light_bleed_reduction = 1.0;
            c.validated()
        },
        "lightBleedReduction",
    );
    assert_invalid(
        {
            let mut c = default();
            c.evsm_positive_exponent = 0.0;
            c.validated()
        },
        "evsmPositiveExponent",
    );
    assert_invalid(
        {
            let mut c = default();
            c.evsm_negative_exponent = 11.0;
            c.validated()
        },
        "evsmNegativeExponent",
    );
    assert_invalid(
        {
            let mut c = default();
            c.peter_panning_offset = f32::NAN;
            c.validated()
        },
        "peterPanningOffset",
    );
}

#[test]
fn peter_panning_safe_requires_bias_and_offset() {
    let mut config = ShadowConfig::default();
    assert!(config.peter_panning_safe());
    config.depth_bias = 1e-4;
    assert!(!config.peter_panning_safe());
    config.depth_bias = 0.002;
    config.peter_panning_offset = 0.0;
    assert!(!config.peter_panning_safe());
}

#[test]
fn csm_defaults_and_validation() {
    let csm = CsmConfig::default().validated().unwrap();
    assert!(!csm.enabled);
    assert_eq!(csm.cascade_count, 3);
    assert_eq!(csm.max_distance, 200.0);
    assert_eq!(csm.split_lambda, 0.75);
    assert_eq!(csm.blend_range, 0.1);
    assert!(csm.stabilize);
    assert_eq!(csm.debug_view, ShadowDebugView::None);
    assert_eq!(csm.effective_cascade_count(), 1);

    assert_invalid(
        {
            let mut c = CsmConfig::default();
            c.enabled = true;
            c.cascade_count = 5;
            c.validated()
        },
        "cascadeCount",
    );
    assert_invalid(
        {
            let mut c = CsmConfig::default();
            c.max_distance = 0.0;
            c.validated()
        },
        "maxDistance",
    );
    assert_invalid(
        {
            let mut c = CsmConfig::default();
            c.split_lambda = 1.5;
            c.validated()
        },
        "splitLambda",
    );
    assert_invalid(
        {
            let mut c = CsmConfig::default();
            c.blend_range = -0.1;
            c.validated()
        },
        "blendRange",
    );
}

#[test]
fn disabled_splits_cover_near_to_min_far() {
    let csm = CsmConfig::default();
    let splits = shadow_split_distances(0.5, 500.0, &csm).unwrap();
    assert_eq!(splits, vec![0.5, 200.0]);
    let splits = shadow_split_distances(0.5, 50.0, &csm).unwrap();
    assert_eq!(splits, vec![0.5, 50.0]);
}

#[test]
fn enabled_splits_match_practical_split_scheme_literal() {
    let mut csm = CsmConfig::default();
    csm.enabled = true;
    csm.cascade_count = 4;
    let splits = shadow_split_distances(0.1, 100.0, &csm).unwrap();
    let expected = [
        0.1,
        6.690505993892763,
        14.884208245126285,
        32.09334557529192,
        100.0,
    ];
    assert_eq!(splits.len(), 5);
    for (actual, expected) in splits.iter().zip(expected.iter()) {
        assert!(
            (actual - expected).abs() <= 1e-6,
            "split {actual} != {expected}"
        );
    }
}

#[test]
fn split_distances_validate_planes() {
    let csm = CsmConfig::default();
    assert_invalid(shadow_split_distances(0.0, 10.0, &csm), "0 < near < far");
    assert_invalid(shadow_split_distances(10.0, 10.0, &csm), "0 < near < far");
    assert_invalid(shadow_split_distances(-1.0, 10.0, &csm), "0 < near < far");
    assert_invalid(shadow_split_distances(0.1, f32::NAN, &csm), "far");
}

#[test]
fn split_distances_reject_shadow_far_at_or_below_near() {
    let mut csm = CsmConfig {
        max_distance: 5.0,
        ..CsmConfig::default()
    };
    assert_invalid(shadow_split_distances(10.0, 100.0, &csm), "near");
    csm.enabled = true;
    assert_invalid(shadow_split_distances(10.0, 100.0, &csm), "near");
    assert_invalid(shadow_split_distances(10.0, 5.0, &csm), "0 < near < far");
}

#[test]
fn stabilize_bounds_matches_lead_literal() {
    let bounds = stabilize_bounds([-10.3, -5.1, -20.0], [11.7, 6.9, 30.0], 1024).unwrap();
    assert!((bounds.texel_size - 0.021484375).abs() <= 1e-9);
    assert!((bounds.min[0] - -10.291015625).abs() <= 1e-6);
    assert!((bounds.min[1] - -10.09765625).abs() <= 1e-6);
    assert!((bounds.max[0] - 11.708984375).abs() <= 1e-6);
    assert!((bounds.max[1] - 11.90234375).abs() <= 1e-6);
    assert_eq!(bounds.min[2], -20.0);
    assert_eq!(bounds.max[2], 30.0);
}

#[test]
fn uniform_layout_is_exact() {
    assert_eq!(std::mem::size_of::<ShadowUniform>(), SHADOW_UNIFORM_BYTES);
    assert_eq!(
        std::mem::size_of::<ShadowDepthUniform>(),
        SHADOW_DEPTH_UNIFORM_BYTES
    );
    assert_eq!(std::mem::align_of::<ShadowUniform>(), 16);
    assert_eq!(std::mem::align_of::<ShadowDepthUniform>(), 16);
}

#[test]
fn packed_uniform_places_fields() {
    let config = ShadowConfig {
        enabled: true,
        filter: ShadowFilter::Pcss,
        map_size: 512,
        ..ShadowConfig::default()
    };
    let csm = CsmConfig {
        enabled: true,
        cascade_count: 2,
        debug_view: ShadowDebugView::Cascades,
        ..CsmConfig::default()
    };
    let matrices = vec![[[1.0_f32; 4]; 4], [[2.0_f32; 4]; 4]];
    let splits = [0.1_f32, 10.0, 50.0];
    let packed = pack_shadow_uniform(&matrices, &splits, [0.0, -1.0, 0.0], &config, &csm, true);
    assert_eq!(packed.matrices[0][0][0], 1.0);
    assert_eq!(packed.matrices[1][0][0], 2.0);
    assert_eq!(packed.matrices[2][0][0], 0.0);
    assert_eq!(packed.splits, [10.0, 50.0, 50.0, 50.0]);
    assert_eq!(packed.light_direction, [0.0, -1.0, 0.0, 0.001]);
    assert_eq!(packed.params0, [512.0, 1.0 / 512.0, 0.002, 0.02]);
    assert_eq!(packed.params1, [0.01, 1.0, 2.0, 4.0]);
    assert_eq!(packed.params2, [0.25, 0.0005, 0.2, 5.0]);
    assert_eq!(packed.params3, [5.0, 0.1, 200.0, 0.75]);
    assert_eq!(packed.control, [1, 2, 2, 1]);
}

#[test]
fn estimated_gpu_bytes_follows_contract() {
    let disabled = ShadowConfig::default();
    assert_eq!(disabled.estimated_gpu_bytes(3).unwrap(), 0);

    let pcf = ShadowConfig {
        enabled: true,
        filter: ShadowFilter::Pcf,
        map_size: 1024,
        ..ShadowConfig::default()
    };
    assert_eq!(
        pcf.estimated_gpu_bytes(2).unwrap(),
        1024 * 1024 * 4 * 2 + 368 + 2 * 64
    );

    let evsm = ShadowConfig {
        enabled: true,
        filter: ShadowFilter::Evsm,
        map_size: 1024,
        ..ShadowConfig::default()
    };
    assert_eq!(
        evsm.estimated_gpu_bytes(2).unwrap(),
        1024 * 1024 * 4 * 2 + 1024 * 1024 * 16 * 2 + 368 + 2 * 64
    );
}

#[test]
fn estimated_gpu_bytes_rejects_out_of_range_cascade_counts() {
    let config = ShadowConfig {
        enabled: true,
        ..ShadowConfig::default()
    };
    for count in [0u32, 5, u32::MAX] {
        assert_invalid(config.estimated_gpu_bytes(count), "cascadeCount");
    }
    for count in 1u32..=4 {
        assert!(config.estimated_gpu_bytes(count).is_ok());
    }
    let disabled = ShadowConfig::default();
    assert_invalid(disabled.estimated_gpu_bytes(0), "cascadeCount");
}

fn test_camera() -> CameraInput {
    CameraInput {
        position: [0.0, 0.0, 0.0],
        target: [0.0, 0.0, -10.0],
        up: [0.0, 1.0, 0.0],
        fov_y_degrees: 46.0,
        near: 0.1,
        far: 100.0,
    }
}

#[test]
fn cascades_produce_finite_distinct_matrices() {
    let config = ShadowConfig {
        enabled: true,
        map_size: 512,
        ..ShadowConfig::default()
    };
    let csm = CsmConfig {
        enabled: true,
        cascade_count: 3,
        stabilize: true,
        ..CsmConfig::default()
    };
    let cascades =
        build_shadow_cascades(&test_camera(), 1.6, [-0.4, -0.8, -0.4], &config, &csm).unwrap();
    assert_eq!(cascades.len(), 3);
    for cascade in &cascades {
        assert!(cascade.near < cascade.far);
        assert!(cascade.texel_size > 0.0);
        for value in cascade.matrix.iter().flatten() {
            assert!(value.is_finite());
        }
    }
    assert_ne!(cascades[0].matrix, cascades[2].matrix);
}

#[test]
fn sub_texel_camera_translation_stabilizes_identically() {
    let config = ShadowConfig {
        enabled: true,
        map_size: 512,
        ..ShadowConfig::default()
    };
    let csm = CsmConfig {
        enabled: true,
        cascade_count: 2,
        stabilize: true,
        ..CsmConfig::default()
    };
    let camera_a = test_camera();
    let mut camera_b = test_camera();
    camera_b.position[0] += 1e-4;
    camera_b.target[0] += 1e-4;
    let a = build_shadow_cascades(&camera_a, 1.0, [0.0, -1.0, 0.0], &config, &csm).unwrap();
    let b = build_shadow_cascades(&camera_b, 1.0, [0.0, -1.0, 0.0], &config, &csm).unwrap();
    assert_eq!(
        a[0].matrix, b[0].matrix,
        "sub-texel shift must snap identically"
    );

    let mut camera_c = test_camera();
    camera_c.position[0] += 5.0;
    camera_c.target[0] += 5.0;
    let c = build_shadow_cascades(&camera_c, 1.0, [0.0, -1.0, 0.0], &config, &csm).unwrap();
    assert_ne!(a[0].matrix, c[0].matrix);
}

#[test]
fn unstabilized_cascades_track_camera_translation() {
    let config = ShadowConfig {
        enabled: true,
        map_size: 512,
        ..ShadowConfig::default()
    };
    let csm = CsmConfig {
        enabled: true,
        cascade_count: 2,
        stabilize: false,
        ..CsmConfig::default()
    };
    let mut camera_b = test_camera();
    camera_b.position[0] += 1e-4;
    camera_b.target[0] += 1e-4;
    let a = build_shadow_cascades(&test_camera(), 1.0, [0.0, -1.0, 0.0], &config, &csm).unwrap();
    let b = build_shadow_cascades(&camera_b, 1.0, [0.0, -1.0, 0.0], &config, &csm).unwrap();
    assert_ne!(a[0].matrix, b[0].matrix);
}

#[test]
fn effective_map_size_drives_cascade_texel_grid() {
    let csm = CsmConfig {
        enabled: true,
        cascade_count: 2,
        stabilize: true,
        ..CsmConfig::default()
    };
    let requested = ShadowConfig {
        enabled: true,
        map_size: 1024,
        ..ShadowConfig::default()
    };
    let effective = ShadowConfig {
        map_size: 256,
        ..requested
    };
    let camera = test_camera();
    let wide = build_shadow_cascades(&camera, 1.0, [0.0, -1.0, 0.0], &requested, &csm).unwrap();
    let narrow = build_shadow_cascades(&camera, 1.0, [0.0, -1.0, 0.0], &effective, &csm).unwrap();
    assert!(
        (narrow[0].texel_size - wide[0].texel_size * 4.0).abs() <= 1e-6,
        "256 texel grid must be four times coarser than the 1024 grid"
    );
    assert_ne!(wide[0].matrix, narrow[0].matrix);
    let splits = shadow_split_distances(camera.near, camera.far, &csm).unwrap();
    let matrices: Vec<[[f32; 4]; 4]> = narrow.iter().map(|c| c.matrix).collect();
    let packed = pack_shadow_uniform(&matrices, &splits, [0.0, -1.0, 0.0], &effective, &csm, true);
    assert_eq!(packed.params0[0], 256.0);
    assert_eq!(packed.params0[1], 1.0 / 256.0);
}

#[test]
fn msm_reference_solve_is_finite_and_differs_from_vsm() {
    let depths = [0.2_f32, 0.5, 0.8];
    let b: [f32; 4] = [
        depths.iter().sum::<f32>() / 3.0,
        depths.iter().map(|z| z * z).sum::<f32>() / 3.0,
        depths.iter().map(|z| z * z * z).sum::<f32>() / 3.0,
        depths.iter().map(|z| z * z * z * z).sum::<f32>() / 3.0,
    ];
    let z = 0.65_f32;
    let d22 = b[1] - b[0] * b[0];
    let vsm = if z <= b[0] {
        1.0
    } else {
        let d = z - b[0];
        (d22 / (d22 + d * d)).clamp(0.0, 1.0)
    };
    let l32_d22 = b[2] - b[0] * b[1];
    let l32 = l32_d22 / d22;
    let squared_depth_variance = b[3] - b[1] * b[1];
    let d33_d22 = squared_depth_variance * d22 - l32_d22 * l32_d22;
    assert!(
        d22 > 1e-8 && d33_d22 > 1e-8,
        "distribution must not be degenerate"
    );
    let mut c = [1.0_f32, z, z * z];
    c[1] -= b[0];
    c[2] -= b[1] + l32 * c[1];
    c[1] /= d22;
    c[2] *= d22 / d33_d22;
    c[1] -= l32 * c[2];
    c[0] -= c[1] * b[0] + c[2] * b[1];
    let p = c[1] / c[2];
    let q = c[0] / c[2];
    let discriminant = p * p * 0.25 - q;
    assert!(discriminant >= 0.0);
    let root = discriminant.sqrt();
    let z2 = -p * 0.5 - root;
    let z3 = -p * 0.5 + root;
    let msm = if z3 < z {
        let quotient = (z2 * z3 - b[0] * (z2 + z3) + b[1]) / ((z3 - z) * (z - z2));
        (-quotient).clamp(0.0, 1.0)
    } else if z2 < z {
        let quotient = (z * z3 - b[0] * (z + z3) + b[1]) / ((z3 - z2) * (z - z2));
        (1.0 - quotient).clamp(0.0, 1.0)
    } else {
        1.0
    };
    assert!(msm.is_finite() && (0.0..=1.0).contains(&msm), "msm {msm}");
    assert!(
        (msm - vsm).abs() > 1e-3,
        "msm {msm} must differ from vsm {vsm}"
    );
}

#[test]
fn cascades_reject_invalid_inputs() {
    let config = ShadowConfig::default();
    let csm = CsmConfig::default();
    assert_invalid(
        build_shadow_cascades(&test_camera(), 0.0, [0.0, -1.0, 0.0], &config, &csm),
        "aspect",
    );
    assert_invalid(
        build_shadow_cascades(&test_camera(), 1.0, [0.0, 0.0, 0.0], &config, &csm),
        "direction",
    );
}
