use crate::error::{Forge3dError, Result};

const MAGIC_RADIANCE: &[u8] = b"#?RADIANCE";
const MAGIC_RGBE: &[u8] = b"#?RGBE";
const FORMAT_TOKEN: &[u8] = b"FORMAT=32-bit_rle_rgbe";
const FLAT_MAX_WIDTH: u32 = 8;
const RLE_MAX_WIDTH: u32 = 32767;
const CHANNELS: usize = 4;

#[derive(Debug, Clone, PartialEq)]
pub struct RgbeImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<f32>,
}

pub fn decode_rgbe(bytes: &[u8], max_dimension: u32, max_pixels: u64) -> Result<RgbeImage> {
    let mut cursor = Cursor::new(bytes);
    let magic = cursor
        .line()
        .ok_or_else(|| invalid("missing RGBE magic line"))?;
    if trim_ascii(magic) != MAGIC_RADIANCE && trim_ascii(magic) != MAGIC_RGBE {
        return Err(invalid("not a Radiance RGBE stream"));
    }

    let mut format_ok = false;
    loop {
        let line = cursor
            .line()
            .ok_or_else(|| invalid("RGBE header is not terminated"))?;
        let trimmed = trim_ascii(line);
        if trimmed.is_empty() {
            break;
        }
        if trimmed == FORMAT_TOKEN {
            format_ok = true;
        }
    }
    if !format_ok {
        return Err(invalid("RGBE header lacks FORMAT=32-bit_rle_rgbe"));
    }

    let resolution = cursor
        .line()
        .ok_or_else(|| invalid("RGBE resolution line is missing"))?;
    let (y_sign, height, x_sign, width) = parse_resolution(resolution)?;

    if width > max_dimension || height > max_dimension {
        return Err(Forge3dError::ResourceLimitExceeded {
            resource: "rgbe".to_string(),
            message: format!(
                "RGBE dimensions {width}x{height} exceed max dimension {max_dimension}"
            ),
        });
    }
    let pixel_count = u64::from(width) * u64::from(height);
    if pixel_count > max_pixels {
        return Err(Forge3dError::ResourceLimitExceeded {
            resource: "rgbe".to_string(),
            message: format!("RGBE pixel count {pixel_count} exceeds the {max_pixels} pixel limit"),
        });
    }
    let rgba_len = usize::try_from(
        pixel_count
            .checked_mul(CHANNELS as u64)
            .ok_or_else(|| invalid("RGBE pixel count overflowed"))?,
    )
    .map_err(|_| invalid("RGBE pixel count does not fit this platform"))?;

    let mut pixels = vec![[0u8; CHANNELS]; pixel_count as usize];
    let head = cursor.remaining();
    let modern_scanlines = (FLAT_MAX_WIDTH..=RLE_MAX_WIDTH).contains(&width)
        && head.len() >= CHANNELS
        && head[0] == 2
        && head[1] == 2;
    if modern_scanlines {
        decode_rle(&mut cursor, &mut pixels, width)?;
    } else {
        decode_flat(&mut cursor, &mut pixels)?;
    }
    if cursor.remaining().iter().any(|byte| !is_ascii_space(*byte)) {
        return Err(invalid("RGBE stream has trailing non-whitespace bytes"));
    }

    let mut rgba = vec![0f32; rgba_len];
    let rows_top_first = y_sign == -1;
    let columns_left_first = x_sign == 1;
    for stored_row in 0..height as usize {
        let out_row = if rows_top_first {
            stored_row
        } else {
            height as usize - 1 - stored_row
        };
        for stored_column in 0..width as usize {
            let out_column = if columns_left_first {
                stored_column
            } else {
                width as usize - 1 - stored_column
            };
            let pixel = pixels[stored_row * width as usize + stored_column];
            let offset = (out_row * width as usize + out_column) * CHANNELS;
            write_rgbe_pixel(&mut rgba[offset..offset + CHANNELS], pixel)?;
        }
    }
    Ok(RgbeImage {
        width,
        height,
        rgba,
    })
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn line(&mut self) -> Option<&'a [u8]> {
        if self.position >= self.bytes.len() {
            return None;
        }
        let start = self.position;
        let mut end = start;
        while end < self.bytes.len() && self.bytes[end] != b'\n' {
            end += 1;
        }
        self.position = if end < self.bytes.len() { end + 1 } else { end };
        let mut line = &self.bytes[start..end];
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        Some(line)
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        if self.bytes.len() - self.position < count {
            return Err(invalid("RGBE pixel data is truncated"));
        }
        let slice = &self.bytes[self.position..self.position + count];
        self.position += count;
        Ok(slice)
    }

    fn remaining(&self) -> &'a [u8] {
        &self.bytes[self.position..]
    }
}

fn trim_ascii(line: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = line.len();
    while start < end && is_ascii_space(line[start]) {
        start += 1;
    }
    while end > start && is_ascii_space(line[end - 1]) {
        end -= 1;
    }
    &line[start..end]
}

fn is_ascii_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

fn invalid(message: impl Into<String>) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: "rgbe".to_string(),
        message: message.into(),
    }
}

fn parse_resolution(line: &[u8]) -> Result<(i8, u32, i8, u32)> {
    let text = std::str::from_utf8(line).map_err(|_| invalid("RGBE resolution is not ASCII"))?;
    let mut tokens = text.split_ascii_whitespace();
    let y_token = tokens
        .next()
        .ok_or_else(|| invalid("RGBE resolution lacks the Y orientation"))?;
    let height = tokens
        .next()
        .ok_or_else(|| invalid("RGBE resolution lacks the height"))?
        .parse::<u32>()
        .map_err(|_| invalid("RGBE resolution height is not an integer"))?;
    let x_token = tokens
        .next()
        .ok_or_else(|| invalid("RGBE resolution lacks the X orientation"))?;
    let width = tokens
        .next()
        .ok_or_else(|| invalid("RGBE resolution lacks the width"))?
        .parse::<u32>()
        .map_err(|_| invalid("RGBE resolution width is not an integer"))?;
    if tokens.next().is_some() {
        return Err(invalid("RGBE resolution has extra tokens"));
    }
    let y_sign = match y_token {
        "-Y" => -1,
        "+Y" => 1,
        _ => return Err(invalid("RGBE resolution must start with -Y or +Y")),
    };
    let x_sign = match x_token {
        "+X" => 1,
        "-X" => -1,
        _ => return Err(invalid("RGBE resolution must use +X or -X")),
    };
    if width == 0 || height == 0 {
        return Err(invalid("RGBE dimensions must be positive"));
    }
    Ok((y_sign, height, x_sign, width))
}

fn decode_flat(cursor: &mut Cursor<'_>, pixels: &mut [[u8; CHANNELS]]) -> Result<()> {
    let byte_count = pixels
        .len()
        .checked_mul(CHANNELS)
        .ok_or_else(|| invalid("RGBE pixel byte count overflowed"))?;
    let data = cursor.take(byte_count)?;
    for (index, pixel) in pixels.iter_mut().enumerate() {
        pixel.copy_from_slice(&data[index * CHANNELS..index * CHANNELS + CHANNELS]);
    }
    Ok(())
}

fn decode_rle(cursor: &mut Cursor<'_>, pixels: &mut [[u8; CHANNELS]], width: u32) -> Result<()> {
    let width = width as usize;
    let mut channels = vec![0u8; CHANNELS * width];
    for row in 0..pixels.len() / width {
        let marker = cursor.take(CHANNELS)?;
        if marker[0] != 2 || marker[1] != 2 {
            return Err(invalid("RGBE scanline lacks the RLE marker"));
        }
        let declared = (usize::from(marker[2]) << 8) | usize::from(marker[3]);
        if declared != width {
            return Err(invalid("RGBE scanline width does not match the header"));
        }
        for channel in 0..CHANNELS {
            let mut written = 0usize;
            while written < width {
                let count = cursor.take(1)?[0];
                if count == 0 {
                    return Err(invalid("RGBE RLE count of zero is invalid"));
                }
                if count > 128 {
                    let run = usize::from(count) - 128;
                    if written + run > width {
                        return Err(invalid("RGBE RLE run overflows the scanline"));
                    }
                    let value = cursor.take(1)?[0];
                    for offset in 0..run {
                        channels[channel * width + written + offset] = value;
                    }
                    written += run;
                } else {
                    let literal = usize::from(count);
                    if written + literal > width {
                        return Err(invalid("RGBE literal run overflows the scanline"));
                    }
                    let values = cursor.take(literal)?;
                    channels[channel * width + written..channel * width + written + literal]
                        .copy_from_slice(values);
                    written += literal;
                }
            }
        }
        for column in 0..width {
            pixels[row * width + column] = [
                channels[column],
                channels[width + column],
                channels[2 * width + column],
                channels[3 * width + column],
            ];
        }
    }
    Ok(())
}

fn write_rgbe_pixel(out: &mut [f32], pixel: [u8; CHANNELS]) -> Result<()> {
    let exponent = pixel[3];
    if exponent == 0 {
        out[0] = 0.0;
        out[1] = 0.0;
        out[2] = 0.0;
        out[3] = 1.0;
        return Ok(());
    }
    let scale = f32::powi(2.0, i32::from(exponent) - 136);
    for channel in 0..3 {
        let value = f32::from(pixel[channel]) * scale;
        if !value.is_finite() {
            return Err(invalid("RGBE pixel is not finite"));
        }
        out[channel] = value;
    }
    out[3] = 1.0;
    Ok(())
}

#[cfg(test)]
mod tests;
