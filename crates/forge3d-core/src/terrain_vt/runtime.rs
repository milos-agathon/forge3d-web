//! W08/T14a `terrain_vt::runtime` — GPU-free port of the native
//! `TerrainMaterialVT`/`TerrainMaterialVTRuntime` (register_source,
//! mip chains, page tables, LRU tile cache, request collection,
//! feedback, stats). Atlas/page-table uploads are represented by CPU
//! side data (`TileUpload`, `page_table_texels`) — no GPU objects.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use crate::error::{Forge3dError, Result};

use super::{
    TerrainVtSettings, VtLayerFamily, TERRAIN_VT_BYTES_PER_PIXEL, TERRAIN_VT_MATERIAL_CAPACITY,
    TERRAIN_VT_SUPPORTED_FAMILY,
};

fn invalid(field: &str, message: String) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message,
    }
}

/// Native `ceil_div`.
pub fn ceil_div(value: u32, divisor: u32) -> u32 {
    (value + divisor.saturating_sub(1)) / divisor.max(1)
}

/// Native `page_table_mip_levels`: levels until the page pyramid bottoms
/// out at 1x1 (`ceil(log2(max_dim)) + 1`; e.g. 9 pages -> 9,5,3,2,1 = 5).
pub fn page_table_mip_levels(pages_x0: u32, pages_y0: u32) -> u32 {
    let max_dim = pages_x0.max(pages_y0).max(1);
    if max_dim <= 1 {
        return 1;
    }
    (u32::BITS - (max_dim - 1).leading_zeros()) + 1
}

/// Native `pages_for_mip_counts`: ceil-div by `2^mip`, min 1.
pub fn pages_for_mip_counts(pages_x0: u32, pages_y0: u32, mip_level: u32) -> (u32, u32) {
    let div = 1u32.checked_shl(mip_level).unwrap_or(u32::MAX).max(1);
    (
        ceil_div(pages_x0.max(1), div).max(1),
        ceil_div(pages_y0.max(1), div).max(1),
    )
}

/// Native `full_pyramid_levels`.
pub fn full_pyramid_levels(width: u32, height: u32, tile_size: u32) -> u32 {
    let pages_x = ceil_div(width, tile_size).max(1);
    let pages_y = ceil_div(height, tile_size).max(1);
    page_table_mip_levels(pages_x, pages_y)
}

/// Native `total_pages_for`: pages summed over `0..max_mip_levels`.
pub fn total_pages_for(virtual_size: (u32, u32), tile_size: u32, max_mip_levels: u32) -> u32 {
    let pages_x0 = ceil_div(virtual_size.0, tile_size);
    let pages_y0 = ceil_div(virtual_size.1, tile_size);
    let mut total = 0u32;
    for mip_level in 0..max_mip_levels {
        let (pages_x, pages_y) = pages_for_mip_counts(pages_x0, pages_y0, mip_level);
        total = total.saturating_add(pages_x.saturating_mul(pages_y));
    }
    total
}

/// One mip level of a prepared source (native `MipImage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MipImage {
    pub width: u32,
    pub height: u32,
    /// Row-major RGBA8, `width * height * 4` bytes.
    pub data: Vec<u8>,
}

/// Native `build_rgba_mip_chain`: 2x2 box filter with integer truncating
/// average; once a mip reaches 1x1 it is cloned for the remaining levels.
pub fn build_rgba_mip_chain(data: &[u8], size: (u32, u32), max_mip_levels: u32) -> Vec<MipImage> {
    let mut chain = Vec::with_capacity(max_mip_levels as usize);
    chain.push(MipImage {
        width: size.0,
        height: size.1,
        data: data.to_vec(),
    });

    while chain.len() < max_mip_levels as usize {
        let previous = chain.last().unwrap().clone();
        if previous.width == 1 && previous.height == 1 {
            chain.push(previous);
            continue;
        }

        let next_width = previous.width.max(1).div_ceil(2);
        let next_height = previous.height.max(1).div_ceil(2);
        let mut next_data =
            vec![0u8; next_width as usize * next_height as usize * TERRAIN_VT_BYTES_PER_PIXEL];

        for y in 0..next_height {
            for x in 0..next_width {
                let mut accum = [0u32; TERRAIN_VT_BYTES_PER_PIXEL];
                let mut sample_count = 0u32;
                for src_y in (y * 2)..((y * 2 + 2).min(previous.height)) {
                    for src_x in (x * 2)..((x * 2 + 2).min(previous.width)) {
                        let src_index = (src_y as usize * previous.width as usize + src_x as usize)
                            * TERRAIN_VT_BYTES_PER_PIXEL;
                        for (channel, acc) in accum.iter_mut().enumerate() {
                            *acc += previous.data[src_index + channel] as u32;
                        }
                        sample_count += 1;
                    }
                }
                let dst_index =
                    (y as usize * next_width as usize + x as usize) * TERRAIN_VT_BYTES_PER_PIXEL;
                for (channel, acc) in accum.iter().enumerate() {
                    next_data[dst_index + channel] = (acc / sample_count.max(1)) as u8;
                }
            }
        }

        chain.push(MipImage {
            width: next_width,
            height: next_height,
            data: next_data,
        });
    }
    chain
}

/// Registered VT source data (native `VTSource`).
#[derive(Debug, Clone, PartialEq)]
pub struct VtSource {
    pub virtual_size: (u32, u32),
    /// RGBA8 for `albedo` (`w*h*4` bytes); opaque bytes for other families.
    pub data: Vec<u8>,
    pub fallback_color: [f32; 4],
}

/// Native `TerrainMaterialVT` source registry (`register_source` /
/// `clear_sources` semantics, native error messages).
#[derive(Debug, Default)]
pub struct VtSourceRegistry {
    sources: HashMap<(u32, String), VtSource>,
    source_generation: u64,
}

impl VtSourceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Native `register_source`: albedo data must be exactly `w*h*4`
    /// RGBA8 bytes; non-albedo sources must be non-empty and are stored
    /// for forward compatibility but never paged. Re-registering an
    /// existing `(material_index, family)` with a different virtual size
    /// is rejected.
    pub fn register(
        &mut self,
        material_index: u32,
        family: &str,
        virtual_size_px: (u32, u32),
        data: Vec<u8>,
        fallback_color: [f32; 4],
    ) -> Result<()> {
        if virtual_size_px.0 == 0 || virtual_size_px.1 == 0 {
            return Err(invalid(
                "vt.virtual_size_px",
                "virtual_size_px must be > 0 in both dimensions".to_string(),
            ));
        }
        if family == TERRAIN_VT_SUPPORTED_FAMILY {
            let expected_len = virtual_size_px.0 as usize
                * virtual_size_px.1 as usize
                * TERRAIN_VT_BYTES_PER_PIXEL;
            if data.len() != expected_len {
                return Err(invalid(
                    "vt.source_data",
                    format!(
                        "VT source data size mismatch for {family}: expected {expected_len} RGBA8 bytes, got {}",
                        data.len()
                    ),
                ));
            }
        } else if data.is_empty() {
            return Err(invalid(
                "vt.source_data",
                "VT source data must not be empty".to_string(),
            ));
        }

        if let Some(existing) = self.sources.get(&(material_index, family.to_string())) {
            if existing.virtual_size != virtual_size_px {
                return Err(invalid(
                    "vt.virtual_size_px",
                    format!(
                        "Virtual size mismatch: existing {:?}, new {:?}",
                        existing.virtual_size, virtual_size_px
                    ),
                ));
            }
        }

        self.sources.insert(
            (material_index, family.to_string()),
            VtSource {
                virtual_size: virtual_size_px,
                data,
                fallback_color,
            },
        );
        self.source_generation = self.source_generation.wrapping_add(1);
        Ok(())
    }

    /// Native `clear_sources`.
    pub fn clear(&mut self) {
        self.sources.clear();
        self.source_generation = self.source_generation.wrapping_add(1);
    }

    pub fn source_generation(&self) -> u64 {
        self.source_generation
    }

    pub fn sources(&self) -> &HashMap<(u32, String), VtSource> {
        &self.sources
    }

    pub fn get(&self, material_index: u32, family: &str) -> Option<&VtSource> {
        self.sources.get(&(material_index, family.to_string()))
    }

    pub fn len(&self) -> usize {
        self.sources.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sources.is_empty()
    }
}

/// Paged tile identity (native `TileKey`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TileKey {
    pub material_index: u32,
    pub x: u32,
    pub y: u32,
    pub mip_level: u32,
}

/// Native `FeedbackEntry` (material index is `frame_number - 1`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeedbackEntry {
    pub tile_x: u32,
    pub tile_y: u32,
    pub mip_level: u32,
    pub frame_number: u32,
}

/// Native `PageTableEntry` (`[atlas_u, atlas_v, is_resident, mip_bias]`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PageTableEntry {
    pub atlas_u: f32,
    pub atlas_v: f32,
    pub is_resident: u32,
    pub mip_bias: f32,
}

/// Prepared albedo source: fallback color + full mip chain.
#[derive(Debug, Clone)]
pub struct PreparedVtSource {
    pub fallback_color: [f32; 4],
    pub mips: Vec<MipImage>,
}

/// The tile data an atlas upload would carry (GPU-free `TileData`).
#[derive(Debug, Clone, PartialEq)]
pub struct TileUpload {
    /// Atlas texel origin of the slot.
    pub atlas_x: u32,
    pub atlas_y: u32,
    /// `slot_size` — the upload is `size x size x 4` bytes.
    pub size: u32,
    /// Slot-sized RGBA8 tile incl. border-clamped gutter.
    pub rgba: Vec<u8>,
}

/// Encoded cache-tile id (native `TileId` used by the tile cache).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct CacheTile {
    x: u32,
    y: u32,
    mip_level: u32,
}

/// LRU tile cache over atlas slots (GPU-free port of the native
/// `TileCache`: free slots in row-major order, then LRU eviction).
#[derive(Debug)]
struct VtTileCache {
    slot_size: u32,
    slots_per_row: u32,
    resident: HashMap<CacheTile, u32>,
    /// Free slot indices (front = next).
    free: VecDeque<u32>,
    /// LRU order (front = least recently used).
    lru: VecDeque<CacheTile>,
    evictions: u64,
}

impl VtTileCache {
    fn new(capacity: usize, atlas_size: u32, slot_size: u32) -> Self {
        Self {
            slot_size,
            slots_per_row: (atlas_size / slot_size.max(1)).max(1),
            resident: HashMap::new(),
            free: (0..capacity.max(1) as u32).collect(),
            lru: VecDeque::new(),
            evictions: 0,
        }
    }

    fn is_resident(&self, tile: &CacheTile) -> bool {
        self.resident.contains_key(tile)
    }

    fn access(&mut self, tile: &CacheTile) {
        if self.resident.contains_key(tile) {
            self.lru.retain(|t| t != tile);
            self.lru.push_back(*tile);
        }
    }

    /// Allocate a slot for `tile`; evicts the LRU resident when full.
    /// Returns `(slot_index, evicted_tiles)`; `None` when a slot is
    /// somehow unavailable.
    fn allocate(&mut self, tile: CacheTile) -> Option<(u32, Vec<CacheTile>)> {
        if self.resident.contains_key(&tile) {
            self.access(&tile);
            return Some((*self.resident.get(&tile).unwrap(), Vec::new()));
        }
        let mut evicted = Vec::new();
        let slot = match self.free.pop_front() {
            Some(slot) => slot,
            None => {
                let victim = self.lru.pop_front()?;
                let slot = self.resident.remove(&victim)?;
                evicted.push(victim);
                self.evictions += 1;
                slot
            }
        };
        self.resident.insert(tile, slot);
        self.lru.push_back(tile);
        Some((slot, evicted))
    }

    fn resident_count(&self) -> usize {
        self.resident.len()
    }

    /// Atlas texel origin of `slot` (row-major slot order).
    fn slot_origin(&self, slot: u32) -> (u32, u32) {
        (
            (slot % self.slots_per_row) * self.slot_size,
            (slot / self.slots_per_row) * self.slot_size,
        )
    }
}

/// Camera parameters needed by the GPU-free request path (subset of the
/// native `TerrainRenderParams` used by `visible_uv_rect` /
/// `target_mip_level`).
#[derive(Debug, Clone, PartialEq)]
pub struct VtViewParams {
    /// `"mesh"` for perspective mesh camera; anything else gives the full
    /// `[0, 1]` uv rect.
    pub camera_mode: String,
    pub size_px: (u32, u32),
    /// Camera target in terrain-relative XZ (uv = target / span + 0.5).
    pub cam_target: [f32; 3],
    pub terrain_span: f32,
    pub cam_radius: f32,
    pub fov_y_deg: f32,
}

impl Default for VtViewParams {
    fn default() -> Self {
        Self {
            camera_mode: "screen".to_string(),
            size_px: (224, 160),
            cam_target: [0.0, 0.0, 0.0],
            terrain_span: 8.0,
            cam_radius: 4.0,
            fov_y_deg: 50.0,
        }
    }
}

/// Native `TerrainMaterialVTStats` (+ derived `miss_rate` at read time).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VtStats {
    pub resident_pages: u32,
    pub total_pages: u32,
    pub cache_budget_pages: u32,
    pub cache_budget_mb: f32,
    pub cache_hits: u32,
    pub cache_misses: u32,
    pub miss_rate: f32,
    pub tiles_streamed: u32,
    pub evictions: u32,
    pub avg_upload_ms: f32,
    pub last_upload_ms: f32,
    pub resident_megabytes: f32,
    pub source_count: u32,
    pub feedback_requests: u32,
}

/// GPU-free `TerrainMaterialVTRuntime`: page tables, prepared sources,
/// LRU atlas cache, request collection, feedback, stats.
#[derive(Debug)]
pub struct VtRuntimeState {
    virtual_size: (u32, u32),
    tile_size: u32,
    tile_border: u32,
    slot_size: u32,
    atlas_size: u32,
    material_count: u32,
    max_mip_levels: u32,
    pages_x0: u32,
    pages_y0: u32,
    /// `[material_index * max_mip_levels + mip_level][y * pages_x + x]`.
    page_tables: Vec<Vec<PageTableEntry>>,
    sources: HashMap<u32, PreparedVtSource>,
    cache: VtTileCache,
    pending_feedback: Vec<TileKey>,
    budget_pages: u32,
    source_generation: u64,
    use_feedback: bool,
    /// (material_index, mip_level) page-table layers touched since
    /// [`take_dirty_layers`].
    dirty_layers: BTreeSet<(u32, u32)>,
    stats: VtStats,
}

impl VtRuntimeState {
    /// Build from a registry + the albedo layer + settings.
    /// `material_count` is clamped to `1..=TERRAIN_VT_MATERIAL_CAPACITY`
    /// (native `material_count.clamp(1, MATERIAL_LAYER_CAPACITY)`).
    pub fn new(
        registry: &VtSourceRegistry,
        layer: &VtLayerFamily,
        settings: &TerrainVtSettings,
        material_count: u32,
    ) -> Result<Self> {
        let material_count = material_count.clamp(1, TERRAIN_VT_MATERIAL_CAPACITY as u32);
        let slot_size = layer.slot_size();
        let pages_x0 = layer.pages_x0();
        let pages_y0 = layer.pages_y0();
        // The runtime page pyramid always bottoms out at 1x1 pages
        // (`page_table_mip_levels` = ceil(log2)+1) — matching the 1.38
        // runtime (total_pages 480 / resident_pages 20 at the w08 golden
        // params). It is intentionally NOT clamped by the public
        // `full_pyramid_levels`, which keeps the 1f4084a/1.38
        // floor(log2)+1 value.
        let max_mip_levels = settings
            .max_mip_levels
            .min(page_table_mip_levels(pages_x0, pages_y0))
            .max(1);

        let mut sources = HashMap::new();
        for ((material_index, family), source) in registry.sources() {
            if family != TERRAIN_VT_SUPPORTED_FAMILY || *material_index >= material_count {
                continue;
            }
            if source.virtual_size != layer.virtual_size_px {
                return Err(invalid(
                    "vt.source",
                    format!(
                        "VT source {:?} virtual size {:?} does not match layer contract {:?}",
                        (material_index, family),
                        source.virtual_size,
                        layer.virtual_size_px
                    ),
                ));
            }
            sources.insert(
                *material_index,
                PreparedVtSource {
                    fallback_color: source.fallback_color,
                    mips: build_rgba_mip_chain(&source.data, source.virtual_size, max_mip_levels),
                },
            );
        }

        let source_count = sources.len() as u32;
        let total_pages = total_pages_for(layer.virtual_size_px, layer.tile_size, max_mip_levels)
            .saturating_mul(source_count);

        let atlas_slots_total =
            (settings.atlas_size / slot_size) * (settings.atlas_size / slot_size);
        let slot_bytes = slot_size as u64 * slot_size as u64 * TERRAIN_VT_BYTES_PER_PIXEL as u64;
        let budget_bytes = (settings.residency_budget_mb as f64 * 1024.0 * 1024.0).floor() as u64;
        let budget_pages = (budget_bytes / slot_bytes.max(1)).max(1) as u32;
        let budget_pages = budget_pages.min(atlas_slots_total).max(1);

        let mut page_tables = Vec::with_capacity((material_count * max_mip_levels) as usize);
        for _material_index in 0..material_count {
            for mip_level in 0..max_mip_levels {
                let (pages_x, pages_y) = pages_for_mip_counts(pages_x0, pages_y0, mip_level);
                page_tables.push(vec![
                    PageTableEntry::default();
                    (pages_x * pages_y) as usize
                ]);
            }
        }

        Ok(Self {
            virtual_size: layer.virtual_size_px,
            tile_size: layer.tile_size,
            tile_border: layer.tile_border,
            slot_size,
            atlas_size: settings.atlas_size,
            material_count,
            max_mip_levels,
            pages_x0,
            pages_y0,
            page_tables,
            sources,
            cache: VtTileCache::new(budget_pages as usize, settings.atlas_size, slot_size),
            pending_feedback: Vec::new(),
            budget_pages,
            source_generation: registry.source_generation(),
            use_feedback: settings.use_feedback,
            dirty_layers: BTreeSet::new(),
            stats: VtStats {
                total_pages,
                cache_budget_pages: budget_pages,
                cache_budget_mb: settings.residency_budget_mb,
                source_count,
                ..VtStats::default()
            },
        })
    }

    /// Per-frame stat reset (native `reset_frame_stats`).
    pub fn reset_frame_stats(&mut self, residency_budget_mb: f32) {
        self.stats.cache_hits = 0;
        self.stats.cache_misses = 0;
        self.stats.tiles_streamed = 0;
        self.stats.evictions = 0;
        self.stats.last_upload_ms = 0.0;
        self.stats.avg_upload_ms = 0.0;
        self.stats.cache_budget_pages = self.budget_pages;
        self.stats.cache_budget_mb = residency_budget_mb;
        self.stats.source_count = self.sources.len() as u32;
    }

    /// Native `visible_uv_rect`: "mesh" perspective from camera
    /// target/radius/fov/aspect/terrain span; full `[0,1]` otherwise.
    pub fn native_visible_uv_rect(&self, params: &VtViewParams) -> ([f32; 2], [f32; 2]) {
        if params.camera_mode.eq_ignore_ascii_case("mesh") {
            let aspect = params.size_px.0 as f32 / params.size_px.1.max(1) as f32;
            let center = [
                (params.cam_target[0] / params.terrain_span.max(1e-3)) + 0.5,
                (params.cam_target[1] / params.terrain_span.max(1e-3)) + 0.5,
            ];
            let half_height =
                params.cam_radius.max(1.0) * (params.fov_y_deg.to_radians() * 0.5).tan();
            let half_width = half_height * aspect;
            let span_u = ((half_width * 2.5) / params.terrain_span.max(1e-3)).clamp(0.05, 1.0);
            let span_v = ((half_height * 2.5) / params.terrain_span.max(1e-3)).clamp(0.05, 1.0);
            let min = [
                (center[0] - span_u * 0.5).clamp(0.0, 1.0),
                (center[1] - span_v * 0.5).clamp(0.0, 1.0),
            ];
            let max = [
                (center[0] + span_u * 0.5).clamp(0.0, 1.0),
                (center[1] + span_v * 0.5).clamp(0.0, 1.0),
            ];
            (min, max)
        } else {
            ([0.0, 0.0], [1.0, 1.0])
        }
    }

    /// Native `target_mip_level`.
    pub fn target_mip_level(
        &self,
        params: &VtViewParams,
        render_width: u32,
        render_height: u32,
    ) -> u32 {
        let (uv_min, uv_max) = self.native_visible_uv_rect(params);
        let uv_span_x = (uv_max[0] - uv_min[0]).max(1.0 / render_width.max(1) as f32);
        let uv_span_y = (uv_max[1] - uv_min[1]).max(1.0 / render_height.max(1) as f32);
        let texels_per_pixel_x =
            self.virtual_size.0 as f32 * uv_span_x / render_width.max(1) as f32;
        let texels_per_pixel_y =
            self.virtual_size.1 as f32 * uv_span_y / render_height.max(1) as f32;
        let texels_per_pixel = texels_per_pixel_x.max(texels_per_pixel_y).max(1.0);
        let desired = texels_per_pixel.log2().floor().max(0.0) as u32;
        desired.min(self.max_mip_levels.saturating_sub(1))
    }

    /// Native `collect_requests`: tiles covering the visible uv rect at
    /// the desired mip + their ancestors + pending feedback (+ancestors),
    /// sorted by `(mip_level, material_index, y, x)`.
    pub fn collect_requests(
        &self,
        params: &VtViewParams,
        render_width: u32,
        render_height: u32,
        use_feedback: bool,
    ) -> Vec<TileKey> {
        let desired_mip = self.target_mip_level(params, render_width, render_height);
        let (uv_min, uv_max) = self.native_visible_uv_rect(params);
        let (pages_x, pages_y) = self.pages_at_mip(desired_mip);
        let start_x = ((uv_min[0] * pages_x as f32).floor() as i32).clamp(0, pages_x as i32 - 1);
        let start_y = ((uv_min[1] * pages_y as f32).floor() as i32).clamp(0, pages_y as i32 - 1);
        let end_x = ((uv_max[0] * pages_x as f32).ceil() as i32 - 1).clamp(0, pages_x as i32 - 1);
        let end_y = ((uv_max[1] * pages_y as f32).ceil() as i32 - 1).clamp(0, pages_y as i32 - 1);

        let mut requests = HashSet::new();
        for material_index in self.sources.keys().copied() {
            for y in start_y..=end_y {
                for x in start_x..=end_x {
                    self.insert_tile_with_ancestors(
                        &mut requests,
                        TileKey {
                            material_index,
                            x: x as u32,
                            y: y as u32,
                            mip_level: desired_mip,
                        },
                    );
                }
            }
        }

        if use_feedback {
            for feedback in &self.pending_feedback {
                if self.sources.contains_key(&feedback.material_index) {
                    self.insert_tile_with_ancestors(&mut requests, *feedback);
                }
            }
        }

        let mut ordered = requests.into_iter().collect::<Vec<_>>();
        ordered.sort_by_key(|key| (key.mip_level, key.material_index, key.y, key.x));
        ordered
    }

    /// Native `ensure_tile_resident` (GPU-free): `Some(TileUpload)` when
    /// the tile was newly streamed into an atlas slot, `None` on cache
    /// hit, missing source, or allocation failure. Updates hit/miss,
    /// streamed, and eviction counters and the page table.
    pub fn ensure_resident(&mut self, key: TileKey) -> Option<TileUpload> {
        let cache_tile = self.encode_cache_tile(key);
        if self.cache.is_resident(&cache_tile) {
            self.cache.access(&cache_tile);
            self.stats.cache_hits += 1;
            return None;
        }

        let source = self.sources.get(&key.material_index).cloned()?;

        self.stats.cache_misses += 1;
        let (slot, evicted) = self.cache.allocate(cache_tile)?;
        for evicted_tile in evicted {
            self.clear_page_entry(self.decode_cache_tile(evicted_tile));
        }

        let rgba = self.build_tile_data(&source, key);
        let (atlas_x, atlas_y) = self.cache.slot_origin(slot);
        self.stats.tiles_streamed += 1;
        self.stats.evictions = self.cache.evictions as u32;
        self.set_page_entry(key, slot);
        Some(TileUpload {
            atlas_x,
            atlas_y,
            size: self.slot_size,
            rgba,
        })
    }

    /// Record an upload duration (native `last_upload_ms` /
    /// `avg_upload_ms` update: running average over `tiles_streamed`).
    pub fn record_upload_ms(&mut self, ms: f32) {
        self.stats.last_upload_ms = ms;
        let stream_count = self.stats.tiles_streamed.max(1) as f32;
        self.stats.avg_upload_ms =
            ((self.stats.avg_upload_ms * (stream_count - 1.0)) + ms) / stream_count;
    }

    /// Native feedback processing (`finish_frame`): replaces
    /// `pending_feedback` with the bounds-filtered request set;
    /// `material_index = frame_number - 1`.
    pub fn apply_feedback(&mut self, entries: &[FeedbackEntry]) {
        self.pending_feedback.clear();
        for entry in entries {
            let material_index = entry.frame_number.saturating_sub(1);
            if !self.sources.contains_key(&material_index) {
                continue;
            }
            if entry.mip_level >= self.max_mip_levels {
                continue;
            }
            let (pages_x, pages_y) = self.pages_at_mip(entry.mip_level);
            if entry.tile_x >= pages_x || entry.tile_y >= pages_y {
                continue;
            }
            self.pending_feedback.push(TileKey {
                material_index,
                x: entry.tile_x,
                y: entry.tile_y,
                mip_level: entry.mip_level,
            });
        }
        self.stats.feedback_requests = self.pending_feedback.len() as u32;
    }

    /// Packed page-table texels `[atlas_u, atlas_v, resident, mip_bias]`
    /// for `(material_index, mip_level)`.
    pub fn page_table_texels(&self, material_index: u32, mip_level: u32) -> Vec<[f32; 4]> {
        if material_index >= self.material_count || mip_level >= self.max_mip_levels {
            return Vec::new();
        }
        self.page_tables[self.layer_mip_index(material_index, mip_level)]
            .iter()
            .map(|entry| {
                [
                    entry.atlas_u,
                    entry.atlas_v,
                    if entry.is_resident > 0 { 1.0 } else { 0.0 },
                    entry.mip_bias,
                ]
            })
            .collect()
    }

    /// Dirty `(material_index, mip_level)` page-table layers since the
    /// last call (sorted, cleared on read).
    pub fn take_dirty_layers(&mut self) -> Vec<(u32, u32)> {
        std::mem::take(&mut self.dirty_layers).into_iter().collect()
    }

    /// Per-material fallback colors (`MATERIAL_CAPACITY` slots; layer
    /// fallback for unregistered indices).
    pub fn fallback_colors(
        &self,
        layer_fallback: [f32; 4],
    ) -> [[f32; 4]; TERRAIN_VT_MATERIAL_CAPACITY] {
        let mut colors = [layer_fallback; TERRAIN_VT_MATERIAL_CAPACITY];
        for (material_index, source) in &self.sources {
            if (*material_index as usize) < colors.len() {
                colors[*material_index as usize] = source.fallback_color;
            }
        }
        colors
    }

    /// Snapshot stats (native `refresh_stats` + `miss_rate` derivation).
    pub fn stats(&self) -> VtStats {
        let mut stats = self.stats;
        stats.resident_pages = self.cache.resident_count() as u32;
        let resident_bytes = stats.resident_pages as u64
            * self.slot_size as u64
            * self.slot_size as u64
            * TERRAIN_VT_BYTES_PER_PIXEL as u64;
        stats.resident_megabytes = resident_bytes as f32 / (1024.0 * 1024.0);
        let total_requests = stats.cache_hits + stats.cache_misses;
        stats.miss_rate = if total_requests == 0 {
            0.0
        } else {
            stats.cache_misses as f32 / total_requests as f32
        };
        stats
    }

    /// Whether `key`'s cache tile is resident.
    pub fn is_resident(&self, key: TileKey) -> bool {
        self.cache.is_resident(&self.encode_cache_tile(key))
    }

    /// Pages visible tile key at `key`'s position `mip + 1`, i.e. the
    /// native ancestor step (`x/2`, `y/2`, `mip+1`) capped at the top.
    pub fn ancestor(&self, key: TileKey) -> Option<TileKey> {
        if key.mip_level + 1 >= self.max_mip_levels {
            return None;
        }
        Some(TileKey {
            material_index: key.material_index,
            x: key.x / 2,
            y: key.y / 2,
            mip_level: key.mip_level + 1,
        })
    }

    /// Native `build_tile_data`: slot-sized tile with border pixels
    /// clamped to the mip edge (`src = key * tile_size + slot - border`,
    /// clamped `[0, dim-1]`).
    pub fn build_tile_data(&self, source: &PreparedVtSource, key: TileKey) -> Vec<u8> {
        let mip = &source.mips[key.mip_level as usize];
        let slot_size = self.slot_size as usize;
        let tile_size = self.tile_size as i32;
        let tile_border = self.tile_border as i32;
        let mut data = vec![0u8; slot_size * slot_size * TERRAIN_VT_BYTES_PER_PIXEL];

        for slot_y in 0..slot_size {
            for slot_x in 0..slot_size {
                let src_x = (key.x as i32 * tile_size + slot_x as i32 - tile_border)
                    .clamp(0, mip.width as i32 - 1) as usize;
                let src_y = (key.y as i32 * tile_size + slot_y as i32 - tile_border)
                    .clamp(0, mip.height as i32 - 1) as usize;
                let src_index = (src_y * mip.width as usize + src_x) * TERRAIN_VT_BYTES_PER_PIXEL;
                let dst_index = (slot_y * slot_size + slot_x) * TERRAIN_VT_BYTES_PER_PIXEL;
                data[dst_index..dst_index + TERRAIN_VT_BYTES_PER_PIXEL]
                    .copy_from_slice(&mip.data[src_index..src_index + TERRAIN_VT_BYTES_PER_PIXEL]);
            }
        }
        data
    }

    fn insert_tile_with_ancestors(&self, requests: &mut HashSet<TileKey>, mut key: TileKey) {
        loop {
            if !requests.insert(key) {
                break;
            }
            if key.mip_level + 1 >= self.max_mip_levels {
                break;
            }
            key = TileKey {
                material_index: key.material_index,
                x: key.x / 2,
                y: key.y / 2,
                mip_level: key.mip_level + 1,
            };
        }
    }

    fn pages_at_mip(&self, mip_level: u32) -> (u32, u32) {
        pages_for_mip_counts(self.pages_x0, self.pages_y0, mip_level)
    }

    fn layer_mip_index(&self, material_index: u32, mip_level: u32) -> usize {
        (material_index * self.max_mip_levels + mip_level) as usize
    }

    fn encode_cache_tile(&self, key: TileKey) -> CacheTile {
        CacheTile {
            x: key.material_index * self.pages_x0.max(1) + key.x,
            y: key.y,
            mip_level: key.mip_level,
        }
    }

    fn decode_cache_tile(&self, tile: CacheTile) -> TileKey {
        TileKey {
            material_index: tile.x / self.pages_x0.max(1),
            x: tile.x % self.pages_x0.max(1),
            y: tile.y,
            mip_level: tile.mip_level,
        }
    }

    fn set_page_entry(&mut self, key: TileKey, slot: u32) {
        if key.material_index >= self.material_count || key.mip_level >= self.max_mip_levels {
            return;
        }
        let (pages_x, pages_y) = self.pages_at_mip(key.mip_level);
        if key.x >= pages_x || key.y >= pages_y {
            return;
        }
        let layer_index = self.layer_mip_index(key.material_index, key.mip_level);
        let page_index = (key.y * pages_x + key.x) as usize;
        let (atlas_x, atlas_y) = self.cache.slot_origin(slot);
        if let Some(entry) = self.page_tables[layer_index].get_mut(page_index) {
            entry.atlas_u = atlas_x as f32 / self.atlas_size as f32;
            entry.atlas_v = atlas_y as f32 / self.atlas_size as f32;
            entry.is_resident = 1;
            entry.mip_bias = 0.0;
        }
        self.dirty_layers
            .insert((key.material_index, key.mip_level));
    }

    fn clear_page_entry(&mut self, key: TileKey) {
        if key.material_index >= self.material_count || key.mip_level >= self.max_mip_levels {
            return;
        }
        let layer_index = self.layer_mip_index(key.material_index, key.mip_level);
        let (pages_x, pages_y) = self.pages_at_mip(key.mip_level);
        if key.x >= pages_x || key.y >= pages_y {
            return;
        }
        let page_index = (key.y * pages_x + key.x) as usize;
        if let Some(entry) = self.page_tables[layer_index].get_mut(page_index) {
            *entry = PageTableEntry::default();
        }
        self.dirty_layers
            .insert((key.material_index, key.mip_level));
    }

    // ---- read-only accessors ----

    pub fn virtual_size(&self) -> (u32, u32) {
        self.virtual_size
    }
    pub fn tile_size(&self) -> u32 {
        self.tile_size
    }
    pub fn tile_border(&self) -> u32 {
        self.tile_border
    }
    pub fn slot_size(&self) -> u32 {
        self.slot_size
    }
    pub fn atlas_size(&self) -> u32 {
        self.atlas_size
    }
    pub fn material_count(&self) -> u32 {
        self.material_count
    }
    pub fn max_mip_levels(&self) -> u32 {
        self.max_mip_levels
    }
    pub fn pages_x0(&self) -> u32 {
        self.pages_x0
    }
    pub fn pages_y0(&self) -> u32 {
        self.pages_y0
    }
    pub fn budget_pages(&self) -> u32 {
        self.budget_pages
    }
    pub fn source_generation(&self) -> u64 {
        self.source_generation
    }
    pub fn use_feedback(&self) -> bool {
        self.use_feedback
    }
    pub fn prepared_source(&self, material_index: u32) -> Option<&PreparedVtSource> {
        self.sources.get(&material_index)
    }
    pub fn prepared_source_count(&self) -> usize {
        self.sources.len()
    }
    pub fn pending_feedback(&self) -> &[TileKey] {
        &self.pending_feedback
    }
}
