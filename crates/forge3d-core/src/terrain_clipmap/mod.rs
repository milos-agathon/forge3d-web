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

use crate::error::{Forge3dError, Result};

/// Configuration for clipmap terrain generation (native `ClipmapConfig`).
#[derive(Debug, Clone, PartialEq)]
pub struct ClipmapConfig {
    /// Number of LOD rings around the center block (1..=16).
    pub ring_count: u32,
    /// Ring strip width in cells; even and >= 4.
    pub ring_resolution: u32,
    /// Center block cells per side; even and >= 4.
    pub center_resolution: u32,
    /// Skirt depth in world units (finite, >= 0).
    pub skirt_depth: f32,
    /// Geo-morph blend range as a fraction of ring width, clamped to [0, 1].
    pub morph_range: f32,
}

impl Default for ClipmapConfig {
    fn default() -> Self {
        Self {
            ring_count: 4,
            ring_resolution: 64,
            center_resolution: 64,
            skirt_depth: 10.0,
            morph_range: 0.3,
        }
    }
}

fn invalid_input(field: &str, message: impl Into<String>) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message: message.into(),
    }
}

impl ClipmapConfig {
    /// Create and validate a clipmap configuration.
    ///
    /// `morph_range` is clamped to `[0, 1]` like native `with_morph_range`;
    /// NaN is rejected.
    pub fn new(
        ring_count: u32,
        ring_resolution: u32,
        center_resolution: u32,
        skirt_depth: f32,
        morph_range: f32,
    ) -> Result<Self> {
        if morph_range.is_nan() {
            return Err(invalid_input(
                "clipmap.morph_range",
                "morph_range must not be NaN",
            ));
        }
        let config = Self {
            ring_count,
            ring_resolution,
            center_resolution,
            skirt_depth,
            morph_range: morph_range.clamp(0.0, 1.0),
        };
        config.validate()?;
        Ok(config)
    }

    /// Validate the configuration (`clipmap.*` field prefix).
    pub fn validate(&self) -> Result<()> {
        if !(1..=16).contains(&self.ring_count) {
            return Err(invalid_input(
                "clipmap.ring_count",
                format!("ring_count must be in [1, 16], got {}", self.ring_count),
            ));
        }
        if self.ring_resolution < 4 || !self.ring_resolution.is_multiple_of(2) {
            return Err(invalid_input(
                "clipmap.ring_resolution",
                format!(
                    "ring_resolution must be even and >= 4, got {}",
                    self.ring_resolution
                ),
            ));
        }
        if self.center_resolution < 4 || !self.center_resolution.is_multiple_of(2) {
            return Err(invalid_input(
                "clipmap.center_resolution",
                format!(
                    "center_resolution must be even and >= 4, got {}",
                    self.center_resolution
                ),
            ));
        }
        if !self.skirt_depth.is_finite() || self.skirt_depth < 0.0 {
            return Err(invalid_input(
                "clipmap.skirt_depth",
                format!(
                    "skirt_depth must be finite and >= 0, got {}",
                    self.skirt_depth
                ),
            ));
        }
        Ok(())
    }

    /// Center block half extent in level-0 grid units (`Hc`).
    pub fn center_half_units(&self) -> i32 {
        (self.center_resolution / 2) as i32
    }

    /// Outer half extent of `ring` in that ring's cells (`M_r`).
    ///
    /// Ring 0: `M0 = Hc + R` rounded up to even. Ring r >= 1:
    /// `M_r = h_r + R` rounded up to even with `h_r = M_{r-1} / 2`.
    /// Ring width is therefore `R` or `R + 1` cells; topology is fixed.
    pub fn ring_outer_half_cells(&self, ring: u32) -> i32 {
        debug_assert!(ring < self.ring_count);
        let r = self.ring_resolution as i32;
        let mut outer = round_up_even(self.center_half_units() + r);
        for _ in 1..=ring {
            outer = round_up_even(outer / 2 + r);
        }
        outer
    }

    /// Hole half extent of `ring` in that ring's cells
    /// (`Hc` for ring 0, `M_{r-1} / 2` otherwise).
    pub fn ring_hole_half_cells(&self, ring: u32) -> i32 {
        if ring == 0 {
            self.center_half_units()
        } else {
            self.ring_outer_half_cells(ring - 1) / 2
        }
    }
}

fn round_up_even(value: i32) -> i32 {
    (value + 1) & !1
}

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
