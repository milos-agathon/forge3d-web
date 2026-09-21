use crate::error::{Forge3dError, Result};
use wgpu::TextureFormat;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextureFormatInfo {
    pub bytes_per_block: u32,
    pub block_width: u32,
    pub block_height: u32,
    pub compressed: bool,
}

pub fn texture_format_info(format: TextureFormat) -> Option<TextureFormatInfo> {
    let uncompressed = |bytes_per_block: u32| {
        Some(TextureFormatInfo {
            bytes_per_block,
            block_width: 1,
            block_height: 1,
            compressed: false,
        })
    };
    let compressed = |bytes_per_block: u32| {
        Some(TextureFormatInfo {
            bytes_per_block,
            block_width: 4,
            block_height: 4,
            compressed: true,
        })
    };
    match format {
        TextureFormat::R8Unorm => uncompressed(1),
        TextureFormat::Rg8Unorm => uncompressed(2),
        TextureFormat::Rgba8Unorm
        | TextureFormat::Rgba8UnormSrgb
        | TextureFormat::Bgra8Unorm
        | TextureFormat::Bgra8UnormSrgb => uncompressed(4),
        TextureFormat::R16Float => uncompressed(2),
        TextureFormat::Rg16Float => uncompressed(4),
        TextureFormat::Rgba16Float => uncompressed(8),
        TextureFormat::R32Float => uncompressed(4),
        TextureFormat::Rg32Float => uncompressed(8),
        TextureFormat::Rgba32Float => uncompressed(16),
        TextureFormat::Bc1RgbaUnorm | TextureFormat::Bc1RgbaUnormSrgb => compressed(8),
        TextureFormat::Bc3RgbaUnorm
        | TextureFormat::Bc3RgbaUnormSrgb
        | TextureFormat::Bc7RgbaUnorm
        | TextureFormat::Bc7RgbaUnormSrgb
        | TextureFormat::Etc2Rgba8Unorm
        | TextureFormat::Etc2Rgba8UnormSrgb => compressed(16),
        TextureFormat::Etc2Rgb8Unorm | TextureFormat::Etc2Rgb8UnormSrgb => compressed(8),
        _ => None,
    }
}

pub fn texture_byte_size(
    format: TextureFormat,
    width: u32,
    height: u32,
    mip_levels: u32,
) -> Result<u64> {
    if width == 0 {
        return invalid("width", "must be greater than zero");
    }
    if height == 0 {
        return invalid("height", "must be greater than zero");
    }
    if mip_levels == 0 {
        return invalid("mip_levels", "must be greater than zero");
    }
    if mip_levels > mip_level_count(width, height)? {
        return invalid("mip_levels", "exceeds the mip chain length for the size");
    }
    let info = texture_format_info(format).ok_or_else(|| Forge3dError::InvalidInput {
        field: "format".to_string(),
        message: "unsupported texture format".to_string(),
    })?;

    let mut total = 0u64;
    for level in 0..mip_levels {
        let mip_width = (width >> level).max(1);
        let mip_height = (height >> level).max(1);
        let blocks_wide = u64::from(mip_width.div_ceil(info.block_width));
        let blocks_high = u64::from(mip_height.div_ceil(info.block_height));
        let mip_bytes = blocks_wide
            .checked_mul(blocks_high)
            .and_then(|blocks| blocks.checked_mul(u64::from(info.bytes_per_block)))
            .ok_or_else(|| overflow())?;
        total = total.checked_add(mip_bytes).ok_or_else(|| overflow())?;
    }
    Ok(total)
}

pub fn mip_level_count(width: u32, height: u32) -> Result<u32> {
    if width == 0 {
        return invalid("width", "must be greater than zero");
    }
    if height == 0 {
        return invalid("height", "must be greater than zero");
    }
    Ok(u32::BITS - width.max(height).leading_zeros())
}

pub fn select_transcode_fallback(supported: &[TextureFormat], srgb: bool) -> Option<TextureFormat> {
    let candidates = if srgb {
        [
            TextureFormat::Bc7RgbaUnormSrgb,
            TextureFormat::Etc2Rgba8UnormSrgb,
            TextureFormat::Rgba8UnormSrgb,
        ]
    } else {
        [
            TextureFormat::Bc7RgbaUnorm,
            TextureFormat::Etc2Rgba8Unorm,
            TextureFormat::Rgba8Unorm,
        ]
    };
    candidates
        .iter()
        .copied()
        .find(|candidate| supported.contains(candidate))
}

fn invalid<T>(field: &str, message: &str) -> Result<T> {
    Err(Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.to_string(),
    })
}

fn overflow() -> Forge3dError {
    Forge3dError::InvalidInput {
        field: "format".to_string(),
        message: "texture byte size overflowed".to_string(),
    }
}
