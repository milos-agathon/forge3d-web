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

fn invalid<T>(field: &str, message: &str) -> Result<T> {
    Err(Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{align_copy_bytes_per_row, rgba8_layout, unpad_rows};

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
