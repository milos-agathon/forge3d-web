//! Ordered feature execution. Capture never advances display motion or LOD.
mod capture;
mod direct;
use super::{terrain::CaptureCameraUniform, Forge3DRuntime};
use crate::error::WebError;
pub(super) use capture::{encode_capture_view, CaptureView};
use forge3d_core::gpu::GpuContext;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Display,
    Readback,
    Offline,
}
impl Mode {
    fn feedback(self) -> bool {
        self != Self::Readback
    }
    fn advances_history(self) -> bool {
        self == Self::Display
    }
}

pub(super) fn prepare(runtime: &mut Forge3DRuntime) -> Result<(), WebError> {
    super::environment::refresh(runtime)?;
    super::shadows::refresh_shadow_state(runtime)?;
    super::shader_variants::sync_pipelines(runtime)?;
    super::scatter::prepare(runtime, None)
}

// Offline samples preserve the capture camera and their established refresh order.
pub(super) fn prepare_sample(
    runtime: &mut Forge3DRuntime,
    context: &GpuContext,
    uniform: &CaptureCameraUniform,
    refresh: bool,
) -> Result<(), WebError> {
    super::scatter::prepare(runtime, Some(uniform))?;
    if refresh {
        super::environment::refresh(runtime)?;
    }
    if let Some(e) = &runtime.environment {
        e.update_capture(context, uniform, runtime.terrain.as_ref());
    }
    super::shadows::refresh_shadow_state(runtime)
}

pub(super) fn begin(runtime: &Forge3DRuntime, encoder: &mut wgpu::CommandEncoder, mode: Mode) {
    if mode != Mode::Readback || super::postfx::readback_needs_scene_render(runtime) {
        super::shadows::encode_shadow_passes(runtime, encoder);
    }
    if mode.feedback() {
        if let Some(terrain) = &runtime.terrain {
            terrain.encode_w08_frame_start(encoder);
        }
    }
}
pub(super) fn end(runtime: &mut Forge3DRuntime, encoder: &mut wgpu::CommandEncoder, mode: Mode) {
    if mode.feedback() {
        if let Some(terrain) = &runtime.terrain {
            terrain.encode_w08_frame_end(encoder);
        }
    }
    if mode.advances_history() {
        if let Some(terrain) = &mut runtime.terrain {
            terrain.encode_w08_compute(encoder);
        }
    }
}
pub(super) fn encode_output(
    runtime: &mut Forge3DRuntime,
    encoder: &mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    mode: Mode,
    label: &'static str,
    timestamp: Option<usize>,
    preserve_depth: bool,
) -> Result<(), WebError> {
    begin(runtime, encoder, mode);
    if runtime.postfx.is_some() {
        super::postfx::encode(runtime, encoder, view, mode.advances_history())?;
    } else {
        direct::encode_scene_render_pass(runtime, encoder, view, label, timestamp, preserve_depth);
    }
    end(runtime, encoder, mode);
    Ok(())
}
pub(super) fn submit(
    runtime: &mut Forge3DRuntime,
    context: &GpuContext,
    encoder: wgpu::CommandEncoder,
    mode: Mode,
) {
    context.queue.submit(std::iter::once(encoder.finish()));
    if mode.advances_history() {
        if let Some(scene) = &mut runtime.scene {
            scene.advance_motion(context);
        }
        if let Some(scatter) = &mut runtime.scatter {
            scatter.advance_motion(runtime.time_seconds);
        }
    }
    if mode.feedback() {
        if let Some(terrain) = &mut runtime.terrain {
            terrain.begin_w08_map(context);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Mode;
    #[test]
    fn capture_modes_keep_display_history_stationary() {
        for mode in [
            Mode::Display,
            Mode::Readback,
            Mode::Offline,
            Mode::Readback,
            Mode::Display,
        ] {
            assert_eq!(mode.advances_history(), mode == Mode::Display);
            assert_eq!(mode.feedback(), mode != Mode::Readback);
        }
    }
}
