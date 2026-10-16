//! W08/T08: CPU reference for `clipmap_lod_select.wgsl` tile LOD selection.
//!
//! Mirrors the compute shader: XZ distance to tile center, a p-vertex
//! frustum test against the tile's own `[height_min, height_max]` (the
//! shader hard-codes `0..1000`), and first-LOD-within-budget selection.
//! Output is sorted by `(distance, tile_id)` for determinism.

use glam::{Mat4, Vec3, Vec4, Vec4Swizzles};

/// Frustum planes extracted from a view-projection matrix
/// (`left, right, bottom, top, near, far`; `Ax + By + Cz + D = 0` form).
#[derive(Debug, Clone, Copy)]
pub struct FrustumPlanes {
    pub planes: [Vec4; 6],
}

impl FrustumPlanes {
    /// Native row extraction + normalize.
    pub fn from_view_proj(vp: Mat4) -> Self {
        let rows = [
            Vec4::new(vp.x_axis.x, vp.y_axis.x, vp.z_axis.x, vp.w_axis.x),
            Vec4::new(vp.x_axis.y, vp.y_axis.y, vp.z_axis.y, vp.w_axis.y),
            Vec4::new(vp.x_axis.z, vp.y_axis.z, vp.z_axis.z, vp.w_axis.z),
            Vec4::new(vp.x_axis.w, vp.y_axis.w, vp.z_axis.w, vp.w_axis.w),
        ];
        Self {
            planes: [
                normalize_plane(rows[3] + rows[0]),
                normalize_plane(rows[3] - rows[0]),
                normalize_plane(rows[3] + rows[1]),
                normalize_plane(rows[3] - rows[1]),
                normalize_plane(rows[3] + rows[2]),
                normalize_plane(rows[3] - rows[2]),
            ],
        }
    }

    /// Plane accessors matching the WGSL order.
    pub fn left(&self) -> Vec4 {
        self.planes[0]
    }
    pub fn right(&self) -> Vec4 {
        self.planes[1]
    }
    pub fn bottom(&self) -> Vec4 {
        self.planes[2]
    }
    pub fn top(&self) -> Vec4 {
        self.planes[3]
    }
    pub fn near(&self) -> Vec4 {
        self.planes[4]
    }
    pub fn far(&self) -> Vec4 {
        self.planes[5]
    }

    /// p-vertex AABB test (WGSL `frustum_cull_aabb`): for each plane the
    /// vertex furthest along the plane normal must be inside it.
    pub fn test_aabb(
        &self,
        bounds_min: [f32; 2],
        bounds_max: [f32; 2],
        height_min: f32,
        height_max: f32,
    ) -> bool {
        for plane in self.planes {
            let mut p_vertex = Vec3::new(bounds_min[0], height_min, bounds_min[1]);
            if plane.x >= 0.0 {
                p_vertex.x = bounds_max[0];
            }
            if plane.y >= 0.0 {
                p_vertex.y = height_max;
            }
            if plane.z >= 0.0 {
                p_vertex.z = bounds_max[1];
            }
            if plane.xyz().dot(p_vertex) + plane.w < 0.0 {
                return false;
            }
        }
        true
    }
}

fn normalize_plane(plane: Vec4) -> Vec4 {
    let len = plane.xyz().length();
    if len > 0.0 {
        plane / len
    } else {
        plane
    }
}

/// Native `pack_tile_id`: `lod << 24 | (x & 0xFFF) << 12 | (y & 0xFFF)`.
pub fn pack_tile_id(lod: u32, x: u32, y: u32) -> u32 {
    (lod << 24) | ((x & 0xFFF) << 12) | (y & 0xFFF)
}

/// Inverse of [`pack_tile_id`] -> `(lod, x, y)`.
pub fn unpack_tile_id(packed: u32) -> (u32, u32, u32) {
    (packed >> 24, (packed >> 12) & 0xFFF, packed & 0xFFF)
}

/// Parameters for CPU LOD selection (uniform contents of `LodSelectParams`
/// plus the derived frustum).
#[derive(Debug, Clone)]
pub struct LodSelectParams {
    pub view_proj: Mat4,
    pub camera_pos: [f32; 3],
    pub frustum: FrustumPlanes,
    /// Screen-space error budget in pixels (native default 2.0).
    pub pixel_error_budget: f32,
    pub viewport_height: f32,
    /// Vertical field of view in radians.
    pub fov_y: f32,
    pub max_lod: u32,
}

impl LodSelectParams {
    /// Build params; derives the frustum from `view_proj`.
    pub fn new(
        view_proj: Mat4,
        camera_pos: [f32; 3],
        viewport_height: f32,
        fov_y: f32,
        max_lod: u32,
    ) -> Self {
        Self {
            view_proj,
            camera_pos,
            frustum: FrustumPlanes::from_view_proj(view_proj),
            pixel_error_budget: 2.0,
            viewport_height,
            fov_y,
            max_lod,
        }
    }
}

/// Input tile for LOD selection (world XZ bounds + own height range).
#[derive(Debug, Clone, Copy)]
pub struct LodTile {
    pub tile_id: u32,
    pub bounds_min: [f32; 2],
    pub bounds_max: [f32; 2],
    pub height_min: f32,
    pub height_max: f32,
}

impl LodTile {
    pub fn new(
        lod: u32,
        x: u32,
        y: u32,
        bounds_min: [f32; 2],
        bounds_max: [f32; 2],
        height_min: f32,
        height_max: f32,
    ) -> Self {
        Self {
            tile_id: pack_tile_id(lod, x, y),
            bounds_min,
            bounds_max,
            height_min,
            height_max,
        }
    }
}

/// One tile after LOD selection.
#[derive(Debug, Clone, Copy)]
pub struct SelectedTile {
    pub tile_id: u32,
    pub distance: f32,
    pub selected_lod: u32,
    pub visible: bool,
}

/// Result of [`select_tiles`].
#[derive(Debug, Clone)]
pub struct LodSelection {
    /// All input tiles, sorted by `(distance, tile_id)`.
    pub tiles: Vec<SelectedTile>,
    pub visible_count: u32,
    /// Sum of `(128*128*2) >> (2*lod)` over visible tiles.
    pub total_triangles: u64,
}

/// CPU mirror of the WGSL selection pass.
pub fn select_tiles(params: &LodSelectParams, tiles: &[LodTile]) -> LodSelection {
    let mut selected = Vec::with_capacity(tiles.len());
    let mut visible_count = 0u32;
    let mut total_triangles = 0u64;
    for tile in tiles {
        let center = [
            (tile.bounds_min[0] + tile.bounds_max[0]) * 0.5,
            (tile.bounds_min[1] + tile.bounds_max[1]) * 0.5,
        ];
        let dx = center[0] - params.camera_pos[0];
        let dz = center[1] - params.camera_pos[2];
        let distance = (dx * dx + dz * dz).sqrt();
        let visible = params.frustum.test_aabb(
            tile.bounds_min,
            tile.bounds_max,
            tile.height_min,
            tile.height_max,
        );
        let mut selected_lod = 0;
        if visible {
            visible_count += 1;
            let tile_size = tile.bounds_max[0] - tile.bounds_min[0];
            selected_lod = select_lod(
                distance,
                tile_size,
                params.viewport_height,
                params.fov_y,
                params.pixel_error_budget,
                params.max_lod,
            );
            total_triangles += ((128 * 128 * 2) >> (2 * selected_lod)) as u64;
        }
        selected.push(SelectedTile {
            tile_id: tile.tile_id,
            distance,
            selected_lod,
            visible,
        });
    }
    selected.sort_by(|a, b| {
        a.distance
            .total_cmp(&b.distance)
            .then(a.tile_id.cmp(&b.tile_id))
    });
    LodSelection {
        tiles: selected,
        visible_count,
        total_triangles,
    }
}

/// `error = tile_size * ppu / 2^lod` with
/// `ppu = (vh/2) / (max(d, 0.1) * tan(fov/2))`; first lod within budget,
/// else `max_lod`.
fn select_lod(
    distance: f32,
    tile_size: f32,
    viewport_height: f32,
    fov_y: f32,
    pixel_error_budget: f32,
    max_lod: u32,
) -> u32 {
    let safe_distance = distance.max(0.1);
    let half_fov = fov_y * 0.5;
    let pixels_per_unit = (viewport_height * 0.5) / (safe_distance * half_fov.tan());
    for lod in 0..=max_lod {
        let lod_scale = 1.0 / (1u32 << lod) as f32;
        if tile_size * pixels_per_unit * lod_scale <= pixel_error_budget {
            return lod;
        }
    }
    max_lod
}
