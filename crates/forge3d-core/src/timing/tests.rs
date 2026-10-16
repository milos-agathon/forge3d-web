use super::{FrameTimer, TimingSource};
use crate::error::Forge3dError;

#[test]
fn source_reflects_timestamp_query_support() {
    let gpu = FrameTimer::new(true);
    assert_eq!(gpu.source(), TimingSource::GpuTimestamp);

    let cpu = FrameTimer::new(false);
    assert_eq!(cpu.source(), TimingSource::Cpu);
}

#[test]
fn record_gpu_falls_back_to_cpu_when_unsupported() {
    let mut timer = FrameTimer::new(true);
    timer.begin_frame();
    timer.record_gpu("terrain", 1.5).unwrap();
    timer.record_cpu("submit", 0.25).unwrap();
    let stats = timer.finish_frame(4.0, 12, 3000).unwrap();

    assert_eq!(stats.frame_index, 0);
    assert_eq!(stats.frame_time_ms, 4.0);
    assert_eq!(stats.draw_calls, 12);
    assert_eq!(stats.triangles, 3000);
    assert_eq!(stats.passes.len(), 2);
    assert_eq!(stats.passes[0].name, "terrain");
    assert_eq!(stats.passes[0].source, TimingSource::GpuTimestamp);
    assert_eq!(stats.passes[1].source, TimingSource::Cpu);

    let mut fallback = FrameTimer::new(false);
    fallback.begin_frame();
    fallback.record_gpu("terrain", 2.0).unwrap();
    let stats = fallback.finish_frame(3.0, 1, 10).unwrap();
    assert_eq!(stats.passes[0].source, TimingSource::Cpu);
}

#[test]
fn finish_frame_increments_index_and_drains_passes() {
    let mut timer = FrameTimer::new(false);
    timer.begin_frame();
    timer.record_cpu("a", 1.0).unwrap();
    let first = timer.finish_frame(2.0, 1, 1).unwrap();
    assert_eq!(first.frame_index, 0);
    assert_eq!(first.passes.len(), 1);

    timer.begin_frame();
    let second = timer.finish_frame(3.0, 2, 2).unwrap();
    assert_eq!(second.frame_index, 1);
    assert!(second.passes.is_empty());
}

#[test]
fn non_finite_or_negative_times_are_rejected() {
    let mut timer = FrameTimer::new(true);
    timer.begin_frame();

    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
        assert!(matches!(
            timer.record_cpu("bad", bad),
            Err(Forge3dError::InvalidInput { .. })
        ));
        assert!(matches!(
            timer.record_gpu("bad", bad),
            Err(Forge3dError::InvalidInput { .. })
        ));
        assert!(matches!(
            timer.finish_frame(bad, 0, 0),
            Err(Forge3dError::InvalidInput { .. })
        ));
    }
}
