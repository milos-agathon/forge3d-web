use super::{
    MemoryCategory, MemoryTracker, OverflowPolicy, QualityLevel, DEFAULT_MEMORY_BUDGET_BYTES,
};
use crate::error::Forge3dError;

#[test]
fn default_budget_is_512_mib() {
    let tracker = MemoryTracker::default_budget();
    assert_eq!(tracker.report().budget_bytes, DEFAULT_MEMORY_BUDGET_BYTES);
    assert_eq!(DEFAULT_MEMORY_BUDGET_BYTES, 512 * 1024 * 1024);
    assert!(matches!(
        MemoryTracker::new(0),
        Err(Forge3dError::InvalidInput { .. })
    ));
}

#[test]
fn duplicate_key_is_idempotent_and_conflicts_error() {
    let mut tracker = MemoryTracker::new(1024).unwrap();

    let first = tracker
        .allocate("tex", MemoryCategory::Textures, 100)
        .unwrap();
    let second = tracker
        .allocate("tex", MemoryCategory::Textures, 100)
        .unwrap();

    assert_eq!(first, second);
    assert_eq!(tracker.report().current_bytes, 100);
    assert_eq!(tracker.report().allocation_count, 1);

    assert!(matches!(
        tracker.allocate("tex", MemoryCategory::Textures, 200),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        tracker.allocate("tex", MemoryCategory::Buffers, 100),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        tracker.allocate("zero", MemoryCategory::Buffers, 0),
        Err(Forge3dError::InvalidInput { .. })
    ));
}

#[test]
fn release_updates_categories_and_unknown_release_is_false() {
    let mut tracker = MemoryTracker::new(1024).unwrap();
    let texture = tracker
        .allocate("tex", MemoryCategory::Textures, 64)
        .unwrap();
    let buffer = tracker
        .allocate("buf", MemoryCategory::Buffers, 32)
        .unwrap();

    assert_eq!(
        tracker.report().categories.get(&MemoryCategory::Textures),
        Some(&64)
    );

    assert!(tracker.release(texture));
    assert!(!tracker.release(texture));
    assert!(tracker.release(buffer));

    let report = tracker.report();
    assert_eq!(report.current_bytes, 0);
    assert!(report.categories.is_empty());
    assert_eq!(report.allocation_count, 0);
}

#[test]
fn peak_survives_release_and_clear() {
    let mut tracker = MemoryTracker::new(1024).unwrap();
    let a = tracker.allocate("a", MemoryCategory::Buffers, 100).unwrap();
    tracker.allocate("b", MemoryCategory::Buffers, 50).unwrap();
    assert_eq!(tracker.report().peak_bytes, 150);

    tracker.release(a);
    tracker.clear();

    let report = tracker.report();
    assert_eq!(report.current_bytes, 0);
    assert_eq!(report.allocation_count, 0);
    assert!(report.categories.is_empty());
    assert_eq!(report.peak_bytes, 150);
}

#[test]
fn reject_policy_fails_before_overflow() {
    let mut tracker = MemoryTracker::new(100).unwrap();
    tracker
        .allocate("big", MemoryCategory::Buffers, 80)
        .unwrap();

    let rejected = tracker.admit(30, QualityLevel::Ultra, OverflowPolicy::Reject);
    assert!(matches!(
        rejected,
        Err(Forge3dError::ResourceLimitExceeded { .. })
    ));

    assert!(matches!(
        tracker.allocate("over", MemoryCategory::Buffers, 30),
        Err(Forge3dError::ResourceLimitExceeded { .. })
    ));
    assert_eq!(tracker.report().current_bytes, 80);
}

#[test]
fn downscale_steps_down_deterministically() {
    let mut tracker = MemoryTracker::new(200).unwrap();
    tracker
        .allocate("used", MemoryCategory::Buffers, 150)
        .unwrap();

    let decision = tracker
        .admit(100, QualityLevel::Ultra, OverflowPolicy::Downscale)
        .unwrap();
    assert_eq!(decision.effective_quality, QualityLevel::Medium);
    assert_eq!(decision.admitted_bytes, 50);
    assert!(decision.downscaled);
    assert_eq!(decision.requested_quality, QualityLevel::Ultra);
    assert_eq!(decision.requested_bytes, 100);

    let high = tracker
        .admit(80, QualityLevel::Ultra, OverflowPolicy::Downscale)
        .unwrap();
    assert_eq!(high.effective_quality, QualityLevel::Medium);
    assert_eq!(high.admitted_bytes, 40);
}

#[test]
fn downscale_uses_ceil_arithmetic() {
    let mut tracker = MemoryTracker::new(226).unwrap();
    tracker
        .allocate("used", MemoryCategory::Buffers, 150)
        .unwrap();

    let decision = tracker
        .admit(101, QualityLevel::Ultra, OverflowPolicy::Downscale)
        .unwrap();
    assert_eq!(decision.effective_quality, QualityLevel::High);
    assert_eq!(decision.admitted_bytes, 76);
}

#[test]
fn requested_quality_is_never_upgraded() {
    let mut tracker = MemoryTracker::new(200).unwrap();
    tracker
        .allocate("used", MemoryCategory::Buffers, 150)
        .unwrap();

    let decision = tracker
        .admit(60, QualityLevel::High, OverflowPolicy::Downscale)
        .unwrap();
    assert_eq!(decision.effective_quality, QualityLevel::Medium);
    assert_eq!(decision.admitted_bytes, 30);
}

#[test]
fn low_quality_overflow_rejects() {
    let mut tracker = MemoryTracker::new(110).unwrap();
    tracker
        .allocate("used", MemoryCategory::Buffers, 90)
        .unwrap();

    assert!(matches!(
        tracker.admit(100, QualityLevel::Ultra, OverflowPolicy::Downscale),
        Err(Forge3dError::ResourceLimitExceeded { .. })
    ));
    assert!(matches!(
        tracker.admit(100, QualityLevel::Low, OverflowPolicy::Downscale),
        Err(Forge3dError::ResourceLimitExceeded { .. })
    ));
}

#[test]
fn allocate_with_policy_records_admitted_bytes() {
    let mut tracker = MemoryTracker::new(200).unwrap();
    tracker
        .allocate("used", MemoryCategory::Buffers, 150)
        .unwrap();

    let (id, decision) = tracker
        .allocate_with_policy(
            "scene",
            MemoryCategory::Textures,
            100,
            QualityLevel::Ultra,
            OverflowPolicy::Downscale,
        )
        .unwrap();

    assert_eq!(decision.admitted_bytes, 50);
    assert_eq!(tracker.report().current_bytes, 200);
    assert_eq!(
        tracker.report().categories.get(&MemoryCategory::Textures),
        Some(&50)
    );

    let (again, _) = tracker
        .allocate_with_policy(
            "scene",
            MemoryCategory::Textures,
            100,
            QualityLevel::High,
            OverflowPolicy::Downscale,
        )
        .unwrap();
    assert_eq!(again, id);

    let utilization = tracker.report().utilization;
    assert!((utilization - 1.0).abs() < f64::EPSILON);
}
