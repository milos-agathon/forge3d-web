use super::*;

fn material() -> Material {
    Material {
        id: "mat".to_string(),
        route: resolve_brdf("cooktorrance-ggx").expect("canonical route"),
        base_color: [0.5, 0.4, 0.3, 1.0],
        metallic: 0.0,
        roughness: 0.5,
        sheen: 0.2,
        clearcoat: 0.2,
        subsurface: 0.2,
        anisotropy: 0.25,
        flags: 0,
    }
}

fn state() -> MaterialState {
    default_state()
}

#[test]
fn brdf_model_discriminants_match_canonical_order() {
    let order = [
        BrdfModel::Lambert,
        BrdfModel::Phong,
        BrdfModel::BlinnPhong,
        BrdfModel::OrenNayar,
        BrdfModel::CookTorranceGgx,
        BrdfModel::CookTorranceBeckmann,
        BrdfModel::DisneyPrincipled,
        BrdfModel::AshikhminShirley,
        BrdfModel::Ward,
        BrdfModel::Toon,
        BrdfModel::Minnaert,
        BrdfModel::Subsurface,
        BrdfModel::Hair,
    ];
    for (expected, model) in order.iter().enumerate() {
        assert_eq!(*model as u32, expected as u32, "{model:?} discriminant");
    }
    assert_eq!(order.len(), 13);
    assert_eq!(CANONICAL_BRDF_MODELS, order.map(|model| model.name()));
}

#[test]
fn packed_layout_matches_gpu_contract() {
    assert_eq!(std::mem::size_of::<PackedMaterial>(), 64);
    assert_eq!(std::mem::align_of::<PackedMaterial>(), 16);
    assert_eq!(std::mem::size_of::<MaterialUniform>(), 16);
    assert_eq!(std::mem::align_of::<MaterialUniform>(), 16);
}

#[test]
fn packing_writes_material_lanes() {
    let packed = material().pack();
    assert_eq!(packed.brdf, BrdfModel::CookTorranceGgx as u32);
    assert_eq!(packed.effective_brdf, BrdfModel::CookTorranceGgx as u32);
    assert_eq!(packed.route_kind, ROUTE_EXACT);
    assert_eq!(packed.flags, 0);
    assert_eq!(packed.base_color, [0.5, 0.4, 0.3, 1.0]);
    assert_eq!(packed.surface, [0.0, 0.5, 0.2, 0.2]);
    assert_eq!(packed.lobes, [0.2, 0.25, 0.0, 0.0]);

    let mut aliased = material();
    aliased.route = resolve_brdf("blinn-phong").expect("route");
    let packed = aliased.pack();
    assert_eq!(packed.brdf, BrdfModel::BlinnPhong as u32);
    assert_eq!(packed.effective_brdf, BrdfModel::Phong as u32);
    assert_eq!(packed.route_kind, ROUTE_ALIAS);
}

#[test]
fn texture_flags_pack_and_validate() {
    let mut textured = material();
    textured.flags = MATERIAL_FLAG_BASE_COLOR_TEXTURE
        | MATERIAL_FLAG_NORMAL_TEXTURE
        | MATERIAL_FLAG_METALLIC_ROUGHNESS_TEXTURE
        | MATERIAL_FLAG_OCCLUSION_TEXTURE
        | MATERIAL_FLAG_EMISSIVE_TEXTURE;
    textured.validated().expect("flag bits 0..4 are valid");
    assert_eq!(textured.pack().flags, 0x1f);
    let mut bad = material();
    bad.flags = 0x20;
    assert!(bad.validated().is_err());
}

#[test]
fn state_packing_indexes_by_slot_index() {
    let mut state = state();
    state.slots.push(MaterialSlot {
        slot: "hero".to_string(),
        index: 3,
        material: material(),
    });
    let validated = state.validated().expect("valid state");
    let packed = validated.pack_materials();
    assert_eq!(packed.len(), 4);
    assert_eq!(packed[0].brdf, BrdfModel::CookTorranceGgx as u32);
    assert_eq!(packed[3].route_kind, ROUTE_EXACT);
    let uniform = validated.uniform();
    assert_eq!(uniform.material_count, 4);
    assert_eq!(uniform.default_index, 0);
}

#[test]
fn route_table_covers_exact_alias_and_approximation() {
    for canonical in CANONICAL_BRDF_MODELS {
        let route = resolve_brdf(canonical).expect("canonical model resolves");
        assert_eq!(route.model, canonical);
        assert_eq!(route.requested, canonical);
        match canonical {
            "blinn-phong" => {
                assert_eq!(route.effective_model, "phong");
                assert_eq!(route.implementation, BrdfImplementation::Alias);
                assert_eq!(
                    route.diagnostic.as_deref(),
                    Some("blinn-phong is rendered by the normalized phong route")
                );
            }
            "subsurface" => {
                assert_eq!(route.effective_model, "disney-principled");
                assert_eq!(route.implementation, BrdfImplementation::Approximation);
                assert_eq!(
                    route.diagnostic.as_deref(),
                    Some(
                        "subsurface is approximated by disney-principled with the subsurface lobe"
                    )
                );
            }
            "hair" => {
                assert_eq!(route.effective_model, "ashikhmin-shirley");
                assert_eq!(route.implementation, BrdfImplementation::Approximation);
                assert_eq!(
                    route.diagnostic.as_deref(),
                    Some("hair is approximated by ashikhmin-shirley anisotropy")
                );
            }
            _ => {
                assert_eq!(route.effective_model, canonical);
                assert_eq!(route.implementation, BrdfImplementation::Exact);
                assert!(route.diagnostic.is_none());
            }
        }
    }

    let ggx = resolve_brdf("ggx").expect("alias");
    assert_eq!(ggx.model, "cooktorrance-ggx");
    assert_eq!(ggx.effective_model, "cooktorrance-ggx");
    assert_eq!(ggx.implementation, BrdfImplementation::Alias);
    assert_eq!(
        ggx.diagnostic.as_deref(),
        Some("ggx is an alias for cooktorrance-ggx")
    );

    let sss = resolve_brdf("sss").expect("alias");
    assert_eq!(sss.model, "subsurface");
    assert_eq!(sss.effective_model, "disney-principled");
    assert_eq!(sss.implementation, BrdfImplementation::Approximation);
    assert_eq!(
        sss.diagnostic.as_deref(),
        Some(
            "subsurface is approximated by disney-principled with the subsurface lobe; input alias sss resolves to subsurface"
        )
    );

    let kajiya = resolve_brdf("kajiya-kay").expect("alias");
    assert_eq!(kajiya.model, "hair");
    assert_eq!(kajiya.effective_model, "ashikhmin-shirley");
    assert_eq!(kajiya.implementation, BrdfImplementation::Approximation);
    assert_eq!(
        kajiya.diagnostic.as_deref(),
        Some(
            "hair is approximated by ashikhmin-shirley anisotropy; input alias kajiya-kay resolves to hair"
        )
    );

    let spelled = resolve_brdf("  Blinn_Phong ").expect("normalized canonical");
    assert_eq!(spelled.requested, "  Blinn_Phong ");
    assert_eq!(spelled.model, "blinn-phong");
    assert_eq!(spelled.effective_model, "phong");
    assert_eq!(spelled.implementation, BrdfImplementation::Alias);
    assert_eq!(
        spelled.diagnostic.as_deref(),
        Some("blinn-phong is rendered by the normalized phong route")
    );

    let normalized_exact = resolve_brdf("Oren Nayar").expect("normalized canonical");
    assert_eq!(normalized_exact.model, "oren-nayar");
    assert_eq!(normalized_exact.implementation, BrdfImplementation::Exact);
    assert!(normalized_exact.diagnostic.is_none());

    assert!(resolve_brdf("custom-brdf").is_err());
    assert!(resolve_brdf("").is_err());
    assert!(resolve_brdf("ward-ish").is_err());
}

#[test]
fn lambert_returns_base_over_pi() {
    let mut lambert_material = material();
    lambert_material.route = resolve_brdf("lambert").expect("route");
    lambert_material.base_color = [0.8, 0.6, 0.4, 1.0];
    let expected = [0.25464791_f32, 0.19098593, 0.12732396];
    let actual = evaluate_brdf(
        BrdfModel::Lambert,
        &lambert_material,
        [0.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
    );
    for channel in 0..3 {
        assert!(
            (actual[channel] - expected[channel]).abs() < 1e-6,
            "lambert channel {channel}: {} vs {}",
            actual[channel],
            expected[channel]
        );
    }
}

#[test]
fn cooktorrance_ggx_matches_reference_at_normal_incidence() {
    let mut ggx_material = material();
    ggx_material.base_color = [0.8, 0.6, 0.4, 1.0];
    ggx_material.metallic = 0.0;
    ggx_material.roughness = 0.5;
    let actual = evaluate_brdf(
        BrdfModel::CookTorranceGgx,
        &ggx_material,
        [0.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
    );
    let expected = [0.2571944_f32, 0.1960789, 0.1349634];
    for channel in 0..3 {
        assert!(
            (actual[channel] - expected[channel]).abs() < 2e-5,
            "ggx channel {channel}: {} vs {}",
            actual[channel],
            expected[channel]
        );
    }
}

#[test]
fn every_model_returns_finite_nonnegative_at_incidence_and_grazing() {
    let cases: [[f32; 3]; 3] = [[0.0, 1.0, 0.0], [0.0, 0.05, 0.9987], [0.7071, 0.05, 0.7053]];
    let unit = |v: [f32; 3]| {
        let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        [v[0] / length, v[1] / length, v[2] / length]
    };
    for model in BrdfModel::ALL {
        for light in cases {
            for view in cases {
                let value =
                    evaluate_brdf(model, &material(), [0.0, 1.0, 0.0], unit(view), unit(light));
                for (channel, component) in value.iter().enumerate() {
                    assert!(
                        component.is_finite() && *component >= 0.0,
                        "{model:?} channel {channel} was {component}"
                    );
                }
            }
        }
    }
}

fn hemisphere_energy(model: BrdfModel, material: &Material) -> [f32; 3] {
    const SAMPLES: usize = 8192;
    let normal = [0.0_f32, 1.0, 0.0];
    let view = [0.0_f32, 1.0, 0.0];
    let mut total = [0.0_f32; 3];
    for i in 0..SAMPLES {
        let u = (i as f32 + 0.5) / SAMPLES as f32;
        let phi = 2.0 * std::f32::consts::PI * ((i as f32) * 0.618_034).fract();
        let ring = (1.0 - u * u).max(0.0).sqrt();
        let light = [ring * phi.cos(), u, ring * phi.sin()];
        let value = evaluate_brdf(model, material, normal, view, light);
        let cos = u.max(0.0);
        for channel in 0..3 {
            total[channel] += value[channel] * cos * 2.0 * std::f32::consts::PI / SAMPLES as f32;
        }
    }
    total
}

#[test]
fn brdfs_integrate_to_bounded_energy() {
    for model in BrdfModel::ALL {
        if model == BrdfModel::Toon {
            continue;
        }
        let energy = hemisphere_energy(model, &material());
        for (channel, value) in energy.iter().enumerate() {
            assert!(
                *value <= 1.05,
                "{model:?} channel {channel} energy {value} exceeds 1.05"
            );
        }
    }
    let mat = material();
    for (requested, effective) in [
        (BrdfModel::BlinnPhong, BrdfModel::Phong),
        (BrdfModel::Subsurface, BrdfModel::DisneyPrincipled),
        (BrdfModel::Hair, BrdfModel::AshikhminShirley),
    ] {
        let routed = hemisphere_energy(requested, &mat);
        let direct = hemisphere_energy(effective, &mat);
        for channel in 0..3 {
            assert!(
                (routed[channel] - direct[channel]).abs() < 1e-5,
                "{requested:?} channel {channel} diverges from {effective:?}"
            );
        }
    }
}

#[test]
fn validation_rejects_malformed_materials_and_states() {
    let mut bad = material();
    bad.base_color = [1.5, 0.0, 0.0, 1.0];
    assert!(bad.validated().is_err());
    let mut bad = material();
    bad.metallic = -0.1;
    assert!(bad.validated().is_err());
    let mut bad = material();
    bad.roughness = f32::NAN;
    assert!(bad.validated().is_err());
    let mut bad = material();
    bad.anisotropy = 1.5;
    assert!(bad.validated().is_err());
    let mut bad = material();
    bad.id = String::new();
    assert!(bad.validated().is_err());

    let mut state = default_state();
    state.slots.clear();
    assert!(state.validated().is_err());
    let mut state = default_state();
    state.slots.push(MaterialSlot {
        slot: "default".to_string(),
        index: 1,
        material: material(),
    });
    assert!(state.validated().is_err());
    let mut state = default_state();
    state.max_materials = 0;
    assert!(state.validated().is_err());
    let mut state = default_state();
    state.slots.push(MaterialSlot {
        slot: "hero".to_string(),
        index: 0,
        material: material(),
    });
    assert!(state.validated().is_err());
}

#[test]
fn default_state_contains_only_the_default_slot() {
    let state = default_state().validated().expect("default state");
    assert_eq!(state.slots.len(), 1);
    assert_eq!(state.slots[0].slot, "default");
    assert_eq!(state.slots[0].index, 0);
    assert_eq!(state.slots[0].material.route.model, "cooktorrance-ggx");
}
