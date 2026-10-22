use super::super::{environment, ibl, memory::MemoryLedger, shadows};
use super::parse::ParsedScene;
use crate::error::{Forge3DErrorCode, WebError};
use forge3d_core::memory::{MemoryCategory, OverflowPolicy};

pub(super) struct SceneAdmission {
    pub memory: MemoryLedger,
    pub environment: Option<forge3d_core::environment::Environment>,
    pub ibl: Option<ibl::IblSelection>,
    pub shadow_size: u32,
}
/// Complete replacement admission. Quality priority is explicit: environment, IBL, shadows.
/// No GPU constructors run here; materialization order cannot change admission.
pub(super) fn admit(
    current: &MemoryLedger,
    width: u32,
    height: u32,
    policy: OverflowPolicy,
    max_dimension: u32,
    parsed: &ParsedScene,
    fixed: &[(&str, MemoryCategory, u64)],
) -> Result<SceneAdmission, WebError> {
    let downscale = matches!(policy, OverflowPolicy::Downscale);
    let mut base = current.clone();
    let quality_keys = [
        environment::KEY,
        ibl::IBL_TEXTURES_LEDGER_KEY,
        ibl::IBL_UNIFORM_LEDGER_KEY,
        ibl::IBL_TRANSIENT_LEDGER_KEY,
        shadows::SHADOW_DEPTH_KEY,
        shadows::SHADOW_MOMENTS_KEY,
        shadows::SHADOW_UNIFORMS_KEY,
    ];
    for (key, _, _) in fixed {
        base.release(key);
    }
    for key in quality_keys {
        base.release(key);
    }
    base.replace_all(fixed)?;
    let mut environments = vec![parsed.environment.clone()];
    if downscale {
        if let Some(mut reduced) = parsed
            .environment
            .clone()
            .filter(|e| e.resolution_scale == 1.)
        {
            reduced.resolution_scale = 0.5;
            reduced.steps = (reduced.steps / 2).max(8);
            environments.push(Some(reduced));
        }
    }
    let qualities = match &parsed.ibl {
        Some(p) if p.prepared.is_none() => {
            if downscale {
                ibl::ibl_quality_ladder(p.requested_quality)
            } else {
                vec![p.requested_quality]
            }
        }
        _ => vec![ibl::IblQuality::Low],
    };
    let sizes = shadows::shadow_map_size_ladder(parsed.shadows.config.map_size, policy);
    for env in environments {
        let mut with_env = base.clone();
        if with_env
            .replace(
                environment::KEY,
                MemoryCategory::Textures,
                env.as_ref().map_or(0, |e| e.gpu_bytes(width, height)),
            )
            .is_err()
        {
            continue;
        }
        for &quality in &qualities {
            let selection = match &parsed.ibl {
                Some(p) if p.prepared.is_none() => match ibl::select_ibl_quality_at(
                    &with_env,
                    OverflowPolicy::Reject,
                    max_dimension,
                    p,
                    false,
                    quality,
                ) {
                    Ok(s) => Some(s),
                    Err(_) => continue,
                },
                _ => None,
            };
            let (retained, transient) =
                ibl::scene_footprint(parsed.ibl.as_ref(), selection.as_ref())?;
            for &size in &sizes {
                if parsed.shadows.config.enabled && size > max_dimension {
                    continue;
                }
                let (depth, moments, uniforms) = shadows::shadow_ledger_bytes(
                    &parsed.shadows.config,
                    size,
                    parsed.shadows.csm.effective_cascade_count(),
                )?;
                let mut memory = with_env.clone();
                if memory
                    .replace_all(&[
                        (
                            ibl::IBL_TEXTURES_LEDGER_KEY,
                            MemoryCategory::Textures,
                            retained,
                        ),
                        (
                            ibl::IBL_UNIFORM_LEDGER_KEY,
                            MemoryCategory::Buffers,
                            ibl::IBL_UNIFORM_BYTES,
                        ),
                        (
                            ibl::IBL_TRANSIENT_LEDGER_KEY,
                            MemoryCategory::Textures,
                            transient,
                        ),
                        (shadows::SHADOW_DEPTH_KEY, MemoryCategory::Textures, depth),
                        (
                            shadows::SHADOW_MOMENTS_KEY,
                            MemoryCategory::Textures,
                            moments,
                        ),
                        (
                            shadows::SHADOW_UNIFORMS_KEY,
                            MemoryCategory::Buffers,
                            uniforms,
                        ),
                    ])
                    .is_err()
                {
                    continue;
                }
                let environment = env.clone();
                return Ok(SceneAdmission {
                    memory,
                    environment,
                    ibl: selection,
                    shadow_size: size,
                });
            }
        }
    }
    Err(WebError::new(
        Forge3DErrorCode::ResourceLimitExceeded,
        "complete scene replacement and transient resources exceed limits",
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    use forge3d_core::memory::QualityLevel;
    fn scene() -> ParsedScene {
        ParsedScene {
            postfx: None,
            vectors: None,
            environment: None,
            environment_lighting: None,
            scatter: vec![],
            time_seconds: 0.,
            probes: None,
            nodes: vec![],
            passes: vec![],
            lighting: forge3d_core::lighting::default_state(),
            light_ids: vec![],
            materials: forge3d_core::materials::default_state(),
            texture_sets: Default::default(),
            ibl: None,
            shadows: Default::default(),
        }
    }
    #[test]
    fn exchanges_cross_feature_capacity_before_builders_and_preserves_input_ledger() {
        let keys = [
            ibl::IBL_TEXTURES_LEDGER_KEY,
            shadows::SHADOW_DEPTH_KEY,
            environment::KEY,
            "vectors:textures",
            "postfx:resources",
        ];
        for donor in keys {
            let mut old = MemoryLedger::new(100_000, QualityLevel::High).unwrap();
            old.replace(donor, MemoryCategory::Textures, 90_000)
                .unwrap();
            let mut fixed = vec![
                ("vectors:textures", MemoryCategory::Textures, 40_000),
                ("postfx:resources", MemoryCategory::Textures, 40_000),
            ];
            let a = admit(&old, 32, 32, OverflowPolicy::Reject, 8192, &scene(), &fixed).unwrap();
            fixed.reverse();
            let b = admit(&old, 32, 32, OverflowPolicy::Reject, 8192, &scene(), &fixed).unwrap();
            assert_eq!(a.memory.current_bytes(), b.memory.current_bytes());
            assert!(a.memory.current_bytes() < 100_000);
            assert_eq!(old.current_bytes(), 90_000);
            assert_eq!(old.admitted_bytes(donor), Some(90_000));
            fixed[0].2 = 100_000;
            assert!(admit(&old, 32, 32, OverflowPolicy::Reject, 8192, &scene(), &fixed).is_err());
            assert_eq!(old.current_bytes(), 90_000);
        }
    }
    #[test]
    fn selects_quality_from_the_complete_footprint() {
        let mut parsed = scene();
        parsed.environment = Some(forge3d_core::environment::Environment {
            sun_clock: None,
            sky: None,
            fog: None,
            clouds: None,
            volumes: vec![],
            water: vec![],
            sun_direction: [0., 1., 0.],
            sun_color: [1.; 3],
            sun_intensity: 1.,
            resolution_scale: 1.,
            steps: 32,
            temporal_weight: 0.,
            volumetric_mode: "raymarch".into(),
            max_distance: 1000.,
            debug: "none".into(),
        });
        parsed.shadows.config.enabled = true;
        parsed.shadows.config.map_size = 512;
        let fixed = [
            ("vectors:textures", MemoryCategory::Textures, 10_000),
            ("postfx:resources", MemoryCategory::Textures, 10_000),
        ];
        let roomy = MemoryLedger::new(16 * 1024 * 1024, QualityLevel::High).unwrap();
        let full = admit(
            &roomy,
            128,
            128,
            OverflowPolicy::Reject,
            8192,
            &parsed,
            &fixed,
        )
        .unwrap();
        let smaller =
            MemoryLedger::new(full.memory.current_bytes() - 1, QualityLevel::High).unwrap();
        assert!(admit(
            &smaller,
            128,
            128,
            OverflowPolicy::Reject,
            8192,
            &parsed,
            &fixed
        )
        .is_err());
        let reduced = admit(
            &smaller,
            128,
            128,
            OverflowPolicy::Downscale,
            8192,
            &parsed,
            &fixed,
        )
        .unwrap();
        assert_eq!(reduced.environment.unwrap().resolution_scale, 1.);
        assert!(reduced.shadow_size < 512);
    }
    #[test]
    fn ibl_transient_peak_is_admitted_with_every_retained_feature() {
        let mut parsed = scene();
        parsed.ibl = Some(ibl::ParsedIbl {
            source_width: 1,
            source_height: 1,
            source_data: vec![1.; 4],
            source_hash: String::new(),
            intensity: 1.,
            rotation_degrees: 0.,
            requested_quality: ibl::IblQuality::Low,
            effective_quality: ibl::IblQuality::Low,
            native_prefilter: false,
            prepared: None,
        });
        let memory = MemoryLedger::new(64 * 1024 * 1024, QualityLevel::High).unwrap();
        let fixed = [
            ("vectors:textures", MemoryCategory::Textures, 1234),
            ("postfx:resources", MemoryCategory::Textures, 5678),
        ];
        let plan = admit(
            &memory,
            32,
            32,
            OverflowPolicy::Reject,
            8192,
            &parsed,
            &fixed,
        )
        .unwrap();
        let transient = plan
            .memory
            .admitted_bytes(ibl::IBL_TRANSIENT_LEDGER_KEY)
            .unwrap();
        assert!(transient > 0);
        let peak = plan.memory.current_bytes();
        assert!(admit(
            &MemoryLedger::new(peak - 1, QualityLevel::High).unwrap(),
            32,
            32,
            OverflowPolicy::Reject,
            8192,
            &parsed,
            &fixed
        )
        .is_err());
        assert!(admit(
            &MemoryLedger::new(peak, QualityLevel::High).unwrap(),
            32,
            32,
            OverflowPolicy::Reject,
            8192,
            &parsed,
            &fixed
        )
        .is_ok());
    }
}
