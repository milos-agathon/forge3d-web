use super::*;

fn point() -> PointLight {
    PointLight {
        color: [1.0, 1.0, 1.0],
        intensity: 1.0,
        enabled: true,
        casts_shadow: false,
        position: [0.0, 0.0, 0.0],
        range: 10.0,
        inner_radius: 0.0,
        edge_softness: 0.0,
        falloff: SoftLightFalloff::Quadratic,
        falloff_exponent: 2.0,
    }
}

fn spot() -> SpotLight {
    SpotLight {
        color: [1.0, 1.0, 1.0],
        intensity: 1.0,
        enabled: true,
        casts_shadow: false,
        position: [0.0, 5.0, 0.0],
        direction: [0.0, -1.0, 0.0],
        range: 10.0,
        inner_cone_degrees: 10.0,
        outer_cone_degrees: 30.0,
        inner_radius: 0.0,
        edge_softness: 0.0,
        falloff: SoftLightFalloff::Quadratic,
        falloff_exponent: 2.0,
    }
}

fn rect() -> RectAreaLight {
    RectAreaLight {
        color: [1.0, 1.0, 1.0],
        intensity: 1.0,
        enabled: true,
        casts_shadow: false,
        position: [0.0, 8.0, 0.0],
        right: [1.0, 0.0, 0.0],
        up: [0.0, 0.0, 1.0],
        width: 16.0,
        height: 16.0,
        range: 25.0,
        edge_softness: 0.0,
        two_sided: false,
    }
}

fn directional() -> DirectionalLight {
    DirectionalLight {
        color: [1.0, 1.0, 1.0],
        intensity: 3.0,
        enabled: true,
        casts_shadow: true,
        direction: [0.0, -1.0, 0.0],
    }
}

fn point_light() -> Light {
    Light::Point(point())
}

fn spot_light() -> Light {
    Light::Spot(spot())
}

fn rect_light() -> Light {
    Light::Rect(rect())
}

fn directional_light() -> Light {
    Light::Directional(directional())
}

fn state(lights: Vec<Light>) -> LightingState {
    LightingState {
        max_lights: MAX_LIGHTS as u32,
        exposure: 1.0,
        debug_bounds: false,
        area: AreaLightConfig::default(),
        lights,
    }
}

#[test]
fn packed_layout_matches_gpu_contract() {
    assert_eq!(std::mem::size_of::<PackedLight>(), 112);
    assert_eq!(std::mem::align_of::<PackedLight>(), 16);
    assert_eq!(std::mem::size_of::<LightingUniform>(), 32);
    assert_eq!(std::mem::align_of::<LightingUniform>(), 16);
    assert_eq!(PACKED_LIGHT_BYTES, 112);
    assert_eq!(LIGHTING_UNIFORM_BYTES, 32);
}

#[test]
fn packing_writes_normalized_lanes() {
    let mut spot = spot_light();
    if let Light::Spot(inner) = &mut spot {
        inner.direction = [0.0, -3.0, 0.0];
        inner.inner_radius = 1.5;
        inner.edge_softness = 0.25;
        inner.falloff = SoftLightFalloff::Exponential;
        inner.falloff_exponent = 4.0;
        inner.casts_shadow = true;
    }
    let spot_state = state(vec![spot]).validated().expect("valid state");
    let packed = spot_state.pack_lights();
    assert_eq!(packed.len(), 1);
    let light = packed[0];
    assert_eq!(light.kind, 2);
    assert_eq!(light.enabled & 1, 1);
    assert_eq!(light.casts_shadow, 1);
    assert_eq!(light.falloff_mode, 3);
    assert_eq!(light.color_intensity, [1.0, 1.0, 1.0, 1.0]);
    assert_eq!(light.position_range, [0.0, 5.0, 0.0, 10.0]);
    assert_eq!(light.direction_inner_cos[0], 0.0);
    assert_eq!(light.direction_inner_cos[1], -1.0);
    assert_eq!(light.direction_inner_cos[2], 0.0);
    assert_eq!(light.direction_inner_cos[3], 10.0_f32.to_radians().cos());
    assert_eq!(light.soft_params[0], 1.5);
    assert_eq!(light.soft_params[1], 0.25);
    assert_eq!(light.soft_params[2], 4.0);
    assert_eq!(light.soft_params[3], 30.0_f32.to_radians().cos());

    let rect_state = state(vec![rect_light()]).validated().expect("valid state");
    let rect = rect_state.pack_lights()[0];
    assert_eq!(rect.kind, 3);
    assert_eq!(rect.enabled & 1, 1);
    assert_eq!(rect.enabled & 2, 0);
    assert_eq!(rect.right_width, [1.0, 0.0, 0.0, 16.0]);
    assert_eq!(rect.up_height, [0.0, 0.0, 1.0, 16.0]);
    assert_eq!(rect.position_range[3], 25.0);
}

#[test]
fn packing_sets_two_sided_flag_without_overloading_casts_shadow() {
    let mut rect = rect_light();
    if let Light::Rect(inner) = &mut rect {
        inner.two_sided = true;
        inner.casts_shadow = false;
    }
    let state = state(vec![rect]).validated().expect("valid state");
    let packed = state.pack_lights()[0];
    assert_eq!(packed.enabled & 2, 2);
    assert_eq!(packed.casts_shadow, 0);
}

#[test]
fn uniform_carries_global_lighting_fields() {
    let mut lighting = state(vec![point_light()]);
    lighting.exposure = 1.5;
    lighting.debug_bounds = true;
    lighting.area = AreaLightConfig {
        mode: AreaLightMode::Sampled,
        sample_count: 8,
        lut_size: LTC_LUT_SIZE as u32,
    };
    let uniform = lighting.validated().expect("valid state").uniform();
    assert_eq!(uniform.light_count, 1);
    assert_eq!(uniform.area_mode, 1);
    assert_eq!(uniform.area_sample_count, 8);
    assert_eq!(uniform.debug_bounds, 1);
    assert_eq!(uniform.exposure, 1.5);
    assert_eq!(uniform.ltc_lut_size, 64.0);
}

#[test]
fn effective_range_and_bounds_follow_the_shared_contract() {
    let directional = directional_light().validated().expect("valid light");
    assert_eq!(directional.effective_range(), f32::INFINITY);
    assert!(matches!(directional.bounds(), LightBounds::Unbounded));
    assert!(directional.affects_point([1.0e6, -2.0e6, 0.0]));

    let mut point = point_light();
    if let Light::Point(inner) = &mut point {
        inner.position = [1.0, 2.0, 3.0];
        inner.edge_softness = 2.0;
    }
    let point = point.validated().expect("valid light");
    assert_eq!(point.effective_range(), 12.0);
    assert!(point.affects_point([13.0, 2.0, 3.0]));
    assert!(!point.affects_point([13.001, 2.0, 3.0]));
    match point.bounds() {
        LightBounds::Sphere { center, radius } => {
            assert_eq!(center, [1.0, 2.0, 3.0]);
            assert_eq!(radius, 12.0);
        }
        other => panic!("expected sphere bounds, got {other:?}"),
    }

    let rect = rect_light().validated().expect("valid light");
    assert_eq!(rect.effective_range(), 25.0);
    match rect.bounds() {
        LightBounds::Sphere { center, radius } => {
            assert_eq!(center, [0.0, 8.0, 0.0]);
            let expected = 25.0 + (8.0_f32.hypot(8.0));
            assert!((radius - expected).abs() < 1e-5);
        }
        other => panic!("expected sphere bounds, got {other:?}"),
    }
}

#[test]
fn spot_cone_and_rect_sidedness_gate_point_queries() {
    let spot = spot_light().validated().expect("valid light");
    assert!(spot.affects_point([0.0, 0.0, 0.0]));
    let edge = 0.5 * std::f32::consts::SQRT_2;
    assert!(!spot.affects_point([edge, 5.0 - edge, 0.0]));
    assert!(!spot.affects_point([0.0, 6.0, 0.0]));

    let one_sided = rect_light().validated().expect("valid light");
    assert!(one_sided.affects_point([0.0, -10.0, 0.0]));
    assert!(!one_sided.affects_point([0.0, 20.0, 0.0]));
    assert!(!one_sided.affects_point([0.0, -40.0, 0.0]));

    let mut rect = rect_light();
    if let Light::Rect(inner) = &mut rect {
        inner.two_sided = true;
    }
    let two_sided = rect.validated().expect("valid light");
    assert!(two_sided.affects_point([0.0, 20.0, 0.0]));

    let mut disabled = point_light();
    if let Light::Point(inner) = &mut disabled {
        inner.enabled = false;
    }
    let disabled = disabled.validated().expect("valid light");
    assert!(!disabled.affects_point([0.0, 0.0, 0.0]));
}

#[test]
fn validation_rejects_malformed_lights_and_config() {
    let reject = |light: Light| {
        assert!(light.validated().is_err());
    };

    reject(Light::Directional(DirectionalLight {
        direction: [0.0, 0.0, 0.0],
        ..directional()
    }));
    reject(Light::Directional(DirectionalLight {
        direction: [0.0, f32::NAN, 0.0],
        ..directional()
    }));
    reject(Light::Point(PointLight {
        color: [1.5, 0.0, 0.0],
        ..point()
    }));
    reject(Light::Point(PointLight {
        intensity: f32::NAN,
        ..point()
    }));
    reject(Light::Point(PointLight {
        range: 0.0,
        ..point()
    }));
    reject(Light::Point(PointLight {
        inner_radius: 10.0,
        ..point()
    }));
    reject(Light::Point(PointLight {
        edge_softness: -0.5,
        ..point()
    }));
    reject(Light::Point(PointLight {
        falloff_exponent: 0.0,
        ..point()
    }));
    reject(Light::Spot(SpotLight {
        inner_cone_degrees: 45.0,
        outer_cone_degrees: 30.0,
        ..spot()
    }));
    reject(Light::Spot(SpotLight {
        outer_cone_degrees: 90.0,
        ..spot()
    }));
    reject(Light::Rect(RectAreaLight {
        right: [1.0, 0.0, 0.0],
        up: [2.0, 0.0, 0.0],
        ..rect()
    }));
    reject(Light::Rect(RectAreaLight {
        width: 0.0,
        ..rect()
    }));

    let mut bad = state(vec![point_light()]);
    bad.exposure = f32::NAN;
    assert!(bad.validated().is_err());

    for sample_count in [2, 3, 5, 6, 7, 9, 15, 17, 0] {
        let mut bad = state(vec![point_light()]);
        bad.area.sample_count = sample_count;
        assert!(
            bad.validated().is_err(),
            "sampleCount {sample_count} must be rejected"
        );
    }

    let mut bad = state(vec![point_light()]);
    bad.area.lut_size = 32;
    assert!(bad.validated().is_err());

    let mut bad = state(vec![point_light()]);
    bad.max_lights = 0;
    assert!(bad.validated().is_err());

    let bad = state(vec![point_light(); MAX_LIGHTS + 1]);
    assert!(bad.validated().is_err());
}

#[test]
fn validation_normalizes_directions_and_rect_bases() {
    let directional = Light::Directional(DirectionalLight {
        direction: [0.0, -4.0, 0.0],
        ..directional()
    })
    .validated()
    .expect("valid light");
    match directional {
        Light::Directional(inner) => assert_eq!(inner.direction, [0.0, -1.0, 0.0]),
        other => panic!("expected directional, got {other:?}"),
    }

    let rect = Light::Rect(RectAreaLight {
        right: [2.0, 0.0, 0.0],
        up: [0.5, 1.0, 0.0],
        ..rect()
    })
    .validated()
    .expect("valid light");
    match rect {
        Light::Rect(inner) => {
            assert_eq!(inner.right, [1.0, 0.0, 0.0]);
            assert!((inner.up[0]).abs() < 1e-6);
            assert!((inner.up[1] - 1.0).abs() < 1e-6);
            assert_eq!(inner.up[2], 0.0);
        }
        other => panic!("expected rect, got {other:?}"),
    }
}

#[test]
fn ltc_lut_is_deterministic_finite_and_monotonic() {
    let first = generate_ltc_lut();
    let second = generate_ltc_lut();
    assert_eq!(first.matrix, second.matrix);
    assert_eq!(first.amplitude, second.amplitude);
    assert_eq!(first.matrix.len(), LTC_LUT_SIZE * LTC_LUT_SIZE);
    assert_eq!(first.amplitude.len(), LTC_LUT_SIZE * LTC_LUT_SIZE);
    for texel in &first.matrix {
        for component in texel {
            assert!(component.is_finite());
        }
        assert!(texel[0] > 0.0 && texel[1] > 0.0 && texel[2] > 0.0);
    }
    for amplitude in &first.amplitude {
        assert!(amplitude.is_finite() && *amplitude > 0.0);
    }
    for angle in 0..LTC_LUT_SIZE {
        let mut previous = f32::INFINITY;
        for roughness in 0..LTC_LUT_SIZE {
            let amplitude = first.amplitude[roughness * LTC_LUT_SIZE + angle];
            assert!(
                amplitude <= previous,
                "amplitude must not increase with roughness"
            );
            previous = amplitude;
        }
    }
}

#[test]
fn runtime_defaults_contain_normalized_key_and_fill() {
    let state = default_state();
    assert_eq!(state.lights.len(), 2);
    for (light, direction, intensity) in [
        (state.lights[0].clone(), [0.48_f32, -0.78, -0.40], 3.0_f32),
        (state.lights[1].clone(), [-0.55_f32, -0.45, 0.35], 0.36_f32),
    ] {
        match light {
            Light::Directional(inner) => {
                let expected_len = (direction[0] * direction[0]
                    + direction[1] * direction[1]
                    + direction[2] * direction[2])
                    .sqrt();
                for (component, expected) in inner.direction.iter().zip(direction.iter()) {
                    assert!((component - expected / expected_len).abs() < 1e-6);
                }
                assert_eq!(inner.intensity, intensity);
                assert_eq!(inner.color, [1.0, 1.0, 1.0]);
                assert!(inner.enabled);
            }
            other => panic!("expected directional light, got {other:?}"),
        }
    }
}
