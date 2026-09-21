#[cfg(target_arch = "wasm32")]
use forge3d_core::gpu::SurfaceState;
use forge3d_core::timing::TimingSource;

#[cfg(target_arch = "wasm32")]
use super::init::surface_descriptor_for_alpha;
use super::scene::scene_pass_draws;
use super::timing::{now_ms, pass_milliseconds, world_draw_count};
use super::Forge3DRuntime;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};

pub(super) fn render_runtime(runtime: &mut Forge3DRuntime) -> Result<bool, WebError> {
    if let Some(ring) = runtime.query_ring.as_mut() {
        ring.harvest();
    }
    let Some(frame) = acquire_surface_texture(runtime)? else {
        return Ok(false);
    };
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let view = frame
        .texture
        .create_view(&wgpu::TextureViewDescriptor::default());
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("forge3d-web-scene-encoder"),
        });
    let timestamp_slot = runtime.query_ring.as_mut().and_then(|ring| ring.acquire());
    let frame_start = now_ms();

    encode_scene_render_pass(
        runtime,
        &mut encoder,
        &view,
        "forge3d-web-scene-pass",
        timestamp_slot,
    );
    if let (Some(ring), Some(slot)) = (runtime.query_ring.as_mut(), timestamp_slot) {
        ring.resolve_into(&mut encoder, slot);
    }

    context.queue.submit(std::iter::once(encoder.finish()));
    if let (Some(ring), Some(slot)) = (runtime.query_ring.as_mut(), timestamp_slot) {
        ring.begin_map(slot);
    }
    frame.present();
    record_frame_stats(runtime, now_ms() - frame_start)?;
    Ok(true)
}

fn record_frame_stats(runtime: &mut Forge3DRuntime, frame_ms: f64) -> Result<(), WebError> {
    let passes = scene_pass_draws(runtime);
    let gpu = runtime.query_ring.as_ref().and_then(|ring| ring.latest());
    let (world_ms, overlay_ms, source) = match gpu {
        Some(timing) => (
            timing.world_ms,
            timing.overlay_ms,
            TimingSource::GpuTimestamp,
        ),
        None => (0.0, 0.0, TimingSource::Cpu),
    };
    let world_draws = world_draw_count(&passes);
    runtime.timer.begin_frame();
    for pass in &passes {
        let milliseconds =
            pass_milliseconds(pass, world_ms, overlay_ms, world_draws).ok_or_else(|| {
                WebError::new(
                    Forge3DErrorCode::InternalError,
                    format!("pass {} produced an invalid timing sample", pass.name),
                )
            })?;
        match source {
            TimingSource::GpuTimestamp => {
                runtime
                    .timer
                    .record_gpu(pass.name.clone(), milliseconds)
                    .map_err(map_core_error)?;
            }
            TimingSource::Cpu => {
                runtime
                    .timer
                    .record_cpu(pass.name.clone(), milliseconds)
                    .map_err(map_core_error)?;
            }
        }
    }
    let draw_calls = passes.iter().map(|pass| pass.draws).sum();
    let triangles = passes.iter().map(|pass| pass.triangles).sum();
    runtime.last_stats = runtime
        .timer
        .finish_frame(frame_ms, draw_calls, triangles)
        .map_err(map_core_error)?;
    Ok(())
}

fn acquire_surface_texture(
    runtime: &mut Forge3DRuntime,
) -> Result<Option<wgpu::SurfaceTexture>, WebError> {
    drive_surface_acquisition(&mut RuntimeSurfaceAcquisition { runtime })
}

enum SurfaceAcquireStatus<T> {
    Success(T),
    Suboptimal(T),
    Timeout,
    Occluded,
    Outdated,
    Lost,
    Validation,
}

trait SurfaceAcquisition {
    type Frame;

    fn check_health(&mut self) -> Result<(), WebError>;
    fn acquire(&mut self) -> Result<SurfaceAcquireStatus<Self::Frame>, WebError>;
    fn reconfigure(&mut self) -> Result<(), WebError>;
    fn recreate(&mut self) -> Result<(), WebError>;
}

struct RuntimeSurfaceAcquisition<'a> {
    runtime: &'a mut Forge3DRuntime,
}

impl SurfaceAcquisition for RuntimeSurfaceAcquisition<'_> {
    type Frame = wgpu::SurfaceTexture;

    fn check_health(&mut self) -> Result<(), WebError> {
        super::device_health::ensure_device_healthy_error(self.runtime)
    }

    fn acquire(&mut self) -> Result<SurfaceAcquireStatus<Self::Frame>, WebError> {
        let status = self
            .runtime
            .surface_state
            .as_ref()
            .ok_or_else(|| {
                WebError::new(
                    Forge3DErrorCode::RuntimeDisposed,
                    "Runtime surface state is not available",
                )
            })?
            .surface
            .get_current_texture();
        Ok(match status {
            wgpu::CurrentSurfaceTexture::Success(frame) => SurfaceAcquireStatus::Success(frame),
            wgpu::CurrentSurfaceTexture::Suboptimal(frame) => {
                SurfaceAcquireStatus::Suboptimal(frame)
            }
            wgpu::CurrentSurfaceTexture::Timeout => SurfaceAcquireStatus::Timeout,
            wgpu::CurrentSurfaceTexture::Occluded => SurfaceAcquireStatus::Occluded,
            wgpu::CurrentSurfaceTexture::Outdated => SurfaceAcquireStatus::Outdated,
            wgpu::CurrentSurfaceTexture::Lost => SurfaceAcquireStatus::Lost,
            wgpu::CurrentSurfaceTexture::Validation => SurfaceAcquireStatus::Validation,
        })
    }

    fn reconfigure(&mut self) -> Result<(), WebError> {
        reconfigure_surface(self.runtime)
    }

    fn recreate(&mut self) -> Result<(), WebError> {
        recreate_surface(self.runtime, false).map(|_| ())
    }
}

fn drive_surface_acquisition<A: SurfaceAcquisition>(
    acquisition: &mut A,
) -> Result<Option<A::Frame>, WebError> {
    acquisition.check_health()?;
    let first = acquisition.acquire()?;
    match first {
        SurfaceAcquireStatus::Success(frame) | SurfaceAcquireStatus::Suboptimal(frame) => {
            Ok(Some(frame))
        }
        SurfaceAcquireStatus::Timeout | SurfaceAcquireStatus::Occluded => Ok(None),
        SurfaceAcquireStatus::Validation => validation_error(acquisition),
        SurfaceAcquireStatus::Outdated => {
            acquisition.reconfigure()?;
            retry_surface_acquisition(acquisition)
        }
        SurfaceAcquireStatus::Lost => {
            acquisition.recreate()?;
            retry_surface_acquisition(acquisition)
        }
    }
}

fn retry_surface_acquisition<A: SurfaceAcquisition>(
    acquisition: &mut A,
) -> Result<Option<A::Frame>, WebError> {
    acquisition.check_health()?;
    match acquisition.acquire()? {
        SurfaceAcquireStatus::Success(frame) | SurfaceAcquireStatus::Suboptimal(frame) => {
            Ok(Some(frame))
        }
        SurfaceAcquireStatus::Timeout | SurfaceAcquireStatus::Occluded => Ok(None),
        SurfaceAcquireStatus::Outdated => Err(WebError::new(
            Forge3DErrorCode::SurfaceOutdated,
            "Surface remained outdated after one reconfiguration",
        )),
        SurfaceAcquireStatus::Lost => Err(WebError::new(
            Forge3DErrorCode::SurfaceLost,
            "Surface remained lost after one recreation attempt",
        )),
        SurfaceAcquireStatus::Validation => validation_error(acquisition),
    }
}

fn validation_error<A: SurfaceAcquisition>(
    acquisition: &mut A,
) -> Result<Option<A::Frame>, WebError> {
    match acquisition.check_health() {
        Err(error) => Err(error),
        Ok(()) => Err(WebError::new(
            Forge3DErrorCode::InternalError,
            "Surface texture validation failed without a captured GPU diagnostic",
        )),
    }
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) struct SurfaceRecoveryReport {
    pub(super) old_format: wgpu::TextureFormat,
    pub(super) new_format: wgpu::TextureFormat,
    pub(super) pipeline_rebuilt: bool,
}

#[cfg(target_arch = "wasm32")]
pub(super) fn recreate_surface(
    runtime: &mut Forge3DRuntime,
    force_format_change: bool,
) -> Result<SurfaceRecoveryReport, WebError> {
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let gpu_runtime = runtime.gpu_runtime.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU instance is not available",
        )
    })?;
    let old_format = runtime
        .surface_state
        .take()
        .map(|state| state.config.format)
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::SurfaceLost,
                "Lost surface state is not available for recreation",
            )
        })?;
    let surface = gpu_runtime
        .instance
        .create_surface(runtime.canvas.surface_target())
        .map_err(|error| {
            WebError::new(
                Forge3DErrorCode::SurfaceLost,
                format!("Failed to recreate lost surface: {error}"),
            )
        })?;
    let mut descriptor = surface_descriptor_for_alpha(
        &surface,
        &context,
        runtime.preferred_alpha_mode,
        runtime.width,
        runtime.height,
    )
    .map_err(|error| WebError::new(Forge3DErrorCode::SurfaceLost, error.message()))?;
    if force_format_change {
        let capabilities = surface.get_capabilities(&context.adapter);
        descriptor.format = capabilities
            .formats
            .iter()
            .copied()
            .find(|format| *format != old_format)
            .ok_or_else(|| {
                WebError::new(
                    Forge3DErrorCode::UnsupportedFeature,
                    "Surface does not expose an alternate format for diagnostic recovery",
                )
            })?;
        descriptor.view_formats = vec![descriptor.format];
    }
    let new_format = descriptor.format;
    let state = SurfaceState::new(surface, &context, descriptor)
        .map_err(|error| WebError::new(Forge3DErrorCode::SurfaceLost, error.to_string()))?;

    let pipeline_rebuilt =
        new_format != old_format && (runtime.terrain.is_some() || runtime.scene.is_some());
    if new_format != old_format {
        if let Some(terrain) = runtime.terrain.as_mut() {
            terrain.rebuild_pipeline(&context, new_format);
        }
        if let Some(scene) = runtime.scene.as_mut() {
            scene.rebuild_pipelines(&context, new_format);
        }
    }
    runtime.surface_format = format!("{new_format:?}");
    runtime.surface_state = Some(state);
    Ok(SurfaceRecoveryReport {
        old_format,
        new_format,
        pipeline_rebuilt,
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn recreate_surface(
    _runtime: &mut Forge3DRuntime,
    _force_format_change: bool,
) -> Result<SurfaceRecoveryReport, WebError> {
    Err(WebError::new(
        Forge3DErrorCode::SurfaceLost,
        "Surface recreation is only available in wasm32 browser builds",
    ))
}

pub(super) fn reconfigure_surface(runtime: &Forge3DRuntime) -> Result<(), WebError> {
    let context = runtime.context.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let state = runtime.surface_state.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime surface state is not available",
        )
    })?;
    state.configure(context);
    Ok(())
}

pub(super) fn encode_scene_render_pass(
    runtime: &Forge3DRuntime,
    encoder: &mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    label: &'static str,
    timestamp_slot: Option<usize>,
) {
    let depth_stencil_attachment =
        runtime
            .depth_attachment
            .as_ref()
            .map(|depth| wgpu::RenderPassDepthStencilAttachment {
                view: &depth.view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Discard,
                }),
                stencil_ops: None,
            });
    let world_writes = timestamp_slot.and_then(|slot| {
        runtime
            .query_ring
            .as_ref()
            .map(|ring| ring.pass_writes(slot, 0))
    });
    {
        let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: runtime.clear_color[0] as f64,
                        g: runtime.clear_color[1] as f64,
                        b: runtime.clear_color[2] as f64,
                        a: runtime.clear_color[3] as f64,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment,
            occlusion_query_set: None,
            timestamp_writes: world_writes,
            multiview_mask: None,
        });

        if let Some(terrain) = runtime.terrain.as_ref() {
            render_pass.set_pipeline(&terrain.pipeline);
            render_pass.set_bind_group(0, &terrain.bind_group, &[]);
            render_pass.set_vertex_buffer(0, terrain.vertex_buffer.slice(..));
            render_pass.set_index_buffer(terrain.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            render_pass.draw_indexed(0..terrain.index_count, 0, 0..1);
        }
        if let Some(scene) = runtime.scene.as_ref() {
            if let Some(bundle) = scene.world_bundle.as_ref() {
                render_pass.execute_bundles(std::iter::once(bundle));
            }
        }
    }

    let overlay_writes = timestamp_slot.and_then(|slot| {
        runtime
            .query_ring
            .as_ref()
            .map(|ring| ring.pass_writes(slot, 1))
    });
    let has_overlay = runtime
        .scene
        .as_ref()
        .and_then(|scene| scene.overlay_bundle.as_ref())
        .is_some();
    if !has_overlay && overlay_writes.is_none() {
        return;
    }
    let mut overlay_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("forge3d-web-overlay-pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        occlusion_query_set: None,
        timestamp_writes: overlay_writes,
        multiview_mask: None,
    });
    if let Some(scene) = runtime.scene.as_ref() {
        if let Some(bundle) = scene.overlay_bundle.as_ref() {
            overlay_pass.execute_bundles(std::iter::once(bundle));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::{drive_surface_acquisition, SurfaceAcquireStatus, SurfaceAcquisition};
    use crate::error::Forge3DErrorCode;

    // Contract reference: https://docs.rs/wgpu/29.0.3/wgpu/enum.CurrentSurfaceTexture.html
    struct FakeAcquisition {
        statuses: VecDeque<SurfaceAcquireStatus<&'static str>>,
        health: VecDeque<Result<(), super::WebError>>,
        actions: Vec<&'static str>,
        recovery_error: Option<super::WebError>,
    }

    impl FakeAcquisition {
        fn new(statuses: impl IntoIterator<Item = SurfaceAcquireStatus<&'static str>>) -> Self {
            Self {
                statuses: statuses.into_iter().collect(),
                health: VecDeque::new(),
                actions: Vec::new(),
                recovery_error: None,
            }
        }
    }

    impl SurfaceAcquisition for FakeAcquisition {
        type Frame = &'static str;

        fn check_health(&mut self) -> Result<(), super::WebError> {
            self.actions.push("health");
            self.health.pop_front().unwrap_or(Ok(()))
        }

        fn acquire(&mut self) -> Result<SurfaceAcquireStatus<Self::Frame>, super::WebError> {
            self.actions.push("acquire");
            Ok(self.statuses.pop_front().expect("fixture status"))
        }

        fn reconfigure(&mut self) -> Result<(), super::WebError> {
            self.actions.push("reconfigure");
            match self.recovery_error.take() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }

        fn recreate(&mut self) -> Result<(), super::WebError> {
            self.actions.push("recreate");
            match self.recovery_error.take() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
    }

    #[test]
    fn timeout_and_occlusion_are_skipped_without_submission() {
        for status in [
            SurfaceAcquireStatus::Timeout,
            SurfaceAcquireStatus::Occluded,
        ] {
            let mut acquisition = FakeAcquisition::new([status]);
            assert!(drive_surface_acquisition(&mut acquisition)
                .expect("status should skip")
                .is_none());
            assert_eq!(acquisition.actions, ["health", "acquire"]);
        }
    }

    #[test]
    fn outdated_reconfigures_and_lost_recreates_before_exactly_one_retry() {
        for (first, action) in [
            (SurfaceAcquireStatus::Outdated, "reconfigure"),
            (SurfaceAcquireStatus::Lost, "recreate"),
        ] {
            let mut acquisition =
                FakeAcquisition::new([first, SurfaceAcquireStatus::Success("frame")]);
            assert_eq!(
                drive_surface_acquisition(&mut acquisition).expect("recovery should succeed"),
                Some("frame")
            );
            assert_eq!(
                acquisition.actions,
                ["health", "acquire", action, "health", "acquire"]
            );
        }
    }

    #[test]
    fn second_or_mixed_failure_is_terminal_without_another_recovery() {
        for (second, code) in [
            (
                SurfaceAcquireStatus::Outdated,
                Forge3DErrorCode::SurfaceOutdated,
            ),
            (SurfaceAcquireStatus::Lost, Forge3DErrorCode::SurfaceLost),
        ] {
            let mut acquisition = FakeAcquisition::new([SurfaceAcquireStatus::Outdated, second]);
            let error = drive_surface_acquisition(&mut acquisition)
                .expect_err("second failure must be terminal");
            assert_eq!(error.code(), code);
            assert_eq!(
                acquisition.actions,
                ["health", "acquire", "reconfigure", "health", "acquire"]
            );
        }
    }

    #[test]
    fn recreation_failure_is_surface_lost_and_never_retries() {
        let mut acquisition = FakeAcquisition::new([SurfaceAcquireStatus::Lost]);
        acquisition.recovery_error = Some(super::WebError::new(
            Forge3DErrorCode::SurfaceLost,
            "recreation failed",
        ));
        let error = drive_surface_acquisition(&mut acquisition)
            .expect_err("recreation failure must be terminal");
        assert_eq!(error.code(), Forge3DErrorCode::SurfaceLost);
        assert_eq!(acquisition.actions, ["health", "acquire", "recreate"]);
    }

    #[test]
    fn timeout_or_occlusion_on_retry_skips_without_more_recovery() {
        for second in [
            SurfaceAcquireStatus::Timeout,
            SurfaceAcquireStatus::Occluded,
        ] {
            let mut acquisition = FakeAcquisition::new([SurfaceAcquireStatus::Outdated, second]);
            assert!(drive_surface_acquisition(&mut acquisition)
                .expect("retry should skip")
                .is_none());
            assert_eq!(
                acquisition.actions,
                ["health", "acquire", "reconfigure", "health", "acquire"]
            );
        }
    }

    #[test]
    fn health_is_checked_immediately_before_acquisition() {
        let mut acquisition = FakeAcquisition::new([SurfaceAcquireStatus::Success("unused")]);
        acquisition.health.push_back(Err(super::WebError::new(
            Forge3DErrorCode::DeviceLost,
            "lost while idle",
        )));
        let error = drive_surface_acquisition(&mut acquisition)
            .expect_err("preexisting health error must stop acquisition");
        assert_eq!(error.code(), Forge3DErrorCode::DeviceLost);
        assert_eq!(acquisition.actions, ["health"]);
    }

    #[test]
    fn validation_returns_the_sticky_diagnostic_or_explicit_internal_error() {
        let mut captured = FakeAcquisition::new([SurfaceAcquireStatus::Validation]);
        captured.health.push_back(Ok(()));
        captured.health.push_back(Err(super::WebError::new(
            Forge3DErrorCode::InternalError,
            "captured validation: terrain pipeline",
        )));
        let error = drive_surface_acquisition(&mut captured)
            .expect_err("captured validation must be terminal");
        assert_eq!(error.message(), "captured validation: terrain pipeline");
        assert_eq!(captured.actions, ["health", "acquire", "health"]);

        let mut absent = FakeAcquisition::new([SurfaceAcquireStatus::Validation]);
        let error = drive_surface_acquisition(&mut absent)
            .expect_err("missing diagnostic must still be explicit");
        assert_eq!(error.code(), Forge3DErrorCode::InternalError);
        assert!(error
            .message()
            .contains("without a captured GPU diagnostic"));
    }
}
