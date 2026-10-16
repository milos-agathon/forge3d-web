//! OpenEXR encode/decode for HDR frames and AOVs (`exr` 1.74.2, rayon off).
//!
//! Channel naming ports the native `util::exr_write::channel_specs`: RGBA
//! prefixes become `prefix.R/G/B/A`, `normal` becomes `normal.X/Y/Z`, `depth`
//! becomes `depth.Z`, and any other scalar keeps the bare prefix (`id`,
//! `mask`, `ao`, ...). Decoding validates the header with a bounded parser
//! before the `exr` crate allocates, so malformed or oversized files fail
//! with typed errors instead of large allocations.

use std::io::Cursor;

use exr::prelude::{
    AnyChannel, AnyChannels, AttributeValue, Encoding, FlatSamples, Image, ImageAttributes,
    IntegerBounds, Layer, LayerAttributes, ReadChannels, ReadLayers, SmallVec, Text, Vec2,
    WritableImage,
};

use crate::error::{Forge3dError, Result};

const EXR_MAGIC: u32 = 20_000_630;
/// Upper bound on header attributes accepted by the pre-parser.
const MAX_HEADER_ATTRIBUTES: usize = 1024;
/// Upper bound on channels in one file.
pub const MAX_CHANNELS: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub enum ExrSamples {
    F32(Vec<f32>),
    U32(Vec<u32>),
    F16Bits(Vec<u16>),
}

impl ExrSamples {
    pub fn len(&self) -> usize {
        match self {
            Self::F32(v) => v.len(),
            Self::U32(v) => v.len(),
            Self::F16Bits(v) => v.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn sample_type(&self) -> &'static str {
        match self {
            Self::F32(_) => "f32",
            Self::U32(_) => "u32",
            Self::F16Bits(_) => "f16",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExrChannel {
    pub name: String,
    pub samples: ExrSamples,
    pub quantize_linearly: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExrCompression {
    None,
    Rle,
    Zip,
    Zips,
    Piz,
}

impl ExrCompression {
    pub fn parse(name: &str) -> Result<Self> {
        Ok(match name {
            "none" => Self::None,
            "rle" => Self::Rle,
            "zip" => Self::Zip,
            "zips" => Self::Zips,
            "piz" => Self::Piz,
            other => {
                return Err(invalid(
                    "compression",
                    &format!(
                        "unknown EXR compression {other:?}; expected none, rle, zip, zips or piz"
                    ),
                ))
            }
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Rle => "rle",
            Self::Zip => "zip",
            Self::Zips => "zips",
            Self::Piz => "piz",
        }
    }

    fn to_exr(self) -> exr::compression::Compression {
        use exr::compression::Compression;
        match self {
            Self::None => Compression::Uncompressed,
            Self::Rle => Compression::RLE,
            Self::Zip => Compression::ZIP16,
            Self::Zips => Compression::ZIP1,
            Self::Piz => Compression::PIZ,
        }
    }

    fn from_exr(value: exr::compression::Compression) -> &'static str {
        use exr::compression::Compression;
        match value {
            Compression::Uncompressed => "none",
            Compression::RLE => "rle",
            Compression::ZIP16 => "zip",
            Compression::ZIP1 => "zips",
            Compression::PIZ => "piz",
            Compression::PXR24 => "pxr24",
            Compression::B44 => "b44",
            Compression::B44A => "b44a",
            Compression::DWAA(_) => "dwaa",
            Compression::DWAB(_) => "dwab",
            _ => "other",
        }
    }
}

/// Decoded EXR image (first layer, largest resolution level).
#[derive(Debug, Clone, PartialEq)]
pub struct ExrImage {
    pub width: u32,
    pub height: u32,
    pub channels: Vec<ExrChannel>,
    pub metadata: Vec<(String, String)>,
    pub software: Option<String>,
    pub compression: String,
}

impl ExrImage {
    pub fn channel(&self, name: &str) -> Option<&ExrChannel> {
        self.channels.iter().find(|channel| channel.name == name)
    }
}

/// Header facts read without decoding pixel data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExrHeaderInfo {
    pub width: u32,
    pub height: u32,
    pub channels: Vec<(String, u32)>,
    pub compression: u8,
    pub multipart: bool,
    pub tiled: bool,
    pub deep: bool,
}

/// Native channel naming for a prefix and a channel count.
pub fn channel_names(prefix: &str, channel_count: usize) -> Result<Vec<(String, bool)>> {
    let prefix = prefix.trim();
    if prefix.is_empty() {
        return Err(invalid("prefix", "EXR channel prefix must be non-empty"));
    }
    if !prefix.is_ascii() || prefix.contains('\0') {
        return Err(invalid(
            "prefix",
            "EXR channel prefix must be printable ASCII",
        ));
    }
    Ok(match channel_count {
        1 => {
            let name = if prefix.eq_ignore_ascii_case("depth") {
                format!("{prefix}.Z")
            } else {
                prefix.to_string()
            };
            vec![(name, true)]
        }
        2 => ["X", "Y"]
            .iter()
            .map(|suffix| (format!("{prefix}.{suffix}"), true))
            .collect(),
        3 => {
            let (suffixes, linear) = if prefix.eq_ignore_ascii_case("normal") {
                (["X", "Y", "Z"], true)
            } else {
                (["R", "G", "B"], false)
            };
            suffixes
                .iter()
                .map(|suffix| (format!("{prefix}.{suffix}"), linear))
                .collect()
        }
        4 => ["R", "G", "B", "A"]
            .iter()
            .map(|suffix| (format!("{prefix}.{suffix}"), *suffix == "A"))
            .collect(),
        other => {
            return Err(invalid(
                "channels",
                &format!("unsupported EXR channel count: {other}"),
            ))
        }
    })
}

/// Splits interleaved float pixels into native-named channels.
pub fn planar_channels(
    prefix: &str,
    interleaved: &[f32],
    pixel_count: usize,
    channel_count: usize,
) -> Result<Vec<ExrChannel>> {
    let names = channel_names(prefix, channel_count)?;
    if interleaved.len() != pixel_count * channel_count {
        return Err(invalid(
            prefix,
            &format!(
                "expected {} floats for {channel_count} channels, got {}",
                pixel_count * channel_count,
                interleaved.len()
            ),
        ));
    }
    Ok(names
        .into_iter()
        .enumerate()
        .map(|(lane, (name, quantize_linearly))| ExrChannel {
            name,
            samples: ExrSamples::F32(
                interleaved
                    .iter()
                    .skip(lane)
                    .step_by(channel_count)
                    .copied()
                    .collect(),
            ),
            quantize_linearly,
        })
        .collect())
}

/// Encodes one single-part scanline EXR with increasing line order.
pub fn encode_exr(
    width: u32,
    height: u32,
    channels: Vec<ExrChannel>,
    metadata: &[(String, String)],
    compression: ExrCompression,
) -> Result<Vec<u8>> {
    if width == 0 || height == 0 {
        return Err(invalid("size", "EXR dimensions must be positive"));
    }
    if channels.is_empty() {
        return Err(invalid("channels", "EXR requires at least one channel"));
    }
    if channels.len() > MAX_CHANNELS {
        return Err(invalid("channels", "too many EXR channels"));
    }
    let pixels = width as usize * height as usize;
    let mut names = std::collections::BTreeSet::new();
    let mut list = SmallVec::<[AnyChannel<FlatSamples>; 4]>::new();
    for channel in channels {
        if channel.samples.len() != pixels {
            return Err(invalid(
                &channel.name,
                &format!("expected {pixels} samples, got {}", channel.samples.len()),
            ));
        }
        if !names.insert(channel.name.clone()) {
            return Err(invalid(&channel.name, "duplicate EXR channel name"));
        }
        let name = Text::new_or_none(&channel.name)
            .ok_or_else(|| invalid(&channel.name, "invalid EXR channel name"))?;
        let sample_data = match channel.samples {
            ExrSamples::F32(values) => FlatSamples::F32(values),
            ExrSamples::U32(values) => FlatSamples::U32(values),
            ExrSamples::F16Bits(values) => FlatSamples::F16(
                values
                    .into_iter()
                    .map(exr::prelude::f16::from_bits)
                    .collect(),
            ),
        };
        list.push(AnyChannel {
            name,
            sample_data,
            quantize_linearly: channel.quantize_linearly,
            sampling: Vec2(1, 1),
        });
    }
    let encoding = Encoding {
        compression: compression.to_exr(),
        blocks: exr::image::Blocks::ScanLines,
        line_order: exr::meta::attribute::LineOrder::Increasing,
    };
    let mut layer_attributes = LayerAttributes::default();
    layer_attributes.software_name = Text::new_or_none(SOFTWARE);
    for (key, value) in metadata {
        let key_text = Text::new_or_none(key)
            .ok_or_else(|| invalid("metadata", &format!("invalid attribute name {key:?}")))?;
        let value_text = Text::new_or_none(value)
            .ok_or_else(|| invalid("metadata", &format!("invalid value for {key:?}")))?;
        if RESERVED_ATTRIBUTES.contains(&key.as_str()) {
            return Err(invalid(
                "metadata",
                &format!("{key:?} is a reserved EXR attribute"),
            ));
        }
        layer_attributes
            .other
            .insert(key_text, AttributeValue::Text(value_text));
    }
    let size = Vec2(width as usize, height as usize);
    let layer = Layer::new(size, layer_attributes, encoding, AnyChannels::sort(list));
    let image = Image::new(
        ImageAttributes::new(IntegerBounds::from_dimensions(size)),
        layer,
    );
    let mut cursor = Cursor::new(Vec::new());
    image
        .write()
        .non_parallel()
        .to_buffered(&mut cursor)
        .map_err(|error| Forge3dError::Io {
            message: format!("EXR encoding failed: {error}"),
        })?;
    Ok(cursor.into_inner())
}

/// Value of the standard `software` attribute on every encoded file.
pub const SOFTWARE: &str = "forge3d-web";

/// Standard OpenEXR attribute names; custom metadata must not shadow them.
const RESERVED_ATTRIBUTES: &[&str] = &[
    "adoptedNeutral",
    "altitude",
    "aperture",
    "capDate",
    "chromaticities",
    "comments",
    "deepImageState",
    "dwaCompressionLevel",
    "envmap",
    "expTime",
    "farClip",
    "focus",
    "framesPerSecond",
    "isoSpeed",
    "keyCode",
    "latitude",
    "longitude",
    "lookModTransform",
    "multiView",
    "nearClip",
    "originalDataWindow",
    "owner",
    "preview",
    "renderingTransform",
    "software",
    "timeCode",
    "utcOffset",
    "view",
    "whiteLuminance",
    "worldToCamera",
    "worldToNDC",
    "wrapmodes",
    "xDensity",
    "channels",
    "compression",
    "dataWindow",
    "displayWindow",
    "lineOrder",
    "pixelAspectRatio",
    "screenWindowCenter",
    "screenWindowWidth",
    "tiles",
    "type",
    "name",
    "chunkCount",
    "version",
];

/// Reads the first header without touching pixel data.
pub fn inspect_exr(bytes: &[u8]) -> Result<ExrHeaderInfo> {
    let mut reader = HeaderReader { bytes, offset: 0 };
    let magic = reader.u32()?;
    if magic != EXR_MAGIC {
        return Err(corrupt("invalid EXR magic number"));
    }
    let version = reader.u32()?;
    if version & 0xff != 2 {
        return Err(corrupt("unsupported EXR version"));
    }
    let tiled = version & 0x200 != 0;
    let deep = version & 0x800 != 0;
    let multipart = version & 0x1000 != 0;
    let mut channels = None;
    let mut window = None;
    let mut compression = None;
    let mut count = 0usize;
    loop {
        let name = reader.cstring()?;
        if name.is_empty() {
            break;
        }
        count += 1;
        if count > MAX_HEADER_ATTRIBUTES {
            return Err(corrupt("EXR header has too many attributes"));
        }
        let _kind = reader.cstring()?;
        let size = reader.u32()? as usize;
        let payload = reader.take(size)?;
        match name.as_str() {
            "channels" => channels = Some(parse_channel_list(payload)?),
            "dataWindow" => {
                if payload.len() < 16 {
                    return Err(corrupt("truncated EXR dataWindow"));
                }
                let read = |i: usize| i32::from_le_bytes(payload[i..i + 4].try_into().unwrap());
                let (min_x, min_y, max_x, max_y) = (read(0), read(4), read(8), read(12));
                let width = i64::from(max_x) - i64::from(min_x) + 1;
                let height = i64::from(max_y) - i64::from(min_y) + 1;
                if width <= 0
                    || height <= 0
                    || width > i64::from(u32::MAX)
                    || height > i64::from(u32::MAX)
                {
                    return Err(corrupt("EXR dataWindow is empty or inverted"));
                }
                window = Some((width as u32, height as u32));
            }
            "compression" => {
                compression = Some(
                    *payload
                        .first()
                        .ok_or_else(|| corrupt("empty compression attribute"))?,
                )
            }
            _ => {}
        }
        if multipart {
            // Only the first part's header is inspected.
            continue;
        }
    }
    let channels = channels.ok_or_else(|| corrupt("EXR header lacks channels"))?;
    let (width, height) = window.ok_or_else(|| corrupt("EXR header lacks dataWindow"))?;
    Ok(ExrHeaderInfo {
        width,
        height,
        channels,
        compression: compression.ok_or_else(|| corrupt("EXR header lacks compression"))?,
        multipart,
        tiled,
        deep,
    })
}

/// Decodes a flat single-part EXR after bounded header validation.
pub fn decode_exr(bytes: &[u8], max_dimension: u32, max_pixels: u64) -> Result<ExrImage> {
    let header = inspect_exr(bytes)?;
    if header.deep {
        return Err(Forge3dError::UnsupportedFeature {
            feature: "deep EXR data".to_string(),
        });
    }
    if header.multipart {
        return Err(Forge3dError::UnsupportedFeature {
            feature: "multi-part EXR files".to_string(),
        });
    }
    if header.width > max_dimension || header.height > max_dimension {
        return Err(Forge3dError::ResourceLimitExceeded {
            resource: "exr".to_string(),
            message: format!(
                "EXR dimensions {}x{} exceed max dimension {max_dimension}",
                header.width, header.height
            ),
        });
    }
    let pixels = u64::from(header.width) * u64::from(header.height);
    if pixels > max_pixels {
        return Err(Forge3dError::ResourceLimitExceeded {
            resource: "exr".to_string(),
            message: format!("EXR pixel count {pixels} exceeds the {max_pixels} pixel limit"),
        });
    }
    if header.channels.len() > MAX_CHANNELS {
        return Err(Forge3dError::ResourceLimitExceeded {
            resource: "exr".to_string(),
            message: format!(
                "EXR has {} channels (limit {MAX_CHANNELS})",
                header.channels.len()
            ),
        });
    }
    let image = exr::prelude::read()
        .no_deep_data()
        .largest_resolution_level()
        .all_channels()
        .first_valid_layer()
        .all_attributes()
        .non_parallel()
        .pedantic()
        .from_buffered(Cursor::new(bytes))
        .map_err(|error| corrupt(&format!("EXR decoding failed: {error}")))?;
    let layer = &image.layer_data;
    let width = layer.size.width() as u32;
    let height = layer.size.height() as u32;
    let channels = layer
        .channel_data
        .list
        .iter()
        .map(|channel| ExrChannel {
            name: channel.name.to_string(),
            samples: match &channel.sample_data {
                FlatSamples::F32(values) => ExrSamples::F32(values.clone()),
                FlatSamples::U32(values) => ExrSamples::U32(values.clone()),
                FlatSamples::F16(values) => {
                    ExrSamples::F16Bits(values.iter().map(|value| value.to_bits()).collect())
                }
            },
            quantize_linearly: channel.quantize_linearly,
        })
        .collect();
    let mut metadata: Vec<(String, String)> = layer
        .attributes
        .other
        .iter()
        .filter_map(|(key, value)| match value {
            AttributeValue::Text(text) => Some((key.to_string(), text.to_string())),
            _ => None,
        })
        .collect();
    metadata.sort();
    Ok(ExrImage {
        width,
        height,
        channels,
        metadata,
        software: layer
            .attributes
            .software_name
            .as_ref()
            .map(|text| text.to_string()),
        compression: ExrCompression::from_exr(layer.encoding.compression).to_string(),
    })
}

fn parse_channel_list(payload: &[u8]) -> Result<Vec<(String, u32)>> {
    let mut reader = HeaderReader {
        bytes: payload,
        offset: 0,
    };
    let mut channels = Vec::new();
    loop {
        let name = reader.cstring()?;
        if name.is_empty() {
            break;
        }
        if channels.len() >= MAX_CHANNELS {
            return Err(Forge3dError::ResourceLimitExceeded {
                resource: "exr".to_string(),
                message: format!("EXR declares more than {MAX_CHANNELS} channels"),
            });
        }
        let pixel_type = reader.u32()?;
        if pixel_type > 2 {
            return Err(corrupt("unknown EXR channel pixel type"));
        }
        reader.take(12)?;
        channels.push((name, pixel_type));
    }
    Ok(channels)
}

struct HeaderReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> HeaderReader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| corrupt("truncated EXR header"))?;
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn cstring(&mut self) -> Result<String> {
        let rest = &self.bytes[self.offset.min(self.bytes.len())..];
        let len = rest
            .iter()
            .take(256)
            .position(|byte| *byte == 0)
            .ok_or_else(|| corrupt("unterminated or oversized EXR string"))?;
        let text = std::str::from_utf8(&rest[..len])
            .map_err(|_| corrupt("EXR string is not ASCII"))?
            .to_string();
        self.offset += len + 1;
        Ok(text)
    }
}

fn invalid(field: &str, message: &str) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.to_string(),
    }
}

fn corrupt(message: &str) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: "exr".to_string(),
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests;
