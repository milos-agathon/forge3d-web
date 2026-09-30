//! Crack-free-by-construction clipmap mesh generation (W08/T08).
//!
//! All positions are integer grid units relative to the layout anchor; they
//! stay exact in `f32` for `|unit| < 2^24`. Deterministic ordering: center
//! block, then ring `0..N-1` (each: interior cells row-major by z then x,
//! then its outer stitch), then all skirts.

use std::collections::{HashMap, HashSet};

use super::{calculate_morph_weight, ClipmapConfig, ClipmapLayout};

/// Vertex is a skirt duplicate (morph == -1, pushed down by `skirt_depth`).
pub const CLIPMAP_FLAG_SKIRT: u32 = 1;
/// Vertex lies on this ring's outer boundary and a coarser ring exists:
/// its height is always evaluated at the coarser ring's data LOD.
pub const CLIPMAP_FLAG_COARSE_BOUNDARY: u32 = 2;
/// Vertex lies on the ring's hole boundary; morph is forced to 0.
pub const CLIPMAP_FLAG_INNER_BOUNDARY: u32 = 4;

/// Clipmap vertex: absolute integer grid position plus morph metadata.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClipmapVertex {
    /// Absolute grid units from the layout anchor.
    pub grid: [i32; 2],
    /// Ring index (0 for the center block as well).
    pub ring: u32,
    /// Geo-morph weight in `[0, 1]`; `-1.0` marks a skirt vertex.
    pub morph: f32,
    /// `CLIPMAP_FLAG_*` bitset.
    pub flags: u32,
}

/// Index/vertex range of a mesh sub-region.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MeshBounds {
    pub vertex_start: u32,
    pub vertex_count: u32,
    pub index_start: u32,
    pub index_count: u32,
}

/// Complete clipmap mesh (center block + rings + skirts).
#[derive(Debug, Clone)]
pub struct ClipmapMesh {
    pub vertices: Vec<ClipmapVertex>,
    pub indices: Vec<u32>,
    pub center_bounds: MeshBounds,
    pub ring_bounds: Vec<MeshBounds>,
    pub skirt_bounds: MeshBounds,
    /// `indices.len() / 3` (skirts included, matching native).
    pub triangle_count: u32,
    /// Triangle count of a uniform `s0` grid over the whole footprint:
    /// `(2 * outer_half_units(N-1))^2 * 2`.
    pub full_resolution_triangles: u64,
}

impl ClipmapMesh {
    /// Generate the clipmap mesh for a config + snapped layout.
    pub fn generate(config: &ClipmapConfig, layout: &ClipmapLayout) -> ClipmapMesh {
        let n = config.ring_count as usize;
        let hc = layout.center_half_units();
        let c0 = layout.centers[0];
        let mut vertices: Vec<ClipmapVertex> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();

        // ---- Center block: (C+1)^2 vertices, C^2 quads (native winding). ----
        let center_bounds = MeshBounds {
            vertex_start: 0,
            vertex_count: ((2 * hc + 1) * (2 * hc + 1)) as u32,
            index_start: 0,
            index_count: config.center_resolution * config.center_resolution * 2 * 3,
        };
        for dz in -hc..=hc {
            for dx in -hc..=hc {
                vertices.push(ClipmapVertex {
                    grid: [c0[0] + dx, c0[1] + dz],
                    ring: 0,
                    morph: 0.0,
                    flags: 0,
                });
            }
        }
        let stride = (2 * hc + 1) as u32;
        for cz in 0..(2 * hc) {
            for cx in 0..(2 * hc) {
                let i0 = cz as u32 * stride + cx as u32;
                let i1 = i0 + 1;
                let i2 = i0 + stride;
                let i3 = i2 + 1;
                indices.extend_from_slice(&[i0, i1, i2, i1, i3, i2]);
            }
        }

        // ---- Rings: interior cells, then outer stitch/frame. ----
        let mut ring_bounds = Vec::with_capacity(n);
        let mut outer_loops: Vec<Vec<u32>> = Vec::with_capacity(n);
        for r in 0..n {
            let vertex_start = vertices.len() as u32;
            let index_start = indices.len() as u32;
            let m = layout.ring_outer_half_cells(r as u32);
            let spacing = layout.spacing_units(r as u32);
            let center = layout.centers[r];
            let hole_half = layout.ring_hole_half_cells(r as u32);
            let hole_center = if r == 0 {
                [0i32, 0]
            } else {
                [
                    (layout.centers[r - 1][0] - center[0]) / spacing,
                    (layout.centers[r - 1][1] - center[1]) / spacing,
                ]
            };
            let mut ring = RingBuilder {
                vmap: HashMap::new(),
                center,
                spacing,
                ring: r as u32,
                hole_center,
                hole_half,
                outer_half: m,
                morph_range: config.morph_range,
            };

            // Interior cells: inside [-M+1, M-2]^2, outside the hole.
            let hx0 = hole_center[0] - hole_half;
            let hx1 = hole_center[0] + hole_half;
            let hz0 = hole_center[1] - hole_half;
            let hz1 = hole_center[1] + hole_half;
            for cz in (-m + 1)..=(m - 2) {
                for cx in (-m + 1)..=(m - 2) {
                    if cx >= hx0 && cx < hx1 && cz >= hz0 && cz < hz1 {
                        continue;
                    }
                    ring.cell(&mut vertices, &mut indices, cx, cz);
                }
            }

            let loop_indices = if r + 1 < n {
                // Zipper stitch onto the coarser ring's grid.
                let inner_loop = square_loop(m - 1, 1);
                let outer_loop = square_loop(m, 2);
                let inner_idx: Vec<u32> = inner_loop
                    .iter()
                    .map(|&cell| ring.vertex(&mut vertices, cell, 0))
                    .collect();
                let outer_idx: Vec<u32> = outer_loop
                    .iter()
                    .map(|&cell| ring.vertex(&mut vertices, cell, CLIPMAP_FLAG_COARSE_BOUNDARY))
                    .collect();
                zipper_stitch(&mut indices, &inner_idx, &outer_idx);
                outer_idx
            } else {
                // Outermost ring: plain cells for the outermost loop.
                for cz in -m..m {
                    for cx in -m..m {
                        if cx == -m || cx == m - 1 || cz == -m || cz == m - 1 {
                            ring.cell(&mut vertices, &mut indices, cx, cz);
                        }
                    }
                }
                square_loop(m, 1)
                    .iter()
                    .map(|&cell| ring.vertex(&mut vertices, cell, 0))
                    .collect()
            };
            outer_loops.push(loop_indices);

            ring_bounds.push(MeshBounds {
                vertex_start,
                vertex_count: vertices.len() as u32 - vertex_start,
                index_start,
                index_count: indices.len() as u32 - index_start,
            });
        }

        // ---- Skirts: duplicate each ring's used outer loop, quad strip. ----
        let skirt_bounds = MeshBounds {
            vertex_start: vertices.len() as u32,
            vertex_count: 0,
            index_start: indices.len() as u32,
            index_count: 0,
        };
        for loop_idx in &outer_loops {
            let base = vertices.len() as u32;
            for &vi in loop_idx {
                let v = vertices[vi as usize];
                vertices.push(ClipmapVertex {
                    morph: -1.0,
                    flags: v.flags | CLIPMAP_FLAG_SKIRT,
                    ..v
                });
            }
            let len = loop_idx.len();
            for k in 0..len {
                let a = loop_idx[k];
                let b = loop_idx[(k + 1) % len];
                let sa = base + k as u32;
                let sb = base + ((k + 1) % len) as u32;
                indices.extend_from_slice(&[a, b, sa, b, sb, sa]);
            }
        }
        let skirt_bounds = MeshBounds {
            vertex_count: vertices.len() as u32 - skirt_bounds.vertex_start,
            index_count: indices.len() as u32 - skirt_bounds.index_start,
            ..skirt_bounds
        };

        let outer_half = layout.outer_half_units((n - 1) as u32) as u64;
        ClipmapMesh {
            vertices,
            indices,
            center_bounds,
            ring_bounds,
            skirt_bounds,
            triangle_count: 0,
            full_resolution_triangles: (2 * outer_half) * (2 * outer_half) * 2,
        }
        .with_counts()
    }

    fn with_counts(mut self) -> Self {
        self.triangle_count = self.indices.len() as u32 / 3;
        self
    }

    pub fn vertex_count(&self) -> u32 {
        self.vertices.len() as u32
    }

    pub fn index_count(&self) -> u32 {
        self.indices.len() as u32
    }

    /// `max(0, (full - tris) / full * 100)` in percent.
    pub fn triangle_reduction_percent(&self) -> f32 {
        calculate_triangle_reduction(self.full_resolution_triangles, self.triangle_count as u64)
    }
}

/// Per-ring vertex dedupe + cell emission.
struct RingBuilder {
    vmap: HashMap<(i32, i32), u32>,
    center: [i32; 2],
    spacing: i32,
    ring: u32,
    hole_center: [i32; 2],
    hole_half: i32,
    outer_half: i32,
    morph_range: f32,
}

impl RingBuilder {
    fn vertex(
        &mut self,
        vertices: &mut Vec<ClipmapVertex>,
        cell: (i32, i32),
        force_flags: u32,
    ) -> u32 {
        if let Some(&idx) = self.vmap.get(&cell) {
            if force_flags != 0 {
                vertices[idx as usize].flags |= force_flags;
            }
            return idx;
        }
        let on_hole = (cell.0 - self.hole_center[0])
            .abs()
            .max((cell.1 - self.hole_center[1]).abs())
            == self.hole_half;
        let d = cell.0.abs().max(cell.1.abs());
        let mut flags = force_flags;
        let mut morph = calculate_morph_weight(
            (d - self.hole_half) as f32,
            (self.outer_half - self.hole_half) as f32,
            self.morph_range,
        );
        if on_hole {
            flags |= CLIPMAP_FLAG_INNER_BOUNDARY;
            morph = 0.0;
        }
        let idx = vertices.len() as u32;
        vertices.push(ClipmapVertex {
            grid: [
                self.center[0] + cell.0 * self.spacing,
                self.center[1] + cell.1 * self.spacing,
            ],
            ring: self.ring,
            morph,
            flags,
        });
        self.vmap.insert(cell, idx);
        idx
    }

    /// One interior/frame cell: `[i0, i1, i2, i1, i3, i2]` with `i1 = +x`,
    /// `i2 = +z` — positive `(x, z)` cross like the native center block.
    fn cell(
        &mut self,
        vertices: &mut Vec<ClipmapVertex>,
        indices: &mut Vec<u32>,
        cx: i32,
        cz: i32,
    ) {
        let i0 = self.vertex(vertices, (cx, cz), 0);
        let i1 = self.vertex(vertices, (cx + 1, cz), 0);
        let i2 = self.vertex(vertices, (cx, cz + 1), 0);
        let i3 = self.vertex(vertices, (cx + 1, cz + 1), 0);
        indices.extend_from_slice(&[i0, i1, i2, i1, i3, i2]);
    }
}

/// Counter-clockwise perimeter walk of the square at Chebyshev `radius`,
/// taking every `step`-th lattice vertex, starting at the `(-r, -r)` corner.
fn square_loop(radius: i32, step: i32) -> Vec<(i32, i32)> {
    let side = 2 * radius;
    let mut out = Vec::with_capacity((4 * side / step) as usize);
    let mut t = 0;
    while t < side {
        out.push((-radius + t, -radius));
        t += step;
    }
    t = 0;
    while t < side {
        out.push((radius, -radius + t));
        t += step;
    }
    t = 0;
    while t < side {
        out.push((radius - t, radius));
        t += step;
    }
    t = 0;
    while t < side {
        out.push((-radius, radius - t));
        t += step;
    }
    out
}

/// Zipper stitch between a fine inner loop and a coarse outer loop.
///
/// Both loops are walked counter-clockwise from the same corner with
/// perimeter parameters normalized to `[0, 1)` and aligned at the four
/// corners; whichever loop's next vertex has the smaller parameter advances
/// (ties: outer first). Emits exactly `inner.len() + outer.len()` triangles,
/// each `(inner_i, outer_j, next)` which keeps the `(x, z)` cross positive.
fn zipper_stitch(indices: &mut Vec<u32>, inner_idx: &[u32], outer_idx: &[u32]) {
    let ni = inner_idx.len();
    let no = outer_idx.len();
    let mut i = 0usize;
    let mut j = 0usize;
    for _ in 0..(ni + no) {
        let next_inner = (i + 1) as f64 / ni as f64;
        let next_outer = (j + 1) as f64 / no as f64;
        let ii = inner_idx[i % ni];
        let oi = outer_idx[j % no];
        if next_outer <= next_inner {
            indices.extend_from_slice(&[ii, oi, outer_idx[(j + 1) % no]]);
            j += 1;
        } else {
            indices.extend_from_slice(&[ii, oi, inner_idx[(i + 1) % ni]]);
            i += 1;
        }
    }
}

/// Exact closed form of the generated triangle count (camera-independent).
///
/// `estimate_triangle_count(&config) == ClipmapMesh::generate(...).triangle_count`
/// for every valid config and camera position.
pub fn estimate_triangle_count(config: &ClipmapConfig) -> u64 {
    let n = config.ring_count as usize;
    let c = config.center_resolution as i64;
    let hc = c / 2;
    let mut total = 2u64 * c as u64 * c as u64;
    let mut prev_m = 0i64;
    for ring in 0..n {
        let m = config.ring_outer_half_cells(ring as u32) as i64;
        let h = if ring == 0 { hc } else { prev_m / 2 };
        let interior = 2 * ((2 * m - 2) * (2 * m - 2) - (2 * h) * (2 * h));
        let (frame, skirt) = if ring + 1 == n {
            (16 * m - 8, 16 * m)
        } else {
            (12 * m - 8, 8 * m)
        };
        total += (interior + frame + skirt) as u64;
        prev_m = m;
    }
    total
}

/// Native `calculate_triangle_reduction`: percent, `(0, x) -> 0`.
pub fn calculate_triangle_reduction(full_res_triangles: u64, clipmap_triangles: u64) -> f32 {
    if full_res_triangles == 0 {
        return 0.0;
    }
    let reduction =
        (full_res_triangles as f64 - clipmap_triangles as f64) / full_res_triangles as f64;
    (reduction * 100.0).max(0.0) as f32
}

/// CPU mirror of the WGSL clipmap vertex function.
///
/// `height(x_units, z_units, lod)` samples the analytic/loaded height at a
/// grid position and data LOD; `data_lod(ring)` maps ring index to data LOD.
pub fn clipmap_vertex_position(
    v: &ClipmapVertex,
    layout: &ClipmapLayout,
    config: &ClipmapConfig,
    height: &dyn Fn(f32, f32, u32) -> f32,
    data_lod: &dyn Fn(u32) -> u32,
) -> [f32; 3] {
    let k = v.morph.max(0.0);
    let step = 1i32 << (v.ring + 1);
    let coarse = [
        v.grid[0] - v.grid[0].rem_euclid(step),
        v.grid[1] - v.grid[1].rem_euclid(step),
    ];
    let p = if k >= 1.0 {
        [coarse[0] as f32, coarse[1] as f32]
    } else if k <= 0.0 {
        [v.grid[0] as f32, v.grid[1] as f32]
    } else {
        [
            v.grid[0] as f32 * (1.0 - k) + coarse[0] as f32 * k,
            v.grid[1] as f32 * (1.0 - k) + coarse[1] as f32 * k,
        ]
    };
    let last = config.ring_count.saturating_sub(1);
    let lod_f = data_lod(v.ring);
    let lod_c = data_lod((v.ring + 1).min(last));
    let kh = if v.flags & CLIPMAP_FLAG_COARSE_BOUNDARY != 0 {
        1.0
    } else {
        k
    };
    let mut h = if kh >= 1.0 {
        height(p[0], p[1], lod_c)
    } else if kh <= 0.0 {
        height(p[0], p[1], lod_f)
    } else {
        height(p[0], p[1], lod_f) * (1.0 - kh) + height(p[0], p[1], lod_c) * kh
    };
    if v.flags & CLIPMAP_FLAG_SKIRT != 0 {
        h -= config.skirt_depth;
    }
    let s0 = layout.base_cell_size_axes;
    [
        layout.anchor[0] + p[0] * s0[0],
        h,
        layout.anchor[1] + p[1] * s0[1],
    ]
}

/// Seam analysis result for crack/T-junction verification.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SeamReport {
    /// Total boundary edges compared across all ring interfaces.
    pub boundary_edges: u32,
    /// Boundary edges without an identical counterpart (cracks/T-junctions).
    pub unmatched_boundary_edges: u32,
    /// Max XZ distance between coincident vertices of adjacent regions.
    pub max_position_gap: f32,
    /// Max height difference at coincident boundary vertices.
    pub max_height_discontinuity: f32,
}

/// Verify the clipmap is crack-free: every outer-boundary edge of the center
/// block and of ring `r < N-1` must have an identical (integer endpoints)
/// hole-boundary edge in the next finer-region neighbor, and coincident
/// vertices must evaluate to identical world positions.
pub fn analyze_seams(
    mesh: &ClipmapMesh,
    layout: &ClipmapLayout,
    config: &ClipmapConfig,
    height: &dyn Fn(f32, f32, u32) -> f32,
    data_lod: &dyn Fn(u32) -> u32,
) -> SeamReport {
    let n = config.ring_count as usize;
    let c0 = layout.centers[0];
    let hc = layout.center_half_units();
    let center_end = mesh.center_bounds.vertex_start + mesh.center_bounds.vertex_count;

    let mut hole_edges: Vec<HashSet<(i32, i32, i32, i32)>> =
        (0..n).map(|_| HashSet::new()).collect();
    let mut outer_edges: Vec<HashSet<(i32, i32, i32, i32)>> =
        (0..n).map(|_| HashSet::new()).collect();
    let mut center_edges: HashSet<(i32, i32, i32, i32)> = HashSet::new();

    let verts = &mesh.vertices;
    for tri in mesh.indices.chunks_exact(3) {
        let vs = [
            verts[tri[0] as usize],
            verts[tri[1] as usize],
            verts[tri[2] as usize],
        ];
        if vs.iter().any(|v| v.flags & CLIPMAP_FLAG_SKIRT != 0) {
            continue;
        }
        for e in 0..3 {
            let a = vs[e];
            let b = vs[(e + 1) % 3];
            if a.ring == b.ring {
                // Axis-aligned only: corner-cell diagonals also connect two
                // boundary verts but are chords, not perimeter segments.
                let spacing = layout.spacing_units(a.ring);
                if a.flags & CLIPMAP_FLAG_INNER_BOUNDARY != 0
                    && b.flags & CLIPMAP_FLAG_INNER_BOUNDARY != 0
                    && is_axis_edge(a.grid, b.grid, spacing)
                {
                    hole_edges[a.ring as usize].insert(norm_edge(a.grid, b.grid));
                }
                if a.flags & CLIPMAP_FLAG_COARSE_BOUNDARY != 0
                    && b.flags & CLIPMAP_FLAG_COARSE_BOUNDARY != 0
                    && is_axis_edge(a.grid, b.grid, 2 * spacing)
                {
                    outer_edges[a.ring as usize].insert(norm_edge(a.grid, b.grid));
                }
            }
            let ai = tri[e] < center_end;
            let bi = tri[(e + 1) % 3] < center_end;
            if ai
                && bi
                && (a.grid[0] - c0[0]).abs().max((a.grid[1] - c0[1]).abs()) == hc
                && (b.grid[0] - c0[0]).abs().max((b.grid[1] - c0[1]).abs()) == hc
                && is_axis_edge(a.grid, b.grid, 1)
            {
                center_edges.insert(norm_edge(a.grid, b.grid));
            }
        }
    }

    let mut report = SeamReport::default();
    let compare = |outer: &HashSet<(i32, i32, i32, i32)>,
                   hole: &HashSet<(i32, i32, i32, i32)>,
                   report: &mut SeamReport| {
        report.boundary_edges += (outer.len() + hole.len()) as u32;
        report.unmatched_boundary_edges += outer.symmetric_difference(hole).count() as u32;
    };
    compare(&center_edges, &hole_edges[0], &mut report);
    for r in 0..n.saturating_sub(1) {
        let outer = std::mem::take(&mut outer_edges[r]);
        compare(&outer, &hole_edges[r + 1], &mut report);
        outer_edges[r] = outer;
    }

    // Coincident non-skirt vertices must evaluate to the same world position.
    let mut by_grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for (i, v) in verts.iter().enumerate() {
        if v.flags & CLIPMAP_FLAG_SKIRT == 0 {
            by_grid
                .entry((v.grid[0], v.grid[1]))
                .or_default()
                .push(i as u32);
        }
    }
    for group in by_grid.values() {
        if group.len() < 2 {
            continue;
        }
        let base =
            clipmap_vertex_position(&verts[group[0] as usize], layout, config, height, data_lod);
        for &idx in &group[1..] {
            let p = clipmap_vertex_position(&verts[idx as usize], layout, config, height, data_lod);
            let dx = (p[0] - base[0]).abs();
            let dz = (p[2] - base[2]).abs();
            report.max_position_gap = report.max_position_gap.max((dx * dx + dz * dz).sqrt());
            report.max_height_discontinuity =
                report.max_height_discontinuity.max((p[1] - base[1]).abs());
        }
    }
    report
}

/// True for an axis-aligned unit segment of `len` grid units (a real
/// perimeter edge; cell diagonals fail the axis-aligned check).
fn is_axis_edge(a: [i32; 2], b: [i32; 2], len: i32) -> bool {
    let dx = (a[0] - b[0]).abs();
    let dz = (a[1] - b[1]).abs();
    (dx == 0 || dz == 0) && dx + dz == len
}

fn norm_edge(a: [i32; 2], b: [i32; 2]) -> (i32, i32, i32, i32) {
    if (a[0], a[1]) <= (b[0], b[1]) {
        (a[0], a[1], b[0], b[1])
    } else {
        (b[0], b[1], a[0], a[1])
    }
}

/// Native-compatible CPU clipmap data (`clipmap_generate_py` parity).
#[derive(Debug, Clone)]
pub struct ClipmapMeshData {
    /// World XZ positions.
    pub positions: Vec<[f32; 2]>,
    /// Heightmap UVs: `(w + extent/2) / extent` clamped to `[0, 1]`.
    pub uvs: Vec<[f32; 2]>,
    /// `[morph_weight (-1 = skirt), ring index]` per vertex.
    pub morph_data: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
    pub vertex_count: u32,
    pub index_count: u32,
    pub triangle_count: u32,
    pub rings_count: u32,
    pub triangle_reduction_percent: f32,
}

/// Native `clipmap_generate` semantics: `s0 = extent / (C * 8)`, anchor at
/// `[0, 0]` (terrain centered at origin), layout snapped for `center`.
pub fn clipmap_generate(
    config: &ClipmapConfig,
    center: [f32; 2],
    terrain_extent: f32,
) -> ClipmapMeshData {
    let s0 = terrain_extent / (config.center_resolution as f32 * 8.0);
    let layout = ClipmapLayout::for_camera(config, s0, [0.0, 0.0], center);
    let mesh = ClipmapMesh::generate(config, &layout);
    let half = terrain_extent * 0.5;
    let positions: Vec<[f32; 2]> = mesh
        .vertices
        .iter()
        .map(|v| [v.grid[0] as f32 * s0, v.grid[1] as f32 * s0])
        .collect();
    let uvs: Vec<[f32; 2]> = positions
        .iter()
        .map(|p| {
            [
                ((p[0] + half) / terrain_extent).clamp(0.0, 1.0),
                ((p[1] + half) / terrain_extent).clamp(0.0, 1.0),
            ]
        })
        .collect();
    let morph_data: Vec<[f32; 2]> = mesh
        .vertices
        .iter()
        .map(|v| [v.morph, v.ring as f32])
        .collect();
    ClipmapMeshData {
        vertex_count: positions.len() as u32,
        index_count: mesh.indices.len() as u32,
        triangle_count: mesh.triangle_count,
        rings_count: config.ring_count,
        triangle_reduction_percent: mesh.triangle_reduction_percent(),
        positions,
        uvs,
        morph_data,
        indices: mesh.indices,
    }
}
