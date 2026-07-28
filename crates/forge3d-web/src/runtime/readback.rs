use forge3d_core::gpu::GpuContext;
use wasm_bindgen::{closure::Closure, prelude::*, Clamped, JsCast};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Blob, CanvasRenderingContext2d, HtmlCanvasElement, ImageData};

use super::render::encode_scene_render_pass;
use super::Forge3DRuntime;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};

pub(super) async fn screenshot_runtime(runtime: &mut Forge3DRuntime) -> Result<Blob, WebError> {
    let context = runtime.context.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime GPU context is not available",
        )
    })?;
    let surface_state = runtime.surface_state.as_ref().ok_or_else(|| {
        WebError::new(
            Forge3DErrorCode::RuntimeDisposed,
            "Runtime surface state is not available",
        )
    })?;
    let format = surface_state.config.format;
    let layout = forge3d_core::readback::rgba8_layout(runtime.width, runtime.height)
        .map_err(map_core_error)?;
    if layout.buffer_size > runtime.max_buffer_size {
        return Err(WebError::new(
            Forge3DErrorCode::ResourceLimitExceeded,
            format!(
                "screenshot readback requires {} bytes but maxBufferSize is {}",
                layout.buffer_size, runtime.max_buffer_size
            ),
        ));
    }

    let validation_scope = context
        .device
        .push_error_scope(wgpu::ErrorFilter::Validation);
    let texture = context.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge3d-web-screenshot-texture"),
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
    let readback = context.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("forge3d-web-screenshot-readback"),
        size: layout.buffer_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("forge3d-web-screenshot-encoder"),
        });

    encode_scene_render_pass(runtime, &mut encoder, &view, "forge3d-web-screenshot-pass");
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(layout.padded_bytes_per_row),
                rows_per_image: Some(runtime.height),
            },
        },
        wgpu::Extent3d {
            width: runtime.width,
            height: runtime.height,
            depth_or_array_layers: 1,
        },
    );

    context.queue.submit(std::iter::once(encoder.finish()));
    if let Some(error) = validation_scope.pop().await {
        return Err(WebError::new(
            Forge3DErrorCode::InternalError,
            format!("forge3d-web-screenshot-texture/readback: {error}"),
        ));
    }
    let padded = map_readback_buffer(context, &readback, layout.buffer_size).await?;
    let rgba = forge3d_core::readback::unpad_rows(&padded, layout).map_err(map_core_error)?;
    let rgba = normalize_readback_to_rgba(rgba, format)?;
    png_blob_from_rgba(runtime.width, runtime.height, rgba).await
}

async fn map_readback_buffer(
    context: &GpuContext,
    buffer: &wgpu::Buffer,
    size: u64,
) -> Result<Vec<u8>, WebError> {
    let slice = buffer.slice(..);
    let promise = js_sys::Promise::new(&mut |resolve, reject| {
        slice.map_async(wgpu::MapMode::Read, move |result| match result {
            Ok(()) => {
                let _ = resolve.call0(&JsValue::NULL);
            }
            Err(error) => {
                let _ = reject.call1(&JsValue::NULL, &JsValue::from_str(&error.to_string()));
            }
        });
    });
    let _ = context.device.poll(wgpu::PollType::Poll);

    JsFuture::from(promise).await.map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Screenshot readback mapping failed",
            error,
        )
    })?;

    let data = {
        let mapped = buffer.slice(0..size).get_mapped_range();
        mapped.to_vec()
    };
    buffer.unmap();
    Ok(data)
}

fn normalize_readback_to_rgba(
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
            format!("Screenshots do not support surface format {format:?}"),
        )),
    }
}

async fn png_blob_from_rgba(width: u32, height: u32, rgba: Vec<u8>) -> Result<Blob, WebError> {
    let document = web_sys::window()
        .and_then(|window| window.document())
        .ok_or_else(|| WebError::new(Forge3DErrorCode::IoError, "Document is not available"))?;
    let canvas = document
        .create_element("canvas")
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Failed to create screenshot encoding canvas",
                error,
            )
        })?
        .dyn_into::<HtmlCanvasElement>()
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Created element is not a canvas",
                error.into(),
            )
        })?;
    canvas.set_width(width);
    canvas.set_height(height);

    let context = canvas
        .get_context("2d")
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Failed to request 2D canvas context",
                error,
            )
        })?
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::IoError,
                "2D canvas context is unavailable",
            )
        })?
        .dyn_into::<CanvasRenderingContext2d>()
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Canvas context is not CanvasRenderingContext2D",
                error.into(),
            )
        })?;
    let image_data = ImageData::new_with_u8_clamped_array_and_sh(Clamped(&rgba), width, height)
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Failed to create ImageData for screenshot",
                error,
            )
        })?;
    context
        .put_image_data(&image_data, 0.0, 0.0)
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Failed to write screenshot pixels to canvas",
                error,
            )
        })?;

    let promise = js_sys::Promise::new(&mut |resolve, reject| {
        let reject_for_callback = reject.clone();
        let callback = Closure::once(move |blob: Option<Blob>| match blob {
            Some(blob) => {
                let _ = resolve.call1(&JsValue::NULL, &blob);
            }
            None => {
                let _ = reject_for_callback.call1(
                    &JsValue::NULL,
                    &JsValue::from_str("Browser returned no PNG Blob"),
                );
            }
        });

        if let Err(error) = canvas.to_blob_with_type(callback.as_ref().unchecked_ref(), "image/png")
        {
            let _ = reject.call1(&JsValue::NULL, &error);
        } else {
            callback.forget();
        }
    });

    let blob = JsFuture::from(promise).await.map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Browser PNG encoding failed",
            error,
        )
    })?;
    blob.dyn_into::<Blob>().map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Browser PNG encoder did not return a Blob",
            error,
        )
    })
}
