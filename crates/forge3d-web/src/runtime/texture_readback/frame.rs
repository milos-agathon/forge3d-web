use crate::error::{map_core_error, Forge3DErrorCode, WebError};
use crate::runtime::Forge3DRuntime;
use forge3d_core::{gpu::GpuContext, memory::MemoryCategory};
pub(super) struct FrameReadback {
    pub(super) rgba: Vec<u8>,
    pub(super) coverage: Option<Vec<u8>>,
}
const READBACK_MEMORY_KEY: &str = "readback:frame";
pub(in crate::runtime) async fn read_rgba_runtime(
    runtime: &mut Forge3DRuntime,
) -> Result<Vec<u8>, WebError> {
    Ok(read_frame_runtime(runtime, false).await?.rgba)
}
pub(super) async fn read_frame_runtime(
    runtime: &mut Forge3DRuntime,
    with_coverage: bool,
) -> Result<FrameReadback, WebError> {
    crate::runtime::frame::prepare(runtime)?;
    let context = runtime.context.clone().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let format = runtime
        .surface_state
        .as_ref()
        .map(|state| state.config.format)
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::RuntimeDisposed,
                "Runtime surface state is not available",
            )
        })?;
    let layout = forge3d_core::readback::rgba8_layout(runtime.width, runtime.height)
        .map_err(map_core_error)?;
    if layout.buffer_size > runtime.max_buffer_size {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "frame readback requires {} bytes but maxBufferSize is {}",
                layout.buffer_size, runtime.max_buffer_size
            ),
        ));
    }
    let texture_bytes = u64::from(runtime.width)
        .checked_mul(u64::from(runtime.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "readback byte accounting overflowed",
            )
        })?;
    let total_bytes = texture_bytes
        .checked_add(layout.buffer_size)
        .and_then(|bytes| {
            bytes.checked_add(if with_coverage {
                texture_bytes.checked_mul(2)?
            } else {
                0
            })
        })
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::ResourceLimitExceeded,
                "readback byte accounting overflowed",
            )
        })?;
    runtime
        .memory
        .replace(READBACK_MEMORY_KEY, MemoryCategory::Readback, total_bytes)?;
    let result = capture_frame_rgba(runtime, &context, format, with_coverage).await;
    runtime.memory.release(READBACK_MEMORY_KEY);
    result
}

async fn capture_frame_rgba(
    runtime: &mut Forge3DRuntime,
    context: &GpuContext,
    format: wgpu::TextureFormat,
    with_coverage: bool,
) -> Result<FrameReadback, WebError> {
    let validation_scope = context
        .device
        .push_error_scope(wgpu::ErrorFilter::Validation);
    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-web-readback-texture"),
        size: wgpu::Extent3d {
            width: runtime.width,
            height: runtime.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let coverage = with_coverage.then(|| {
        super::coverage::CoverageReadback::new(
            &context.device,
            &runtime.depth_attachment.as_ref().unwrap().view,
            runtime.width,
            runtime.height,
        )
    });
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("forge3d-web-readback-encoder"),
        });

    crate::runtime::frame::encode_output(
        runtime,
        &mut encoder,
        &view,
        crate::runtime::frame::Mode::Readback,
        "forge3d-web-readback-pass",
        None,
        with_coverage,
    )?;
    if let Some(coverage) = &coverage {
        coverage.encode(&mut encoder, runtime.width, runtime.height);
    }
    let readback_format = match format {
        wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba8UnormSrgb => {
            forge3d_core::readback::ReadbackFormat::Rgba8Unorm
        }
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => {
            forge3d_core::readback::ReadbackFormat::Bgra8Unorm
        }
        _ => {
            return Err(WebError::new(
                Forge3DErrorCode::UnsupportedFeature,
                "unsupported frame readback format",
            ))
        }
    };
    let job = super::Job::encode(
        context,
        &mut encoder,
        &[super::Request {
            texture: &texture,
            region: super::Region::image(runtime.width, runtime.height, 0, readback_format),
        }],
    )?;
    crate::runtime::frame::submit(
        runtime,
        context,
        encoder,
        crate::runtime::frame::Mode::Readback,
    );
    if let Some(error) = validation_scope.pop().await {
        return Err(WebError::new(
            Forge3DErrorCode::InternalError,
            format!("forge3d-web-readback-texture/buffer: {error}"),
        ));
    }
    let rgba = job.tight(context).await?;
    let rgba = normalize_readback_to_rgba(rgba, format)?;
    let coverage = match coverage {
        Some(coverage) => Some(coverage.read(context).await?),
        None => None,
    };
    Ok(FrameReadback { rgba, coverage })
}

pub(in crate::runtime) fn normalize_readback_to_rgba(
    mut pixels: Vec<u8>,
    format: wgpu::TextureFormat,
) -> Result<Vec<u8>, WebError> {
    match format {
        wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba8UnormSrgb => Ok(pixels),
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => {
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            Ok(pixels)
        }
        _ => Err(WebError::new(
            Forge3DErrorCode::UnsupportedFeature,
            format!("Frame readback does not support surface format {format:?}"),
        )),
    }
}
