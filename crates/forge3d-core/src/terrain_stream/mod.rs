//! W08/T08: GPU-free tiled heightfield streaming (pure Rust).
//!
//! Ports the native `1f4084a` tiling/paging concepts — `TileId` quadtree
//! addressing (GDAL overview convention: lod 0 = finest, higher = coarser),
//! `HeightPyramid` virtual addressing, `HeightMosaic` slot atlas + page
//! table + LRU, and `TileRequestQueue` (native `AsyncTileLoader`
//! request/drain/cancel semantics as a synchronous state machine) — plus
//! clipmap-driven request planning.
//!
//! Submodules: `pyramid`, `mosaic`, `queue`.

pub mod mosaic;
pub mod pyramid;
pub mod queue;

#[cfg(test)]
mod tests;

pub use mosaic::{HeightMosaic, InsertOutcome, MosaicFull, MosaicStats};
pub use pyramid::HeightPyramid;
pub use queue::{CoalescePolicy, Completion, QueueCounters, RequestOutcome, TileRequestQueue};

use std::cmp::Ordering;

use crate::terrain_clipmap::{ClipmapConfig, ClipmapLayout};

/// Unique identifier of a tile in the quadtree.
///
/// W08 convention: `lod 0` is the finest level; `lod + 1` is the *coarser*
/// parent (GDAL overview convention — this inverts native `tiling.rs`,
/// where children sit at `lod + 1`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TileId {
    pub lod: u32,
    pub x: u32,
    pub y: u32,
}

impl TileId {
    pub fn new(lod: u32, x: u32, y: u32) -> Self {
        Self { lod, x, y }
    }

    /// Coarser parent `(lod + 1, x / 2, y / 2)`.
    ///
    /// The id itself always returns the parent coordinates; whether the top
    /// of the pyramid has been reached is decided by [`HeightPyramid`]
    /// (see [`HeightPyramid::parent_of`]).
    pub fn parent(&self) -> Option<TileId> {
        Some(TileId::new(self.lod + 1, self.x / 2, self.y / 2))
    }

    /// The four finer child tiles, `None` at lod 0 (finest level).
    pub fn children(&self) -> Option<[TileId; 4]> {
        if self.lod == 0 {
            None
        } else {
            let lod = self.lod - 1;
            let x = self.x * 2;
            let y = self.y * 2;
            Some([
                TileId::new(lod, x, y),
                TileId::new(lod, x + 1, y),
                TileId::new(lod, x, y + 1),
                TileId::new(lod, x + 1, y + 1),
            ])
        }
    }

    /// True when `self` lies strictly inside `ancestor`'s quadtree subtree
    /// (`self` is finer: `self.lod < ancestor.lod`).
    pub fn is_descendant_of(&self, ancestor: &TileId) -> bool {
        if self.lod >= ancestor.lod {
            return false;
        }
        let shift = ancestor.lod - self.lod;
        (self.x >> shift) == ancestor.x && (self.y >> shift) == ancestor.y
    }

    /// A6 packing: `lod << 24 | (x & 0xFFF) << 12 | (y & 0xFFF)`.
    pub fn pack(&self) -> u32 {
        (self.lod << 24) | ((self.x & 0xFFF) << 12) | (self.y & 0xFFF)
    }

    /// Inverse of [`TileId::pack`].
    pub fn unpack(packed: u32) -> TileId {
        TileId::new(packed >> 24, (packed >> 12) & 0xFFF, packed & 0xFFF)
    }
}

/// Streaming plan knobs (B5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StreamPlanConfig {
    /// `data lod = clamp(ring + lod_bias, 0, lod_count - 1)`.
    pub lod_bias: i32,
    /// Prefetch ring margin in tiles around each ring's footprint.
    pub prefetch_margin_tiles: u32,
}

impl Default for StreamPlanConfig {
    fn default() -> Self {
        Self {
            lod_bias: 0,
            prefetch_margin_tiles: 1,
        }
    }
}

/// Placement of the virtual heightfield in world space (B5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HeightfieldPlacement {
    /// World XZ of finest-level sample `(0, 0)`.
    pub origin: [f32; 2],
    /// World spacing per axis of one finest-level sample.
    pub spacing: [f32; 2],
}

/// One planned tile request (B5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlannedTile {
    pub id: TileId,
    /// Lower = sooner: `ring * 1e6 + XZ distance to tile center (+ 1e9 prefetch)`.
    pub priority: f32,
    /// True for the prefetch margin ring around each footprint.
    pub prefetch: bool,
    /// Clipmap ring this tile was planned for.
    pub ring: u32,
}

/// `data lod = clamp(ring + lod_bias, 0, lod_count - 1)` (B5).
pub fn data_lod_for_ring(ring: u32, plan: &StreamPlanConfig, pyramid: &HeightPyramid) -> u32 {
    (ring as i64 + plan.lod_bias as i64).clamp(0, pyramid.lod_count() as i64 - 1) as u32
}

/// Plan tile requests for a clipmap layout (B5).
///
/// For each ring (the center block is ring 0) the tiles at its data lod
/// overlapping the ring footprint are requested; `prefetch_margin_tiles`
/// adds a margin ring flagged `prefetch`. Deduplicated by id keeping the
/// lowest priority; stable-sorted by `(priority, id.pack())`.
pub fn plan_clipmap_requests(
    layout: &ClipmapLayout,
    config: &ClipmapConfig,
    pyramid: &HeightPyramid,
    placement: &HeightfieldPlacement,
    plan: &StreamPlanConfig,
) -> Vec<PlannedTile> {
    let s0 = [
        layout.base_cell_size_axes[0] as f64,
        layout.base_cell_size_axes[1] as f64,
    ];
    let camera_xz = [
        layout.anchor[0] as f64 + layout.camera_units[0] * s0[0],
        layout.anchor[1] as f64 + layout.camera_units[1] * s0[1],
    ];
    let mut best: std::collections::HashMap<TileId, PlannedTile> = std::collections::HashMap::new();
    let margin = plan.prefetch_margin_tiles as i64;
    for ring in 0..config.ring_count {
        let lod = data_lod_for_ring(ring, plan, pyramid);
        let (tiles_x, tiles_y) = pyramid.tiles_at(lod);
        let tile_size = pyramid.tile_size() as f64;
        let shift = lod as f64;
        let center = layout.centers[ring as usize];
        let half = layout.outer_half_units(ring) as f64;
        // World AABB -> finest samples -> lod samples -> tile range.
        let sample_min = [
            ((layout.anchor[0] as f64 + (center[0] as f64 - half) * s0[0]
                - placement.origin[0] as f64)
                / placement.spacing[0] as f64)
                / 2f64.powf(shift),
            ((layout.anchor[1] as f64 + (center[1] as f64 - half) * s0[1]
                - placement.origin[1] as f64)
                / placement.spacing[1] as f64)
                / 2f64.powf(shift),
        ];
        let sample_max = [
            ((layout.anchor[0] as f64 + (center[0] as f64 + half) * s0[0]
                - placement.origin[0] as f64)
                / placement.spacing[0] as f64)
                / 2f64.powf(shift),
            ((layout.anchor[1] as f64 + (center[1] as f64 + half) * s0[1]
                - placement.origin[1] as f64)
                / placement.spacing[1] as f64)
                / 2f64.powf(shift),
        ];
        let base_min = [
            (sample_min[0] / tile_size).floor() as i64,
            (sample_min[1] / tile_size).floor() as i64,
        ];
        let base_max = [
            (sample_max[0] / tile_size).floor() as i64,
            (sample_max[1] / tile_size).floor() as i64,
        ];
        let t_min = [
            base_min[0].clamp(0, tiles_x as i64 - 1),
            base_min[1].clamp(0, tiles_y as i64 - 1),
        ];
        let t_max = [
            base_max[0].clamp(0, tiles_x as i64 - 1),
            base_max[1].clamp(0, tiles_y as i64 - 1),
        ];
        if t_min[0] > t_max[0] || t_min[1] > t_max[1] {
            continue;
        }
        let p_min = [
            (base_min[0] - margin).clamp(0, tiles_x as i64 - 1),
            (base_min[1] - margin).clamp(0, tiles_y as i64 - 1),
        ];
        let p_max = [
            (base_max[0] + margin).clamp(0, tiles_x as i64 - 1),
            (base_max[1] + margin).clamp(0, tiles_y as i64 - 1),
        ];
        for ty in p_min[1]..=p_max[1] {
            for tx in p_min[0]..=p_max[0] {
                let prefetch = tx < t_min[0] || tx > t_max[0] || ty < t_min[1] || ty > t_max[1];
                let id = TileId::new(lod, tx as u32, ty as u32);
                // Tile center in world units for the distance term.
                let center_finest = [
                    (tx as f64 + 0.5) * tile_size * 2f64.powf(shift),
                    (ty as f64 + 0.5) * tile_size * 2f64.powf(shift),
                ];
                let center_world = [
                    placement.origin[0] as f64 + center_finest[0] * placement.spacing[0] as f64,
                    placement.origin[1] as f64 + center_finest[1] * placement.spacing[1] as f64,
                ];
                let dx = center_world[0] - camera_xz[0];
                let dz = center_world[1] - camera_xz[1];
                let distance = (dx * dx + dz * dz).sqrt() as f32;
                let mut priority = ring as f32 * 1e6 + distance;
                if prefetch {
                    priority += 1e9;
                }
                let planned = PlannedTile {
                    id,
                    priority,
                    prefetch,
                    ring,
                };
                best.entry(id)
                    .and_modify(|e| {
                        if planned.priority < e.priority {
                            *e = planned;
                        }
                    })
                    .or_insert(planned);
            }
        }
    }
    let mut out: Vec<PlannedTile> = best.into_values().collect();
    out.sort_by(|a, b| {
        a.priority
            .partial_cmp(&b.priority)
            .unwrap_or(Ordering::Equal)
            .then(a.id.pack().cmp(&b.id.pack()))
    });
    out
}
