use super::*;

fn field_of(result: Result<()>) -> (String, String) {
    match result.expect_err("expected a validation error") {
        Forge3dError::InvalidInput { field, message } => (field, message),
        other => panic!("unexpected error {other:?}"),
    }
}

#[test]
fn defaults_match_native_settings_and_zero_feature_baseline() {
    let settings = TerrainMaterialSettings::default();
    settings.validate().unwrap();
    // Native make_terrain_params_config / dataclass defaults.
    assert_eq!(
        settings.triplanar,
        TriplanarSettings {
            scale: 6.0,
            blend_sharpness: 4.0,
            normal_strength: 1.0,
        }
    );
    assert_eq!(settings.lod.lod0_bias, -0.5);
    assert_eq!(settings.sampling.anisotropy, 8);
    assert_eq!(settings.clamp.slope_range, [0.04, 1.0]);
    assert_eq!(settings.clamp.ambient_range, [0.22, 0.38]);
    assert_eq!(settings.clamp.shadow_range, [0.30, 1.0]);
    assert_eq!(settings.clamp.occlusion_range, [0.65, 1.0]);
    assert_eq!(settings.pom.scale, 0.04);
    assert_eq!(
        (
            settings.pom.min_steps,
            settings.pom.max_steps,
            settings.pom.refine_steps
        ),
        (12, 40, 4)
    );
    assert_eq!(settings.layers.snow_altitude_min, 2000.0);
    assert_eq!(settings.layers.rock_color, [0.35, 0.32, 0.28]);
    assert_eq!(settings.layers.variation.octaves, 4);
    assert_eq!(settings.detail.fade_end, 200.0);
    // Zero-feature baseline: colormap albedo, every feature off.
    assert_eq!(settings.albedo_mode, AlbedoMode::Colormap);
    assert_eq!(settings.colormap_strength, 1.0);
    assert!(!settings.pom.enabled);
    assert!(!settings.detail.enabled);
    assert!(!settings.layers.snow_enabled && !settings.layers.rock_enabled);
    assert!(!settings.layers.wetness_enabled);
    assert!(!settings.layers.variation.enabled());
}

#[test]
fn terrain_default_layers_match_native_material_set() {
    let layers = terrain_default_layers();
    let colors: Vec<[f32; 3]> = layers.iter().map(|layer| layer.base_color).collect();
    assert_eq!(
        colors,
        vec![
            [0.28, 0.26, 0.24],
            [0.18, 0.38, 0.10],
            [0.35, 0.25, 0.15],
            [0.95, 0.97, 1.0]
        ]
    );
    let roughness: Vec<f32> = layers.iter().map(|layer| layer.roughness).collect();
    assert_eq!(roughness, vec![0.50, 0.85, 0.50, 0.25]);
    assert_eq!(layer_centers(4), [0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0]);
    assert_eq!(layer_centers(1), [0.0; 4]);
    assert_eq!(layer_blend_half(4), 0.125);
    assert_eq!(layer_blend_half(1), 1.0);
    assert_eq!(layer_blend_half(2), 0.25);
}

#[test]
fn validation_keeps_native_messages() {
    let cases: Vec<(Box<dyn Fn(&mut TerrainMaterialSettings)>, &str, &str)> = vec![
        (
            Box::new(|s| s.triplanar.scale = 0.0),
            "material.triplanar.scale",
            "scale must be > 0",
        ),
        (
            Box::new(|s| s.triplanar.normal_strength = -1.0),
            "material.triplanar.normalStrength",
            "normal_strength must be >= 0",
        ),
        (
            Box::new(|s| s.pom.min_steps = 0),
            "material.pom.minSteps",
            "min_steps must be >= 1",
        ),
        (
            Box::new(|s| s.pom.max_steps = 101),
            "material.pom.maxSteps",
            "max_steps must be <= 100",
        ),
        (
            Box::new(|s| {
                s.pom.min_steps = 20;
                s.pom.max_steps = 10;
            }),
            "material.pom.maxSteps",
            "max_steps must be >= min_steps",
        ),
        (
            Box::new(|s| s.sampling.anisotropy = 17),
            "material.sampling.anisotropy",
            "anisotropy must be 1-16",
        ),
        (
            Box::new(|s| s.clamp.slope_range = [1.0, 0.5]),
            "material.clamp.slopeRange",
            "min must be < max",
        ),
        (
            Box::new(|s| s.height_curve.mode = HeightCurveMode::Lut),
            "material.heightCurve.lut",
            "height_curve_lut is required when height_curve_mode='lut'",
        ),
        (
            Box::new(|s| s.height_curve.lut = Some(vec![0.5; 255])),
            "material.heightCurve.lut",
            "height_curve_lut must be a 1D float32 array of length 256",
        ),
        (
            Box::new(|s| s.height_curve.lut = Some(vec![1.5; 256])),
            "material.heightCurve.lut",
            "height_curve_lut values must be within [0, 1]",
        ),
        (
            Box::new(|s| s.layers.snow_altitude_blend = 0.0),
            "material.layers.snow.altitudeBlend",
            "snow_altitude_blend must be > 0",
        ),
        (
            Box::new(|s| s.layers.snow_slope_max = 91.0),
            "material.layers.snow.slopeMax",
            "snow_slope_max must be in [0, 90]",
        ),
        (
            Box::new(|s| s.layers.snow_subsurface_tint = [0.5, 1.2, 0.5]),
            "material.layers.snow.subsurfaceTint",
            "snow_subsurface_tint components must be in [0, 1]",
        ),
        (
            Box::new(|s| s.layers.rock_slope_blend = 0.0),
            "material.layers.rock.slopeBlend",
            "rock_slope_blend must be > 0",
        ),
        (
            Box::new(|s| s.layers.wetness_strength = 1.5),
            "material.layers.wetness.strength",
            "wetness_strength must be in [0, 1]",
        ),
        (
            Box::new(|s| s.layers.variation.octaves = 9),
            "material.layers.variation.octaves",
            "octaves must be in [1, 8]",
        ),
        (
            Box::new(|s| s.layers.variation.rock_detail_amplitude = 1.5),
            "material.layers.variation.rockDetailAmplitude",
            "rock_detail_amplitude must be in [0, 1]",
        ),
        (
            Box::new(|s| s.detail.albedo_noise = 0.6),
            "material.detail.albedoNoise",
            "albedo_noise must be in [0, 0.5]",
        ),
        (
            Box::new(|s| s.detail.fade_end = 10.0),
            "material.detail.fadeEnd",
            "fade_end must be > fade_start",
        ),
        (
            Box::new(|s| s.material_set.clear()),
            "material.materialSet",
            "must contain between 1 and 4 layers",
        ),
        (
            Box::new(|s| s.material_set[1].roughness = 0.01),
            "material.materialSet[1].roughness",
            "roughness must be in [0.04, 1.0]",
        ),
        (
            Box::new(|s| s.colormap_strength = f32::NAN),
            "material.colormapStrength",
            "must be finite",
        ),
    ];
    for (mutate, field, message) in cases {
        let mut settings = TerrainMaterialSettings::default();
        mutate(&mut settings);
        assert_eq!(
            field_of(settings.validate()),
            (field.to_string(), message.to_string())
        );
    }
}

#[test]
fn uniform_layout_matches_wgsl_struct() {
    assert_eq!(
        std::mem::size_of::<TerrainMaterialUniform>(),
        TERRAIN_MATERIAL_UNIFORM_BYTES
    );
    assert_eq!(TERRAIN_MATERIAL_UNIFORM_BYTES, 1488);
    assert_eq!(TerrainMaterialUniform::disabled().control[0], 0.0);
}

#[test]
fn packing_follows_native_upload_rules() {
    let mut settings = TerrainMaterialSettings::default();
    settings.albedo_mode = AlbedoMode::Mix;
    settings.colormap_strength = 0.25;
    settings.layers.snow_enabled = true;
    settings.layers.snow_slope_max = 58.0;
    settings.layers.rock_subsurface_strength = 0.04;
    settings.layers.variation.snow_macro_amplitude = 0.2;
    let packed = settings.pack([0.0, 1.0], 0b101, false);
    assert_eq!(packed.control, [1.0, 2.0, 0.25, 2.2]);
    // POM disabled packs a zero scale and zero step counts, like native.
    assert_eq!(packed.triplanar, [6.0, 4.0, 1.0, 0.0]);
    assert_eq!(packed.pom_steps, [0.0; 4]);
    assert_eq!(packed.layer_heights, [0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0]);
    assert_eq!(packed.layer_roughness, [0.5, 0.85, 0.5, 0.25]);
    assert_eq!(packed.layer_control, [4.0, 0.125, 0.0, -0.5]);
    assert_eq!(packed.clamp0, [0.0, 1.0, 0.04, 1.0]);
    assert!((packed.snow_params0[2] - 58f32.to_radians()).abs() < 1e-6);
    assert_eq!(packed.snow_params1[2], 1.0);
    assert_eq!(packed.rock_color[3], 0.04);
    assert_eq!(packed.variation_params0, [3.5, 18.0, 4.0, 1.0]);
    assert_eq!(packed.detail1[3], 5.0);
    assert_eq!(packed.spec_aa, [1.0, 1.0, 1.0, 0.0]);
    settings.pom.enabled = true;
    settings.pom.occlusion = true;
    settings.pom.shadow = false;
    let packed = settings.pack([0.0, 1.0], 0, false);
    assert_eq!(packed.pom_steps, [12.0, 40.0, 4.0, 3.0]);
    assert_eq!(packed.triplanar[3], 0.04);
    settings.clamp.height_range = Some([100.0, 900.0]);
    assert_eq!(
        settings.pack([0.0, 1.0], 0, false).clamp0[..2],
        [100.0, 900.0]
    );
}

#[test]
fn specular_aa_tiers_set_variance_thresholds() {
    let mut settings = TerrainMaterialSettings::default();
    for (quality, expected) in [
        (SpecularAaQuality::Native, [1.0, 1.0, 1.0]),
        (SpecularAaQuality::Medium, [1.0, 1.0, 0.25]),
        (SpecularAaQuality::High, [1.0, 1.0, 0.0]),
        (SpecularAaQuality::Off, [0.0, 1.0, 0.0]),
    ] {
        settings.specular_aa.quality = quality;
        assert_eq!(settings.pack([0.0, 1.0], 0, false).spec_aa[..3], expected);
    }
}

#[test]
fn height_curve_lut_packs_row_major() {
    let mut settings = TerrainMaterialSettings::default();
    settings.height_curve.mode = HeightCurveMode::Lut;
    settings.height_curve.strength = 1.0;
    settings.height_curve.lut = Some((0..256).map(|i| i as f32 / 255.0).collect());
    settings.validate().unwrap();
    let packed = settings.pack([0.0, 1.0], 0, false);
    assert_eq!(packed.height_curve[0], 3.0);
    assert_eq!(
        packed.height_curve_lut[0],
        [0.0, 1.0 / 255.0, 2.0 / 255.0, 3.0 / 255.0]
    );
    assert_eq!(packed.height_curve_lut[63][3], 1.0);
}

#[test]
fn flat_material_set_uses_one_texel_per_layer_with_native_rounding() {
    let array = assemble_material_array(&terrain_default_layers(), &[], 8192, u64::MAX);
    assert_eq!((array.width, array.height, array.layers), (1, 1, 4));
    assert_eq!(array.mip_levels(), 1);
    assert_eq!(&array.levels[0][..4], &[71, 66, 61, 255]);
    assert_eq!(&array.levels[0][4..8], &[46, 97, 26, 255]);
    assert!(array.diagnostics.is_empty());
    assert_eq!(array.textured_layers, vec![false; 4]);
}

#[test]
fn textured_layers_resample_to_the_first_texture_and_build_mips() {
    let layers = terrain_default_layers();
    let red = TerrainLayerImage {
        width: 4,
        height: 4,
        rgba: [255u8, 0, 0, 255].repeat(16),
    };
    let blue = TerrainLayerImage {
        width: 2,
        height: 2,
        rgba: [0u8, 0, 255, 255].repeat(4),
    };
    let array = assemble_material_array(
        &layers,
        &[Some(red), None, Some(blue), None],
        8192,
        u64::MAX,
    );
    assert_eq!((array.width, array.height), (4, 4));
    assert_eq!(array.mip_levels(), 3);
    assert_eq!(array.levels[0].len(), 4 * 4 * 4 * 4);
    assert_eq!(array.levels[2].len(), 4 * 4);
    // Layer 1 (untextured grass) is filled with its base color at every mip.
    assert_eq!(&array.levels[2][4..8], &[46, 97, 26, 255]);
    // Layer 2 was resampled from 2x2.
    assert_eq!(&array.levels[0][2 * 64..2 * 64 + 4], &[0, 0, 255, 255]);
    assert_eq!(array.textured_layers, vec![true, false, true, false]);
    assert_eq!(array.diagnostics.len(), 1);
    assert_eq!(
        array.diagnostics[0].code,
        "terrain-material-texture-resampled"
    );
    assert_eq!(array.diagnostics[0].layer, Some(2));
}

#[test]
fn material_textures_downscale_to_the_budget_and_report_it() {
    let layers = terrain_default_layers();
    let big = TerrainLayerImage {
        width: 1024,
        height: 1024,
        rgba: vec![128u8; 1024 * 1024 * 4],
    };
    let budget = texture::rgba8_mip_chain_bytes(512, 512, 4);
    let array = assemble_material_array(&layers, &[Some(big)], 8192, budget);
    assert_eq!((array.width, array.height), (512, 512));
    assert!(array.byte_len() <= budget);
    assert_eq!(
        array.diagnostics[0].code,
        "terrain-material-texture-downscaled"
    );
    // The native floor: never below 256 even when the budget is smaller.
    let big = TerrainLayerImage {
        width: 1024,
        height: 1024,
        rgba: vec![128u8; 1024 * 1024 * 4],
    };
    let array = assemble_material_array(&layers, &[Some(big)], 8192, 1);
    assert_eq!((array.width, array.height), (256, 256));
}

#[test]
fn invalid_layer_textures_fall_back_to_base_color_with_a_diagnostic() {
    let broken = TerrainLayerImage {
        width: 4,
        height: 4,
        rgba: vec![0u8; 7],
    };
    let array = assemble_material_array(&terrain_default_layers(), &[Some(broken)], 8192, u64::MAX);
    assert_eq!((array.width, array.height), (1, 1));
    assert_eq!(array.textured_layers, vec![false; 4]);
    assert_eq!(
        array.diagnostics[0].code,
        "terrain-material-texture-invalid"
    );
    assert_eq!(&array.levels[0][..4], &[71, 66, 61, 255]);
}

#[test]
fn aux_array_packs_detail_normals_and_masks_with_neutral_defaults() {
    let empty = assemble_aux_array(None, [None, None, None], 8192);
    assert_eq!((empty.width, empty.height, empty.mask_bits), (1, 1, 0));
    assert_eq!(empty.normal, vec![128, 128, 255, 255]);
    assert_eq!(empty.masks, vec![255, 255, 255, 255]);
    assert!(!empty.has_detail_map);

    let rock = TerrainMaskImage {
        width: 2,
        height: 2,
        values: vec![0, 64, 128, 255],
    };
    let broken = TerrainMaskImage {
        width: 2,
        height: 2,
        values: vec![0],
    };
    let aux = assemble_aux_array(None, [None, Some(&rock), Some(&broken)], 8192);
    assert_eq!((aux.width, aux.height, aux.mask_bits), (2, 2, 0b010));
    assert_eq!(&aux.masks[..8], &[255, 0, 255, 255, 255, 64, 255, 255]);
    assert_eq!(aux.diagnostics[0].code, "terrain-material-mask-invalid");
    assert_eq!(aux.diagnostics[0].layer, Some(2));
}
