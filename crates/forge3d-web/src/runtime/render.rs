#[cfg(target_arch = "wasm32")]
use forge3d_core::gpu::SurfaceState;

#[cfg(target_arch = "wasm32")]
use super::init::surface_descriptor_for_alpha;
use super::Forge3DRuntime;
use crate::error::{Forge3DErrorCode, WebError};

pub(super) fn render_runtime(runtime: &mut Forge3DRuntime) -> Result<bool, WebError> {
    let Some(frame) = acquire_surface_texture(runtime)? else {
        return Ok(false);
    };
    let context = runtime.context.as_ref().ok_or_else(|| {
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
            label: Some("forge3d-web-clear-encoder"),
        });

    encode_scene_render_pass(runtime, &mut encoder, &view, "forge3d-web-clear-pass");

    context.queue.submit(std::iter::once(encoder.finish()));
    frame.present();
    Ok(true)
}

fn acquire_surface_texture(
    runtime: &mut Forge3DRuntime,
) -> Result<Option<wgpu::SurfaceTexture>, WebError> {
    let first = runtime
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

    match first {
        wgpu::CurrentSurfaceTexture::Success(frame)
        | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => Ok(Some(frame)),
        failure => match classify_surface_failure(&failure)? {
            SurfaceFailureAction::Skip => Ok(None),
            SurfaceFailureAction::Reconfigure => {
                reconfigure_surface(runtime)?;
                let state = runtime.surface_state.as_ref().ok_or_else(|| {
                    WebError::new(
                        Forge3DErrorCode::RuntimeDisposed,
                        "Runtime surface state is not available",
                    )
                })?;
                normalize_surface_retry(state.surface.get_current_texture())
            }
            SurfaceFailureAction::Recreate => {
                recreate_surface(runtime, false)?;
                let retry = runtime
                    .surface_state
                    .as_ref()
                    .ok_or_else(|| {
                        WebError::new(
                            Forge3DErrorCode::SurfaceLost,
                            "Surface recreation did not produce a surface",
                        )
                    })?
                    .surface
                    .get_current_texture();
                normalize_surface_retry(retry)
            }
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SurfaceFailureAction {
    Skip,
    Reconfigure,
    Recreate,
}

fn classify_surface_failure(
    status: &wgpu::CurrentSurfaceTexture,
) -> Result<SurfaceFailureAction, WebError> {
    match status {
        wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
            Ok(SurfaceFailureAction::Skip)
        }
        wgpu::CurrentSurfaceTexture::Outdated => Ok(SurfaceFailureAction::Reconfigure),
        wgpu::CurrentSurfaceTexture::Lost => Ok(SurfaceFailureAction::Recreate),
        wgpu::CurrentSurfaceTexture::Validation => Err(WebError::new(
            Forge3DErrorCode::InternalError,
            "Surface texture validation failed",
        )),
        wgpu::CurrentSurfaceTexture::Success(_) | wgpu::CurrentSurfaceTexture::Suboptimal(_) => {
            Err(WebError::new(
                Forge3DErrorCode::InternalError,
                "Successful surface texture was sent to failure classification",
            ))
        }
    }
}

fn normalize_surface_retry(
    retry: wgpu::CurrentSurfaceTexture,
) -> Result<Option<wgpu::SurfaceTexture>, WebError> {
    match retry {
        wgpu::CurrentSurfaceTexture::Success(frame)
        | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => Ok(Some(frame)),
        wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => Ok(None),
        wgpu::CurrentSurfaceTexture::Outdated => Err(WebError::new(
            Forge3DErrorCode::SurfaceOutdated,
            "Surface remained outdated after one reconfiguration",
        )),
        wgpu::CurrentSurfaceTexture::Lost => Err(WebError::new(
            Forge3DErrorCode::SurfaceLost,
            "Surface remained lost after one recreation attempt",
        )),
        wgpu::CurrentSurfaceTexture::Validation => Err(WebError::new(
            Forge3DErrorCode::InternalError,
            "Surface texture validation failed after recovery",
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
        .create_surface(wgpu::SurfaceTarget::Canvas(runtime.canvas.clone()))
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

    let pipeline_rebuilt = new_format != old_format && runtime.terrain.is_some();
    if new_format != old_format {
        if let Some(terrain) = runtime.terrain.as_mut() {
            terrain.rebuild_pipeline(&context, new_format);
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
        timestamp_writes: None,
        multiview_mask: None,
    });

    if let Some(terrain) = runtime.terrain.as_ref() {
        render_pass.set_pipeline(&terrain.pipeline);
        render_pass.set_bind_group(0, &terrain.bind_group, &[]);
        render_pass.set_vertex_buffer(0, terrain.vertex_buffer.slice(..));
        render_pass.set_index_buffer(terrain.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        render_pass.draw_indexed(0..terrain.index_count, 0, 0..1);
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_surface_failure, normalize_surface_retry, SurfaceFailureAction};
    use crate::error::Forge3DErrorCode;

    #[test]
    fn timeout_and_occlusion_are_skipped_without_submission() {
        for status in [
            wgpu::CurrentSurfaceTexture::Timeout,
            wgpu::CurrentSurfaceTexture::Occluded,
        ] {
            assert_eq!(
                classify_surface_failure(&status).expect("status should be recoverable"),
                SurfaceFailureAction::Skip,
            );
            assert!(normalize_surface_retry(status)
                .expect("retry should skip")
                .is_none());
        }
    }

    #[test]
    fn outdated_and_lost_choose_exactly_one_recovery_action() {
        assert_eq!(
            classify_surface_failure(&wgpu::CurrentSurfaceTexture::Outdated)
                .expect("outdated should reconfigure"),
            SurfaceFailureAction::Reconfigure,
        );
        assert_eq!(
            classify_surface_failure(&wgpu::CurrentSurfaceTexture::Lost)
                .expect("lost should recreate"),
            SurfaceFailureAction::Recreate,
        );

        let outdated = normalize_surface_retry(wgpu::CurrentSurfaceTexture::Outdated)
            .expect_err("second outdated status must fail");
        assert_eq!(outdated.code(), Forge3DErrorCode::SurfaceOutdated);
        let lost = normalize_surface_retry(wgpu::CurrentSurfaceTexture::Lost)
            .expect_err("second lost status must fail");
        assert_eq!(lost.code(), Forge3DErrorCode::SurfaceLost);
    }

    #[test]
    fn validation_is_never_treated_as_a_skipped_frame() {
        let initial = classify_surface_failure(&wgpu::CurrentSurfaceTexture::Validation)
            .expect_err("validation must be terminal");
        assert_eq!(initial.code(), Forge3DErrorCode::InternalError);
        let retry = normalize_surface_retry(wgpu::CurrentSurfaceTexture::Validation)
            .expect_err("retry validation must be terminal");
        assert_eq!(retry.code(), Forge3DErrorCode::InternalError);
    }
}
