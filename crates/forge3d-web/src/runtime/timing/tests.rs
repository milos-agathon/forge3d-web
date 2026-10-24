use super::*;

fn pass(name: &str, group: PassGroup, draws: u32, triangles: u64) -> PassDraw {
    PassDraw {
        name: name.to_string(),
        group,
        draws,
        triangles,
    }
}

#[test]
fn pass_milliseconds_split_world_time_by_draw_share() {
    let passes = [
        pass("terrain", PassGroup::World, 1, 2),
        pass("ground-plane", PassGroup::World, 1, 2),
        pass("overlay", PassGroup::Overlay, 1, 2),
        pass("custom", PassGroup::Noop, 0, 0),
    ];
    let world_draws = world_draw_count(&passes);
    assert_eq!(world_draws, 2);
    assert_eq!(
        pass_milliseconds(&passes[0], 2.0, 1.0, world_draws),
        Some(1.0)
    );
    assert_eq!(
        pass_milliseconds(&passes[1], 2.0, 1.0, world_draws),
        Some(1.0)
    );
    assert_eq!(
        pass_milliseconds(&passes[2], 2.0, 1.0, world_draws),
        Some(1.0)
    );
    assert_eq!(
        pass_milliseconds(&passes[3], 2.0, 1.0, world_draws),
        Some(0.0)
    );
}

#[test]
fn cpu_fallback_assigns_zero_gpu_time_to_world_passes() {
    let passes = vec![pass("terrain", PassGroup::World, 1, 2)];
    assert_eq!(pass_milliseconds(&passes[0], 0.0, 0.0, 1), Some(0.0));
}

#[test]
fn nonfinite_or_negative_group_times_are_rejected() {
    let passes = vec![pass("terrain", PassGroup::World, 1, 2)];
    assert_eq!(pass_milliseconds(&passes[0], f64::NAN, 0.0, 1), None);
    assert_eq!(pass_milliseconds(&passes[0], -1.0, 0.0, 1), None);
}

#[test]
fn ring_slots_keep_independent_submission_ownership() {
    let slots = [Completion::default(), Completion::default()];
    assert!(slots[0].submit());
    assert!(!slots[0].idle());
    assert!(slots[1].idle());
    assert!(slots[1].submit());
    assert!(!slots.iter().any(Completion::idle));
}
