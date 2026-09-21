use wasm_bindgen::JsValue;

use super::{invalid, ParsedTransform};
use crate::error::WebError;

pub(super) fn get_property(value: &JsValue, name: &str) -> Result<JsValue, WebError> {
    js_sys::Reflect::get(value, &JsValue::from_str(name))
        .map_err(|_| invalid(format!("scene snapshot {name} could not be read")))
}

pub(super) fn required_string(value: &JsValue, field: &str) -> Result<String, WebError> {
    value
        .as_string()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid(format!("scene {field} must be a nonempty string")))
}

pub(super) fn optional_string_array(value: &JsValue, field: &str) -> Result<Vec<String>, WebError> {
    if value.is_undefined() || value.is_null() {
        return Ok(Vec::new());
    }
    if !js_sys::Array::is_array(value) {
        return Err(invalid(format!(
            "scene {field} must be an array of strings"
        )));
    }
    js_sys::Array::from(value)
        .iter()
        .map(|entry| {
            entry
                .as_string()
                .ok_or_else(|| invalid(format!("scene {field} entries must be strings")))
        })
        .collect()
}

pub(super) fn finite_number(value: &JsValue, field: &str) -> Result<f32, WebError> {
    value
        .as_f64()
        .filter(|number| number.is_finite())
        .map(|number| number as f32)
        .ok_or_else(|| invalid(format!("scene {field} must be a finite number")))
}

pub(super) fn number_tuple<const N: usize>(
    value: &JsValue,
    field: &str,
) -> Result<[f32; N], WebError> {
    if !js_sys::Array::is_array(value) {
        return Err(invalid(format!(
            "scene {field} must be a {N}-element array"
        )));
    }
    let array = js_sys::Array::from(value);
    if array.length() as usize != N {
        return Err(invalid(format!("scene {field} must contain {N} numbers")));
    }
    let mut out = [0.0f32; N];
    for (index, entry) in array.iter().enumerate() {
        out[index] = finite_number(&entry, field)?;
    }
    Ok(out)
}

pub(super) fn optional_number(value: &JsValue, field: &str, default: f32) -> Result<f32, WebError> {
    if value.is_undefined() || value.is_null() {
        return Ok(default);
    }
    finite_number(value, field)
}

pub(super) fn parse_transform(value: &JsValue) -> Result<ParsedTransform, WebError> {
    let mut transform = ParsedTransform::default();
    if value.is_undefined() || value.is_null() {
        return Ok(transform);
    }
    let translation = get_property(value, "translation")?;
    if !translation.is_undefined() {
        transform.translation = number_tuple(&translation, "transform.translation")?;
    }
    let rotation = get_property(value, "rotation")?;
    if !rotation.is_undefined() {
        transform.rotation = number_tuple(&rotation, "transform.rotation")?;
    }
    let scale = get_property(value, "scale")?;
    if !scale.is_undefined() {
        transform.scale = number_tuple(&scale, "transform.scale")?;
    }
    Ok(transform)
}
