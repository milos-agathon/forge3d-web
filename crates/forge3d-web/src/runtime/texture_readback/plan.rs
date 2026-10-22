use crate::error::{map_core_error, Forge3DErrorCode, WebError};
use forge3d_core::readback::{ReadbackFormat, ReadbackLayout};
#[derive(Clone, Copy, Debug)]
pub(in crate::runtime) struct Region {
    pub origin: wgpu::Origin3d,
    pub extent: wgpu::Extent3d,
    pub mip: u32,
    pub format: ReadbackFormat,
}
impl Region {
    pub fn image(width: u32, height: u32, mip: u32, format: ReadbackFormat) -> Self {
        Self {
            origin: wgpu::Origin3d::ZERO,
            extent: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip,
            format,
        }
    }
}
#[derive(Debug)]
pub(in crate::runtime) struct Plan {
    pub region: Region,
    pub offset: u64,
    pub layout: Option<ReadbackLayout>,
    end: u64,
}
impl Plan {
    pub fn new(
        size: wgpu::Extent3d,
        mips: u32,
        region: Region,
        offset: u64,
        max_buffer: u64,
    ) -> Result<Self, WebError> {
        let invalid = || {
            WebError::new(
                Forge3DErrorCode::InvalidInput,
                "texture readback region outside texture",
            )
        };
        if region.mip >= mips || region.mip >= 32 {
            return Err(invalid());
        }
        for (origin, count, limit) in [
            (
                region.origin.x,
                region.extent.width,
                (size.width >> region.mip).max(1),
            ),
            (
                region.origin.y,
                region.extent.height,
                (size.height >> region.mip).max(1),
            ),
            (
                region.origin.z,
                region.extent.depth_or_array_layers,
                size.depth_or_array_layers,
            ),
        ] {
            if origin.checked_add(count).is_none_or(|end| end > limit) {
                return Err(invalid());
            }
        }
        let empty = region.extent.width == 0
            || region.extent.height == 0
            || region.extent.depth_or_array_layers == 0;
        let layout = if empty {
            None
        } else {
            Some(
                region
                    .format
                    .layout(region.extent.width, region.extent.height)
                    .map_err(map_core_error)?,
            )
        };
        let end = layout
            .map_or(Some(offset), |l| {
                l.buffer_size
                    .checked_mul(u64::from(region.extent.depth_or_array_layers))
                    .and_then(|b| offset.checked_add(b))
            })
            .filter(|end| *end <= max_buffer)
            .ok_or_else(|| {
                WebError::new(
                    Forge3DErrorCode::ResourceLimitExceeded,
                    "texture readback exceeds maxBufferSize",
                )
            })?;
        Ok(Self {
            region,
            offset,
            layout,
            end,
        })
    }
    pub fn end(&self) -> u64 {
        self.end
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn odd_regions_empty_edges_and_cube_mips_are_bounded() {
        let size = wgpu::Extent3d {
            width: 65,
            height: 33,
            depth_or_array_layers: 6,
        };
        let r = Region::image(1, 1, 0, ReadbackFormat::R32Uint);
        let p = Plan::new(size, 7, r, 0, 768).unwrap();
        assert_eq!(p.end(), 256);
        let p = Plan::new(size, 7, r, p.end(), 768).unwrap();
        assert_eq!(p.end(), 512);
        let p = Plan::new(size, 7, r, p.end(), 768).unwrap();
        assert_eq!(p.end(), 768);
        assert!(Plan::new(size, 7, r, p.end(), 768).is_err());
        let mut r = Region::image(32, 16, 1, ReadbackFormat::Rgba16Float);
        r.extent.depth_or_array_layers = 6;
        assert_eq!(
            Plan::new(size, 7, r, 0, u64::MAX).unwrap().end(),
            256 * 16 * 6
        );
        r.origin.x = 2;
        assert!(Plan::new(size, 7, r, 0, u64::MAX).is_err());
        let mut r = Region::image(0, 0, 0, ReadbackFormat::R32Uint);
        r.origin.x = 65;
        r.origin.y = 33;
        assert_eq!(Plan::new(size, 7, r, 0, 0).unwrap().end(), 0);
        r.mip = 7;
        assert!(Plan::new(size, 7, r, 0, u64::MAX).is_err());
    }
}
