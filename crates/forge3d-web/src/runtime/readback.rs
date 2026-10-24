use wasm_bindgen::{closure::Closure, prelude::*, Clamped, JsCast};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Blob, CanvasRenderingContext2d, HtmlCanvasElement, ImageData};

use super::Forge3DRuntime;
use crate::error::{Forge3DErrorCode, WebError};

#[cfg(test)]
pub(super) use super::texture_readback::normalize_readback_to_rgba;
pub(super) use super::texture_readback::{
    map_readback_buffer, read_map_frame_runtime, read_rgba_runtime,
};

pub(super) async fn screenshot_runtime(runtime: &mut Forge3DRuntime) -> Result<Blob, WebError> {
    let rgba = read_rgba_runtime(runtime).await?;
    png_blob_from_rgba(runtime.width, runtime.height, rgba).await
}

async fn png_blob_from_rgba(width: u32, height: u32, mut rgba: Vec<u8>) -> Result<Blob, WebError> {
    match offscreen_png_blob(width, height, &mut rgba).await {
        Ok(blob) => Ok(blob),
        Err(offscreen_error) => {
            if web_sys::window()
                .and_then(|window| window.document())
                .is_some()
            {
                html_canvas_png_blob(width, height, &mut rgba).await
            } else {
                Err(offscreen_error)
            }
        }
    }
}

async fn offscreen_png_blob(width: u32, height: u32, rgba: &mut Vec<u8>) -> Result<Blob, WebError> {
    let canvas = web_sys::OffscreenCanvas::new(width, height).map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Failed to create offscreen PNG encoding canvas",
            error,
        )
    })?;
    let context = canvas
        .get_context("2d")
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Failed to request offscreen 2D canvas context",
                error,
            )
        })?
        .ok_or_else(|| {
            WebError::new(
                Forge3DErrorCode::IoError,
                "Offscreen 2D canvas context is unavailable",
            )
        })?
        .dyn_into::<web_sys::OffscreenCanvasRenderingContext2d>()
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Offscreen context is not OffscreenCanvasRenderingContext2D",
                error.into(),
            )
        })?;
    let image_data = ImageData::new_with_u8_clamped_array_and_sh(Clamped(rgba), width, height)
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
                "Failed to write screenshot pixels to offscreen canvas",
                error,
            )
        })?;
    let options = web_sys::ImageEncodeOptions::new();
    options.set_type("image/png");
    let promise = canvas
        .convert_to_blob_with_options(&options)
        .map_err(|error| {
            WebError::with_details(
                Forge3DErrorCode::IoError,
                "Failed to start offscreen PNG encoding",
                error,
            )
        })?;
    let blob = JsFuture::from(promise).await.map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Offscreen PNG encoding failed",
            error,
        )
    })?;
    blob.dyn_into::<Blob>().map_err(|error| {
        WebError::with_details(
            Forge3DErrorCode::IoError,
            "Offscreen PNG encoder did not return a Blob",
            error,
        )
    })
}

async fn html_canvas_png_blob(
    width: u32,
    height: u32,
    rgba: &mut Vec<u8>,
) -> Result<Blob, WebError> {
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
    let image_data = ImageData::new_with_u8_clamped_array_and_sh(Clamped(rgba), width, height)
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
