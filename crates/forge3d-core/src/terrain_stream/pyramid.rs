//! W08/T08 B2: virtual heightfield pyramid addressing (GDAL overview
//! convention: `dims(lod) = ceil(dims / 2^lod)`, lod 0 = finest).

use super::TileId;
use crate::error::{Forge3dError, Result};

fn invalid(message: impl Into<String>) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: "height_pyramid".to_string(),
        message: message.into(),
    }
}

/// LOD pyramid over a `width` x `height` heightfield with `tile_size`-sized
/// tiles (B2).
#[derive(Debug, Clone)]
pub struct HeightPyramid {
    width: u32,
    height: u32,
    tile_size: u32,
    lod_count: u32,
}

impl HeightPyramid {
    /// `width, height >= 2`, `tile_size >= 16`.
    ///
    /// `lod_count` = smallest `n >= 1` such that `dims(n - 1)` fits in ONE
    /// tile on both axes. Fixture: `16385 x 16385` with `T = 256` ->
    /// `lod0 65x65` tiles, `lod_count 8` (`dims(7) = 129`).
    pub fn new(width: u32, height: u32, tile_size: u32) -> Result<Self> {
        if width < 2 || height < 2 {
            return Err(invalid(format!(
                "pyramid dimensions must be >= 2, got {width}x{height}"
            )));
        }
        if tile_size < 16 {
            return Err(invalid(format!("tile_size must be >= 16, got {tile_size}")));
        }
        let mut lod_count = 1u32;
        loop {
            let (w, h) = dims_at(width, height, lod_count - 1);
            if w <= tile_size && h <= tile_size {
                break;
            }
            lod_count += 1;
        }
        Ok(Self {
            width,
            height,
            tile_size,
            lod_count,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn tile_size(&self) -> u32 {
        self.tile_size
    }

    pub fn lod_count(&self) -> u32 {
        self.lod_count
    }

    /// `(ceil(W / 2^lod), ceil(H / 2^lod))`.
    pub fn dims(&self, lod: u32) -> (u32, u32) {
        dims_at(self.width, self.height, lod)
    }

    /// `(ceil(dims.x / T), ceil(dims.y / T))`.
    pub fn tiles_at(&self, lod: u32) -> (u32, u32) {
        let (w, h) = self.dims(lod);
        (ceil_div(w, self.tile_size), ceil_div(h, self.tile_size))
    }

    /// `(x0, y0, w, h)` in lod samples, clipped at the edge.
    pub fn tile_rect(&self, id: TileId) -> (u32, u32, u32, u32) {
        let (w, h) = self.dims(id.lod);
        let x0 = id.x * self.tile_size;
        let y0 = id.y * self.tile_size;
        (
            x0,
            y0,
            self.tile_size.min(w.saturating_sub(x0)),
            self.tile_size.min(h.saturating_sub(y0)),
        )
    }

    /// Total tile count across all lods.
    pub fn total_tiles(&self) -> u64 {
        (0..self.lod_count)
            .map(|lod| {
                let (tx, ty) = self.tiles_at(lod);
                tx as u64 * ty as u64
            })
            .sum()
    }

    /// Whether `id` is a valid tile coordinate in this pyramid.
    pub fn contains(&self, id: TileId) -> bool {
        if id.lod >= self.lod_count {
            return false;
        }
        let (tx, ty) = self.tiles_at(id.lod);
        id.x < tx && id.y < ty
    }

    /// Coarser parent within the pyramid: `None` at the top lod.
    pub fn parent_of(&self, id: TileId) -> Option<TileId> {
        if id.lod + 1 >= self.lod_count {
            None
        } else {
            id.parent()
        }
    }

    /// Finest-level sample covered by lod-`lod` sample `(i, j)`:
    /// `(min(i * 2^l, W - 1), min(j * 2^l, H - 1))` (point subsample).
    pub fn finest_sample(&self, lod: u32, i: u32, j: u32) -> (u32, u32) {
        let scale = 1u64.checked_shl(lod).unwrap_or(u64::MAX);
        (
            ((i as u64 * scale).min(self.width as u64 - 1)) as u32,
            ((j as u64 * scale).min(self.height as u64 - 1)) as u32,
        )
    }
}

pub(crate) fn dims_at(width: u32, height: u32, lod: u32) -> (u32, u32) {
    let div = 1u64.checked_shl(lod).unwrap_or(u64::MAX);
    (
        (width as u64).div_ceil(div) as u32,
        (height as u64).div_ceil(div) as u32,
    )
}

fn ceil_div(value: u32, divisor: u32) -> u32 {
    (value + divisor - 1) / divisor.max(1)
}
