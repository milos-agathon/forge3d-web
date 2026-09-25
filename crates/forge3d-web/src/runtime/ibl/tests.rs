use super::*;

fn source_data() -> Vec<f32> {
    (0..16).map(|index| index as f32 * 0.25).collect()
}

fn source_hash() -> String {
    forge3d_core::codecs::sha256::ibl_source_hash(2, 2, &source_data())
}

fn snapshot_json() -> serde_json::Value {
    serde_json::json!({
        "source": {
            "width": 2,
            "height": 2,
            "data": source_data(),
            "sourceHash": source_hash(),
        },
        "intensity": 1.0,
        "rotationDegrees": 45.0,
        "requestedQuality": "low",
        "effectiveQuality": "low",
        "report": {
            "requestedQuality": "low",
            "effectiveQuality": "low",
            "cacheBackend": "none",
            "cacheHit": false,
            "effectiveMode": "runtime-precompute",
            "brdfApproximation": "split-sum-ggx",
            "reason": "not prepared",
        },
    })
}

#[test]
fn quality_table_matches_native_tiers() {
    // 1f4084a:src/core/ibl.rs IBLQuality plus irradiance.rs/prefilter.rs/
    // brdf_lut.rs sample counts.
    let tiers = [
        (IblQuality::Low, (128, 64, 128, 5)),
        (IblQuality::Medium, (256, 128, 256, 6)),
        (IblQuality::High, (512, 256, 512, 7)),
        (IblQuality::Ultra, (1024, 256, 1024, 8)),
    ];
    for (quality, expected) in tiers {
        let spec = ibl_quality_spec(quality);
        assert_eq!(
            (
                spec.environment,
                spec.irradiance,
                spec.specular,
                spec.specular_mips
            ),
            expected,
            "{quality:?}"
        );
        assert_eq!(spec.brdf_lut, 512);
        assert_eq!((spec.irradiance_samples, spec.brdf_samples), (128, 1024));
    }
}

#[test]
fn prefilter_mode_defaults_to_per_mip_and_rejects_unknown_values() {
    // `native` is the bug-compatible oracle schedule; it must be requested.
    let parsed = ibl_from_json(&snapshot_json()).unwrap().unwrap();
    assert!(!parsed.native_prefilter);
    let mut snapshot = snapshot_json();
    snapshot["prefilter"] = serde_json::json!("per-mip");
    assert!(!ibl_from_json(&snapshot).unwrap().unwrap().native_prefilter);
    snapshot["prefilter"] = serde_json::json!("native");
    assert!(ibl_from_json(&snapshot).unwrap().unwrap().native_prefilter);
    snapshot["prefilter"] = serde_json::json!("fast");
    assert!(ibl_from_json(&snapshot).is_err());
}

#[test]
fn prefilter_schedule_matches_native() {
    // 1f4084a:src/core/ibl/prefilter.rs: (1024 >> mip).max(64) samples and
    // roughness = sqrt(mip / (mips - 1)).
    let mips = 6;
    let schedule: Vec<(u32, f32)> = (0..mips)
        .map(|mip| prefilter_mip_params(mip, mips))
        .collect();
    let samples: Vec<u32> = schedule.iter().map(|(s, _)| *s).collect();
    assert_eq!(samples, vec![1024, 512, 256, 128, 64, 64]);
    for (mip, (_, roughness)) in schedule.iter().enumerate() {
        let native = (mip as f32 / 5.0).sqrt();
        assert!((roughness - native).abs() < 1e-7, "mip {mip}");
    }
    assert_eq!(prefilter_mip_params(0, 1), (1024, 0.0));
}

#[test]
fn prepared_lengths_match_rgba16f_layout() {
    let spec = ibl_quality_spec(IblQuality::Low);
    let (irradiance, specular, brdf) = ibl_prepared_lengths(&spec).unwrap();
    assert_eq!(irradiance, 64 * 64 * 6 * 8);
    let specular_expected: u64 = [128u64, 64, 32, 16, 8]
        .iter()
        .map(|size| size * size * 6 * 8)
        .sum();
    assert_eq!(specular, specular_expected);
    assert_eq!(brdf, 512 * 512 * 8);
}

#[test]
fn null_snapshot_decodes_to_none() {
    assert!(ibl_from_json(&serde_json::Value::Null).unwrap().is_none());
}

#[test]
fn valid_snapshot_parses() {
    let parsed = ibl_from_json(&snapshot_json()).unwrap().unwrap();
    assert_eq!(parsed.source_width, 2);
    assert_eq!(parsed.source_height, 2);
    assert_eq!(parsed.requested_quality, IblQuality::Low);
    assert_eq!(parsed.effective_quality, IblQuality::Low);
    assert!(parsed.prepared.is_none());
    assert_eq!(parsed.rotation_degrees, 45.0);
}

#[test]
fn rejects_missing_source_and_bad_hash() {
    let mut bad = snapshot_json();
    bad["source"]["sourceHash"] = serde_json::json!("not-hex");
    assert_eq!(
        ibl_from_json(&bad).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
    let mut missing = snapshot_json();
    missing.as_object_mut().unwrap().remove("source");
    assert_eq!(
        ibl_from_json(&missing).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
}

#[test]
fn rejects_nonfinite_intensity_rotation_and_data() {
    for (key, value) in [
        ("intensity", serde_json::json!(f64::NAN)),
        ("intensity", serde_json::json!(-0.5)),
        ("rotationDegrees", serde_json::json!(f64::INFINITY)),
    ] {
        let mut bad = snapshot_json();
        bad[key] = value;
        assert_eq!(
            ibl_from_json(&bad).unwrap_err().code(),
            Forge3DErrorCode::InvalidInput,
            "{key} must be rejected"
        );
    }
    let mut bad = snapshot_json();
    bad["source"]["data"] = serde_json::json!([0.0, 0.0, 0.0, f64::NAN]);
    bad["source"]["data"]
        .as_array_mut()
        .unwrap()
        .extend(std::iter::repeat(serde_json::json!(0.0)).take(12));
    assert_eq!(
        ibl_from_json(&bad).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
}

#[test]
fn rejects_wrong_data_length_and_oversize_dimensions() {
    let mut bad = snapshot_json();
    bad["source"]["data"] = serde_json::json!(vec![0.0; 15]);
    assert_eq!(
        ibl_from_json(&bad).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
    let mut big = snapshot_json();
    big["source"]["width"] = serde_json::json!(IBL_SOURCE_MAX_DIMENSION + 1);
    assert_eq!(
        ibl_from_json(&big).unwrap_err().code(),
        Forge3DErrorCode::ResourceLimitExceeded
    );
}

#[test]
fn rejects_unknown_and_inconsistent_quality() {
    let mut bad = snapshot_json();
    bad["requestedQuality"] = serde_json::json!("epic");
    assert_eq!(
        ibl_from_json(&bad).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
    let mut higher = snapshot_json();
    higher["effectiveQuality"] = serde_json::json!("high");
    assert_eq!(
        ibl_from_json(&higher).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
}

fn prepared_json() -> serde_json::Value {
    let spec = ibl_quality_spec(IblQuality::Low);
    let (irradiance, specular, brdf) = ibl_prepared_lengths(&spec).unwrap();
    serde_json::json!({
        "format": "rgba16float",
        "irradianceSize": spec.irradiance,
        "specularSize": spec.specular,
        "specularMipCount": spec.specular_mips,
        "brdfLutSize": spec.brdf_lut,
        "irradiance": vec![0u8; irradiance as usize],
        "specular": vec![0u8; specular as usize],
        "brdfLut": vec![0u8; brdf as usize],
    })
}

#[test]
fn prepared_payload_validates_against_quality_table() {
    let mut snapshot = snapshot_json();
    snapshot["prepared"] = prepared_json();
    snapshot["report"]["effectiveMode"] = serde_json::json!("prepared-upload");
    let parsed = ibl_from_json(&snapshot).unwrap().unwrap();
    let prepared = parsed.prepared.expect("prepared payload");
    assert_eq!(prepared.specular_mip_count, 5);
    assert_eq!(prepared.irradiance.len() as u64, 64 * 64 * 6 * 8);
}

#[test]
fn rejects_prepared_size_and_length_mismatch() {
    let mut prepared = prepared_json();
    prepared["irradianceSize"] = serde_json::json!(128);
    let mut snapshot = snapshot_json();
    snapshot["prepared"] = prepared;
    snapshot["report"]["effectiveMode"] = serde_json::json!("prepared-upload");
    assert_eq!(
        ibl_from_json(&snapshot).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );

    let mut prepared = prepared_json();
    prepared["irradiance"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!(0));
    let mut snapshot = snapshot_json();
    snapshot["prepared"] = prepared;
    snapshot["report"]["effectiveMode"] = serde_json::json!("prepared-upload");
    assert_eq!(
        ibl_from_json(&snapshot).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );

    let mut prepared = prepared_json();
    prepared["format"] = serde_json::json!("rgba8unorm");
    let mut snapshot = snapshot_json();
    snapshot["prepared"] = prepared;
    snapshot["report"]["effectiveMode"] = serde_json::json!("prepared-upload");
    assert_eq!(
        ibl_from_json(&snapshot).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
}

#[test]
fn rejects_source_hash_mismatch() {
    let mut bad = snapshot_json();
    bad["source"]["sourceHash"] = serde_json::json!("b".repeat(64));
    assert_eq!(
        ibl_from_json(&bad).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
    let mut tampered = snapshot_json();
    tampered["source"]["data"][0] = serde_json::json!(0.75);
    assert_eq!(
        ibl_from_json(&tampered).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
}

#[test]
fn rejects_noncanonical_rotation() {
    for value in [360.0, -0.5, 720.0] {
        let mut bad = snapshot_json();
        bad["rotationDegrees"] = serde_json::json!(value);
        assert_eq!(
            ibl_from_json(&bad).unwrap_err().code(),
            Forge3DErrorCode::InvalidInput,
            "rotationDegrees {value} must be rejected"
        );
    }
}

#[test]
fn rejects_invalid_report_fields() {
    for (key, value) in [
        ("cacheBackend", "auto"),
        ("cacheBackend", "indexeddb"),
        ("cacheHit", "yes"),
        ("brdfApproximation", "split-sum"),
        ("requestedQuality", "high"),
    ] {
        let mut bad = snapshot_json();
        bad["report"][key] = serde_json::json!(value);
        assert_eq!(
            ibl_from_json(&bad).unwrap_err().code(),
            Forge3DErrorCode::InvalidInput,
            "report.{key} = {value} must be rejected"
        );
    }
    let mut bad_reason = snapshot_json();
    bad_reason["report"]["reason"] = serde_json::json!(7);
    assert_eq!(
        ibl_from_json(&bad_reason).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
    let mut missing = snapshot_json();
    missing.as_object_mut().unwrap().remove("report");
    assert_eq!(
        ibl_from_json(&missing).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
    let mut non_object = snapshot_json();
    non_object["report"] = serde_json::json!("none");
    assert_eq!(
        ibl_from_json(&non_object).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
}

#[test]
fn rejects_mode_prepared_mismatch() {
    let mut disabled = snapshot_json();
    disabled["report"]["effectiveMode"] = serde_json::json!("disabled");
    assert_eq!(
        ibl_from_json(&disabled).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
    let mut claimed_prepared = snapshot_json();
    claimed_prepared["report"]["effectiveMode"] = serde_json::json!("prepared-upload");
    assert_eq!(
        ibl_from_json(&claimed_prepared).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
    let mut runtime_mode = snapshot_json();
    runtime_mode["prepared"] = prepared_json();
    assert_eq!(
        ibl_from_json(&runtime_mode).unwrap_err().code(),
        Forge3DErrorCode::InvalidInput
    );
}

#[test]
fn uniform_layout_is_32_bytes() {
    assert_eq!(std::mem::size_of::<IblUniform>() as u64, IBL_UNIFORM_BYTES);
    assert_eq!(std::mem::size_of::<IblPassUniform>(), 32);
}

#[test]
fn compute_shader_uses_8x8_workgroups_and_rgba16float_outputs() {
    assert!(IBL_COMPUTE_SHADER.contains("@workgroup_size(8, 8, 1)"));
    assert_eq!(
        IBL_COMPUTE_SHADER
            .matches("@workgroup_size(8, 8, 1)")
            .count(),
        4
    );
    assert!(IBL_COMPUTE_SHADER.contains("texture_storage_2d_array<rgba16float, write>"));
    assert!(IBL_COMPUTE_SHADER.contains("texture_storage_2d<rgba16float, write>"));
    assert!(IBL_COMPUTE_SHADER.contains("equirect_to_cube"));
    assert!(IBL_COMPUTE_SHADER.contains("irradiance_convolve"));
    assert!(IBL_COMPUTE_SHADER.contains("specular_prefilter"));
    assert!(IBL_COMPUTE_SHADER.contains("brdf_integrate"));
    // Native semantics (1f4084a:src/shaders/ibl_*.wgsl): filtered equirect
    // sampling, saturated irradiance/prefilter/LUT, the native split-sum term.
    // Line endings vary by checkout (CRLF on CI), so compare normalized text.
    let shader = IBL_COMPUTE_SHADER.replace("\r\n", "\n");
    assert!(shader.contains("textureSampleLevel(\n        ibl_src_equirect"));
    assert!(IBL_COMPUTE_SHADER
        .contains("irradiance = saturate(IBL_PI * irradiance / f32(sample_count));"));
    assert!(IBL_COMPUTE_SHADER
        .contains("prefiltered = saturate(prefiltered / max(total_weight, 1e-3));"));
    assert!(IBL_COMPUTE_SHADER.contains("let g = (2.0 * n_dot_h * n_dot_v) / max(v_dot_h, 1e-5);"));
    assert!(!IBL_COMPUTE_SHADER.contains("textureLoad(ibl_src_equirect"));
}

#[test]
fn lighting_shader_uses_fresnel_diffuse_split() {
    const IBL_LIGHTING_SHADER: &str = include_str!("../ibl_lighting.wgsl");
    assert!(IBL_LIGHTING_SHADER.contains("(vec3<f32>(1.0) - schlick)"));
}

#[test]
fn lighting_shader_declares_group3_and_unconditional_samples() {
    const IBL_LIGHTING_SHADER: &str = include_str!("../ibl_lighting.wgsl");
    assert!(IBL_LIGHTING_SHADER.contains("@group(3) @binding(0)"));
    assert!(IBL_LIGHTING_SHADER.contains("@group(3) @binding(4)"));
    assert!(IBL_LIGHTING_SHADER.contains("texture_cube<f32>"));
    assert!(IBL_LIGHTING_SHADER.contains("forge3d_eval_ibl"));
    assert!(IBL_LIGHTING_SHADER.contains("textureSampleLevel"));
    assert!(crate::runtime::scene::pipelines::WORLD_SHADER.contains("@group(3)"));
    assert!(crate::runtime::terrain::TERRAIN_SHADER.contains("@group(3)"));
}

#[test]
fn quality_ladder_descends_from_requested() {
    assert_eq!(
        ibl_quality_ladder(IblQuality::Ultra),
        vec![
            IblQuality::Ultra,
            IblQuality::High,
            IblQuality::Medium,
            IblQuality::Low
        ]
    );
    assert_eq!(ibl_quality_ladder(IblQuality::Low), vec![IblQuality::Low]);
}
