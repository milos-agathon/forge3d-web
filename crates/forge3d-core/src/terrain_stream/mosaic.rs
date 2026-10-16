//! W08/T08 B3: `HeightMosaic` — slot atlas + page table + LRU, GPU-free
//! port of native `stream/height.rs` + `page_table/**`.
//!
//! Tiles occupy slots `0..slot_capacity` in a virtual atlas. The whole
//! coarsest lod is pinned (coarse prefill guarantee: the shader fallback
//! chain always terminates). Eviction removes the least-recently-used
//! unpinned tile not touched this frame; `MosaicFull` is backpressure.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::error::Error;
use std::fmt::{Display, Formatter};

use super::{HeightPyramid, TileId};
use crate::error::{Forge3dError, Result};

/// Slot atlas is out of capacity (or an ordering precondition failed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MosaicFull(pub &'static str);

impl Display for MosaicFull {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl Error for MosaicFull {}

impl From<MosaicFull> for Forge3dError {
    fn from(e: MosaicFull) -> Self {
        Forge3dError::ResourceLimitExceeded {
            resource: "height_mosaic".to_string(),
            message: e.0.to_string(),
        }
    }
}

/// Result of a successful [`HeightMosaic::insert`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InsertOutcome {
    pub slot: u32,
    /// Tile evicted to make room, if any.
    pub evicted: Option<TileId>,
}

/// Cumulative mosaic counters (B3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MosaicStats {
    pub inserts: u64,
    pub evictions: u64,
    pub hits: u64,
    pub misses: u64,
    pub full_rejections: u64,
}

/// Page table + slot atlas + LRU residency state for a [`HeightPyramid`].
#[derive(Debug)]
pub struct HeightMosaic {
    pyramid: HeightPyramid,
    slot_capacity: u32,
    /// TileId -> slot index.
    slots: HashMap<TileId, u32>,
    /// Free slot indices.
    free: Vec<u32>,
    /// Pinned (never evictable) tiles — the whole coarsest lod.
    pinned: HashSet<TileId>,
    /// Tiles touched this frame (never evictable this frame).
    in_use: HashSet<TileId>,
    /// LRU order: front = least recently used.
    lru: VecDeque<TileId>,
    coarsest_pinned: bool,
    generation: u64,
    /// Lods that changed since [`take_dirty_lods`] (dirty-layer scoping).
    dirty_lods: BTreeSet<u32>,
    stats: MosaicStats,
}

impl HeightMosaic {
    /// `slot_capacity` must cover all tiles at the coarsest lod
    /// (`tiles_at(lod_count - 1)`).
    pub fn new(pyramid: HeightPyramid, slot_capacity: u32) -> Result<Self> {
        let (tx, ty) = pyramid.tiles_at(pyramid.lod_count() - 1);
        let needed = tx * ty;
        if slot_capacity < needed {
            return Err(Forge3dError::InvalidInput {
                field: "height_mosaic.slot_capacity".to_string(),
                message: format!(
                    "slot_capacity {slot_capacity} must be >= coarsest lod tile count {needed}"
                ),
            });
        }
        Ok(Self {
            pyramid,
            slot_capacity,
            slots: HashMap::new(),
            free: (0..slot_capacity).rev().collect(),
            pinned: HashSet::new(),
            in_use: HashSet::new(),
            lru: VecDeque::new(),
            coarsest_pinned: false,
            generation: 0,
            dirty_lods: BTreeSet::new(),
            stats: MosaicStats::default(),
        })
    }

    /// Coarse prefill: pin every tile of the coarsest lod. Must be called
    /// before any finer [`insert`]. Idempotent.
    pub fn pin_coarsest(&mut self) -> Result<()> {
        if self.coarsest_pinned {
            return Ok(());
        }
        let top = self.pyramid.lod_count() - 1;
        let (tx, ty) = self.pyramid.tiles_at(top);
        for y in 0..ty {
            for x in 0..tx {
                let id = TileId::new(top, x, y);
                let slot = self.alloc_slot(id)?;
                self.pinned.insert(id);
                self.dirty_lods.insert(top);
                self.slots.insert(id, slot);
                self.lru.push_back(id);
            }
        }
        self.coarsest_pinned = true;
        Ok(())
    }

    /// Bump the frame generation; clears the in-use set.
    pub fn begin_frame(&mut self) {
        self.generation += 1;
        self.in_use.clear();
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Mark `id` in-use this frame and move it to most-recently-used.
    pub fn touch(&mut self, id: TileId) {
        if !self.slots.contains_key(&id) {
            return;
        }
        self.in_use.insert(id);
        self.lru.retain(|&t| t != id);
        self.lru.push_back(id);
    }

    /// Insert `id` into the atlas.
    ///
    /// Existing tiles return their slot (and refresh LRU). Free slots are
    /// used first, then the LRU unpinned tile not touched this frame is
    /// evicted; `MosaicFull` when nothing is evictable (backpressure).
    /// A finer tile cannot be inserted before [`pin_coarsest`].
    pub fn insert(&mut self, id: TileId) -> std::result::Result<InsertOutcome, MosaicFull> {
        if !self.pyramid.contains(id) {
            return Err(MosaicFull("tile outside height pyramid"));
        }
        let top = self.pyramid.lod_count() - 1;
        if !self.coarsest_pinned && id.lod != top {
            return Err(MosaicFull(
                "coarsest lod must be pinned before finer inserts",
            ));
        }
        if let Some(&slot) = self.slots.get(&id) {
            self.in_use.insert(id);
            self.lru.retain(|&t| t != id);
            self.lru.push_back(id);
            return Ok(InsertOutcome {
                slot,
                evicted: None,
            });
        }
        let (slot, evicted) = match self.alloc_slot(id) {
            Ok(slot) => (slot, None),
            Err(_) => {
                let victim = self
                    .lru
                    .iter()
                    .copied()
                    .find(|t| !self.pinned.contains(t) && !self.in_use.contains(t));
                match victim {
                    Some(victim) => {
                        let slot = self.slots.remove(&victim).unwrap();
                        self.lru.retain(|&t| t != victim);
                        self.dirty_lods.insert(victim.lod);
                        self.stats.evictions += 1;
                        (slot, Some(victim))
                    }
                    None => {
                        self.stats.full_rejections += 1;
                        return Err(MosaicFull("no evictable slot"));
                    }
                }
            }
        };
        self.slots.insert(id, slot);
        self.lru.push_back(id);
        self.in_use.insert(id);
        self.dirty_lods.insert(id.lod);
        self.stats.inserts += 1;
        Ok(InsertOutcome { slot, evicted })
    }

    fn alloc_slot(&mut self, _id: TileId) -> std::result::Result<u32, MosaicFull> {
        self.free.pop().ok_or(MosaicFull("atlas slots exhausted"))
    }

    /// Remove a resident tile; `false` when pinned or not resident.
    pub fn remove(&mut self, id: TileId) -> bool {
        if self.pinned.contains(&id) {
            return false;
        }
        match self.slots.remove(&id) {
            Some(slot) => {
                self.free.push(slot);
                self.lru.retain(|&t| t != id);
                self.in_use.remove(&id);
                self.dirty_lods.insert(id.lod);
                true
            }
            None => false,
        }
    }

    /// Resident slot of `id` (does not affect LRU order).
    pub fn lookup(&self, id: TileId) -> Option<u32> {
        self.slots.get(&id).copied()
    }

    pub fn resident_count(&self) -> u32 {
        self.slots.len() as u32
    }

    /// `resident * T * T * 4` bytes.
    pub fn resident_bytes(&self) -> u64 {
        let t = self.pyramid.tile_size() as u64;
        self.resident_count() as u64 * t * t * 4
    }

    /// `slot_capacity * T * T * 4` bytes.
    pub fn capacity_bytes(&self) -> u64 {
        let t = self.pyramid.tile_size() as u64;
        self.slot_capacity as u64 * t * t * 4
    }

    /// Row-major page table over `tiles_at(lod)`: entry = `slot + 1`,
    /// `0` = absent.
    pub fn page_table(&self, lod: u32) -> Vec<u32> {
        let (tx, ty) = self.pyramid.tiles_at(lod);
        let mut out = vec![0u32; (tx * ty) as usize];
        for y in 0..ty {
            for x in 0..tx {
                if let Some(&slot) = self.slots.get(&TileId::new(lod, x, y)) {
                    out[(y * tx + x) as usize] = slot + 1;
                }
            }
        }
        out
    }

    /// Dirty lod set since last call (sorted, cleared on read).
    pub fn take_dirty_lods(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.dirty_lods).into_iter().collect()
    }

    /// Texel origin of `slot` in an atlas with `slots_per_row` slots/row.
    pub fn slot_origin(&self, slot: u32, slots_per_row: u32) -> (u32, u32) {
        let spr = slots_per_row.max(1);
        let t = self.pyramid.tile_size();
        ((slot % spr) * t, (slot / spr) * t)
    }

    /// CPU mirror of the WGSL fallback chain: finest resident tile at or
    /// above `lod` covering lod-texel `(tx, ty)`; returns `(lod', slot)`.
    /// The texel at `lod'` is `(tx >> (lod' - lod), ty >> (lod' - lod))`.
    pub fn resolve(&mut self, lod: u32, tx: u32, ty: u32) -> Option<(u32, u32)> {
        let t = self.pyramid.tile_size();
        for lp in lod..self.pyramid.lod_count() {
            let shift = lp - lod;
            let id = TileId::new(lp, (tx >> shift) / t, (ty >> shift) / t);
            if self.pyramid.contains(id) {
                if let Some(&slot) = self.slots.get(&id) {
                    self.stats.hits += 1;
                    return Some((lp, slot));
                }
            }
        }
        self.stats.misses += 1;
        None
    }

    pub fn is_pinned(&self, id: TileId) -> bool {
        self.pinned.contains(&id)
    }

    pub fn slot_capacity(&self) -> u32 {
        self.slot_capacity
    }

    pub fn pyramid(&self) -> &HeightPyramid {
        &self.pyramid
    }

    pub fn stats(&self) -> MosaicStats {
        self.stats
    }
}
