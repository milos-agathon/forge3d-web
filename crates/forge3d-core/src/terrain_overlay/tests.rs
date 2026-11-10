//! W08/T11 terrain_overlay tests — ports of
//! `tests/test_terrain_overlay_stack.py` and native
//! `viewer/terrain/overlay/tests.rs`, plus the spec-mandated
//! determinism/order/extent/CRS assertions.

use super::*;
use crate::terrain_overlay::crs::*;

fn image_2x2() -> OverlayImage {
    OverlayImage::new(
        2,
        2,
        vec![
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
        ],
    )
    .unwrap()
}

fn solid_image(rgba: [u8; 4]) -> OverlayImage {
    OverlayImage::new(1, 1, rgba.to_vec()).unwrap()
}

fn layer(name: &str) -> OverlayLayer {
    OverlayLayer::new(name, image_2x2()).unwrap()
}

fn err_msg(r: Result<()>) -> String {
    match r.unwrap_err() {
        Forge3dError::InvalidInput { message, .. } => message,
        Forge3dError::UnsupportedFeature { feature } => feature,
        Forge3dError::ResourceLimitExceeded { message, .. } => message,
        other => panic!("unexpected error variant: {other:?}"),
    }
}

// -------------------------------------------------- blend mode (python) --

#[test]
fn test_blend_mode_values() {
    assert_eq!(OverlayBlendMode::Normal.as_str(), "normal");
    assert_eq!(OverlayBlendMode::Multiply.as_str(), "multiply");
    assert_eq!(OverlayBlendMode::Overlay.as_str(), "overlay");
}

#[test]
fn test_blend_mode_parse_valid() {
    for (s, m) in [
        ("normal", OverlayBlendMode::Normal),
        ("multiply", OverlayBlendMode::Multiply),
        ("overlay", OverlayBlendMode::Overlay),
    ] {
        assert_eq!(OverlayBlendMode::parse(s).unwrap(), m);
    }
}

#[test]
fn test_invalid_blend_mode_rejected() {
    for bad in ["invalid", "add"] {
        match OverlayBlendMode::parse(bad).unwrap_err() {
            Forge3dError::InvalidInput { message, .. } => assert_eq!(
                message,
                format!("blend_mode must be one of ['multiply', 'normal', 'overlay'], got '{bad}'")
            ),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }
}

// ------------------------------------------------- layer config (python) -

#[test]
fn test_layer_default_values() {
    let l = layer("test");
    assert_eq!(l.name, "test");
    assert_eq!(l.placement, OverlayPlacement::Uv([0.0, 0.0, 1.0, 1.0]));
    assert_eq!(l.opacity, 1.0);
    assert_eq!(l.blend_mode, OverlayBlendMode::Normal);
    assert!(l.visible);
    assert_eq!(l.z_order, 0);
}

#[test]
fn test_layer_custom_values() {
    let l = layer("satellite")
        .with_placement(OverlayPlacement::uv([0.1, 0.2, 0.8, 0.9]).unwrap())
        .with_opacity(0.7)
        .with_blend_mode(OverlayBlendMode::Multiply)
        .with_visible(false)
        .with_z_order(5);
    l.validate().unwrap();
    assert_eq!(l.name, "satellite");
    assert_eq!(l.placement, OverlayPlacement::Uv([0.1, 0.2, 0.8, 0.9]));
    assert_eq!(l.opacity, 0.7);
    assert_eq!(l.blend_mode, OverlayBlendMode::Multiply);
    assert!(!l.visible);
    assert_eq!(l.z_order, 5);
}

#[test]
fn test_empty_name_rejected() {
    let e = OverlayLayer::new("", image_2x2()).unwrap_err();
    assert!(format!("{e}").contains("name must be non-empty"));
}

#[test]
fn test_opacity_range_validation() {
    assert!(layer("t").with_opacity(-0.1).validate().is_err());
    assert!(layer("t").with_opacity(1.5).validate().is_err());
    assert_eq!(
        err_msg(layer("t").with_opacity(-0.1).validate()),
        "opacity must be in [0.0, 1.0]"
    );
    assert!(layer("t").with_opacity(0.0).validate().is_ok());
    assert!(layer("t").with_opacity(1.0).validate().is_ok());
}

#[test]
fn test_extent_validation() {
    assert_eq!(
        err_msg(OverlayPlacement::uv_slice(&[0.0, 0.0, 1.0]).map(|_| ())),
        "extent must be (u_min, v_min, u_max, v_max)"
    );
    assert_eq!(
        err_msg(OverlayPlacement::uv([0.5, 0.0, 0.5, 1.0]).map(|_| ())),
        "extent must have u_min < u_max and v_min < v_max"
    );
    assert_eq!(
        err_msg(OverlayPlacement::uv([0.0, 0.5, 1.0, 0.5]).map(|_| ())),
        "extent must have u_min < u_max and v_min < v_max"
    );
    assert_eq!(
        OverlayPlacement::uv([0.0, 0.0, 1.0, 1.0]).unwrap(),
        OverlayPlacement::Uv([0.0, 0.0, 1.0, 1.0])
    );
}

#[test]
fn test_image_validation() {
    match OverlayImage::new(2, 2, vec![0u8; 12]).unwrap_err() {
        Forge3dError::InvalidInput { message, .. } => {
            assert_eq!(
                message,
                "overlay image must be 2x2 RGBA8 (16 bytes), got 12"
            )
        }
        other => panic!("expected InvalidInput, got {other:?}"),
    }
    assert!(OverlayImage::new(0, 2, vec![]).is_err());
    assert!(OverlayImage::new(2, 0, vec![]).is_err());
    assert!(OverlayImage::new(1, 1, vec![1, 2, 3, 4]).is_ok());
}

// ------------------------------------------------------ settings (python) -

#[test]
fn test_settings_default_values() {
    let s = OverlaySettings::new();
    assert!(!s.enabled); // default OFF for backward compatibility
    assert_eq!(s.global_opacity, 1.0);
    assert!(s.layers.is_empty());
    assert_eq!(s.resolution_scale, 1.0);
}

#[test]
fn test_global_opacity_validation() {
    let mut s = OverlaySettings::new();
    s.global_opacity = -0.1;
    assert_eq!(
        err_msg(s.validate()),
        "global_opacity must be in [0.0, 1.0]"
    );
    s.global_opacity = 1.5;
    assert_eq!(
        err_msg(s.validate()),
        "global_opacity must be in [0.0, 1.0]"
    );
}

#[test]
fn test_resolution_scale_validation() {
    let mut s = OverlaySettings::new();
    s.resolution_scale = 0.05;
    assert_eq!(
        err_msg(s.validate()),
        "resolution_scale must be in [0.1, 2.0]"
    );
    s.resolution_scale = 3.0;
    assert_eq!(
        err_msg(s.validate()),
        "resolution_scale must be in [0.1, 2.0]"
    );
    s.resolution_scale = 0.1;
    assert!(s.validate().is_ok());
    s.resolution_scale = 2.0;
    assert!(s.validate().is_ok());
}

#[test]
fn test_has_visible_layers() {
    let mut s = OverlaySettings::new();
    assert!(!s.has_visible_layers());
    s.layers.push(layer("test").with_opacity(0.5));
    assert!(s.has_visible_layers());

    let mut hidden = OverlaySettings::new();
    hidden.layers.push(layer("test").with_visible(false));
    assert!(!hidden.has_visible_layers());

    let mut zero = OverlaySettings::new();
    zero.layers.push(layer("test").with_opacity(0.0));
    assert!(!zero.has_visible_layers());
}

#[test]
fn test_layer_count() {
    let mut s = OverlaySettings::new();
    assert_eq!(s.layer_count(), 0);
    s.layers.push(layer("layer1"));
    s.layers.push(layer("layer2"));
    assert_eq!(s.layer_count(), 2);
}

#[test]
fn test_at_most_8_visible_layers() {
    let mut s = OverlaySettings::new();
    for i in 0..9 {
        s.layers.push(layer(&format!("l{i}")));
    }
    assert_eq!(
        err_msg(s.validate()),
        "overlay supports at most 8 visible layers, got 9"
    );
    // 8 visible + hidden extras is fine.
    let mut ok = OverlaySettings::new();
    for i in 0..8 {
        ok.layers.push(layer(&format!("l{i}")));
    }
    ok.layers.push(layer("hidden").with_visible(false));
    ok.layers.push(layer("zero").with_opacity(0.0));
    assert!(ok.validate().is_ok());
}

// -------------------------------------------------------- z-order (python) -

#[test]
fn test_z_order_sorting() {
    let mut s = OverlaySettings::new();
    s.layers.push(layer("top").with_z_order(10));
    s.layers.push(layer("middle").with_z_order(5));
    s.layers.push(layer("bottom").with_z_order(0));
    let names: Vec<&str> = s.visible_layers().iter().map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["bottom", "middle", "top"]);
}

#[test]
fn test_negative_z_order() {
    let l = layer("behind").with_z_order(-5);
    assert_eq!(l.z_order, -5);
}

#[test]
fn test_z_order_stable_by_input_index() {
    // Equal z_order keeps input order (stable sort).
    let mut s = OverlaySettings::new();
    s.layers.push(layer("b").with_z_order(1));
    s.layers.push(layer("a").with_z_order(0));
    s.layers.push(layer("c").with_z_order(1));
    s.layers.push(layer("d").with_z_order(1));
    let names: Vec<&str> = s.visible_layers().iter().map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["a", "b", "c", "d"]);
}

#[test]
fn test_visible_layers_filters_invisible() {
    let mut s = OverlaySettings::new();
    s.layers
        .push(layer("hidden").with_visible(false).with_z_order(-10));
    s.layers
        .push(layer("zero").with_opacity(0.0).with_z_order(-5));
    s.layers.push(layer("shown").with_z_order(0));
    let names: Vec<&str> = s.visible_layers().iter().map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["shown"]);
}

// --------------------------------------------------------- native sampling -

fn approx_eq(a: f32, b: f32) {
    assert!((a - b).abs() <= 1e-6, "expected {b}, got {a}");
}

#[test]
fn test_bilinear_sampling_round_trips_texel_centers() {
    let rgba = [
        10u8, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
    ];
    let top_left = sample_bilinear(&rgba, 2, 2, 0.25, 0.25, 1.0);
    approx_eq(top_left[0], 10.0 / 255.0);
    approx_eq(top_left[1], 20.0 / 255.0);
    approx_eq(top_left[2], 30.0 / 255.0);
    approx_eq(top_left[3], 1.0);

    let bottom_right = sample_bilinear(&rgba, 2, 2, 0.75, 0.75, 1.0);
    approx_eq(bottom_right[0], 100.0 / 255.0);
    approx_eq(bottom_right[1], 110.0 / 255.0);
    approx_eq(bottom_right[2], 120.0 / 255.0);
    approx_eq(bottom_right[3], 1.0);
}

#[test]
fn test_bilinear_edge_clamp_and_opacity() {
    let rgba = [200u8, 100, 50, 128];
    // Out-of-range uv clamps to the single texel.
    let s = sample_bilinear(&rgba, 1, 1, -1.0, 2.0, 0.5);
    approx_eq(s[0], 200.0 / 255.0);
    approx_eq(s[3], (128.0 / 255.0) * 0.5);
    // Empty image -> transparent.
    assert_eq!(sample_bilinear(&[], 0, 0, 0.5, 0.5, 1.0), [0.0; 4]);
}

// ------------------------------------------------------------- blend math -

#[test]
fn test_blend_linear_modes() {
    let dst = [0.8, 0.4, 0.2];
    let src = [0.2, 0.6, 0.9];
    // Normal: dst*(1-a) + src*a.
    let n = blend_linear(OverlayBlendMode::Normal, dst, src, 0.5);
    approx_eq(n[0], 0.5);
    approx_eq(n[1], 0.5);
    approx_eq(n[2], 0.55);
    // Multiply: dst*(1-a) + dst*src*a.
    let m = blend_linear(OverlayBlendMode::Multiply, dst, src, 1.0);
    approx_eq(m[0], 0.8 * 0.2);
    approx_eq(m[1], 0.4 * 0.6);
    // a = 0 -> unchanged dst for every mode.
    for mode in [
        OverlayBlendMode::Normal,
        OverlayBlendMode::Multiply,
        OverlayBlendMode::Overlay,
    ] {
        assert_eq!(blend_linear(mode, dst, src, 0.0), dst);
    }
    // Overlay branch b < 0.5: ov = 2*b*s.
    let dark = [0.4, 0.4, 0.4];
    let o = blend_linear(OverlayBlendMode::Overlay, dark, src, 1.0);
    approx_eq(o[0], 2.0 * 0.4 * 0.2);
    // Overlay branch b >= 0.5: ov = 1 - 2*(1-b)*(1-s).
    let light = [0.8, 0.8, 0.8];
    let o2 = blend_linear(OverlayBlendMode::Overlay, light, src, 1.0);
    approx_eq(o2[0], 1.0 - 2.0 * (1.0 - 0.8) * (1.0 - 0.2));
}

#[test]
fn test_srgb_to_linear() {
    approx_eq(srgb_to_linear(0.0), 0.0);
    approx_eq(srgb_to_linear(1.0), 1.0);
    approx_eq(srgb_to_linear(0.5), 0.21404114);
    approx_eq(srgb_to_linear(0.04045), 0.04045 / 12.92);
}

// ------------------------------------------------------------------- crs --

#[test]
fn test_normalize_crs() {
    assert_eq!(normalize_crs("epsg:4326"), "EPSG:4326");
    assert_eq!(normalize_crs("EPSG:4326"), "EPSG:4326");
    assert_eq!(normalize_crs("CRS:84"), "EPSG:4326");
    assert_eq!(normalize_crs("EPSG:900913"), "EPSG:3857");
    assert_eq!(normalize_crs("epsg:3857"), "EPSG:3857");
    assert_eq!(normalize_crs("EPSG:32632"), "EPSG:32632");
}

#[test]
fn test_mercator_roundtrip() {
    // EPSG:4326 <-> EPSG:3857 round trip within 1e-9 deg.
    for &(lon, lat) in &[
        (0.0, 0.0),
        (6.13, 49.61), // Luxembourg
        (-74.0, 40.7),
        (179.9, -85.05112878),
    ] {
        let (x, y) = lonlat_to_mercator(lon, lat);
        let (lon2, lat2) = mercator_to_lonlat(x, y);
        assert!((lon - lon2).abs() < 1e-9, "lon drift {lon} vs {lon2}");
        assert!((lat - lat2).abs() < 1e-9, "lat drift {lat} vs {lat2}");
    }
    // Lat beyond clamp is clamped.
    let (_, y_clamped) = lonlat_to_mercator(0.0, 89.0);
    let (_, y_max) = lonlat_to_mercator(0.0, WEB_MERCATOR_MAX_LAT);
    assert_eq!(y_clamped, y_max);
}

#[test]
fn test_crs_transform() {
    // Identical -> affine (identity here; the affine is the uv/bounds map).
    assert_eq!(
        crs_transform("EPSG:4326", "epsg:4326", 3.0, -2.0),
        Some((3.0, -2.0))
    );
    // Unsupported pair -> None.
    assert_eq!(crs_transform("EPSG:4326", "EPSG:32632", 0.0, 0.0), None);
    assert!(crs_pair_supported("EPSG:4326", "EPSG:3857"));
    assert!(!crs_pair_supported("EPSG:4326", "EPSG:3035"));
}

#[test]
fn test_georeference_uv_crs() {
    // Terrain bounds in EPSG:4326 over Luxembourg-ish area.
    let g = TerrainGeoreference::new("EPSG:4326", [5.0, 49.0, 7.0, 50.0]);
    // v = 0 is north (maxy).
    assert_eq!(g.uv_to_crs(0.0, 0.0), Some((5.0, 50.0)));
    assert_eq!(g.uv_to_crs(1.0, 1.0), Some((7.0, 49.0)));
    assert_eq!(g.uv_to_crs(0.5, 0.5), Some((6.0, 49.5)));
    assert_eq!(g.crs_to_uv(6.0, 49.5), Some((0.5, 0.5)));
    assert_eq!(TerrainGeoreference::none().uv_to_crs(0.0, 0.0), None);
}

// -------------------------------------------------------------- planning --

fn georef_none() -> TerrainGeoreference {
    TerrainGeoreference::none()
}

#[test]
fn test_plan_disabled_and_no_visible() {
    let g = georef_none();
    let s = OverlaySettings::new(); // disabled
    let plan = plan_overlays(&s, &g, 512, 512, 4096, 1 << 20).unwrap();
    assert_eq!(plan.width, 0);
    assert_eq!(plan.height, 0);
    assert!(plan.layers.is_empty());
    assert_eq!(plan.gpu_bytes, 0);
    assert!(!plan.downscaled);
    assert_eq!(plan.global_opacity, 1.0);

    // Enabled but all layers hidden -> also empty.
    let mut s2 = OverlaySettings::with_layers(vec![layer("h").with_visible(false)]);
    s2.enabled = true;
    let plan2 = plan_overlays(&s2, &g, 512, 512, 4096, 1 << 20).unwrap();
    assert!(plan2.layers.is_empty());
}

#[test]
fn test_plan_target_dims_and_scale() {
    let g = georef_none();
    let mut s = OverlaySettings::with_layers(vec![layer("a")]);
    s.enabled = true;
    let plan = plan_overlays(&s, &g, 512, 256, 4096, 1 << 26).unwrap();
    assert_eq!((plan.width, plan.height), (512, 256));
    assert_eq!((plan.requested_width, plan.requested_height), (512, 256));
    assert!(!plan.downscaled);
    assert_eq!(plan.gpu_bytes, 512 * 256 * 4);

    s.resolution_scale = 0.5;
    let plan = plan_overlays(&s, &g, 512, 256, 4096, 1 << 26).unwrap();
    assert_eq!((plan.width, plan.height), (256, 128));

    // Clamped to max_dim.
    s.resolution_scale = 2.0;
    let plan = plan_overlays(&s, &g, 512, 256, 700, 1 << 26).unwrap();
    assert_eq!((plan.width, plan.height), (700, 512));
}

#[test]
fn test_plan_budget_downscale_and_limit() {
    let g = georef_none();
    let mut s = OverlaySettings::with_layers(vec![layer("a")]);
    s.enabled = true;
    // budget forces halving: 512*256*4 = 512K; budget 256K -> 256x128 (128K).
    let budget = 512 * 256 * 4 / 2;
    let plan = plan_overlays(&s, &g, 512, 256, 4096, budget).unwrap();
    assert!(plan.downscaled);
    assert_eq!((plan.width, plan.height), (256, 128));
    assert_eq!(plan.gpu_bytes, 256 * 128 * 4);
    assert_eq!((plan.requested_width, plan.requested_height), (512, 256));

    // Absurdly small budget: halves down to 16x16 min, then errors.
    let err = plan_overlays(&s, &g, 512, 256, 4096, 100).unwrap_err();
    match err {
        Forge3dError::ResourceLimitExceeded { resource, .. } => {
            assert_eq!(resource, "overlay_composite")
        }
        other => panic!("expected ResourceLimitExceeded, got {other:?}"),
    }
}

#[test]
fn explicit_output_size_preserves_imagery_resolution_independent_of_dem() {
    let mut settings = OverlaySettings::with_layers(vec![layer("imagery")]);
    settings.enabled = true;
    settings.output_size = Some([4096, 4096]);
    let plan = plan_overlays(&settings, &georef_none(), 513, 513, 8192, 1 << 27).unwrap();
    assert_eq!((plan.width, plan.height), (4096, 4096));
    assert_eq!(plan.gpu_bytes, 4096 * 4096 * 4);
    assert!(!plan.downscaled);
    drop(plan);

    // Explicit pixels still obey device limits and budget admission.
    let clamped = plan_overlays(&settings, &georef_none(), 513, 513, 256, 1 << 20).unwrap();
    assert_eq!((clamped.width, clamped.height), (256, 256));
    let budgeted = plan_overlays(&settings, &georef_none(), 513, 513, 8192, 256 * 256 * 4).unwrap();
    assert_eq!((budgeted.width, budgeted.height), (256, 256));
    assert_eq!(
        (budgeted.requested_width, budgeted.requested_height),
        (4096, 4096)
    );
    assert!(budgeted.downscaled);
    assert!(plan_overlays(&settings, &georef_none(), 513, 513, 8192, 100).is_err());

    settings.output_size = None;
    settings.resolution_scale = 2.0;
    let legacy = plan_overlays(&settings, &georef_none(), 513, 513, 8192, 1 << 27).unwrap();
    assert_eq!((legacy.width, legacy.height), (1026, 1026));
}

#[test]
fn explicit_output_size_rejects_zero_dimensions() {
    for size in [[0, 4096], [4096, 0]] {
        let mut settings = OverlaySettings::default();
        settings.output_size = Some(size);
        assert!(err_msg(settings.validate())
            .contains("output_size must contain two positive uint32 dimensions"));
    }
}

#[test]
fn test_plan_determinism() {
    let g = georef_none();
    let mut s = OverlaySettings::with_layers(vec![
        layer("b").with_z_order(1),
        layer("a").with_z_order(0).with_opacity(0.5),
        layer("c").with_z_order(1),
    ]);
    s.enabled = true;
    let p1 = plan_overlays(&s, &g, 64, 64, 4096, 1 << 24).unwrap();
    let p2 = plan_overlays(&s, &g, 64, 64, 4096, 1 << 24).unwrap();
    assert_eq!(p1, p2); // byte-identical plan
                        // Order: a (z=0), then b, c (z=1, stable).
    let names: Vec<&str> = p1.layers.iter().map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["a", "b", "c"]);
    let z: Vec<i32> = p1.layers.iter().map(|l| l.z_order).collect();
    assert_eq!(z, [0, 1, 1]);
}

#[test]
fn test_plan_resamples_uv_extent() {
    let g = georef_none();
    // Half-extent layer: only target pixels with uv in [0.25, 0.75]^2.
    let l = layer("win").with_placement(OverlayPlacement::uv([0.25, 0.25, 0.75, 0.75]).unwrap());
    let mut s = OverlaySettings::with_layers(vec![l]);
    s.enabled = true;
    let plan = plan_overlays(&s, &g, 8, 8, 4096, 1 << 20).unwrap();
    let px = |x: usize, y: usize| -> [u8; 4] {
        let i = (y * 8 + x) * 4;
        [
            plan.layers[0].rgba[i],
            plan.layers[0].rgba[i + 1],
            plan.layers[0].rgba[i + 2],
            plan.layers[0].rgba[i + 3],
        ]
    };
    // uv of pixel (0,0) center = (0.0625, 0.0625) -> outside extent -> transparent.
    assert_eq!(px(0, 0), [0, 0, 0, 0]);
    // (7,7) center = (0.9375) -> outside.
    assert_eq!(px(7, 7), [0, 0, 0, 0]);
    // (4,4) center = (0.5625) -> inside -> sampled from the 2x2 image.
    let inside = px(4, 4);
    assert_eq!(inside[3], 255);
    // Extent clipping: edge of the extent region.
    // pixel (2,2) center = 0.3125 inside; (1,1) = 0.1875 outside.
    assert_eq!(px(1, 1), [0, 0, 0, 0]);
    assert_ne!(px(2, 2)[3], 0);
}

#[test]
fn local_uv_plan_preserves_detail_and_footprint() {
    let extent = [0.45, 0.4, 0.46, 0.41];
    let l = layer("detail").with_placement(OverlayPlacement::uv(extent).unwrap());
    let mut settings = OverlaySettings::with_layers(vec![l]);
    settings.enabled = true;
    settings.output_size = Some([2, 2]);
    let local = plan_overlays_local_uv(&settings, &georef_none(), 513, 513, 4096, 1024).unwrap();
    assert_eq!(local.layers[0].extent, extent);
    assert_eq!(local.layers[0].rgba, image_2x2().rgba);
    // A terrain-wide bake misses this small footprint entirely at this size.
    let baked = plan_overlays(&settings, &georef_none(), 513, 513, 4096, 1024).unwrap();
    assert!(baked.layers[0].rgba.iter().all(|v| *v == 0));
    assert_eq!(local.gpu_bytes, baked.gpu_bytes);
}

#[test]
fn local_uv_plan_full_domain_is_unchanged() {
    let mut settings = OverlaySettings::with_layers(vec![layer("overview")]);
    settings.enabled = true;
    let baked = plan_overlays(&settings, &georef_none(), 8, 8, 4096, 1024).unwrap();
    let local = plan_overlays_local_uv(&settings, &georef_none(), 8, 8, 4096, 1024).unwrap();
    assert_eq!(local, baked);
}

#[test]
fn local_uv_plan_budget_preserves_extent_when_downscaled() {
    let extent = [0.2, 0.3, 0.4, 0.5];
    let mut settings = OverlaySettings::with_layers(vec![
        layer("detail").with_placement(OverlayPlacement::uv(extent).unwrap())
    ]);
    settings.enabled = true;
    settings.output_size = Some([2048, 2048]);
    let local =
        plan_overlays_local_uv(&settings, &georef_none(), 513, 513, 4096, 1024 * 1024).unwrap();
    assert!(local.downscaled);
    assert_eq!((local.width, local.height), (512, 512));
    assert_eq!(local.layers[0].extent, extent);
    assert_eq!(local.gpu_bytes, 1024 * 1024);
}

#[test]
fn test_plan_resample_exact_full_extent() {
    let g = georef_none();
    // Full-extent single-texel red layer: every pixel = red*opacity.
    let l = OverlayLayer::new("r", solid_image([200, 10, 5, 255]))
        .unwrap()
        .with_opacity(0.5);
    let mut s = OverlaySettings::with_layers(vec![l]);
    s.enabled = true;
    let plan = plan_overlays(&s, &g, 4, 4, 4096, 1 << 20).unwrap();
    for i in (0..4 * 4 * 4).step_by(4) {
        assert_eq!(plan.layers[0].rgba[i], 200);
        assert_eq!(plan.layers[0].rgba[i + 1], 10);
        assert_eq!(plan.layers[0].rgba[i + 2], 5);
        // alpha = 255/255 * 0.5 = 0.5 -> (0.5 * 255) as u8 = 127.
        assert_eq!(plan.layers[0].rgba[i + 3], 127);
    }
}

#[test]
fn test_plan_crs_layer_identical_crs() {
    // Terrain EPSG:4326 [5,49..7,50]; layer covers the NE quadrant.
    let g = TerrainGeoreference::new("EPSG:4326", [5.0, 49.0, 7.0, 50.0]);
    let l = layer("quad").with_placement(OverlayPlacement::Crs {
        crs: "epsg:4326".to_string(),
        bounds: [6.0, 49.5, 7.0, 50.0],
    });
    let mut s = OverlaySettings::with_layers(vec![l]);
    s.enabled = true;
    let plan = plan_overlays(&s, &g, 8, 8, 4096, 1 << 20).unwrap();
    let px = |x: usize, y: usize| -> u8 { plan.layers[0].rgba[(y * 8 + x) * 4 + 3] };
    // SW quadrant -> outside layer bounds -> transparent.
    assert_eq!(px(0, 7), 0); // uv (0.0625, 0.9375) -> x 5.125, y 49.0625 -> outside
                             // NE -> inside.
    assert_eq!(px(7, 0), 255); // uv (0.9375, 0.0625) -> x 6.875, y 49.9375 -> inside
}

#[test]
fn test_plan_crs_layer_reprojected() {
    // Layer in EPSG:3857 covering the whole terrain bounds reprojected.
    let g = TerrainGeoreference::new("EPSG:4326", [5.0, 49.0, 7.0, 50.0]);
    let (x0, y0) = lonlat_to_mercator(5.0, 49.0);
    let (x1, y1) = lonlat_to_mercator(7.0, 50.0);
    let l = OverlayLayer::new("m", solid_image([0, 200, 0, 255]))
        .unwrap()
        .with_placement(OverlayPlacement::Crs {
            crs: "EPSG:3857".to_string(),
            bounds: [x0, y0, x1, y1],
        });
    let mut s = OverlaySettings::with_layers(vec![l]);
    s.enabled = true;
    let plan = plan_overlays(&s, &g, 4, 4, 4096, 1 << 20).unwrap();
    // Whole terrain is inside the layer bounds -> all pixels opaque green.
    for i in (0..4 * 4 * 4).step_by(4) {
        assert_eq!(plan.layers[0].rgba[i + 1], 200);
        assert_eq!(plan.layers[0].rgba[i + 3], 255);
    }
}

#[test]
fn test_plan_crs_mismatch_error() {
    // Terrain without crs+bounds -> crs_mismatch.
    let l = layer("bad").with_placement(OverlayPlacement::Crs {
        crs: "EPSG:4326".to_string(),
        bounds: [0.0, 0.0, 1.0, 1.0],
    });
    let mut s = OverlaySettings::with_layers(vec![l]);
    s.enabled = true;
    let err = plan_overlays(&s, &georef_none(), 4, 4, 4096, 1 << 20).unwrap_err();
    match err {
        Forge3dError::UnsupportedFeature { feature } => assert_eq!(
            feature,
            "crs_mismatch: overlay layer 'bad' CRS EPSG:4326 cannot be placed on terrain CRS none (supported: identical CRS, EPSG:4326<->EPSG:3857)"
        ),
        other => panic!("expected UnsupportedFeature, got {other:?}"),
    }

    // Unsupported CRS pair -> same diagnostic with terrain CRS spelled out.
    let g = TerrainGeoreference::new("EPSG:32632", [0.0, 0.0, 1.0, 1.0]);
    let err = plan_overlays(&s, &g, 4, 4, 4096, 1 << 20).unwrap_err();
    match err {
        Forge3dError::UnsupportedFeature { feature } => assert!(feature.contains(
            "overlay layer 'bad' CRS EPSG:4326 cannot be placed on terrain CRS EPSG:32632"
        )),
        other => panic!("expected UnsupportedFeature, got {other:?}"),
    }
}

// ------------------------------------------------ resample reuse (web) --

fn reuse_settings(layers: Vec<OverlayLayer>) -> OverlaySettings {
    let mut settings = OverlaySettings::with_layers(layers);
    settings.enabled = true;
    settings.output_size = Some([16, 16]);
    settings
}

fn plan_reusing(
    settings: &OverlaySettings,
    previous: Option<(&OverlayPlan, &[u64])>,
) -> (OverlayPlan, Vec<u64>) {
    plan_overlays_local_uv_reusing(settings, &georef_none(), 64, 64, 4096, 1 << 24, previous)
        .unwrap()
}

#[test]
fn reusing_plan_is_byte_identical_to_a_fresh_plan() {
    let base = layer("base");
    let lava = OverlayLayer::new("lava", solid_image([255, 112, 40, 214]))
        .unwrap()
        .with_z_order(20);
    let first = reuse_settings(vec![base.clone(), lava]);
    let (plan, keys) = plan_reusing(&first, None);
    assert_eq!(
        plan,
        plan_overlays_local_uv(&first, &georef_none(), 64, 64, 4096, 1 << 24).unwrap()
    );
    assert_eq!(keys.len(), plan.layers.len());

    let next_lava = OverlayLayer::new("lava", solid_image([150, 50, 28, 158]))
        .unwrap()
        .with_z_order(20);
    let second = reuse_settings(vec![base, next_lava]);
    let (reused, _) = plan_reusing(&second, Some((&plan, &keys)));
    assert_eq!(
        reused,
        plan_overlays_local_uv(&second, &georef_none(), 64, 64, 4096, 1 << 24).unwrap()
    );
}

#[test]
fn reuse_copies_only_layers_whose_key_matches() {
    let settings = reuse_settings(vec![layer("base"), layer("lava").with_opacity(0.5)]);
    let (mut plan, keys) = plan_reusing(&settings, None);
    // Mark the cached bytes so a copy is distinguishable from a resample.
    for layer in &mut plan.layers {
        layer.rgba.fill(7);
    }
    let changed = reuse_settings(vec![layer("base"), layer("lava").with_opacity(0.25)]);
    let (next, next_keys) = plan_reusing(&changed, Some((&plan, &keys)));
    assert!(
        next.layers[0].rgba.iter().all(|v| *v == 7),
        "unchanged layer is copied"
    );
    assert!(
        next.layers[1].rgba.iter().any(|v| *v != 7),
        "edited layer is resampled"
    );
    assert_eq!(next_keys[0], keys[0]);
    assert_ne!(next_keys[1], keys[1]);
    // A different target size never reuses.
    let mut resized = changed.clone();
    resized.output_size = Some([8, 8]);
    let (small, _) = plan_reusing(&resized, Some((&plan, &keys)));
    assert!(small.layers[0].rgba.iter().any(|v| *v != 7));
}

#[test]
fn layer_key_tracks_resample_inputs_only() {
    let g = georef_none();
    let key = |l: &OverlayLayer| overlay_layer_key(l, &g, 16, 16, true);
    let base = layer("a");
    let mut edited = base.clone();
    edited.image.rgba[5] ^= 1;
    assert_ne!(key(&base), key(&edited));
    assert_ne!(key(&base), key(&base.clone().with_opacity(0.9)));
    assert_ne!(
        key(&base),
        key(&base
            .clone()
            .with_placement(OverlayPlacement::uv([0.0, 0.0, 0.5, 1.0]).unwrap()))
    );
    assert_ne!(key(&base), overlay_layer_key(&base, &g, 16, 8, true));
    assert_ne!(key(&base), overlay_layer_key(&base, &g, 16, 16, false));
    let restyled = OverlayLayer {
        name: "b".into(),
        blend_mode: OverlayBlendMode::Multiply,
        z_order: 9,
        ..base.clone()
    };
    assert_eq!(key(&base), key(&restyled));
}

#[test]
fn separable_uv_resample_matches_pointwise() {
    // Deterministic pseudo-random image so every channel and texel differs.
    let mut seed = 0x2545_F491_u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    let g = georef_none();
    for (iw, ih) in [(1, 1), (2, 3), (37, 19), (64, 64)] {
        let rgba = (0..iw * ih * 4).map(|_| next() as u8).collect();
        let image = OverlayImage::new(iw, ih, rgba).unwrap();
        for extent in [
            [0.0, 0.0, 1.0, 1.0],
            [0.15, 0.2, 0.65, 0.9],
            [0.45, 0.4, 0.46, 0.41],
        ] {
            for opacity in [1.0, 0.7, 0.33] {
                let layer = OverlayLayer::new("l", image.clone())
                    .unwrap()
                    .with_placement(OverlayPlacement::uv(extent).unwrap())
                    .with_opacity(opacity);
                // Equal-size targets put taps on texel centers (zero weights).
                for (tw, th) in [
                    (1, 1),
                    (16, 9),
                    (61, 77),
                    (128, 128),
                    (iw, ih),
                    (2 * iw, ih),
                ] {
                    for local_uv in [false, true] {
                        let pointwise =
                            resample_layer_pointwise(&layer, &g, tw, th, local_uv).unwrap();
                        let separable = resample_uv_separable(&layer, &extent, tw, th, local_uv);
                        assert!(
                            pointwise == separable,
                            "image {iw}x{ih} extent {extent:?} opacity {opacity} target {tw}x{th} local {local_uv}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn equal_size_uv_layer_takes_the_row_copy_and_matches_pointwise() {
    // The La Palma lava/overview shape: a 2048² layer into a 2048² plan.
    let size = 2048;
    let taps = axis_taps(size, size, 0.0, 1.0, true);
    assert!(
        taps.iter()
            .enumerate()
            .all(|(i, tap)| !tap.skip && tap.t == 0.0 && tap.lo as usize == i),
        "every column is a weight-0 tap of its own texel, so rows are copied whole"
    );
    let mut seed = 0x9E37_79B9_u32;
    let rgba: Vec<u8> = (0..size * size * 4)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as u8
        })
        .collect();
    let image = OverlayImage::new(size, size, rgba).unwrap();
    let g = georef_none();
    let extent = [0.0, 0.0, 1.0, 1.0];
    for opacity in [1.0, 0.62] {
        let layer = OverlayLayer::new("l", image.clone())
            .unwrap()
            .with_opacity(opacity);
        let pointwise = resample_layer_pointwise(&layer, &g, size, size, true).unwrap();
        let separable = resample_uv_separable(&layer, &extent, size, size, true);
        assert!(pointwise == separable, "opacity {opacity}");
    }
}
