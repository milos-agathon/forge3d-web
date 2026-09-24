use crate::error::{Forge3dError, Result};

pub const RGBA8_BYTES_PER_PIXEL: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadbackLayout {
    pub width: u32,
    pub height: u32,
    pub bytes_per_pixel: u32,
    pub unpadded_bytes_per_row: u32,
    pub padded_bytes_per_row: u32,
    pub buffer_size: u64,
}

impl ReadbackLayout {
    pub fn new(width: u32, height: u32, bytes_per_pixel: u32) -> Result<Self> {
        if width == 0 {
            return invalid("width", "must be greater than zero");
        }
        if height == 0 {
            return invalid("height", "must be greater than zero");
        }
        if bytes_per_pixel == 0 {
            return invalid("bytes_per_pixel", "must be greater than zero");
        }

        let unpadded_bytes_per_row =
            width
                .checked_mul(bytes_per_pixel)
                .ok_or_else(|| Forge3dError::InvalidInput {
                    field: "width".to_string(),
                    message: "readback row byte count overflowed".to_string(),
                })?;
        let padded_bytes_per_row = align_copy_bytes_per_row(unpadded_bytes_per_row)?;
        let buffer_size = u64::from(padded_bytes_per_row)
            .checked_mul(u64::from(height))
            .ok_or_else(|| Forge3dError::InvalidInput {
                field: "height".to_string(),
                message: "readback buffer size overflowed".to_string(),
            })?;

        Ok(Self {
            width,
            height,
            bytes_per_pixel,
            unpadded_bytes_per_row,
            padded_bytes_per_row,
            buffer_size,
        })
    }
}

pub fn rgba8_layout(width: u32, height: u32) -> Result<ReadbackLayout> {
    ReadbackLayout::new(width, height, RGBA8_BYTES_PER_PIXEL)
}

pub fn align_copy_bytes_per_row(row_bytes: u32) -> Result<u32> {
    if row_bytes == 0 {
        return invalid("row_bytes", "must be greater than zero");
    }

    let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    row_bytes
        .checked_add(alignment - 1)
        .map(|value| (value / alignment) * alignment)
        .ok_or_else(|| Forge3dError::InvalidInput {
            field: "row_bytes".to_string(),
            message: "aligned row byte count overflowed".to_string(),
        })
}

pub fn unpad_rows(padded: &[u8], layout: ReadbackLayout) -> Result<Vec<u8>> {
    if padded.len() < layout.buffer_size as usize {
        return Err(Forge3dError::InvalidInput {
            field: "padded".to_string(),
            message: format!(
                "expected at least {} bytes, got {}",
                layout.buffer_size,
                padded.len()
            ),
        });
    }

    let tight_size = u64::from(layout.unpadded_bytes_per_row)
        .checked_mul(u64::from(layout.height))
        .ok_or_else(|| Forge3dError::InvalidInput {
            field: "height".to_string(),
            message: "tight readback size overflowed".to_string(),
        })? as usize;
    let mut tight = vec![0u8; tight_size];

    for row in 0..layout.height as usize {
        let padded_start = row * layout.padded_bytes_per_row as usize;
        let padded_end = padded_start + layout.unpadded_bytes_per_row as usize;
        let tight_start = row * layout.unpadded_bytes_per_row as usize;
        let tight_end = tight_start + layout.unpadded_bytes_per_row as usize;
        tight[tight_start..tight_end].copy_from_slice(&padded[padded_start..padded_end]);
    }

    Ok(tight)
}

/// Texel formats the typed readback path copies out of GPU textures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadbackFormat {
    Rgba8Unorm,
    Bgra8Unorm,
    Rgba16Float,
    Rgba32Float,
    Rg32Float,
    R32Float,
    R32Uint,
}

impl ReadbackFormat {
    pub fn bytes_per_pixel(self) -> u32 {
        match self {
            Self::Rgba8Unorm | Self::Bgra8Unorm | Self::R32Float | Self::R32Uint => 4,
            Self::Rgba16Float | Self::Rg32Float => 8,
            Self::Rgba32Float => 16,
        }
    }

    pub fn channels(self) -> u32 {
        match self {
            Self::Rgba8Unorm | Self::Bgra8Unorm | Self::Rgba16Float | Self::Rgba32Float => 4,
            Self::Rg32Float => 2,
            Self::R32Float | Self::R32Uint => 1,
        }
    }

    pub fn layout(self, width: u32, height: u32) -> Result<ReadbackLayout> {
        ReadbackLayout::new(width, height, self.bytes_per_pixel())
    }
}

/// IEEE 754 binary16 to binary32 (exact; subnormals, infinities and NaN kept).
pub fn f16_to_f32(bits: u16) -> f32 {
    let sign = u32::from(bits >> 15) << 31;
    let exponent = u32::from((bits >> 10) & 0x1f);
    let mantissa = u32::from(bits & 0x3ff);
    let magnitude = match (exponent, mantissa) {
        (0, 0) => 0,
        (0, m) => {
            // Subnormal: normalize the mantissa.
            let shift = m.leading_zeros() - 21;
            let m = (m << shift) & 0x3ff;
            ((113 - shift) << 23) | (m << 13)
        }
        (0x1f, m) => 0x7f80_0000 | (m << 13),
        (e, m) => ((e + 112) << 23) | (m << 13),
    };
    f32::from_bits(sign | magnitude)
}

/// Unpads rows and decodes little-endian texels to `f32` lanes.
pub fn decode_float_rows(
    padded: &[u8],
    layout: ReadbackLayout,
    format: ReadbackFormat,
) -> Result<Vec<f32>> {
    let tight = unpad_rows(padded, layout)?;
    match format {
        ReadbackFormat::Rgba32Float | ReadbackFormat::Rg32Float | ReadbackFormat::R32Float => {
            Ok(tight
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect())
        }
        ReadbackFormat::Rgba16Float => Ok(tight
            .chunks_exact(2)
            .map(|b| f16_to_f32(u16::from_le_bytes([b[0], b[1]])))
            .collect()),
        ReadbackFormat::Rgba8Unorm | ReadbackFormat::Bgra8Unorm | ReadbackFormat::R32Uint => {
            invalid("format", "not a float readback format")
        }
    }
}

/// Unpads rows and decodes little-endian `u32` texels.
pub fn decode_u32_rows(padded: &[u8], layout: ReadbackLayout) -> Result<Vec<u32>> {
    let tight = unpad_rows(padded, layout)?;
    Ok(tight
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

fn invalid<T>(field: &str, message: &str) -> Result<T> {
    Err(Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        align_copy_bytes_per_row, decode_float_rows, decode_u32_rows, f16_to_f32, rgba8_layout,
        unpad_rows, ReadbackFormat,
    };

    #[test]
    fn typed_formats_report_texel_sizes_and_padded_layouts() {
        assert_eq!(ReadbackFormat::Rgba32Float.bytes_per_pixel(), 16);
        assert_eq!(ReadbackFormat::Rg32Float.channels(), 2);
        let layout = ReadbackFormat::Rgba32Float.layout(17, 3).unwrap();
        assert_eq!(layout.unpadded_bytes_per_row, 272);
        assert_eq!(layout.padded_bytes_per_row, 512);
        let layout = ReadbackFormat::R32Float.layout(65, 2).unwrap();
        assert_eq!(layout.padded_bytes_per_row, 512);
    }

    #[test]
    fn f16_decoding_is_exact_across_classes() {
        assert_eq!(f16_to_f32(0x3c00), 1.0);
        assert_eq!(f16_to_f32(0xc000), -2.0);
        assert_eq!(f16_to_f32(0x7bff), 65504.0);
        assert_eq!(f16_to_f32(0x0001), 2.0f32.powi(-24));
        assert_eq!(f16_to_f32(0x03ff), 1023.0 * 2.0f32.powi(-24));
        assert_eq!(f16_to_f32(0x0400), 2.0f32.powi(-14));
        assert_eq!(f16_to_f32(0x8000).to_bits(), (-0.0f32).to_bits());
        assert!(f16_to_f32(0x7c00).is_infinite());
        assert!(f16_to_f32(0x7e00).is_nan());
        assert_eq!(f16_to_f32(0x3555), 0.333_251_95);
    }

    #[test]
    fn float_and_uint_rows_decode_after_unpadding() {
        let layout = ReadbackFormat::R32Float.layout(3, 2).unwrap();
        let mut padded = vec![0u8; layout.buffer_size as usize];
        for (row, values) in [[1.5f32, -2.0, 3.25], [0.125, 7.0, -0.5]]
            .iter()
            .enumerate()
        {
            for (x, value) in values.iter().enumerate() {
                let start = row * layout.padded_bytes_per_row as usize + x * 4;
                padded[start..start + 4].copy_from_slice(&value.to_le_bytes());
            }
        }
        assert_eq!(
            decode_float_rows(&padded, layout, ReadbackFormat::R32Float).unwrap(),
            vec![1.5, -2.0, 3.25, 0.125, 7.0, -0.5]
        );
        let ids = decode_u32_rows(&padded, layout).unwrap();
        assert_eq!(ids[0], 1.5f32.to_bits());
        assert!(decode_float_rows(&padded, layout, ReadbackFormat::R32Uint).is_err());

        let layout = ReadbackFormat::Rgba16Float.layout(1, 1).unwrap();
        let mut padded = vec![0u8; layout.buffer_size as usize];
        for (lane, bits) in [0x3c00u16, 0x4000, 0x3800, 0x0000].iter().enumerate() {
            padded[lane * 2..lane * 2 + 2].copy_from_slice(&bits.to_le_bytes());
        }
        assert_eq!(
            decode_float_rows(&padded, layout, ReadbackFormat::Rgba16Float).unwrap(),
            vec![1.0, 2.0, 0.5, 0.0]
        );
    }

    #[test]
    fn aligns_rows_to_webgpu_copy_alignment() {
        assert_eq!(align_copy_bytes_per_row(4).unwrap(), 256);
        assert_eq!(align_copy_bytes_per_row(256).unwrap(), 256);
        assert_eq!(align_copy_bytes_per_row(260).unwrap(), 512);
    }

    #[test]
    fn rgba8_layout_uses_padded_rows_and_tight_row_size() {
        let layout = rgba8_layout(77, 53).unwrap();

        assert_eq!(layout.unpadded_bytes_per_row, 308);
        assert_eq!(layout.padded_bytes_per_row, 512);
        assert_eq!(layout.buffer_size, 512 * 53);
    }

    #[test]
    fn unpad_rows_returns_tightly_packed_rgba() {
        let layout = rgba8_layout(3, 2).unwrap();
        let mut padded = vec![0u8; layout.buffer_size as usize];
        padded[0..12].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        let second_row = layout.padded_bytes_per_row as usize;
        padded[second_row..second_row + 12]
            .copy_from_slice(&[13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);

        let tight = unpad_rows(&padded, layout).unwrap();

        assert_eq!(
            tight,
            vec![
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
                24
            ]
        );
    }
}
