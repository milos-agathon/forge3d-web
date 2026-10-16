//! W08 (E2/E3/E4): clipmap geometry, streamed heightfield runtime state and
//! GPU LOD-selection readback for the wasm terrain path.
//!
//! The clipmap vertex data reuses the 20-byte `TerrainVertex` layout exactly:
//! `position = [grid_x, morph, grid_z]`, `uv = [ring, flags]`. One grid unit
//! equals the clipmap `base_cell_size`; `grid` is absolute units relative to
//! the layout anchor so the ring centers are baked into the vertex buffer and
//! the buffer is rewritten (constant size) whenever the snapped layout
//! changes. All GPU-facing height lookup goes through the
//! `terrain_height_*` WGSL helpers declared in the terrain template; this
//! module only owns the Rust-side state and buffer/texture plumbing.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use forge3d_core::gpu::GpuContext;
use forge3d_core::terrain::{TerrainClipmapGeometry, TerrainHeightmapInput, TerrainStreaming};
use forge3d_core::terrain_clipmap::{
    estimate_triangle_count, ClipmapConfig, ClipmapLayout, ClipmapMesh, FrustumPlanes,
};
use forge3d_core::terrain_stream::{
    plan_clipmap_requests, CoalescePolicy, Completion, HeightMosaic, HeightPyramid,
    HeightfieldPlacement, PlannedTile, RequestOutcome, StreamPlanConfig, TileId, TileRequestQueue,
};
use wgpu::util::DeviceExt;

use super::terrain::TerrainVertex;
use crate::error::{map_core_error, Forge3DErrorCode, WebError};

/// `TerrainGeometryUniform.mode_flags`: the clipmap vertex path is active.
pub(super) const GEOMETRY_FLAG_CLIPMAP: u32 = 1;
/// `TerrainGeometryUniform.mode_flags`: the streamed atlas/page-table is bound.
pub(super) const GEOMETRY_FLAG_STREAMING: u32 = 2;

/// Coarse proxy grid resolution for the clipmap shadow caster (E2).
const SHADOW_PROXY_MAX_DIM: u32 = 257;

/// Group-0 binding 12 uniform: clipmap + streamed heightfield parameters.
///
/// Always bound by every terrain bind group; zeroed for plain grid inputs.
/// The field order is part of the shader contract — `uniform_layout` tests in
/// `terrain.rs` pin the WGSL offsets.
#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct TerrainGeometryUniform {
    /// World size of one level-0 clipmap grid unit per axis (`s0`).
    pub s0: [f32; 2],
    /// World XZ of clipmap grid unit `(0, 0)`.
    pub anchor: [f32; 2],
    /// Skirt drop in world units.
    pub skirt_depth: f32,
    /// Clipmap ring count (0 for grid mode).
    pub ring_count: u32,
    /// `GEOMETRY_FLAG_*` bits.
    pub mode_flags: u32,
    /// Streaming pyramid depth (0 without streaming).
    pub lod_count: u32,
    /// World XZ of finest-level heightfield sample `(0, 0)`.
    pub hf_origin: [f32; 2],
    /// World spacing of one finest-level heightfield sample per axis.
    pub hf_spacing: [f32; 2],
    /// Finest-level heightfield dimensions in samples.
    pub hf_dims: [u32; 2],
    /// Streamed tile size in texels.
    pub tile_size: u32,
    /// Atlas slots per row.
    pub slots_per_row: u32,
    /// Committed base-level texture dimensions (the dense `heights`).
    pub base_dims: [u32; 2],
    /// Geo-morph blend range (`[0, 1]`, informational — morph is per-vertex).
    pub morph_range: f32,
    pub _pad0: f32,
    /// Per-ring data lod, packed 4 per vec4 for up to 16 rings.
    pub ring_data_lod: [[u32; 4]; 4],
}

impl TerrainGeometryUniform {
    /// Zeroed uniform for plain grid terrain (binding 12 stays bound).
    pub(super) fn grid() -> Self {
        Self::default()
    }

    /// Uniform contents for a committed clipmap/streaming input.
    ///
    /// `ring_data_lod` is the per-ring data-LOD table the vertex stage walks:
    /// `clamp(ring + lod_bias, 0, lod_count - 1)` under streaming, all zero for
    /// a dense clipmap (only lod 0 exists).
    pub(super) fn for_input(
        terrain: &TerrainHeightmapInput,
        clipmap: &ClipmapGeometryState,
        streaming: Option<&HeightStreamingState>,
    ) -> Self {
        let (hf_w, hf_h) = terrain.heightfield_dims();
        let mut uniform = Self {
            s0: clipmap.s0,
            anchor: clipmap.anchor,
            skirt_depth: clipmap.config.skirt_depth,
            ring_count: clipmap.config.ring_count,
            mode_flags: GEOMETRY_FLAG_CLIPMAP,
            lod_count: 0,
            hf_origin: terrain.heightfield_origin(),
            hf_spacing: terrain.spacing,
            hf_dims: [hf_w, hf_h],
            tile_size: 0,
            slots_per_row: 0,
            base_dims: [terrain.width, terrain.height],
            morph_range: clipmap.config.morph_range,
            _pad0: 0.0,
            ring_data_lod: [[0; 4]; 4],
        };
        if let Some(stream) = streaming {
            uniform.mode_flags |= GEOMETRY_FLAG_STREAMING;
            uniform.lod_count = stream.pyramid.lod_count();
            uniform.tile_size = stream.pyramid.tile_size();
            uniform.slots_per_row = stream.slots_per_row;
            let last = stream.pyramid.lod_count() - 1;
            for ring in 0..clipmap.config.ring_count.min(16) {
                let lod = (ring as i64 + stream.plan.lod_bias as i64).clamp(0, last as i64) as u32;
                uniform.ring_data_lod[ring as usize / 4][ring as usize % 4] = lod;
            }
        }
        uniform
    }
}

/// Camera-facing clipmap state for one committed terrain.
///
/// The mesh is generated once at commit and regenerated whenever the snapped
/// ring centers move (`layout.changed`); vertex/index counts are constant by
/// construction, so the GPU buffers are fixed-size and rewritten in place.
pub(super) struct ClipmapGeometryState {
    pub config: ClipmapConfig,
    /// `s0` per axis (world units per level-0 grid unit).
    pub s0: [f32; 2],
    /// World XZ of grid unit `(0, 0)` — the heightfield origin, so grid unit
    /// `i` coincides with finest sample `i` when `s0 == spacing`.
    pub anchor: [f32; 2],
    pub layout: ClipmapLayout,
    /// Packed `TerrainVertex` data for the current layout.
    pub vertices: Vec<TerrainVertex>,
    pub indices: Vec<u32>,
    pub triangle_budget: u64,
    pub full_resolution_triangles: u64,
    /// Subsampled dense proxy drawn by the shadow depth pass (E2).
    pub shadow_caster: [u32; 2],
}

impl ClipmapGeometryState {
    pub(super) fn new(
        geometry: &TerrainClipmapGeometry,
        terrain: &TerrainHeightmapInput,
        camera_xz: [f32; 2],
    ) -> Result<Self, WebError> {
        let config = geometry.clipmap_config().map_err(map_core_error)?;
        let anchor = terrain.heightfield_origin();
        let layout =
            ClipmapLayout::for_camera_axes(&config, geometry.base_cell_size, anchor, camera_xz);
        let mesh = ClipmapMesh::generate(&config, &layout);
        let shadow_caster = shadow_proxy_dims(terrain.width, terrain.height);
        let triangle_budget = estimate_triangle_count(&config);
        let full_resolution_triangles = mesh.full_resolution_triangles;
        Ok(Self {
            config,
            s0: geometry.base_cell_size,
            anchor,
            layout,
            vertices: pack_clipmap_vertices(&mesh),
            indices: mesh.indices,
            triangle_budget,
            full_resolution_triangles,
            shadow_caster,
        })
    }

    /// Snaps ring centers to `camera_xz`; on change regenerates the packed
    /// mesh and returns it for `queue.write_buffer`. `None` = unchanged.
    pub(super) fn update_layout(
        &mut self,
        camera_xz: [f32; 2],
    ) -> Option<(&[TerrainVertex], &[u32])> {
        let layout = ClipmapLayout::for_camera_axes(&self.config, self.s0, self.anchor, camera_xz);
        if !layout.changed(&self.layout) {
            return None;
        }
        self.layout = layout;
        let mesh = ClipmapMesh::generate(&self.config, &self.layout);
        debug_assert_eq!(
            mesh.vertices.len(),
            self.vertices.len(),
            "clipmap vertex count changed across layouts"
        );
        debug_assert_eq!(
            mesh.indices.len(),
            self.indices.len(),
            "clipmap index count changed across layouts"
        );
        self.vertices = pack_clipmap_vertices(&mesh);
        self.indices = mesh.indices;
        Some((&self.vertices, &self.indices))
    }

    /// `terrain:clipmap` ledger bytes: the fixed-size clipmap vertex/index
    /// buffers, the geometry uniform and the shadow-proxy grid. Known from
    /// the CPU state, so the commit pre-checks it before any allocation.
    pub(super) fn gpu_bytes(&self) -> u64 {
        (self.vertices.len() * std::mem::size_of::<TerrainVertex>()
            + self.indices.len() * std::mem::size_of::<u32>()) as u64
            + std::mem::size_of::<TerrainGeometryUniform>() as u64
            + shadow_proxy_bytes(self.shadow_caster)
    }

    /// Snapped ring centers as world `[[x, z]]` pairs for the geometry report.
    pub(super) fn centers_world(&self) -> Vec<[f32; 2]> {
        self.layout
            .centers
            .iter()
            .map(|center| {
                [
                    self.anchor[0] + center[0] as f32 * self.s0[0],
                    self.anchor[1] + center[1] as f32 * self.s0[1],
                ]
            })
            .collect()
    }
}

/// Packs `ClipmapVertex` records into the 20-byte `TerrainVertex` layout:
/// `position = [grid_x, morph, grid_z]`, `uv = [ring, flags]`.
fn pack_clipmap_vertices(mesh: &ClipmapMesh) -> Vec<TerrainVertex> {
    mesh.vertices
        .iter()
        .map(|vertex| TerrainVertex {
            position: [vertex.grid[0] as f32, vertex.morph, vertex.grid[1] as f32],
            uv: [vertex.ring as f32, vertex.flags as f32],
        })
        .collect()
}

/// Subsampled proxy-grid dims over the base texture (`<= 257` per axis, E2).
fn shadow_proxy_dims(width: u32, height: u32) -> [u32; 2] {
    [
        width.clamp(2, SHADOW_PROXY_MAX_DIM),
        height.clamp(2, SHADOW_PROXY_MAX_DIM),
    ]
}

/// GPU bytes of the `[cols, rows]` shadow-proxy grid `shadow_proxy_mesh`
/// builds (vertices + two triangles per cell).
pub(super) fn shadow_proxy_bytes([cols, rows]: [u32; 2]) -> u64 {
    u64::from(cols) * u64::from(rows) * std::mem::size_of::<TerrainVertex>() as u64
        + u64::from(cols - 1) * u64::from(rows - 1) * 6 * std::mem::size_of::<u32>() as u64
}

/// Builds the dense shadow-caster proxy grid (world XZ positions spanning the
/// committed base heightfield footprint, uv over the base texture). Drawn by
/// `vs_terrain_depth` unchanged in clipmap mode.
pub(super) fn shadow_proxy_mesh(terrain: &TerrainHeightmapInput) -> (Vec<TerrainVertex>, Vec<u32>) {
    let [cols, rows] = shadow_proxy_dims(terrain.width, terrain.height);
    let origin = terrain.heightfield_origin();
    let (hf_w, hf_h) = terrain.heightfield_dims();
    // The committed base texture covers the same world footprint as the
    // finest level; sample `i` of the base sits at finest sample
    // `i * 2^(lod_count-1)` (edge-clipped), so the footprint is measured in
    // finest-sample spacing either way.
    let extent = [
        (hf_w.saturating_sub(1)) as f32 * terrain.spacing[0],
        (hf_h.saturating_sub(1)) as f32 * terrain.spacing[1],
    ];
    let mut vertices = Vec::with_capacity((cols * rows) as usize);
    for y in 0..rows {
        let v = y as f32 / (rows - 1) as f32;
        for x in 0..cols {
            let u = x as f32 / (cols - 1) as f32;
            vertices.push(TerrainVertex {
                position: [origin[0] + u * extent[0], 0.0, origin[1] + v * extent[1]],
                uv: [u, v],
            });
        }
    }
    let mut indices = Vec::with_capacity((cols - 1) as usize * (rows - 1) as usize * 6);
    for y in 0..(rows - 1) {
        for x in 0..(cols - 1) {
            let tl = y * cols + x;
            let tr = tl + 1;
            let bl = tl + cols;
            let br = bl + 1;
            indices.extend_from_slice(&[tl, tr, bl, tr, br, bl]);
        }
    }
    (vertices, indices)
}

// ---------------------------------------------------------------------------
// E3: streamed heightfield runtime state.
// ---------------------------------------------------------------------------

/// GPU + bookkeeping state of a committed `terrain.streaming` declaration.
///
/// The atlas is an R32Float texture of `tile_size` x `tile_size` slots laid
/// out `slots_per_row` wide; the page table is an R32Uint `texture_2d_array`
/// with one layer per lod and `tiles_at(0)` texels per layer (`slot + 1`,
/// `0` = absent), exactly the layout `HeightMosaic::page_table` produces.
pub(super) struct HeightStreamingState {
    pub pyramid: HeightPyramid,
    pub mosaic: HeightMosaic,
    pub queue: TileRequestQueue,
    pub plan: StreamPlanConfig,
    pub placement: HeightfieldPlacement,
    pub atlas: wgpu::Texture,
    pub atlas_view: wgpu::TextureView,
    pub page_table: wgpu::Texture,
    pub page_table_view: wgpu::TextureView,
    pub slots_per_row: u32,
    /// Latest `planHeightTiles` plan (for `converged` / stats).
    pub last_plan: Vec<PlannedTile>,
    /// Last GPU LOD selection used to filter non-prefetch requests.
    pub lod_visibility: Option<HashSet<TileId>>,
    /// E4 GPU LOD-selection pass over the lod-0 tile grid.
    pub lod_select: Option<GpuLodSelect>,
    /// `streaming.maxResidentBytes` (stats echo).
    pub max_resident_bytes: u64,
    /// True once the committed coarse heights are resident (stats echo).
    pub coarse_prefilled: bool,
    pub tiles_uploaded: u64,
    pub tiles_failed: u64,
}

impl HeightStreamingState {
    /// Allocates the atlas/page-table textures, pins the coarsest level and
    /// uploads the committed base heights into its slot.
    pub(super) fn new(
        context: &GpuContext,
        terrain: &TerrainHeightmapInput,
        streaming: &TerrainStreaming,
    ) -> Result<Self, WebError> {
        let pyramid = HeightPyramid::new(streaming.width, streaming.height, streaming.tile_size)
            .map_err(map_core_error)?;
        let mut mosaic =
            HeightMosaic::new(pyramid.clone(), streaming.slot_capacity).map_err(map_core_error)?;
        mosaic.pin_coarsest().map_err(map_core_error)?;

        let (slots_per_row, rows) = streaming.atlas_grid();
        let t = streaming.tile_size;
        let atlas = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-web-terrain-height-atlas"),
            size: wgpu::Extent3d {
                width: slots_per_row * t,
                height: rows * t,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor::default());

        let (tiles_x, tiles_y) = pyramid.tiles_at(0);
        let page_table = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("forge3d-web-terrain-height-page-table"),
            size: wgpu::Extent3d {
                width: tiles_x,
                height: tiles_y,
                depth_or_array_layers: streaming.lod_count,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R32Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let page_table_view = page_table.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        let policy = match streaming.coalesce_policy {
            forge3d_core::terrain::TerrainCoalescePolicy::PreferCoarse => {
                CoalescePolicy::PreferCoarse
            }
            forge3d_core::terrain::TerrainCoalescePolicy::PreferFine => CoalescePolicy::PreferFine,
        };
        let mut state = Self {
            pyramid,
            mosaic,
            queue: TileRequestQueue::new(streaming.max_in_flight as usize, policy),
            plan: StreamPlanConfig {
                lod_bias: streaming.lod_bias,
                prefetch_margin_tiles: streaming.prefetch_margin_tiles,
            },
            placement: HeightfieldPlacement {
                origin: terrain.heightfield_origin(),
                spacing: terrain.spacing,
            },
            atlas,
            atlas_view,
            page_table,
            page_table_view,
            slots_per_row,
            last_plan: Vec::new(),
            lod_visibility: None,
            lod_select: None,
            max_resident_bytes: streaming.max_resident_bytes,
            coarse_prefilled: false,
            tiles_uploaded: 0,
            tiles_failed: 0,
        };
        state.lod_select = Some(GpuLodSelect::new(
            context,
            &state.lod0_tiles(terrain),
            state.lod_terrain_params(terrain),
        ));
        state.upload_coarse_base(context, terrain)?;
        state.coarse_prefilled = true;
        Ok(state)
    }

    /// One `LodTileInfo` per lod-0 tile: world XZ bounds (edge-clipped) and
    /// the `[min, max]` height range of the committed coarse data covering
    /// the tile footprint (E4: per-tile ranges come from the base level).
    fn lod0_tiles(&self, terrain: &TerrainHeightmapInput) -> Vec<LodTileInfo> {
        let (tiles_x, tiles_y) = self.pyramid.tiles_at(0);
        let top = self.pyramid.lod_count() - 1;
        let t = self.pyramid.tile_size();
        let origin = terrain.heightfield_origin();
        let (hf_w, hf_h) = terrain.heightfield_dims();
        let mut tiles = Vec::with_capacity((tiles_x * tiles_y) as usize);
        for y in 0..tiles_y {
            for x in 0..tiles_x {
                let i0 = (x * t).min(hf_w - 1);
                let j0 = (y * t).min(hf_h - 1);
                let i1 = ((x + 1) * t).min(hf_w - 1);
                let j1 = ((y + 1) * t).min(hf_h - 1);
                let bounds_min = [
                    origin[0] + i0 as f32 * terrain.spacing[0],
                    origin[1] + j0 as f32 * terrain.spacing[1],
                ];
                let bounds_max = [
                    origin[0] + i1 as f32 * terrain.spacing[0],
                    origin[1] + j1 as f32 * terrain.spacing[1],
                ];
                // Coarse-sample footprint of this lod-0 tile:
                // `min(i >> top, dim - 1)` is the inverse of `finest_sample`.
                let ci0 = (i0 >> top).min(terrain.width - 1);
                let cj0 = (j0 >> top).min(terrain.height - 1);
                let ci1 = (i1 >> top).min(terrain.width - 1);
                let cj1 = (j1 >> top).min(terrain.height - 1);
                let mut h_min = f32::INFINITY;
                let mut h_max = f32::NEG_INFINITY;
                for cy in cj0..=cj1 {
                    for cx in ci0..=ci1 {
                        let value = terrain.heights[(cy * terrain.width + cx) as usize];
                        if value.is_finite() {
                            h_min = h_min.min(value);
                            h_max = h_max.max(value);
                        }
                    }
                }
                if !h_min.is_finite() {
                    h_min = 0.0;
                    h_max = 0.0;
                }
                tiles.push(LodTileInfo {
                    tile_id: forge3d_core::terrain_clipmap::pack_tile_id(0, x, y),
                    bounds_min,
                    bounds_max,
                    distance: 0.0,
                    selected_lod: 0,
                    height_min: h_min,
                    height_max: h_max,
                    visible: 0,
                });
            }
        }
        tiles
    }

    /// `[terrain_world_width, lod0_tile_world_size, tiles_x, tiles_y]`.
    fn lod_terrain_params(&self, terrain: &TerrainHeightmapInput) -> [f32; 4] {
        let (tiles_x, tiles_y) = self.pyramid.tiles_at(0);
        let (hf_w, _) = terrain.heightfield_dims();
        [
            (hf_w - 1) as f32 * terrain.spacing[0],
            self.pyramid.tile_size() as f32 * terrain.spacing[0],
            tiles_x as f32,
            tiles_y as f32,
        ]
    }

    /// Writes the committed coarsest-level heights into the pinned slots.
    fn upload_coarse_base(
        &mut self,
        context: &GpuContext,
        terrain: &TerrainHeightmapInput,
    ) -> Result<(), WebError> {
        let top = self.pyramid.lod_count() - 1;
        let (tiles_x, tiles_y) = self.pyramid.tiles_at(top);
        let t = self.pyramid.tile_size();
        for ty in 0..tiles_y {
            for tx in 0..tiles_x {
                let id = TileId::new(top, tx, ty);
                let Some(slot) = self.mosaic.lookup(id) else {
                    return Err(WebError::new(
                        Forge3DErrorCode::InternalError,
                        "coarsest height tile was not pinned",
                    ));
                };
                let (w, h) = {
                    let (_, _, tw, th) = self.pyramid.tile_rect(id);
                    (tw, th)
                };
                let mut rect = Vec::with_capacity((w * h) as usize);
                for row in 0..h {
                    let start = ((ty * t + row) * terrain.width + tx * t) as usize;
                    rect.extend_from_slice(&terrain.heights[start..start + w as usize]);
                }
                self.upload_rect(context, slot, &rect, w, h)?;
            }
        }
        // Page-table upload goes through the regular dirty-lod flush.
        self.flush_page_table(context);
        Ok(())
    }

    /// Writes a `w` x `h` rect into an atlas slot, edge-replicating the rest
    /// of the `tile_size` x `tile_size` slot like the native uploader.
    fn upload_rect(
        &mut self,
        context: &GpuContext,
        slot: u32,
        data: &[f32],
        w: u32,
        h: u32,
    ) -> Result<(), WebError> {
        let t = self.pyramid.tile_size();
        if data.len() != (w * h) as usize || w == 0 || h == 0 || w > t || h > t {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                format!(
                    "tile payload {} does not match tile rect {w}x{h} (tile size {t})",
                    data.len()
                ),
            ));
        }
        let mut padded = vec![0.0f32; (t * t) as usize];
        for row in 0..t {
            let src_row = row.min(h - 1);
            for col in 0..t {
                let src_col = col.min(w - 1);
                padded[(row * t + col) as usize] = data[(src_row * w + src_col) as usize];
            }
        }
        let (ox, oy) = self.mosaic.slot_origin(slot, self.slots_per_row);
        context.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.atlas,
                mip_level: 0,
                origin: wgpu::Origin3d { x: ox, y: oy, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            bytemuck::cast_slice(&padded),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(t * 4),
                rows_per_image: Some(t),
            },
            wgpu::Extent3d {
                width: t,
                height: t,
                depth_or_array_layers: 1,
            },
        );
        self.tiles_uploaded += 1;
        Ok(())
    }

    /// Uploads every dirty page-table layer (called before render/readback).
    pub(super) fn flush_page_table(&mut self, context: &GpuContext) {
        for lod in self.mosaic.take_dirty_lods() {
            let table = self.mosaic.page_table(lod);
            let (tiles_x, tiles_y) = self.pyramid.tiles_at(lod);
            let row_bytes = tiles_x * 4;
            if row_bytes % wgpu::COPY_BYTES_PER_ROW_ALIGNMENT == 0 {
                context.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.page_table,
                        mip_level: 0,
                        origin: wgpu::Origin3d { x: 0, y: 0, z: lod },
                        aspect: wgpu::TextureAspect::All,
                    },
                    bytemuck::cast_slice(&table),
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(row_bytes),
                        rows_per_image: Some(tiles_y),
                    },
                    wgpu::Extent3d {
                        width: tiles_x,
                        height: tiles_y,
                        depth_or_array_layers: 1,
                    },
                );
            } else {
                // Unaligned rows upload one row at a time (as the R32Float
                // heightmap path does for odd widths).
                for y in 0..tiles_y {
                    let start = (y * tiles_x) as usize;
                    context.queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &self.page_table,
                            mip_level: 0,
                            origin: wgpu::Origin3d { x: 0, y, z: lod },
                            aspect: wgpu::TextureAspect::All,
                        },
                        bytemuck::cast_slice(&table[start..start + tiles_x as usize]),
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: None,
                            rows_per_image: None,
                        },
                        wgpu::Extent3d {
                            width: tiles_x,
                            height: 1,
                            depth_or_array_layers: 1,
                        },
                    );
                }
            }
        }
    }

    /// `planHeightTiles` (E3): plans the clipmap-driven request set, applies
    /// the latest GPU visibility filter, feeds the queue, cancels stale
    /// pending requests and touches resident planned tiles.
    pub(super) fn plan(
        &mut self,
        layout: &ClipmapLayout,
        config: &ClipmapConfig,
        max_requests: u32,
    ) -> (Vec<PlannedTile>, Vec<TileId>) {
        let mut planned =
            plan_clipmap_requests(layout, config, &self.pyramid, &self.placement, &self.plan);
        // GPU LOD visibility filter: a non-prefetch tile is dropped when no
        // lod-0 tile in its footprint survived frustum culling. No filter
        // applies before the first completed readback.
        if let Some(visible) = self.lod_visibility.as_ref() {
            planned.retain(|p| {
                if p.prefetch {
                    return true;
                }
                let (min, max) = lod0_tile_range(p.id);
                (min.0..=max.0)
                    .any(|x| (min.1..=max.1).any(|y| visible.contains(&TileId::new(0, x, y))))
            });
        }
        self.last_plan = planned.clone();

        let mut requests = Vec::new();
        for tile in &planned {
            if self.mosaic.lookup(tile.id).is_some() || self.queue.pending().contains(&tile.id) {
                continue;
            }
            if matches!(self.queue.request(tile.id), RequestOutcome::Enqueued) {
                requests.push(*tile);
                if requests.len() >= max_requests as usize {
                    break;
                }
            }
        }

        // Pending tiles the planner no longer wants are cancelled.
        let planned_ids: HashSet<TileId> = planned.iter().map(|tile| tile.id).collect();
        let stale: Vec<TileId> = self
            .queue
            .pending()
            .iter()
            .copied()
            .filter(|id| !planned_ids.contains(id))
            .collect();
        self.queue.cancel(&stale);

        // Resident planned tiles stay hot for the LRU.
        for tile in &planned {
            self.mosaic.touch(tile.id);
        }
        (requests, stale)
    }

    /// `completeHeightTile` (E3): queue completion, mosaic insert and atlas
    /// upload; `Ok(None)` = cancelled/backpressure rejection.
    pub(super) fn complete(
        &mut self,
        context: &GpuContext,
        id: TileId,
        heights: &[f32],
    ) -> Result<Option<forge3d_core::terrain_stream::InsertOutcome>, WebError> {
        if !self.pyramid.contains(id) {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                format!(
                    "height tile ({}, {}, {}) is outside the pyramid",
                    id.lod, id.x, id.y
                ),
            ));
        }
        let (_, _, w, h) = self.pyramid.tile_rect(id);
        if heights.len() != (w * h) as usize {
            return Err(WebError::new(
                Forge3DErrorCode::InvalidInput,
                format!(
                    "tile payload length {} does not match tile rect {w}x{h}",
                    heights.len()
                ),
            ));
        }
        if matches!(self.queue.complete(id), Completion::Discarded) {
            return Ok(None);
        }
        let outcome = match self.mosaic.insert(id) {
            Ok(outcome) => outcome,
            Err(_) => {
                // MosaicFull is the native backpressure signal: accepted=false.
                self.tiles_failed += 1;
                return Ok(None);
            }
        };
        self.upload_rect(context, outcome.slot, heights, w, h)?;
        Ok(Some(outcome))
    }

    /// `failHeightTile` (E3): releases the in-flight slot and counts it.
    pub(super) fn fail(&mut self, id: TileId) {
        self.queue.cancel(&[id]);
        self.tiles_failed += 1;
    }

    /// Every non-prefetch planned tile is resident at its planned lod.
    pub(super) fn converged(&self) -> bool {
        self.last_plan
            .iter()
            .filter(|tile| !tile.prefetch)
            .all(|tile| self.mosaic.lookup(tile.id).is_some())
    }

    /// Resident tiles below the coarsest (pinned) level.
    pub(super) fn resident_fine_tiles(&self) -> u32 {
        let top = self.pyramid.lod_count() - 1;
        (0..top)
            .map(|lod| {
                let (tx, ty) = self.pyramid.tiles_at(lod);
                (0..ty)
                    .flat_map(|y| (0..tx).map(move |x| TileId::new(lod, x, y)))
                    .filter(|id| self.mosaic.lookup(*id).is_some())
                    .count() as u32
            })
            .sum()
    }

    /// Atlas + page-table GPU bytes (ledger `terrain:height-stream`).
    pub(super) fn gpu_bytes(&self) -> u64 {
        let t = u64::from(self.pyramid.tile_size());
        let slots = u64::from(self.slots_per_row)
            * u64::from(
                self.mosaic
                    .slot_capacity()
                    .div_ceil(self.slots_per_row)
                    .max(1),
            );
        let (tiles_x, tiles_y) = self.pyramid.tiles_at(0);
        slots * t * t * 4
            + u64::from(tiles_x) * u64::from(tiles_y) * u64::from(self.pyramid.lod_count()) * 4
    }
}

/// `terrain:height-stream` ledger bytes for a streaming declaration: the
/// whole `slots_per_row x rows` R32Float atlas that is allocated (not just
/// `slot_capacity` slots) plus the R32Uint page table, one layer per lod.
pub(super) fn streaming_gpu_bytes(streaming: &TerrainStreaming) -> Result<u64, WebError> {
    let pyramid = HeightPyramid::new(streaming.width, streaming.height, streaming.tile_size)
        .map_err(map_core_error)?;
    let (atlas_width, atlas_height) = streaming.atlas_extent();
    let (tiles_x, tiles_y) = pyramid.tiles_at(0);
    Ok(atlas_width * atlas_height * 4
        + u64::from(tiles_x) * u64::from(tiles_y) * u64::from(pyramid.lod_count()) * 4)
}

/// `terrain:lod-select` ledger bytes for a streaming declaration (one
/// `LodTileInfo` per lod-0 tile).
pub(super) fn streaming_lod_select_gpu_bytes(
    streaming: &TerrainStreaming,
) -> Result<u64, WebError> {
    let pyramid = HeightPyramid::new(streaming.width, streaming.height, streaming.tile_size)
        .map_err(map_core_error)?;
    let (tiles_x, tiles_y) = pyramid.tiles_at(0);
    Ok(lod_select_gpu_bytes(tiles_x * tiles_y))
}

/// GPU bytes of the LOD-select pass over `tile_count` lod-0 tiles.
fn lod_select_gpu_bytes(tile_count: u32) -> u64 {
    let output_bytes = LOD_HEADER_BYTES + u64::from(tile_count) * 40;
    (std::mem::size_of::<LodSelectGpuParams>() as u64)
        + output_bytes // input tiles
        + (u64::from(tile_count.max(1))) * 40 // output tiles
        + LOD_HEADER_BYTES
        + output_bytes // staging
}

/// Inclusive lod-0 tile range covered by tile `id`.
fn lod0_tile_range(id: TileId) -> ((u32, u32), (u32, u32)) {
    let shift = id.lod;
    (
        (id.x << shift, id.y << shift),
        (
            ((id.x + 1) << shift).saturating_sub(1),
            ((id.y + 1) << shift).saturating_sub(1),
        ),
    )
}

// ---------------------------------------------------------------------------
// E4: GPU LOD selection (native gpu_lod port) with non-blocking readback.
// ---------------------------------------------------------------------------

/// `LodSelectParams` uniform for the compute pass (208 bytes).
#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct LodSelectGpuParams {
    pub view_proj: [[f32; 4]; 4],
    pub camera_pos: [f32; 4],
    pub frustum_planes: [[f32; 4]; 6],
    /// `[pixel_error_budget, viewport_height, fov_y, max_lod]`.
    pub lod_params: [f32; 4],
    /// `[terrain_world_width, world_tile_size, tiles_x, tiles_y]`.
    pub terrain_params: [f32; 4],
}

/// `TileInfo` record shared by the input/output storage buffers (40 bytes).
/// `bounds_*` come first so the `vec2<f32>` members land on 8-byte
/// boundaries: the WGSL storage stride then equals the `repr(C)` size (40).
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct LodTileInfo {
    pub bounds_min: [f32; 2],
    pub bounds_max: [f32; 2],
    pub tile_id: u32,
    pub distance: f32,
    pub selected_lod: u32,
    pub height_min: f32,
    pub height_max: f32,
    pub visible: u32,
}

const LOD_HEADER_BYTES: u64 = 16;

/// Latest harvested LOD selection (CPU-sorted by `(distance, tile_id)`).
#[derive(Debug, Clone, Default)]
pub(super) struct LodSelectResult {
    pub frame: u64,
    pub visible_count: u32,
    pub total_triangles: u64,
    pub tiles: Vec<LodTileInfo>,
    /// Visible lod-0 tile set used to filter `planHeightTiles`.
    pub visible_ids: HashSet<TileId>,
}

#[derive(Default)]
struct LodMapState {
    ready: bool,
    failed: bool,
}

/// GPU LOD-selection pass over the lod-0 tile grid (E4). The output header +
/// tile array are copied into one MAP_READ staging buffer; `map_async` runs
/// non-blocking and the latest completed result feeds `planHeightTiles`.
pub(super) struct GpuLodSelect {
    pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    params_buffer: wgpu::Buffer,
    output_buffer: wgpu::Buffer,
    header_buffer: wgpu::Buffer,
    staging: wgpu::Buffer,
    tile_count: u32,
    output_bytes: u64,
    /// `[terrain_world_width, world_tile_size, tiles_x, tiles_y]`.
    terrain_params: [f32; 4],
    map_state: Arc<Mutex<LodMapState>>,
    map_pending: bool,
    pub latest: Option<LodSelectResult>,
    pub frame: u64,
}

impl GpuLodSelect {
    /// Builds the pass for `tiles_at(0)` tiles. `tiles` carries each lod-0
    /// tile's world XZ bounds and its `[height_min, height_max]` range taken
    /// from the committed coarse base data.
    pub(super) fn new(
        context: &GpuContext,
        tiles: &[LodTileInfo],
        terrain_params: [f32; 4],
    ) -> Self {
        let tile_count = tiles.len() as u32;
        let output_bytes = LOD_HEADER_BYTES + tile_count as u64 * 40;
        let shader = context
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("forge3d-web-clipmap-lod-select"),
                source: wgpu::ShaderSource::Wgsl(include_str!("clipmap_lod_select.wgsl").into()),
            });
        let layout = context
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("forge3d-web-clipmap-lod-select-layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
        let pipeline_layout =
            context
                .device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("forge3d-web-clipmap-lod-select-pipeline-layout"),
                    bind_group_layouts: &[Some(&layout)],
                    immediate_size: 0,
                });
        let pipeline = context
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("forge3d-web-clipmap-lod-select-pipeline"),
                layout: Some(&pipeline_layout),
                module: &shader,
                entry_point: Some("cs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                cache: None,
            });
        let params_buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-web-clipmap-lod-params"),
            size: std::mem::size_of::<LodSelectGpuParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let input_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("forge3d-web-clipmap-lod-input"),
                contents: bytemuck::cast_slice(tiles),
                usage: wgpu::BufferUsages::STORAGE,
            });
        let output_buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-web-clipmap-lod-output"),
            size: tile_count.max(1) as u64 * 40,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let header_buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-web-clipmap-lod-header"),
            size: LOD_HEADER_BYTES,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let staging = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge3d-web-clipmap-lod-staging"),
            size: output_bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = context
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("forge3d-web-clipmap-lod-select-bind-group"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: params_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: input_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: output_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: header_buffer.as_entire_binding(),
                    },
                ],
            });
        Self {
            pipeline,
            bind_group,
            params_buffer,
            output_buffer,
            header_buffer,
            staging,
            tile_count,
            output_bytes,
            terrain_params,
            map_state: Arc::new(Mutex::new(LodMapState::default())),
            map_pending: false,
            latest: None,
            frame: 0,
        }
    }

    /// Total GPU buffer bytes for `terrain:lod-select` ledger accounting.
    pub(super) fn gpu_bytes(&self) -> u64 {
        lod_select_gpu_bytes(self.tile_count)
    }

    /// Per-frame camera write for the compute pass.
    pub(super) fn update_params(
        &self,
        context: &GpuContext,
        camera: &forge3d_core::camera::CameraInput,
        viewport_height: f32,
        max_lod: u32,
        aspect: f32,
    ) -> Result<(), WebError> {
        let view_proj = camera
            .view_projection_matrix(aspect)
            .map_err(map_core_error)?;
        let frustum = FrustumPlanes::from_view_proj(glam::Mat4::from_cols_array_2d(&view_proj));
        let params = LodSelectGpuParams {
            view_proj,
            camera_pos: [
                camera.position[0],
                camera.position[1],
                camera.position[2],
                1.0,
            ],
            frustum_planes: [
                frustum.planes[0].to_array(),
                frustum.planes[1].to_array(),
                frustum.planes[2].to_array(),
                frustum.planes[3].to_array(),
                frustum.planes[4].to_array(),
                frustum.planes[5].to_array(),
            ],
            lod_params: [
                2.0,
                viewport_height,
                camera.fov_y_degrees.to_radians(),
                max_lod as f32,
            ],
            terrain_params: self.terrain_params,
        };
        context
            .queue
            .write_buffer(&self.params_buffer, 0, bytemuck::bytes_of(&params));
        Ok(())
    }

    /// Encodes the header clear + dispatch + staging copy when no readback
    /// is in flight (one frame's worth of selection work).
    pub(super) fn encode_frame(&mut self, encoder: &mut wgpu::CommandEncoder) {
        if self.map_pending {
            return;
        }
        encoder.clear_buffer(&self.header_buffer, 0, Some(LOD_HEADER_BYTES));
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("forge3d-web-clipmap-lod-select-pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.dispatch_workgroups(self.tile_count.div_ceil(64), 1, 1);
        }
        encoder.copy_buffer_to_buffer(&self.header_buffer, 0, &self.staging, 0, LOD_HEADER_BYTES);
        encoder.copy_buffer_to_buffer(
            &self.output_buffer,
            0,
            &self.staging,
            LOD_HEADER_BYTES,
            self.tile_count as u64 * 40,
        );
        self.frame += 1;
    }

    /// Starts the non-blocking map after the frame's submission.
    pub(super) fn begin_map(&mut self, context: &GpuContext) {
        if self.map_pending {
            return;
        }
        self.map_pending = true;
        let shared = self.map_state.clone();
        self.staging
            .slice(..self.output_bytes)
            .map_async(wgpu::MapMode::Read, move |result| {
                let mut state = shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state.ready = result.is_ok();
                state.failed = result.is_err();
            });
        let _ = context.device.poll(wgpu::PollType::Poll);
    }

    /// Harvests a completed map into `latest` (called once per frame).
    pub(super) fn harvest(&mut self, context: &GpuContext) {
        if !self.map_pending {
            return;
        }
        let _ = context.device.poll(wgpu::PollType::Poll);
        let (ready, failed) = {
            let state = self
                .map_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (state.ready, state.failed)
        };
        if !ready && !failed {
            return;
        }
        if ready {
            let data = {
                let view = self.staging.slice(..self.output_bytes).get_mapped_range();
                view.to_vec()
            };
            self.staging.unmap();
            let mut header = [0u32; 4];
            for (index, chunk) in data[..16].chunks_exact(4).enumerate() {
                header[index] = u32::from_le_bytes(chunk.try_into().unwrap_or([0; 4]));
            }
            let visible_count = header[0].min(self.tile_count);
            let mut tiles: Vec<LodTileInfo> = Vec::with_capacity(visible_count as usize);
            for chunk in data[16..].chunks_exact(40).take(visible_count as usize) {
                let record: LodTileInfo = *bytemuck::from_bytes(chunk);
                tiles.push(record);
            }
            tiles.sort_by(|a, b| {
                a.distance
                    .total_cmp(&b.distance)
                    .then(a.tile_id.cmp(&b.tile_id))
            });
            let visible_ids = tiles
                .iter()
                .map(|tile| {
                    let (lod, x, y) = forge3d_core::terrain_clipmap::unpack_tile_id(tile.tile_id);
                    TileId::new(lod, x, y)
                })
                .collect();
            self.latest = Some(LodSelectResult {
                frame: self.frame,
                visible_count,
                total_triangles: u64::from(header[1]),
                tiles,
                visible_ids,
            });
        }
        {
            let mut state = self
                .map_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.ready = false;
            state.failed = false;
        }
        self.map_pending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// E3/E7: the `TerrainGeometryUniform` field order is part of the WGSL
    /// contract — pin size and offsets against the shader declaration.
    #[test]
    fn terrain_geometry_uniform_layout_matches_wgsl() {
        use core::mem::offset_of;
        assert_eq!(
            std::mem::size_of::<TerrainGeometryUniform>(),
            144,
            "TerrainGeometryUniform must be exactly 144 bytes"
        );
        let expected: &[(&str, usize)] = &[
            ("s0", 0),
            ("anchor", 8),
            ("skirt_depth", 16),
            ("ring_count", 20),
            ("mode_flags", 24),
            ("lod_count", 28),
            ("hf_origin", 32),
            ("hf_spacing", 40),
            ("hf_dims", 48),
            ("tile_size", 56),
            ("slots_per_row", 60),
            ("base_dims", 64),
            ("morph_range", 72),
            ("_pad0", 76),
            ("ring_data_lod", 80),
        ];
        let actual: &[usize] = &[
            offset_of!(TerrainGeometryUniform, s0),
            offset_of!(TerrainGeometryUniform, anchor),
            offset_of!(TerrainGeometryUniform, skirt_depth),
            offset_of!(TerrainGeometryUniform, ring_count),
            offset_of!(TerrainGeometryUniform, mode_flags),
            offset_of!(TerrainGeometryUniform, lod_count),
            offset_of!(TerrainGeometryUniform, hf_origin),
            offset_of!(TerrainGeometryUniform, hf_spacing),
            offset_of!(TerrainGeometryUniform, hf_dims),
            offset_of!(TerrainGeometryUniform, tile_size),
            offset_of!(TerrainGeometryUniform, slots_per_row),
            offset_of!(TerrainGeometryUniform, base_dims),
            offset_of!(TerrainGeometryUniform, morph_range),
            offset_of!(TerrainGeometryUniform, _pad0),
            offset_of!(TerrainGeometryUniform, ring_data_lod),
        ];
        for ((name, expected), actual) in expected.iter().zip(actual.iter()) {
            assert_eq!(expected, actual, "TerrainGeometryUniform.{name} offset");
        }
    }

    /// E4: the GPU `LodSelectParams`/`TileInfo` layouts mirror the WGSL
    /// structs — the header is 16 bytes and each tile record is 40.
    /// `TileInfo` puts both `vec2`s on 8-byte boundaries so the WGSL
    /// storage stride is the same 40 bytes (`vec2` has AlignOf 8).
    #[test]
    fn lod_select_layouts_match_wgsl() {
        use core::mem::offset_of;
        assert_eq!(std::mem::size_of::<LodSelectGpuParams>(), 208);
        assert_eq!(std::mem::size_of::<LodTileInfo>(), 40);
        let expected: &[(&str, usize)] = &[
            ("bounds_min", 0),
            ("bounds_max", 8),
            ("tile_id", 16),
            ("distance", 20),
            ("selected_lod", 24),
            ("height_min", 28),
            ("height_max", 32),
            ("visible", 36),
        ];
        let actual: &[usize] = &[
            offset_of!(LodTileInfo, bounds_min),
            offset_of!(LodTileInfo, bounds_max),
            offset_of!(LodTileInfo, tile_id),
            offset_of!(LodTileInfo, distance),
            offset_of!(LodTileInfo, selected_lod),
            offset_of!(LodTileInfo, height_min),
            offset_of!(LodTileInfo, height_max),
            offset_of!(LodTileInfo, visible),
        ];
        for ((name, expected), actual) in expected.iter().zip(actual.iter()) {
            assert_eq!(expected, actual, "LodTileInfo.{name} offset");
        }
    }

    /// E2: the clipmap `TerrainVertex` pack mirrors
    /// `[grid_x, morph, grid_z]` / `[ring, flags]` in 20 bytes.
    #[test]
    fn shadow_proxy_bytes_match_the_built_mesh() {
        for dims in [[2u32, 2u32], [129, 97], [SHADOW_PROXY_MAX_DIM, 3]] {
            let terrain = TerrainHeightmapInput::new(
                dims[0],
                dims[1],
                vec![0.0; (dims[0] * dims[1]) as usize],
            )
            .unwrap();
            let (vertices, indices) = shadow_proxy_mesh(&terrain);
            let built = (vertices.len() * std::mem::size_of::<TerrainVertex>()
                + indices.len() * std::mem::size_of::<u32>()) as u64;
            assert_eq!(
                shadow_proxy_bytes(shadow_proxy_dims(dims[0], dims[1])),
                built
            );
        }
    }

    #[test]
    fn streaming_ledger_bytes_cover_the_whole_allocated_atlas() {
        // 64 MiB / 256 KiB = 256 slots => 16 x 16 grid (exact).
        let square = streaming_for_tests(64 << 20);
        assert_eq!(square.slot_capacity, 256);
        let page_table = 65 * 65 * 8 * 4; // tiles_at(0) x lods x u32
        assert_eq!(
            streaming_gpu_bytes(&square).unwrap(),
            256 * 256 * 256 * 4 + page_table
        );
        // 300 slots => 18 x 17 = 306 allocated slots, all charged.
        let ragged = streaming_for_tests(300 * 256 * 256 * 4);
        assert_eq!(ragged.slot_capacity, 300);
        assert_eq!(ragged.atlas_grid(), (18, 17));
        assert_eq!(
            streaming_gpu_bytes(&ragged).unwrap(),
            306 * 256 * 256 * 4 + page_table
        );
        assert_eq!(
            streaming_lod_select_gpu_bytes(&ragged).unwrap(),
            lod_select_gpu_bytes(65 * 65)
        );
    }

    fn streaming_for_tests(max_resident_bytes: u64) -> TerrainStreaming {
        let input = forge3d_core::terrain::TerrainHeightmapInput::with_options(
            129,
            129,
            vec![0.0; 129 * 129],
            forge3d_core::terrain::TerrainGridOptions {
                spacing: Some([1.0, 1.0]),
                streaming: Some(forge3d_core::terrain::TerrainStreamingOptions {
                    width: Some(16385),
                    height: Some(16385),
                    tile_size: Some(256),
                    max_resident_bytes: Some(max_resident_bytes),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .unwrap();
        input.streaming.unwrap()
    }

    #[test]
    fn clipmap_vertex_pack_is_terrain_layout() {
        assert_eq!(std::mem::size_of::<TerrainVertex>(), 20);
    }
}
