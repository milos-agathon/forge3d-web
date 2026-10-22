//! W08/T08: geometry clipmap terrain LOD (pure Rust, GPU-free).
//!
//! Ports the native `1f4084a:src/terrain/clipmap/**` semantics onto a
//! crack-free-by-construction layout: all geometry lives in integer grid
//! units relative to an anchor, every ring center is snapped to a stable
//! multiple of its hole spacing, ring `r`'s hole is exactly ring `r-1`'s
//! footprint, and each non-final ring stitches its outermost cell loop onto
//! the coarser ring's grid (a "zipper") so the outer boundary edges are
//! byte-identical to the next ring's hole edges — no T-junctions, no cracks.
//!
//! Submodules: `mesh` (generation, vertex evaluation, seam analysis,
//! native-compatible `clipmap_generate` data API), `lod_select` (CPU mirror
//! of the `clipmap_lod_select.wgsl` tile LOD selection).

pub mod lod_select;
pub mod mesh;

#[cfg(test)]
mod tests;

pub use lod_select::{
    pack_tile_id, select_tiles, unpack_tile_id, FrustumPlanes, LodSelectParams, LodSelection,
    LodTile, SelectedTile,
};
pub use mesh::{
    analyze_seams, calculate_triangle_reduction, clipmap_generate, clipmap_vertex_position,
    estimate_triangle_count, ClipmapMesh, ClipmapMeshData, ClipmapVertex, MeshBounds, SeamReport,
    CLIPMAP_FLAG_COARSE_BOUNDARY, CLIPMAP_FLAG_INNER_BOUNDARY, CLIPMAP_FLAG_SKIRT,
};

pub use crate::terrain::clipmap_config::ClipmapConfig;

/// Camera-dependent clipmap layout: snapped ring centers in integer units.
///
/// One grid unit equals `base_cell_size` world units; the anchor is the
/// world XZ of grid unit `(0, 0)`. `centers[0]` is the level-0 center shared
/// by the center block and ring 0; `centers[r]` is ring `r`'s center.
#[derive(Debug, Clone)]
pub struct ClipmapLayout {
    /// World-space size of one level-0 grid unit (`s0`).
    ///
    /// Kept for scalar consumers; equals `base_cell_size_axes[0]`.
    pub base_cell_size: f32,
    /// World-space size of one level-0 grid unit per axis (`[sx, sz]`).
    /// Isotropic layouts have both components equal to `base_cell_size`.
    pub base_cell_size_axes: [f32; 2],
    /// World XZ of grid unit (0, 0).
    pub anchor: [f32; 2],
    /// Per-ring snapped centers; index 0 is the center-block/ring-0 center.
    pub centers: Vec<[i32; 2]>,
    /// Unsnapped camera position in grid units (for request planning).
    pub camera_units: [f64; 2],
    /// `M_r` per ring.
    outer_half_cells: Vec<i32>,
    /// Hole half in ring cells (`h_r`; `Hc` at index 0).
    hole_half_cells: Vec<i32>,
    /// `Hc` in level-0 units.
    center_half: i32,
}

impl ClipmapLayout {
    /// Snap ring centers for a camera position (native `round = floor(x + 0.5)`).
    ///
    /// `cam = (camera_xz - anchor) / s0`; `c0 = round(cam / 2) * 2` and
    /// `c_r = round(cam / 2^(r+1)) * 2^(r+1)`.
    pub fn for_camera(
        config: &ClipmapConfig,
        base_cell_size: f32,
        anchor: [f32; 2],
        camera_xz: [f32; 2],
    ) -> Self {
        Self::for_camera_axes(config, [base_cell_size, base_cell_size], anchor, camera_xz)
    }

    /// [`for_camera`] with a per-axis cell size: `cam_i = (camera_i -
    /// anchor_i) / s0_i` and snapping identical in unit space.
    pub fn for_camera_axes(
        config: &ClipmapConfig,
        base_cell_size: [f32; 2],
        anchor: [f32; 2],
        camera_xz: [f32; 2],
    ) -> Self {
        let s0x = base_cell_size[0].max(f32::EPSILON) as f64;
        let s0z = base_cell_size[1].max(f32::EPSILON) as f64;
        let cam = [
            (camera_xz[0] as f64 - anchor[0] as f64) / s0x,
            (camera_xz[1] as f64 - anchor[1] as f64) / s0z,
        ];
        let n = config.ring_count as usize;
        let mut centers = Vec::with_capacity(n);
        let mut outer_half_cells = Vec::with_capacity(n);
        let mut hole_half_cells = Vec::with_capacity(n);
        for r in 0..n {
            let m = 1i64 << (r + 1);
            centers.push([
                (snap_units(cam[0], m)) as i32,
                (snap_units(cam[1], m)) as i32,
            ]);
            outer_half_cells.push(config.ring_outer_half_cells(r as u32));
            hole_half_cells.push(config.ring_hole_half_cells(r as u32));
        }
        Self {
            base_cell_size: base_cell_size[0],
            base_cell_size_axes: base_cell_size,
            anchor,
            centers,
            camera_units: cam,
            outer_half_cells,
            hole_half_cells,
            center_half: config.center_half_units(),
        }
    }

    /// Ring spacing in level-0 grid units (`2^r`).
    pub fn spacing_units(&self, ring: u32) -> i32 {
        1i32 << ring
    }

    /// Ring outer half extent in level-0 grid units (`M_r * 2^r`).
    pub fn outer_half_units(&self, ring: u32) -> i64 {
        self.outer_half_cells[ring as usize] as i64 * (1i64 << ring)
    }

    /// Ring hole half extent in level-0 grid units
    /// (`Hc` for ring 0, `M_{r-1} * 2^(r-1)` otherwise — ring `r - 1`'s
    /// footprint, so the hole is exactly the finer ring's outer square).
    pub fn hole_half_units(&self, ring: u32) -> i64 {
        if ring == 0 {
            self.center_half as i64
        } else {
            self.outer_half_units(ring - 1)
        }
    }

    /// `M_r` for `ring` in that ring's cells.
    pub fn ring_outer_half_cells(&self, ring: u32) -> i32 {
        self.outer_half_cells[ring as usize]
    }

    /// Hole half for `ring` in that ring's cells.
    pub fn ring_hole_half_cells(&self, ring: u32) -> i32 {
        self.hole_half_cells[ring as usize]
    }

    /// `Hc` for the center block, in level-0 grid units.
    pub fn center_half_units(&self) -> i32 {
        self.center_half
    }

    /// True when any snapped center differs (topology is per-config).
    pub fn changed(&self, other: &ClipmapLayout) -> bool {
        self.centers != other.centers
    }
}

fn snap_units(cam: f64, modulus: i64) -> i64 {
    (cam / modulus as f64 + 0.5).floor() as i64 * modulus
}

/// Native `geomorph.rs::calculate_morph_weight`: 0 when `ring_width <= 0` or
/// `morph_range <= 0`; `t` clamped to `[0, 1]`; `(t - (1 - m)) / m` for
/// `t > 1 - m`.
pub fn calculate_morph_weight(distance_from_inner: f32, ring_width: f32, morph_range: f32) -> f32 {
    if ring_width <= 0.0 || morph_range <= 0.0 {
        return 0.0;
    }
    let t = (distance_from_inner / ring_width).clamp(0.0, 1.0);
    let morph_start = 1.0 - morph_range;
    if t > morph_start {
        ((t - morph_start) / morph_range).min(1.0)
    } else {
        0.0
    }
}
