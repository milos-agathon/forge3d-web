use super::{
    select_caster, shadow_map_size_ladder, shadow_texture_bytes, shadows_from_json, ShadowCaster,
};
use forge3d_core::lighting::{DirectionalLight, Light, LightingState};
use forge3d_core::memory::OverflowPolicy;
use forge3d_core::shadowing::{ShadowFilter, SHADOW_DEPTH_UNIFORM_BYTES, SHADOW_UNIFORM_BYTES};
use serde_json::json;

fn shadow_snapshot() -> serde_json::Value {
    json!({
        "config": {
            "enabled": true,
            "filter": "pcf",
            "mapSize": 256,
            "depthBias": 0.002,
            "normalBias": 0.02,
            "slopeBias": 0.01,
            "softness": 1.0,
            "pcssBlockerRadius": 2.0,
            "pcssFilterRadius": 4.0,
            "lightSize": 0.25,
            "momentBias": 0.0005,
            "lightBleedReduction": 0.2,
            "evsmPositiveExponent": 5.0,
            "evsmNegativeExponent": 5.0,
            "peterPanningOffset": 0.001
        },
        "csm": {
            "enabled": true,
            "cascadeCount": 3,
            "maxDistance": 200.0,
            "splitLambda": 0.75,
            "blendRange": 0.1,
            "stabilize": true,
            "debugView": "none"
        },
        "report": {
            "requestedFilter": "pcf",
            "effectiveFilter": "pcf",
            "requestedMapSize": 256,
            "effectiveMapSize": 256,
            "csmEnabled": true,
            "cascadeCount": 3,
            "momentFormat": "none",
            "casterLightId": null,
            "reason": "requested configuration"
        }
    })
}

fn directional_light(casts_shadow: bool) -> Light {
    Light::Directional(DirectionalLight {
        color: [1.0, 1.0, 1.0],
        intensity: 1.0,
        enabled: true,
        casts_shadow,
        direction: [0.0, -1.0, 0.0],
    })
}

fn lighting_state(lights: Vec<Light>) -> LightingState {
    LightingState {
        max_lights: 64,
        exposure: 1.0,
        debug_bounds: false,
        area: forge3d_core::lighting::AreaLightConfig::default(),
        lights,
    }
}

#[test]
fn parses_a_valid_shadow_snapshot() {
    let parsed = shadows_from_json(&shadow_snapshot()).expect("valid snapshot");
    assert!(parsed.config.enabled);
    assert_eq!(parsed.config.filter, ShadowFilter::Pcf);
    assert_eq!(parsed.config.map_size, 256);
    assert!(parsed.csm.enabled);
    assert_eq!(parsed.csm.cascade_count, 3);
}

#[test]
fn rejects_csm_as_a_filter_with_pipeline_message() {
    let mut snapshot = shadow_snapshot();
    snapshot["config"]["filter"] = json!("csm");
    snapshot["report"]["requestedFilter"] = json!("csm");
    snapshot["report"]["effectiveFilter"] = json!("csm");
    let error = shadows_from_json(&snapshot).expect_err("csm must be rejected");
    assert_eq!(error.code().as_str(), "INVALID_INPUT");
    assert!(
        error
            .message()
            .contains("csm is a cascade pipeline, not a shadow filter"),
        "unexpected message: {}",
        error.message()
    );
}

#[test]
fn rejects_invalid_config_and_csm_values() {
    for (path, value) in [
        (vec!["config", "filter"], json!("gaussian")),
        (vec!["config", "mapSize"], json!(300)),
        (vec!["config", "mapSize"], json!(128)),
        (vec!["config", "depthBias"], json!(-0.1)),
        (vec!["config", "lightSize"], json!(0.0)),
        (vec!["config", "lightBleedReduction"], json!(1.0)),
        (vec!["config", "evsmPositiveExponent"], json!(0.0)),
        (vec!["csm", "cascadeCount"], json!(5)),
        (vec!["csm", "maxDistance"], json!(0.0)),
        (vec!["csm", "splitLambda"], json!(1.5)),
        (vec!["csm", "debugView"], json!("depth")),
    ] {
        let mut snapshot = shadow_snapshot();
        let mut cursor = &mut snapshot;
        for key in &path[..path.len() - 1] {
            cursor = cursor.get_mut(*key).expect("path component");
        }
        *cursor.get_mut(path[path.len() - 1]).expect("leaf") = value;
        assert!(
            shadows_from_json(&snapshot).is_err(),
            "expected rejection for {path:?}"
        );
    }
}

#[test]
fn rejects_report_tampering() {
    let cases: Vec<(Vec<&str>, serde_json::Value)> = vec![
        (vec!["report", "requestedFilter"], json!("vsm")),
        (vec!["report", "effectiveFilter"], json!("hard")),
        (vec!["report", "requestedMapSize"], json!(512)),
        (vec!["report", "effectiveMapSize"], json!(300)),
        (vec!["report", "csmEnabled"], json!(false)),
        (vec!["report", "cascadeCount"], json!(1)),
        (vec!["report", "momentFormat"], json!("rgba32float")),
        (vec!["report", "casterLightId"], json!("7")),
        (vec!["report", "reason"], json!(7)),
    ];
    for (path, value) in cases {
        let mut snapshot = shadow_snapshot();
        let mut cursor = &mut snapshot;
        for key in &path[..path.len() - 1] {
            cursor = cursor.get_mut(*key).expect("path component");
        }
        *cursor.get_mut(path[path.len() - 1]).expect("leaf") = value;
        assert!(
            shadows_from_json(&snapshot).is_err(),
            "expected rejection for {path:?}"
        );
    }
}

#[test]
fn disabled_shadows_report_no_effective_cascades() {
    let mut snapshot = shadow_snapshot();
    snapshot["config"]["enabled"] = json!(false);
    snapshot["report"]["reason"] = json!("shadows disabled");
    snapshot["report"]["csmEnabled"] = json!(false);
    snapshot["report"]["cascadeCount"] = json!(1);
    let parsed = shadows_from_json(&snapshot).expect("disabled snapshot");
    assert!(parsed.csm.enabled, "requested csm config is preserved");

    let mut claims_csm = snapshot.clone();
    claims_csm["report"]["csmEnabled"] = json!(true);
    claims_csm["report"]["cascadeCount"] = json!(3);
    assert!(
        shadows_from_json(&claims_csm).is_err(),
        "a disabled shadow report must not claim active cascades"
    );
}

#[test]
fn moment_filter_snapshots_require_rgba32float_report() {
    let mut snapshot = shadow_snapshot();
    snapshot["config"]["filter"] = json!("vsm");
    snapshot["report"]["requestedFilter"] = json!("vsm");
    snapshot["report"]["effectiveFilter"] = json!("vsm");
    snapshot["report"]["momentFormat"] = json!("none");
    assert!(shadows_from_json(&snapshot).is_err());
    snapshot["report"]["momentFormat"] = json!("rgba32float");
    let parsed = shadows_from_json(&snapshot).expect("vsm snapshot");
    assert!(parsed.config.requires_moments());
}

#[test]
fn selects_the_first_enabled_shadow_casting_directional() {
    let state = lighting_state(vec![
        directional_light(false),
        directional_light(true),
        directional_light(true),
    ]);
    let caster = select_caster(&state, &[10, 11, 12]).expect("caster");
    assert_eq!(
        caster,
        ShadowCaster {
            index: 1,
            id: 11,
            direction: [0.0, -1.0, 0.0]
        }
    );
}

#[test]
fn caster_falls_back_to_index_when_ids_are_absent() {
    let state = lighting_state(vec![directional_light(true)]);
    let caster = select_caster(&state, &[]).expect("caster");
    assert_eq!(caster.id, 0);
}

#[test]
fn non_directional_and_disabled_casters_are_skipped() {
    let disabled = match directional_light(true) {
        Light::Directional(mut light) => {
            light.enabled = false;
            Light::Directional(light)
        }
        other => other,
    };
    let point = Light::Point(forge3d_core::lighting::PointLight {
        color: [1.0, 1.0, 1.0],
        intensity: 1.0,
        enabled: true,
        casts_shadow: true,
        position: [0.0, 0.0, 0.0],
        range: 10.0,
        inner_radius: 0.0,
        edge_softness: 0.0,
        falloff: forge3d_core::lighting::SoftLightFalloff::Linear,
        falloff_exponent: 2.0,
    });
    let state = lighting_state(vec![disabled, point, directional_light(true)]);
    let caster = select_caster(&state, &[3, 4, 5]).expect("caster");
    assert_eq!((caster.index, caster.id), (2, 5));
}

#[test]
fn map_size_ladder_downscales_powers_of_two() {
    assert_eq!(
        shadow_map_size_ladder(2048, OverflowPolicy::Downscale),
        vec![2048, 1024, 512, 256]
    );
    assert_eq!(
        shadow_map_size_ladder(2048, OverflowPolicy::Reject),
        vec![2048]
    );
    assert_eq!(
        shadow_map_size_ladder(256, OverflowPolicy::Downscale),
        vec![256]
    );
}

#[test]
fn shadow_texture_bytes_matches_the_public_estimate_formula() {
    let bytes = shadow_texture_bytes(256, 3, true).expect("bytes");
    let expected = 256u64 * 256 * 4 * 3
        + 256u64 * 256 * 16 * 3
        + SHADOW_UNIFORM_BYTES as u64
        + 3 * SHADOW_DEPTH_UNIFORM_BYTES as u64;
    assert_eq!(bytes, expected);
    assert_eq!(
        shadow_texture_bytes(256, 3, false).expect("bytes"),
        256u64 * 256 * 4 * 3 + SHADOW_UNIFORM_BYTES as u64 + 3 * SHADOW_DEPTH_UNIFORM_BYTES as u64
    );
}

#[test]
fn shader_sources_cover_all_six_filters_and_debug_views() {
    const SHADOW_LIGHTING: &str = include_str!("../shadow_lighting.wgsl");
    const SHADOW_DEPTH: &str = include_str!("../shadow_depth.wgsl");
    const SHADOW_MOMENTS: &str = include_str!("../shadow_moments.wgsl");
    for needle in [
        "texture_depth_2d_array",
        "sampler_comparison",
        "textureSampleCompare",
        "forge3d_shadow_pcss",
        "forge3d_shadow_vsm",
        "forge3d_shadow_evsm",
        "forge3d_shadow_msm",
        "forge3d_shadow_visibility",
        "forge3d_shadow_debug_color",
        "cascade pipeline",
    ] {
        if needle == "cascade pipeline" {
            continue;
        }
        assert!(SHADOW_LIGHTING.contains(needle), "missing {needle}");
    }
    assert!(SHADOW_DEPTH.contains("vs_terrain_depth"));
    assert!(SHADOW_DEPTH.contains("vs_scene_depth"));
    assert!(SHADOW_MOMENTS.contains("rgba32float"));
    assert!(SHADOW_MOMENTS.contains("z * z * z"));
    assert!(!SHADOW_LIGHTING.contains("case 6u"));
}

#[test]
fn comparison_sampler_is_nearest_for_hard_filtering() {
    const SOURCE: &str = include_str!("../shadows.rs");
    let block = SOURCE
        .split("forge3d-shadow-compare")
        .nth(1)
        .and_then(|rest| rest.split("forge3d-shadow-plain").next())
        .expect("comparison sampler descriptor");
    assert!(block.contains("mag_filter: wgpu::FilterMode::Nearest"));
    assert!(block.contains("min_filter: wgpu::FilterMode::Nearest"));
    assert!(!block.contains("FilterMode::Linear"));
}

#[test]
fn evsm_uses_negative_warp_and_full_rgba32float_range() {
    const SHADOW_LIGHTING: &str = include_str!("../shadow_lighting.wgsl");
    const SHADOW_MOMENTS: &str = include_str!("../shadow_moments.wgsl");
    assert!(SHADOW_MOMENTS.contains("-exp(-min(moments.negative_exponent"));
    assert!(SHADOW_LIGHTING.contains("-exp(-min(forge3d_shadows.params3.x"));
    assert!(
        !SHADOW_MOMENTS.contains("65504"),
        "rgba32float moments must not be clamped to half-float range"
    );
}

#[test]
fn msm_uses_the_scaled_hamburger_correction() {
    const SHADOW_LIGHTING: &str = include_str!("../shadow_lighting.wgsl");
    assert!(SHADOW_LIGHTING.contains("c.z *= d22 / d33_d22"));
    assert!(!SHADOW_LIGHTING.contains("c.z /= d33_d22"));
}

#[test]
fn out_of_volume_projections_are_lit() {
    const SHADOW_LIGHTING: &str = include_str!("../shadow_lighting.wgsl");
    assert!(SHADOW_LIGHTING.contains("projected.z >= 0.0"));
    assert!(SHADOW_LIGHTING.contains("projected.z <= 1.0"));
    assert!(SHADOW_LIGHTING.contains("abs(projected.w) > 1e-6"));
}

#[test]
fn refresh_uses_the_effective_map_size_for_cascades() {
    const SOURCE: &str = include_str!("../shadows.rs");
    assert!(SOURCE.contains("effective_config.map_size = shadows.effective_map_size"));
    let prepare = SOURCE
        .split("fn prepare_shadow_state")
        .nth(1)
        .expect("prepare_shadow_state");
    assert!(
        prepare.matches("&effective_config").count() >= 2,
        "cascade building and uniform packing must use the effective config"
    );
}
