//! Stateless W06 helpers exported to the TypeScript facade: EXR encode and
//! decode, the CPU tonemap and A-trous references and image metrics. They run
//! in WASM without a GPU device.

use forge3d_core::codecs::exr::{
    channel_names, decode_exr, encode_exr, ExrChannel, ExrCompression, ExrSamples,
};
use forge3d_core::offline::denoise::{atrous_denoise, AtrousGuides, AtrousParams};
use forge3d_core::offline::image_metrics::compare_images;
use forge3d_core::offline::tonemap::{
    quantize_unorm8, tonemap_rgb, DisplayEncode, TonemapOperator,
};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::error::{map_core_error, to_js_error, Forge3DErrorCode, WebError};

fn prop(value: &JsValue, name: &str) -> JsValue {
    js_sys::Reflect::get(value, &JsValue::from_str(name)).unwrap_or(JsValue::UNDEFINED)
}

fn set(target: &JsValue, name: &str, value: &JsValue) {
    let _ = js_sys::Reflect::set(target, &JsValue::from_str(name), value);
}

fn invalid(field: &str, message: impl Into<String>) -> WebError {
    WebError::new(
        Forge3DErrorCode::InvalidInput,
        format!("{field}: {}", message.into()),
    )
}

fn dimension(value: &JsValue, name: &str) -> Result<u32, WebError> {
    match prop(value, name).as_f64() {
        Some(n) if n.fract() == 0.0 && (1.0..=65_536.0).contains(&n) => Ok(n as u32),
        _ => Err(invalid(name, "must be an integer in [1, 65536]")),
    }
}

fn optional_f32(value: &JsValue, name: &str, default: f32) -> Result<f32, WebError> {
    let raw = prop(value, name);
    if raw.is_undefined() || raw.is_null() {
        return Ok(default);
    }
    match raw.as_f64() {
        Some(n) if n.is_finite() => Ok(n as f32),
        _ => Err(invalid(name, "must be a finite number")),
    }
}

fn float_array(value: &JsValue, name: &str) -> Result<Option<Vec<f32>>, WebError> {
    let raw = prop(value, name);
    if raw.is_undefined() || raw.is_null() {
        return Ok(None);
    }
    let array: js_sys::Float32Array = raw
        .dyn_into()
        .map_err(|_| invalid(name, "must be a Float32Array"))?;
    Ok(Some(array.to_vec()))
}

/// Native EXR channel names for `prefix` and `channelCount`.
#[wasm_bindgen(js_name = exrChannelNames)]
pub fn exr_channel_names(prefix: &str, channel_count: u32) -> Result<js_sys::Array, JsValue> {
    let names = channel_names(prefix, channel_count as usize)
        .map_err(|error| to_js_error(map_core_error(error)))?;
    Ok(names
        .into_iter()
        .map(|(name, _)| JsValue::from_str(&name))
        .collect())
}

/// Encodes `{ width, height, channels, metadata?, compression? }` to EXR bytes.
#[wasm_bindgen(js_name = encodeExr)]
pub fn encode_exr_js(input: JsValue) -> Result<js_sys::Uint8Array, JsValue> {
    encode_exr_inner(&input).map_err(to_js_error)
}

fn encode_exr_inner(input: &JsValue) -> Result<js_sys::Uint8Array, WebError> {
    let width = dimension(input, "width")?;
    let height = dimension(input, "height")?;
    let list: js_sys::Array = prop(input, "channels")
        .dyn_into()
        .map_err(|_| invalid("channels", "must be an array"))?;
    let mut channels = Vec::with_capacity(list.length() as usize);
    for entry in list.iter() {
        let name = prop(&entry, "name")
            .as_string()
            .ok_or_else(|| invalid("channels[].name", "must be a string"))?;
        let data = prop(&entry, "data");
        let samples = if let Some(array) = data.dyn_ref::<js_sys::Float32Array>() {
            ExrSamples::F32(array.to_vec())
        } else if let Some(array) = data.dyn_ref::<js_sys::Uint32Array>() {
            ExrSamples::U32(array.to_vec())
        } else {
            return Err(invalid(
                &format!("channels[{name}].data"),
                "must be a Float32Array or Uint32Array",
            ));
        };
        let quantize_linearly = prop(&entry, "quantizeLinearly").as_bool().unwrap_or(true);
        channels.push(ExrChannel {
            name,
            samples,
            quantize_linearly,
        });
    }
    let mut metadata = Vec::new();
    let meta = prop(input, "metadata");
    if !meta.is_undefined() && !meta.is_null() {
        let object: js_sys::Object = meta
            .dyn_into()
            .map_err(|_| invalid("metadata", "must be an object of strings"))?;
        for pair in js_sys::Object::entries(&object).iter() {
            let pair: js_sys::Array = pair.unchecked_into();
            let key = pair.get(0).as_string().unwrap_or_default();
            let value = pair
                .get(1)
                .as_string()
                .ok_or_else(|| invalid(&format!("metadata.{key}"), "must be a string"))?;
            metadata.push((key, value));
        }
        metadata.sort();
    }
    let compression = match prop(input, "compression").as_string() {
        Some(name) => ExrCompression::parse(&name).map_err(map_core_error)?,
        None => ExrCompression::Zip,
    };
    let bytes =
        encode_exr(width, height, channels, &metadata, compression).map_err(map_core_error)?;
    Ok(js_sys::Uint8Array::from(bytes.as_slice()))
}

/// Decodes EXR bytes into `{ width, height, channels, metadata, software,
/// compression }` after bounded header validation.
#[wasm_bindgen(js_name = decodeExr)]
pub fn decode_exr_js(
    bytes: js_sys::Uint8Array,
    max_dimension: u32,
    max_pixels: f64,
) -> Result<JsValue, JsValue> {
    let limit = if max_pixels.is_finite() && max_pixels > 0.0 {
        max_pixels as u64
    } else {
        return Err(to_js_error(invalid(
            "maxPixels",
            "must be finite and positive",
        )));
    };
    let image = decode_exr(&bytes.to_vec(), max_dimension, limit)
        .map_err(|error| to_js_error(map_core_error(error)))?;
    let output: JsValue = js_sys::Object::new().into();
    set(&output, "width", &JsValue::from_f64(f64::from(image.width)));
    set(
        &output,
        "height",
        &JsValue::from_f64(f64::from(image.height)),
    );
    set(
        &output,
        "compression",
        &JsValue::from_str(&image.compression),
    );
    set(
        &output,
        "software",
        &image
            .software
            .as_deref()
            .map_or(JsValue::NULL, JsValue::from_str),
    );
    let channels = js_sys::Array::new();
    for channel in &image.channels {
        let entry: JsValue = js_sys::Object::new().into();
        set(&entry, "name", &JsValue::from_str(&channel.name));
        set(
            &entry,
            "type",
            &JsValue::from_str(channel.samples.sample_type()),
        );
        let data: JsValue = match &channel.samples {
            ExrSamples::F32(values) => js_sys::Float32Array::from(values.as_slice()).into(),
            ExrSamples::U32(values) => js_sys::Uint32Array::from(values.as_slice()).into(),
            ExrSamples::F16Bits(values) => {
                let decoded: Vec<f32> = values
                    .iter()
                    .map(|bits| forge3d_core::readback::f16_to_f32(*bits))
                    .collect();
                js_sys::Float32Array::from(decoded.as_slice()).into()
            }
        };
        set(&entry, "data", &data);
        channels.push(&entry);
    }
    set(&output, "channels", channels.as_ref());
    let metadata: JsValue = js_sys::Object::new().into();
    for (key, value) in &image.metadata {
        set(&metadata, key, &JsValue::from_str(value));
    }
    set(&output, "metadata", &metadata);
    Ok(output)
}

/// CPU tonemap of RGBA HDR pixels; `displayEncode` selects the per-pixel
/// display encode (0 linear, 1 sRGB surface, 2 screen-mode filmic).
#[wasm_bindgen(js_name = tonemapHdr)]
pub fn tonemap_hdr_js(input: JsValue) -> Result<js_sys::Uint8Array, JsValue> {
    tonemap_inner(&input).map_err(to_js_error)
}

fn tonemap_inner(input: &JsValue) -> Result<js_sys::Uint8Array, WebError> {
    let width = dimension(input, "width")?;
    let height = dimension(input, "height")?;
    let pixels = width as usize * height as usize;
    let color = float_array(input, "color")?.ok_or_else(|| invalid("color", "is required"))?;
    if color.len() != pixels * 4 {
        return Err(invalid("color", format!("expected {} floats", pixels * 4)));
    }
    let operator = match prop(input, "operator").as_string() {
        Some(name) => TonemapOperator::parse(&name).map_err(map_core_error)?,
        None => TonemapOperator::Display,
    };
    let white_point = optional_f32(input, "whitePoint", 4.0)?;
    if white_point <= 0.0 {
        return Err(invalid("whitePoint", "must be > 0"));
    }
    let encode_raw = prop(input, "displayEncode");
    let encodes: Option<Vec<u8>> = if encode_raw.is_undefined() || encode_raw.is_null() {
        None
    } else {
        let array: js_sys::Uint8Array = encode_raw
            .dyn_into()
            .map_err(|_| invalid("displayEncode", "must be a Uint8Array"))?;
        if array.length() as usize != pixels {
            return Err(invalid(
                "displayEncode",
                format!("expected {pixels} entries"),
            ));
        }
        Some(array.to_vec())
    };
    let mut out = vec![0u8; pixels * 4];
    for index in 0..pixels {
        let encode = match encodes.as_ref().map_or(0, |values| values[index]) {
            1 => DisplayEncode::LinearSrgb,
            2 => DisplayEncode::ScreenFilmic,
            _ => DisplayEncode::Linear,
        };
        let rgb = [color[index * 4], color[index * 4 + 1], color[index * 4 + 2]];
        let mapped = tonemap_rgb(rgb, operator, white_point, encode);
        out[index * 4] = quantize_unorm8(mapped[0]);
        out[index * 4 + 1] = quantize_unorm8(mapped[1]);
        out[index * 4 + 2] = quantize_unorm8(mapped[2]);
        out[index * 4 + 3] = quantize_unorm8(color[index * 4 + 3]);
    }
    Ok(js_sys::Uint8Array::from(out.as_slice()))
}

/// CPU A-trous reference (`forge3d.denoise.atrous_denoise`). Color may be RGB
/// or RGBA; RGBA alpha passes through unchanged.
#[wasm_bindgen(js_name = atrousDenoise)]
pub fn atrous_denoise_js(input: JsValue) -> Result<js_sys::Float32Array, JsValue> {
    atrous_inner(&input).map_err(to_js_error)
}

fn to_rgb(values: &[f32], pixels: usize, name: &str) -> Result<Vec<f32>, WebError> {
    if values.len() == pixels * 3 {
        Ok(values.to_vec())
    } else if values.len() == pixels * 4 {
        Ok(values
            .chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect())
    } else {
        Err(invalid(
            name,
            format!("expected {} or {} floats", pixels * 3, pixels * 4),
        ))
    }
}

fn atrous_inner(input: &JsValue) -> Result<js_sys::Float32Array, WebError> {
    let width = dimension(input, "width")?;
    let height = dimension(input, "height")?;
    let pixels = width as usize * height as usize;
    let color = float_array(input, "color")?.ok_or_else(|| invalid("color", "is required"))?;
    let rgba = color.len() == pixels * 4;
    let rgb = to_rgb(&color, pixels, "color")?;
    let albedo = float_array(input, "albedo")?
        .map(|v| to_rgb(&v, pixels, "albedo"))
        .transpose()?;
    let normal = float_array(input, "normal")?
        .map(|v| to_rgb(&v, pixels, "normal"))
        .transpose()?;
    let depth = float_array(input, "depth")?;
    let defaults = AtrousParams::default();
    let iterations = match prop(input, "iterations").as_f64() {
        None => defaults.iterations,
        Some(n) if n.fract() == 0.0 && (1.0..=10.0).contains(&n) => n as u32,
        Some(_) => return Err(invalid("iterations", "must be an integer in [1, 10]")),
    };
    let params = AtrousParams {
        iterations,
        sigma_color: optional_f32(input, "sigmaColor", defaults.sigma_color)?,
        sigma_albedo: optional_f32(input, "sigmaAlbedo", defaults.sigma_albedo)?,
        sigma_normal: optional_f32(input, "sigmaNormal", defaults.sigma_normal)?,
        sigma_depth: optional_f32(input, "sigmaDepth", defaults.sigma_depth)?,
        edge_stopping: optional_f32(input, "edgeStopping", defaults.edge_stopping)?,
        noise_sigma: match prop(input, "noiseSigma").as_f64() {
            Some(n) => Some(n as f32),
            None => None,
        },
    };
    let result = atrous_denoise(
        &rgb,
        width,
        height,
        AtrousGuides {
            albedo: albedo.as_deref(),
            normal: normal.as_deref(),
            depth: depth.as_deref(),
        },
        params,
    )
    .map_err(map_core_error)?;
    if !rgba {
        return Ok(js_sys::Float32Array::from(result.as_slice()));
    }
    let mut out = Vec::with_capacity(pixels * 4);
    for (index, pixel) in result.chunks_exact(3).enumerate() {
        out.extend_from_slice(pixel);
        out.push(color[index * 4 + 3]);
    }
    Ok(js_sys::Float32Array::from(out.as_slice()))
}

/// MSE, PSNR, Gaussian SSIM and max absolute error between two images.
#[wasm_bindgen(js_name = compareImages)]
pub fn compare_images_js(
    a: js_sys::Float32Array,
    b: js_sys::Float32Array,
    options: JsValue,
) -> Result<JsValue, JsValue> {
    let run = || -> Result<JsValue, WebError> {
        let width = dimension(&options, "width")?;
        let height = dimension(&options, "height")?;
        let channels = dimension(&options, "channels")?;
        let compare = match prop(&options, "compareChannels").as_f64() {
            None => channels,
            Some(n) => n as u32,
        };
        let range = f64::from(optional_f32(&options, "dataRange", 1.0)?);
        let metrics = compare_images(
            &a.to_vec(),
            &b.to_vec(),
            width,
            height,
            channels,
            compare,
            range,
        )
        .map_err(map_core_error)?;
        let output: JsValue = js_sys::Object::new().into();
        set(&output, "mse", &JsValue::from_f64(metrics.mse));
        set(&output, "psnr", &JsValue::from_f64(metrics.psnr));
        set(&output, "ssim", &JsValue::from_f64(metrics.ssim));
        set(&output, "maxAbs", &JsValue::from_f64(metrics.max_abs));
        Ok(output)
    };
    run().map_err(to_js_error)
}
