use super::*;
use forge3d_core::memory::{QualityLevel, DEFAULT_MEMORY_BUDGET_BYTES};

#[test]
fn downscaled_dimension_preserves_edges_and_floor() {
    assert_eq!(downscaled_dimension(101, 0.75), 87);
    assert_eq!(downscaled_dimension(2, 0.25), 2);
    assert_eq!(downscaled_dimension(3, 0.25), 2);
    assert_eq!(downscaled_dimension(1025, 0.25), 513);
}

#[test]
fn resample_heightmap_keeps_first_and_last_samples() {
    let heights: Vec<f32> = (0..25).map(|v| v as f32).collect();
    let sampled = resample_heightmap(&heights, 5, 5, 3, 3);
    assert_eq!(
        sampled,
        vec![0.0, 2.0, 4.0, 10.0, 12.0, 14.0, 20.0, 22.0, 24.0]
    );
}

#[test]
fn ledger_replace_swaps_accounting_and_rejects_overflow() {
    let mut ledger = MemoryLedger::new(DEFAULT_MEMORY_BUDGET_BYTES, QualityLevel::High).unwrap();
    ledger
        .replace("depth", MemoryCategory::Textures, 1024)
        .unwrap();
    assert_eq!(ledger.current_bytes(), 1024);
    ledger
        .replace("depth", MemoryCategory::Textures, 2048)
        .unwrap();
    assert_eq!(ledger.current_bytes(), 2048);
    ledger
        .replace("terrain:mesh", MemoryCategory::Buffers, 512)
        .unwrap();
    let err = ledger
        .replace("big", MemoryCategory::Other, DEFAULT_MEMORY_BUDGET_BYTES)
        .unwrap_err();
    assert_eq!(err.code(), Forge3DErrorCode::ResourceLimitExceeded);
    assert_eq!(ledger.current_bytes(), 2560);
    ledger.release("depth");
    ledger.release("terrain:mesh");
    assert_eq!(ledger.current_bytes(), 0);
    let report = ledger.tracker.report();
    assert_eq!(report.allocation_count, 0);
    assert!(report.categories.is_empty());
}

#[test]
fn ledger_records_downgrades_and_effective_quality() {
    let mut ledger = MemoryLedger::new(4096, QualityLevel::Ultra).unwrap();
    ledger.record_downgrade(LedgerDowngrade {
        requested: QualityLevel::Ultra,
        effective: QualityLevel::Low,
        requested_bytes: 8000,
        admitted_bytes: 2000,
    });
    assert_eq!(ledger.effective_quality, QualityLevel::Low);
    assert_eq!(ledger.downgrades.len(), 1);
}

#[test]
fn native_ledger_admits_each_fixed_w04_key_once_and_clear_empties() {
    let mut ledger = MemoryLedger::new(DEFAULT_MEMORY_BUDGET_BYTES, QualityLevel::High).unwrap();
    let keys: Vec<&'static str> = crate::runtime::scene::scene_memory_keys()
        .into_iter()
        .chain(crate::runtime::lighting::lighting_memory_keys())
        .chain(crate::runtime::textures::texture_memory_keys())
        .chain(crate::runtime::terrain::terrain_memory_keys())
        .chain([
            crate::runtime::ibl::IBL_TEXTURES_LEDGER_KEY,
            crate::runtime::ibl::IBL_UNIFORM_LEDGER_KEY,
            crate::runtime::ibl::IBL_TRANSIENT_LEDGER_KEY,
            crate::runtime::shadows::SHADOW_DEPTH_KEY,
            crate::runtime::shadows::SHADOW_MOMENTS_KEY,
            crate::runtime::shadows::SHADOW_UNIFORMS_KEY,
            "depth",
            "readback:frame",
        ])
        .collect();
    let unique: std::collections::BTreeSet<_> = keys.iter().copied().collect();
    assert_eq!(unique.len(), keys.len(), "fixed ledger keys must be unique");
    for key in &keys {
        ledger.replace(key, MemoryCategory::Buffers, 64).unwrap();
        assert_eq!(ledger.admitted_bytes(key), Some(64));
    }
    let admitted: std::collections::BTreeSet<_> = ledger.admitted_keys().collect();
    assert_eq!(admitted.len(), keys.len());
    ledger.clear();
    let report = ledger.tracker.report();
    assert_eq!(report.allocation_count, 0);
    assert_eq!(report.current_bytes, 0);
    assert!(report.categories.is_empty());
    assert_eq!(ledger.admitted_keys().count(), 0);
}

#[test]
fn native_ledger_clone_isolates_failed_planning_from_live_accounting() {
    let mut ledger = MemoryLedger::new(4096, QualityLevel::High).unwrap();
    ledger
        .replace("scene:vertices", MemoryCategory::Buffers, 256)
        .unwrap();
    let before = ledger.tracker.report();
    let mut planned = ledger.clone();
    planned
        .replace("textures:payload", MemoryCategory::Textures, 2048)
        .unwrap();
    assert!(planned
        .replace("ibl:textures", MemoryCategory::Textures, 4096)
        .is_err());
    drop(planned);
    let after = ledger.tracker.report();
    assert_eq!(after.current_bytes, before.current_bytes);
    assert_eq!(after.allocation_count, before.allocation_count);
    assert_eq!(ledger.admitted_bytes("textures:payload"), None);
}

#[test]
fn disabled_shadow_moment_allocation_reports_actual_one_layer_bytes() {
    use forge3d_core::shadowing::{
        ShadowConfig, ShadowFilter, SHADOW_DEPTH_UNIFORM_BYTES, SHADOW_UNIFORM_BYTES,
    };
    let config = ShadowConfig::default();
    let (depth, moments, uniforms) =
        crate::runtime::shadows::shadow_ledger_bytes(&config, 2048, 4).unwrap();
    assert_eq!(depth, 4);
    assert_eq!(moments, 16);
    assert_eq!(
        uniforms,
        (SHADOW_UNIFORM_BYTES + SHADOW_DEPTH_UNIFORM_BYTES + 16) as u64
    );
    let enabled = ShadowConfig {
        enabled: true,
        ..Default::default()
    };
    let (depth, moments, uniforms) =
        crate::runtime::shadows::shadow_ledger_bytes(&enabled, 256, 3).unwrap();
    assert_eq!(depth, 256 * 256 * 4 * 3);
    assert_eq!(moments, 16 * 3);
    assert_eq!(
        uniforms,
        (SHADOW_UNIFORM_BYTES + 3 * SHADOW_DEPTH_UNIFORM_BYTES + 16) as u64
    );
    let vsm = ShadowConfig {
        enabled: true,
        filter: ShadowFilter::Vsm,
        ..Default::default()
    };
    let (_, moments, _) = crate::runtime::shadows::shadow_ledger_bytes(&vsm, 256, 3).unwrap();
    assert_eq!(moments, 256 * 256 * 16 * 3);
}
