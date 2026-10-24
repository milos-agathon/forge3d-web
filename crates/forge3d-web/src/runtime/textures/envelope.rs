//! Extraction adapters supply values; this module alone owns envelope acceptance.
use super::*;

pub(super) trait Value: Sized {
    fn absent(&self) -> bool;
    fn object(&self) -> bool;
    fn get(&self, key: &str) -> Result<Self, WebError>;
    fn array(&self) -> Option<Vec<Self>>;
    fn number(&self) -> Option<f64>;
    fn text(&self) -> Option<String>;
    fn bytes(&self) -> Option<Vec<u8>> {
        None
    }
}
impl Value for serde_json::Value {
    fn absent(&self) -> bool {
        self.is_null()
    }
    fn object(&self) -> bool {
        self.is_object() || self.is_array()
    }
    fn get(&self, key: &str) -> Result<Self, WebError> {
        Ok(self.get(key).cloned().unwrap_or(Self::Null))
    }
    fn array(&self) -> Option<Vec<Self>> {
        self.as_array().cloned()
    }
    fn number(&self) -> Option<f64> {
        self.as_f64()
    }
    fn text(&self) -> Option<String> {
        self.as_str().map(str::to_owned)
    }
}
#[cfg(target_arch = "wasm32")]
impl Value for JsValue {
    fn absent(&self) -> bool {
        self.is_null() || self.is_undefined()
    }
    fn object(&self) -> bool {
        self.is_object() && !self.is_null()
    }
    fn get(&self, key: &str) -> Result<Self, WebError> {
        js_get(self, key)
    }
    fn array(&self) -> Option<Vec<Self>> {
        js_sys::Array::is_array(self).then(|| js_sys::Array::from(self).iter().collect())
    }
    fn number(&self) -> Option<f64> {
        self.as_f64()
    }
    fn text(&self) -> Option<String> {
        self.as_string()
    }
    fn bytes(&self) -> Option<Vec<u8>> {
        self.dyn_ref::<js_sys::Uint8Array>().map(|a| a.to_vec())
    }
}
fn object(value: &impl Value, field: &str) -> Result<(), WebError> {
    if value.object() {
        Ok(())
    } else {
        Err(invalid(format!("{field} must be an object")))
    }
}
fn integer(value: &impl Value, max: f64, field: &str) -> Result<u64, WebError> {
    value
        .number()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= max)
        .map(|n| n as u64)
        .ok_or_else(|| invalid(format!("{field} must be a nonnegative integer")))
}
fn text(value: &impl Value, field: &str) -> Result<String, WebError> {
    value
        .text()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid(format!("{field} must be a nonempty string")))
}
fn bytes(value: &impl Value, field: &str) -> Result<Vec<u8>, WebError> {
    if let Some(bytes) = value.bytes() {
        return Ok(bytes);
    }
    value
        .array()
        .ok_or_else(|| invalid(format!("{field} must be a byte array")))?
        .iter()
        .map(|v| integer(v, 255.0, field).map(|n| n as u8))
        .collect()
}
pub(super) fn decode<V: Value>(value: V) -> Result<ParsedTextureSet, WebError> {
    object(&value, "material.textures")?;
    let mut images: [Option<ParsedTextureImage>; 5] = Default::default();
    for (index, (name, _)) in SEMANTIC_FIELDS.iter().enumerate() {
        let image = value.get(name)?;
        if image.absent() {
            continue;
        }
        let field = format!("material.textures.{name}");
        object(&image, &field)?;
        let width = integer(
            &image.get("width")?,
            u32::MAX as f64,
            &format!("{field}.width"),
        )? as u32;
        let height = integer(
            &image.get("height")?,
            u32::MAX as f64,
            &format!("{field}.height"),
        )? as u32;
        let format = text(&image.get("format")?, &format!("{field}.format"))?;
        let color_space = text(&image.get("colorSpace")?, &format!("{field}.colorSpace"))?;
        let levels = image
            .get("levels")?
            .array()
            .ok_or_else(|| invalid(format!("{field}.levels must be an array")))?;
        if levels.is_empty() {
            return Err(invalid(format!(
                "{field}.levels must contain the base level"
            )));
        }
        let mut inputs = Vec::with_capacity(levels.len());
        for (i, level) in levels.into_iter().enumerate() {
            let field = format!("{field}.levels[{i}]");
            object(&level, &field)?;
            inputs.push((
                integer(
                    &level.get("width")?,
                    u32::MAX as f64,
                    &format!("{field}.width"),
                )? as u32,
                integer(
                    &level.get("height")?,
                    u32::MAX as f64,
                    &format!("{field}.height"),
                )? as u32,
                bytes(&level.get("data")?, &format!("{field}.data"))?,
            ));
        }
        let (base_width, base_height, base) = inputs.remove(0);
        if (base_width, base_height) != (width, height) {
            return Err(invalid(format!(
                "{field}.levels[0] must match the image dimensions"
            )));
        }
        images[index] = Some(validate_image(
            index,
            RawImage {
                width,
                height,
                format,
                color_space,
                base,
                mipmaps: inputs,
            },
            &field,
        )?);
    }
    let value = value.get("sampler")?;
    let sampler = if value.absent() {
        ParsedSampler::default()
    } else {
        let field = "material.textures.sampler";
        object(&value, field)?;
        let optional = |name: &str| -> Result<Option<String>, WebError> {
            let entry = value.get(name)?;
            if entry.absent() {
                Ok(None)
            } else {
                text(&entry, &format!("{field}.{name}")).map(Some)
            }
        };
        let anisotropy = value.get("maxAnisotropy")?;
        validate_sampler(
            RawSampler {
                wrap_u: optional("wrapU")?,
                wrap_v: optional("wrapV")?,
                mag_filter: optional("magFilter")?,
                min_filter: optional("minFilter")?,
                mipmap_filter: optional("mipmapFilter")?,
                max_anisotropy: if anisotropy.absent() {
                    None
                } else {
                    Some(integer(
                        &anisotropy,
                        u32::MAX as f64,
                        &format!("{field}.maxAnisotropy"),
                    )?)
                },
            },
            field,
        )?
    };
    Ok(ParsedTextureSet { images, sampler })
}
