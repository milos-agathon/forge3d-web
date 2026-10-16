use super::*;
#[test]
fn hzb_includes_odd_edges_and_reaches_one_pixel() {
    let input = vec![
        0.8, 0.7, 0.6, 0.5, 0.1, 0.4, 0.3, 0.2, 0.9, 0.05, 0.8, 0.7, 0.6, 0.5, 0.01,
    ];
    let first = hzb_reduce(&input, 5, 3);
    assert_eq!(first, vec![0.3, 0.01]);
    assert_eq!(hzb_reduce(&first, 2, 1), vec![0.01]);
    assert_eq!(hzb_dimensions(5, 3), vec![(5, 3), (2, 1), (1, 1)]);
}
#[test]
fn bloom_and_lens_match_native_formulas() {
    assert_eq!(bloom_brightpass([0.1; 3], 1.5, 0.5), [0.; 3]);
    assert_eq!(bloom_brightpass([3.; 3], 1.5, 0.5), [3.; 3]);
    for x in bloom_brightpass([1.5; 3], 1.5, 0.5) {
        assert!((x - 0.375).abs() < 1e-6);
    }
    assert_eq!(bloom_brightpass([1.; 3], 1., 0.), [1.; 3]);
    assert_eq!(lens_distort([0.5, 0.5], 0.8), [0.5, 0.5]);
    assert!((lens_distort([1., 1.], 0.5)[0] - 1.15625).abs() < 1e-6);
    assert_eq!(circle_of_confusion(10., 10., 0.1, 50., 36., 1.), 0.);
    assert!((circle_of_confusion(20., 10., 0.1, 50., 36., 1.) - 1.5).abs() < 1e-6);
}
#[test]
fn trilinear_lut_preserves_linear_rgb() {
    let mut lut = ColorLut {
        size: 2,
        data: vec![],
    };
    for b in 0..2 {
        for g in 0..2 {
            for r in 0..2 {
                lut.data.extend([r as f32, g as f32, b as f32]);
            }
        }
    }
    for rgb in [[0.02, 0.5, 0.99], [0., 1., 0.31], [1., 1., 1.]] {
        let result = sample_color_lut(&lut, rgb);
        for i in 0..3 {
            assert!((result[i] - rgb[i]).abs() < 1e-6);
        }
    }
}
#[test]
fn temporal_disocclusion_rejects_identity_and_depth_changes() {
    assert!(history_accepted(3, 3, 0.5, 0.501, 0.01));
    assert!(!history_accepted(3, 4, 0.5, 0.5, 0.01));
    assert!(!history_accepted(3, 3, 0.5, 0.6, 0.01));
    let mut state = TemporalState::default();
    let camera = crate::camera::CameraInput::default();
    state.advance(camera);
    assert_eq!(state.frames, 1);
    assert!(!state.camera_cut(&camera));
    let mut cut = camera;
    cut.target = [
        camera.position[0],
        camera.position[1],
        camera.position[2] + 100.,
    ];
    assert!(state.camera_cut(&cut));
    state.reset("resize");
    assert_eq!(state.frames, 0);
    assert_eq!(state.reason, "resize");
}

fn ordered_config() -> PostFxConfig {
    let mut bloom = [0.; 16];
    bloom[..5].copy_from_slice(&[1.5, 0.5, 0.3, 1., 2.]);
    let mut denoise = [0.; 16];
    denoise[..4].copy_from_slice(&[2., 0.2, 0.01, 0.2]);
    let mut tone = [0.; 16];
    tone[..6].copy_from_slice(&[0., 4., 0., 1., 0., 3.]);
    PostFxConfig {
        effects: [
            ("glow", EffectKind::Bloom, bloom, "high", "display"),
            ("noise", EffectKind::Denoise, denoise, "medium", "display"),
            ("map", EffectKind::Tonemap, tone, "medium", "aces"),
        ]
        .into_iter()
        .map(|(id, kind, params, quality, operator)| Effect {
            id: id.into(),
            kind,
            params,
            enabled: true,
            quality: quality.into(),
            operator: operator.into(),
            lut: None,
        })
        .collect(),
        debug: DebugView {
            view: "none".into(),
            effect_id: None,
            hzb_mip: 0,
        },
    }
}
#[test]
fn ordered_passes_expose_quality_blurs_and_atrous_iterations() {
    let config = ordered_config();
    config.validate().unwrap();
    assert_eq!(
        config.pass_order(),
        [
            "gbuffer:primary",
            "gbuffer:surface",
            "hzb",
            "glow:brightpass",
            "glow:blur-0-x",
            "glow:blur-0-y",
            "glow:blur-1-x",
            "glow:blur-1-y",
            "glow:composite",
            "noise:atrous-0",
            "noise:atrous-1",
            "map:resolve",
            "output:srgb",
            "overlay"
        ]
    );
}
#[test]
fn wasm_boundary_rejects_order_quality_and_reserved_parameter_drift() {
    let config = ordered_config();
    let mut invalid = config.clone();
    invalid.effects.swap(0, 2);
    assert!(invalid.validate().is_err());
    let mut invalid = config.clone();
    invalid.effects[0].params[4] = 1.;
    assert!(invalid.validate().is_err());
    let mut invalid = config.clone();
    invalid.effects[0].params[15] = 1.;
    assert!(invalid.validate().is_err());
    let mut invalid = config.clone();
    invalid.effects[2].params[5] = 1.;
    assert!(invalid.validate().is_err());
    let mut invalid = serde_json::to_value(config).unwrap();
    invalid["effects"][0]["unknown"] = true.into();
    assert!(serde_json::from_value::<PostFxConfig>(invalid).is_err());
}
