use forge3d_core::lighting::{self, DirectionalLight, Light, PointLight};
use forge3d_core::materials::{self, BrdfModel, MaterialSlot};

use super::{specialize, ShaderFeatures, BRDF_MODEL_COUNT, SHADOW_FILTER_BASE};
use crate::runtime::scene::pipelines::WORLD_SHADER;
use crate::runtime::terrain::TERRAIN_SHADER;

fn validate(label: &str, source: &str) {
    let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| {
        panic!(
            "{label}: WGSL parse failed:\n{}",
            error.emit_to_string(source)
        )
    });
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .unwrap_or_else(|error| panic!("{label}: WGSL validation failed: {error:?}"));
}

/// Feature sets exercised against both templates: the full template, the
/// empty set, every single region toggled on and off, and a deterministic
/// pseudo-random sweep of combinations.
fn variant_sweep() -> Vec<ShaderFeatures> {
    let all = ShaderFeatures::ALL.bits();
    let mut sets = vec![all, 0];
    for bit in 0..41 {
        sets.push(1 << bit);
        sets.push(all & !(1 << bit));
    }
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    for _ in 0..96 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        sets.push(state & all);
    }
    sets.into_iter().map(ShaderFeatures::from_bits).collect()
}

#[test]
fn preprocessor_handles_if_else_nesting_negation_and_alternatives() {
    let template = "a\n// #if ibl\nb\n// #if !shadows\nc\n// #else\nd\n// #endif\n// #else\ne\n// #endif\n// #if shadows || tex_base\nf\n// #endif\ng\n";
    let ibl_only = ShaderFeatures::from_bits(super::IBL);
    assert_eq!(specialize(template, ibl_only), "a\nb\nc\ng\n");
    let ibl_shadows = ShaderFeatures::from_bits(super::IBL | super::SHADOWS);
    assert_eq!(specialize(template, ibl_shadows), "a\nb\nd\nf\ng\n");
    let texture_only = ShaderFeatures::from_bits(super::TEX_BASE);
    assert_eq!(specialize(template, texture_only), "a\ne\nf\ng\n");
}

#[test]
#[should_panic(expected = "unterminated #if")]
fn preprocessor_rejects_unterminated_regions() {
    specialize("// #if ibl\na\n", ShaderFeatures::ALL);
}

#[test]
#[should_panic(expected = "unknown shader feature")]
fn preprocessor_rejects_unknown_features() {
    specialize("// #if nope\na\n// #endif\n", ShaderFeatures::ALL);
}

#[test]
fn full_template_keeps_every_region_and_no_markers() {
    for (label, template) in [("terrain", TERRAIN_SHADER), ("world", WORLD_SHADER)] {
        let full = specialize(template, ShaderFeatures::ALL);
        assert!(
            !full.contains("// #"),
            "{label}: markers leaked into the full template"
        );
        for model in 0..BRDF_MODEL_COUNT {
            assert!(
                full.contains(&format!("case {model}u")),
                "{label}: brdf {model} missing"
            );
        }
        assert!(full.contains("forge3d_shadow_msm(shadow_uv, cascade, depth)"));
        assert!(full.contains("forge3d_eval_ibl(n, v, base_color"));
    }
    let terrain = specialize(TERRAIN_SHADER, ShaderFeatures::ALL);
    assert!(terrain.contains("return terrain_screen_shade(input);"));
}

#[test]
fn every_terrain_variant_is_valid_wgsl() {
    for features in variant_sweep() {
        for mode in [0, 1] {
            let features = features.with_terrain_mode(mode);
            validate(
                &format!("terrain {:#x}", features.bits()),
                &specialize(TERRAIN_SHADER, features),
            );
        }
    }
}

#[test]
fn every_world_variant_is_valid_wgsl() {
    for features in variant_sweep() {
        validate(
            &format!("world {:#x}", features.bits()),
            &specialize(WORLD_SHADER, features),
        );
    }
}

#[test]
fn specialization_drops_unreachable_regions() {
    let defaults = ShaderFeatures::for_lighting(
        &lighting::default_state(),
        &materials::default_state(),
        false,
        [0; 4],
    )
    .with_terrain_mode(0);
    let full = specialize(TERRAIN_SHADER, ShaderFeatures::ALL);
    let minimal = specialize(TERRAIN_SHADER, defaults);
    assert!(
        minimal.len() < full.len(),
        "default variant should shed unreachable regions"
    );
    assert!(!minimal.contains("return terrain_screen_shade(input);"));
    assert!(!minimal.contains("forge3d_shadow_pcss(shadow_uv"));
    assert!(!minimal.contains("forge3d_eval_ibl(n, v"));
    assert!(
        minimal.contains("case 4u"),
        "default GGX material must stay"
    );
    assert!(
        !minimal.contains("case 8u"),
        "unused Ward route must be dropped"
    );
}

#[test]
fn default_runtime_state_selects_ggx_and_directional_only() {
    let features = ShaderFeatures::for_lighting(
        &lighting::default_state(),
        &materials::default_state(),
        false,
        [0; 4],
    );
    assert_eq!(
        features.bits(),
        (1 << BrdfModel::CookTorranceGgx as u64) | super::LIGHT_DIRECTIONAL
    );
}

#[test]
fn every_material_route_enables_its_effective_shader_case() {
    for model in BrdfModel::ALL {
        let mut state = materials::default_state();
        let mut material = materials::default_material();
        material.id = model.name().to_string();
        material.route = materials::resolve_brdf(model.name()).expect("canonical route");
        state.slots.push(MaterialSlot {
            slot: format!("slot-{}", model.name()),
            index: 3,
            material,
        });
        let effective = state.pack_materials()[3].effective_brdf;
        let features =
            ShaderFeatures::for_lighting(&lighting::default_state(), &state, false, [0; 4]);
        assert_ne!(features.bits() & (1 << effective), 0, "{}", model.name());
        // Unused slots between packed lanes resolve to Lambert, the switch default.
        assert_eq!(state.pack_materials()[1].effective_brdf, 0);
        let source = specialize(TERRAIN_SHADER, features.with_terrain_mode(0));
        assert!(
            source.contains(&format!("case {effective}u")),
            "{}",
            model.name()
        );
    }
}

#[test]
fn texture_flags_light_kinds_and_debug_bounds_select_regions() {
    let mut state = materials::default_state();
    state.slots[0].material.flags = 0b1_0110;
    let mut lights = lighting::default_state();
    lights.debug_bounds = true;
    lights.lights = vec![Light::Point(PointLight {
        color: [1.0; 3],
        intensity: 1.0,
        enabled: false,
        casts_shadow: false,
        position: [0.0; 3],
        range: 1.0,
        inner_radius: 0.0,
        edge_softness: 0.0,
        falloff: lighting::SoftLightFalloff::Quadratic,
        falloff_exponent: 2.0,
    })];
    let features = ShaderFeatures::for_lighting(&lights, &state, true, [0; 4]);
    let bits = features.bits();
    assert_eq!(bits & super::TEX_BASE, 0);
    assert_ne!(bits & super::TEX_NORMAL, 0);
    assert_ne!(bits & super::TEX_METALLIC_ROUGHNESS, 0);
    assert_eq!(bits & super::TEX_OCCLUSION, 0);
    assert_ne!(bits & super::TEX_EMISSIVE, 0);
    // Disabled lights still count: their kind stays reachable once re-enabled
    // by a lighting-only update that does not rebuild pipelines itself.
    assert_ne!(bits & super::LIGHT_POINT_SPOT, 0);
    assert_eq!(bits & super::LIGHT_DIRECTIONAL, 0);
    assert_ne!(bits & super::LIGHT_DEBUG_BOUNDS, 0);
    assert_ne!(bits & super::IBL, 0);
}

#[test]
fn shadow_control_lanes_select_filter_and_debug_regions() {
    let lights = lighting::default_state();
    let state = materials::default_state();
    for lane in 0..6u32 {
        let features = ShaderFeatures::for_lighting(&lights, &state, false, [1, lane, 3, 0]);
        let expected = super::SHADOWS | (1 << (SHADOW_FILTER_BASE + lane));
        assert_eq!(
            features.bits() & (super::SHADOWS | 0x3f << SHADOW_FILTER_BASE),
            expected
        );
    }
    let disabled = ShaderFeatures::for_lighting(&lights, &state, false, [0, 2, 1, 1]);
    assert_eq!(disabled.bits() & super::SHADOWS, 0);
    assert_eq!(disabled.bits() & (0x3f << SHADOW_FILTER_BASE), 0);
    assert_ne!(disabled.bits() & super::SHADOW_DEBUG_CASCADES, 0);
    let factor = ShaderFeatures::for_lighting(&lights, &state, false, [1, 1, 1, 2]);
    assert_ne!(factor.bits() & super::SHADOW_DEBUG_FACTOR, 0);
    let _ = DirectionalLight {
        color: [1.0; 3],
        intensity: 1.0,
        enabled: true,
        casts_shadow: true,
        direction: [0.0, -1.0, 0.0],
    };
}

#[test]
fn terrain_mode_selects_exactly_one_render_path() {
    let features = ShaderFeatures::from_bits(super::TERRAIN_SCREEN | super::TERRAIN_PERSPECTIVE);
    let perspective = features.with_terrain_mode(0).bits();
    assert_eq!(perspective & super::TERRAIN_SCREEN, 0);
    assert_ne!(perspective & super::TERRAIN_PERSPECTIVE, 0);
    let screen = features.with_terrain_mode(1).bits();
    assert_ne!(screen & super::TERRAIN_SCREEN, 0);
    assert_eq!(screen & super::TERRAIN_PERSPECTIVE, 0);
}
