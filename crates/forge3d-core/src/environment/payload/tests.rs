use super::*;
use crate::environment::{DensityVolume, WaterLayer};
fn environment() -> Environment {
    serde_json::from_value(serde_json::json!({"sky":null,"fog":null,"clouds":null,"volumes":[],"water":[],"sunDirection":[0,1,0],"sunColor":[1,1,1],"sunIntensity":1,"resolutionScale":1,"steps":8,"temporalWeight":0,"volumetricMode":"raymarch","maxDistance":100,"debug":"none"})).unwrap()
}
#[test]
fn every_descriptor_field_and_variable_offset_matches_shader_schema() {
    let mut s = environment();
    s.volumes = (0..VOLUME_CAPACITY)
        .map(|i| DensityVolume {
            bounds: [1., 2., 3., 4., 5., 6.],
            density: 7.,
            color: [8., 9., 10.],
            anisotropy: 11.,
            dimensions: [2, 3, 4],
            data: vec![i as f32; 24],
        })
        .collect();
    s.water = (0..WATER_CAPACITY)
        .map(|i| WaterLayer {
            terrain_mask: i == 0,
            mode: "animated".into(),
            reflection: "planar".into(),
            bounds: [1., 2., 3., 4.],
            height: 5.,
            alpha: 6.,
            depth_scale: 7.,
            shallow_color: [8., 9., 10.],
            deep_color: [11., 12., 13.],
            wave_amplitude: 14.,
            wave_frequency: 15.,
            wave_speed: 16.,
            ripple_scale: 17.,
            reflection_strength: 18.,
            roughness: 19.,
            fresnel_power: 20.,
            foam_width: 21.,
            foam_intensity: 22.,
            flow: [23., 24.],
            mask_dimensions: [2, 3],
            mask: vec![i as f32 + 10.; 6],
            tint_color: [25., 26., 27.],
            tint_strength: 28.,
            hue_shift: 29.,
            ripple_speed: 30.,
            refraction_strength: 31.,
            shore_attenuation_width: 32.,
            wave_distortion_strength: 33.,
            foam_noise_scale: 34.,
        })
        .collect();
    let layout = Layout::new(&s).unwrap();
    let data = encode(&s).unwrap();
    assert_eq!(data.len(), s.payload_floats());
    assert_eq!(layout.bytes(), data.len() as u64 * 4);
    assert_eq!(
        HEADER_FLOATS,
        VOLUME_CAPACITY * VOLUME_STRIDE + WATER_CAPACITY * WATER_STRIDE
    );
    for i in 0..VOLUME_CAPACITY {
        let offset = HEADER_FLOATS + i * 24;
        assert_eq!(
            &data[i * VOLUME_STRIDE..(i + 1) * VOLUME_STRIDE],
            &[
                1.,
                2.,
                3.,
                7.,
                4.,
                5.,
                6.,
                11.,
                8.,
                9.,
                10.,
                offset as f32,
                2.,
                3.,
                4.,
                0.
            ]
        );
        assert_eq!(&data[offset..offset + 24], vec![i as f32; 24]);
    }
    for i in 0..WATER_CAPACITY {
        let offset = HEADER_FLOATS + VOLUME_CAPACITY * 24 + i * 6;
        let b = WATER_BASE + i * WATER_STRIDE;
        let expected = [
            1.,
            2.,
            3.,
            4.,
            5.,
            6.,
            7.,
            3.,
            8.,
            9.,
            10.,
            0.,
            11.,
            12.,
            13.,
            0.,
            14.,
            15.,
            16.,
            17.,
            18.,
            19.,
            2.,
            20.,
            21.,
            22.,
            23.,
            24.,
            2.,
            3.,
            offset as f32,
            0.,
            25.,
            26.,
            27.,
            28.,
            29.,
            30.,
            31.,
            32.,
            33.,
            34.,
            if i == 0 { 1. } else { 0. },
            0.,
            0.,
            0.,
            0.,
            0.,
        ];
        assert_eq!(&data[b..b + WATER_STRIDE], &expected);
        assert_eq!(&data[offset..offset + 6], vec![i as f32 + 10.; 6]);
    }
    // Resolve generated WGSL constants independently of the Rust field accesses.
    for (name, offset) in [
        ("VOLUME_OFFSET", 11),
        ("WATER_MASK_OFFSET", 30),
        ("WATER_TERRAIN_MASK", 42),
    ] {
        assert!(WGSL_LAYOUT.contains(&format!("const {name}:u32={offset}u;")));
    }
}
#[test]
fn offsets_reject_f32_rounding_instead_of_reading_another_sample() {
    assert_eq!(exact_offset(1 << 24).unwrap(), 16777216.);
    assert!(exact_offset((1 << 24) + 1).is_err());
    assert!(exact_offset((1 << 24) + 2).is_ok());
    assert!(exact_offset(usize::MAX).is_err());
}
#[test]
fn empty_payload_still_contains_all_zero_fallback_descriptors() {
    let s = environment();
    assert_eq!(encode(&s).unwrap(), vec![0.; HEADER_FLOATS]);
    let mut s = s;
    s.volumes = vec![
        DensityVolume {
            bounds: [0.; 6],
            density: 0.,
            color: [0.; 3],
            anisotropy: 0.,
            dimensions: [1; 3],
            data: vec![1.]
        };
        VOLUME_CAPACITY + 1
    ];
    assert!(encode(&s).is_err());
}
