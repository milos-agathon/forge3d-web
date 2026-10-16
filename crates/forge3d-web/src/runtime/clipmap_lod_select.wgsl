// W08 (E4): GPU LOD selection compute pass — port of the native
// clipmap_lod_select.wgsl with the core `select_tiles` (A6) semantics:
// XZ distance to tile center, per-tile p-vertex frustum culling against the
// tile's own [height_min, height_max], first-LOD-within-budget selection.
//
// One deviation from the native shader: the screen-space error uses the
// tile's own world width (bounds_max.x - bounds_min.x) exactly like the CPU
// reference, so edge tiles behave identically on both paths; the native
// shader read a uniform tile size instead.

struct LodSelectParams {
    view_proj: mat4x4<f32>,
    camera_pos: vec4<f32>,
    frustum_planes: array<vec4<f32>, 6>,  // left, right, bottom, top, near, far
    lod_params: vec4<f32>,     // x=pixel_error_budget, y=viewport_height, z=fov_y, w=max_lod
    terrain_params: vec4<f32>, // x=terrain_width, y=world_tile_size, z=num_tiles_x, w=num_tiles_y
}

// vec2 members first: both vec2s sit on 8-byte boundaries so the WGSL
// storage stride is 40 bytes — identical to the Rust `LodTileInfo`
// `#[repr(C)]` layout that fills the input buffer and decodes the output.
struct TileInfo {
    bounds_min: vec2<f32>,
    bounds_max: vec2<f32>,
    tile_id: u32,       // packed: lod(8) | x(12) | y(12)
    distance: f32,
    selected_lod: u32,
    height_min: f32,
    height_max: f32,
    visible: u32,       // 0 = culled, 1 = visible
}

struct OutputHeader {
    visible_count: atomic<u32>,
    total_triangles: atomic<u32>,
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: LodSelectParams;
@group(0) @binding(1) var<storage, read> input_tiles: array<TileInfo>;
@group(0) @binding(2) var<storage, read_write> output_tiles: array<TileInfo>;
@group(0) @binding(3) var<storage, read_write> output_header: OutputHeader;

fn point_in_plane(point: vec3<f32>, plane: vec4<f32>) -> bool {
    return dot(plane.xyz, point) + plane.w >= 0.0;
}

// p-vertex AABB test: the vertex furthest along each plane normal must be
// inside the plane's positive half-space.
fn frustum_cull_aabb(bounds_min: vec2<f32>, bounds_max: vec2<f32>, height_min: f32, height_max: f32) -> bool {
    for (var i = 0u; i < 6u; i = i + 1u) {
        let plane = params.frustum_planes[i];
        var p_vertex = vec3<f32>(bounds_min.x, height_min, bounds_min.y);
        if (plane.x >= 0.0) { p_vertex.x = bounds_max.x; }
        if (plane.y >= 0.0) { p_vertex.y = height_max; }
        if (plane.z >= 0.0) { p_vertex.z = bounds_max.y; }
        if (!point_in_plane(p_vertex, plane)) {
            return false;
        }
    }
    return true;
}

// Core A6: error = tile_size * ppu / 2^lod with
// ppu = (vh/2) / (max(d, 0.1) * tan(fov/2)).
fn calculate_screen_space_error(distance: f32, tile_size: f32, lod: u32) -> f32 {
    let pixel_error_budget = params.lod_params.x;
    let viewport_height = params.lod_params.y;
    let fov_y = params.lod_params.z;
    let safe_distance = max(distance, 0.1);
    let half_fov = fov_y * 0.5;
    let pixels_per_unit = (viewport_height * 0.5) / (safe_distance * tan(half_fov));
    let projected_size = tile_size * pixels_per_unit;
    let lod_scale = 1.0 / f32(1u << lod);
    return projected_size * lod_scale;
}

// First lod within the pixel-error budget, else max_lod.
fn select_lod(distance: f32, tile_size: f32) -> u32 {
    let max_lod = u32(params.lod_params.w);
    let pixel_error_budget = params.lod_params.x;
    for (var lod = 0u; lod <= max_lod; lod = lod + 1u) {
        let error = calculate_screen_space_error(distance, tile_size, lod);
        if (error <= pixel_error_budget) {
            return lod;
        }
    }
    return max_lod;
}

@compute @workgroup_size(64, 1, 1)
fn cs_main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let tile_index = global_id.x;
    let num_tiles = u32(params.terrain_params.z) * u32(params.terrain_params.w);
    if (tile_index >= num_tiles) {
        return;
    }

    var tile = input_tiles[tile_index];
    let tile_center = (tile.bounds_min + tile.bounds_max) * 0.5;
    let camera_pos_2d = params.camera_pos.xz;
    let distance = length(tile_center - camera_pos_2d);
    tile.distance = distance;

    let visible = frustum_cull_aabb(
        tile.bounds_min,
        tile.bounds_max,
        tile.height_min,
        tile.height_max,
    );
    tile.visible = select(0u, 1u, visible);

    if (visible) {
        // Per-tile world width matches the CPU reference exactly.
        let tile_size = tile.bounds_max.x - tile.bounds_min.x;
        let selected_lod = select_lod(distance, tile_size);
        tile.selected_lod = selected_lod;

        let output_idx = atomicAdd(&output_header.visible_count, 1u);
        output_tiles[output_idx] = tile;

        let base_triangles = 128u * 128u * 2u;
        let tri_count = base_triangles / max(1u << (selected_lod * 2u), 1u);
        atomicAdd(&output_header.total_triangles, tri_count);
    }
}
