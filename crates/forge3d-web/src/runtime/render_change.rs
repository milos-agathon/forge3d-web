//! Consequences of successful semantic changes; GPU resource rebuilding remains local.
use super::Forge3DRuntime;
use forge3d_core::{camera::CameraInput, postfx::TemporalState};

#[derive(Clone, Copy)]
pub(super) enum Change {
    Scene,
    Lighting,
    Camera,
    Selection,
    Explicit,
    Size,
}
#[derive(Debug, PartialEq, Eq)]
struct Consequences {
    pick: bool,
    environment: bool,
    temporal: Option<&'static str>,
    recapture: bool,
    rebuild: bool,
}
impl Change {
    fn consequences(self) -> Consequences {
        use Change::*;
        match self {
            Scene | Lighting => Consequences {
                pick: true,
                environment: false,
                temporal: Some("scene"),
                recapture: true,
                rebuild: true,
            },
            // Camera cuts are classified against the last rendered camera, not each setter.
            Camera => Consequences {
                pick: true,
                environment: true,
                temporal: None,
                recapture: false,
                rebuild: false,
            },
            Selection => Consequences {
                pick: false,
                environment: false,
                temporal: Some("vectors-highlight"),
                recapture: false,
                rebuild: false,
            },
            Explicit => Consequences {
                pick: true,
                environment: false,
                temporal: Some("explicit"),
                recapture: true,
                rebuild: false,
            },
            Size => Consequences {
                pick: true,
                environment: true,
                temporal: Some("resize"),
                recapture: true,
                rebuild: false,
            },
        }
    }
}
pub(super) fn applied(runtime: &mut Forge3DRuntime, change: Change) {
    let effects = change.consequences();
    if effects.pick {
        super::vector::invalidate_pick(runtime);
    }
    if effects.environment {
        if let Some(e) = &runtime.environment {
            e.history_valid.set(false);
        }
    }
    if let Some(reason) = effects.temporal {
        super::postfx::reset_derived(runtime, reason, effects.recapture, effects.rebuild);
    }
}

// Deferred observation preserves TAA across small moves, and resets accumulation
// on any camera/time edit. This runs only when the frame will be recomputed.
pub(super) fn observe_frame(
    temporal: &mut TemporalState,
    camera: &CameraInput,
    accumulation: bool,
    time_changed: bool,
) {
    if temporal.camera_cut(camera) {
        temporal.reset("camera-cut");
    }
    if accumulation && (temporal.previous.is_some_and(|c| c != *camera) || time_changed) {
        temporal.reset("scene");
    }
}
pub(super) fn environment_time_changed(previous: f32, current: f32) -> bool {
    previous != current
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_preserves_pick_and_capture_geometry() {
        let s = Change::Selection.consequences();
        assert!(!s.pick && !s.rebuild && !s.recapture && !s.environment);
        assert_eq!(s.temporal, Some("vectors-highlight"));
    }
    #[test]
    fn camera_defers_cut_policy_but_invalidates_view_pixels() {
        let c = Change::Camera.consequences();
        assert!(c.pick && c.environment);
        assert_eq!(c.temporal, None);
        assert!(!c.rebuild);
        assert!(!environment_time_changed(1., 1.));
        assert!(environment_time_changed(1., 2.));
    }
    #[test]
    fn reset_reasons_and_capture_rebuilds_are_distinct() {
        for c in [Change::Scene, Change::Lighting] {
            assert!(c.consequences().rebuild);
            assert_eq!(c.consequences().temporal, Some("scene"));
        }
        assert!(!Change::Explicit.consequences().rebuild);
        assert_eq!(Change::Explicit.consequences().temporal, Some("explicit"));
        assert_eq!(Change::Size.consequences().temporal, Some("resize"));
    }
}
