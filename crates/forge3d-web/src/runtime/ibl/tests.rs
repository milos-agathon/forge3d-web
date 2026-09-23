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
fn quality_table_matches_public_contract() {
    let low = ibl_quality_spec(IblQuality::Low);
    assert_eq!(
        (
            low.environment,
            low.irradiance,
            low.specular,
            low.specular_mips,
            low.brdf_lut,
            low.samples
        ),
        (32, 8, 32, 4, 32, 32)
    );
    let medium = ibl_quality_spec(IblQuality::Medium);
    assert_eq!(
        (
            medium.environment,
            medium.irradiance,
            medium.specular,
            medium.specular_mips,
            medium.brdf_lut,
            medium.samples
        ),
        (64, 16, 64, 5, 64, 64)
    );
    let high = ibl_quality_spec(IblQuality::High);
    assert_eq!(
        (
            high.environment,
            high.irradiance,
            high.specular,
            high.specular_mips,
            high.brdf_lut,
            high.samples
        ),
        (128, 32, 128, 6, 128, 128)
    );
    let ultra = ibl_quality_spec(IblQuality::Ultra);
    assert_eq!(
        (
            ultra.environment,
            ultra.irradiance,
            ultra.specular,
            ultra.specular_mips,
            ultra.brdf_lut,
            ultra.samples
        ),
        (256, 64, 256, 7, 256, 256)
    );
}

#[test]
fn prepared_lengths_match_rgba16f_layout() {
    let spec = ibl_quality_spec(IblQuality::Low);
    let (irradiance, specular, brdf) = ibl_prepared_lengths(&spec).unwrap();
    assert_eq!(irradiance, 8 * 8 * 6 * 8);
    let specular_expected: u64 = [32u64, 16, 8, 4]
        .iter()
        .map(|size| size * size * 6 * 8)
        .sum();
    assert_eq!(specular, specular_expected);
    assert_eq!(brdf, 32 * 32 * 8);
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
    assert_eq!(prepared.specular_mip_count, 4);
    assert_eq!(prepared.irradiance.len() as u64, 8 * 8 * 6 * 8);
}

#[test]
fn rejects_prepared_size_and_length_mismatch() {
    let mut prepared = prepared_json();
    prepared["irradianceSize"] = serde_json::json!(16);
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
    assert!(IBL_COMPUTE_SHADER.contains("textureLoad(ibl_src_equirect"));
    assert!(IBL_COMPUTE_SHADER.contains("65504"));
    assert!(IBL_COMPUTE_SHADER.contains("* IBL_PI"));
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
