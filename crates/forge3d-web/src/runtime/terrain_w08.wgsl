// ---------------------------------------------------------------------------
// W08 overlays (E5) + material virtual texturing (E6) — group-0 bindings
// 14-16 (overlays) and 17-19 (VT). Binding 8/9 keep their material roles;
// when `terrain_vt` is on they point at the VT atlas and VT sampler instead.
// With both feature bits off none of these declarations exist, so the
// specialized source is byte-identical to the pre-W08 shader.
// ---------------------------------------------------------------------------

// #if terrain_overlay
// Planned overlay composite — layer = one RGBA8 slice in z-order, alpha
// already carries the layer opacity (C `plan_overlays`).
@group(0) @binding(14) var terrain_overlays: texture_2d_array<f32>;
@group(0) @binding(15) var terrain_overlay_sampler: sampler;

struct TerrainOverlayUniform {
    // x = visible layer count, y = global opacity.
    control: vec4<f32>,
    // x = blend mode (0 normal / 1 multiply / 2 overlay); one u32 lane per
    // layer, matching core `OverlayBlendMode` discriminant order.
    modes: array<vec4<u32>, 2>,
}
@group(0) @binding(16) var<uniform> terrain_overlay: TerrainOverlayUniform;

fn terrain_overlay_mode(layer_index: u32) -> u32 {
    return terrain_overlay.modes[layer_index / 4u][layer_index % 4u];
}

/// C `blend_linear` in WGSL: linear-space channels, `a` already includes
/// layer alpha * global opacity.
fn terrain_overlay_blend(mode: u32, base: vec3<f32>, src: vec3<f32>, a: f32) -> vec3<f32> {
    if (mode == 1u) {
        return base * (1.0 - a) + base * src * a;
    }
    if (mode == 2u) {
        let lo = 2.0 * base * src;
        let hi = vec3<f32>(1.0) - 2.0 * (vec3<f32>(1.0) - base) * (vec3<f32>(1.0) - src);
        let ov = select(hi, lo, base < vec3<f32>(0.5));
        return base * (1.0 - a) + ov * a;
    }
    return base * (1.0 - a) + src * a;
}

/// E5: apply the planned overlay stack over the material/color-ramp albedo
/// before lighting. `textureSampleLevel` is uniformity-safe.
fn terrain_apply_overlays(albedo: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
    var result = albedo;
    let count = u32(terrain_overlay.control.x + 0.5);
    for (var i = 0u; i < count; i = i + 1u) {
        let s = textureSampleLevel(terrain_overlays, terrain_overlay_sampler, uv, i32(i), 0.0);
        let a = clamp(s.a, 0.0, 1.0) * clamp(terrain_overlay.control.y, 0.0, 1.0);
        result = terrain_overlay_blend(terrain_overlay_mode(i), result, s.rgb, a);
    }
    return result;
}
// #endif

// #if terrain_vt
// #if terrain_material
// E6: albedo-only terrain material virtual texturing — exact port of the
// native `sample_material_layer_uv` (terrain_pbr_pom.wgsl). The page table
// is one RGBA32Float texture_2d_array; layer =
// `material_index * max_mip_levels + mip`, entry =
// [atlas_u, atlas_v, resident_flag, scale].
@group(0) @binding(17) var terrain_vt_page_table: texture_2d_array<f32>;

struct TerrainVTUniforms {
    // [enabled, tile_size, tile_border, atlas_size].
    config0: vec4<u32>,
    // [virtual_size_x, virtual_size_y, pages_x_mip0, pages_y_mip0].
    config1: vec4<u32>,
    // [max_mip_levels, material_count, unused, use_feedback].
    config2: vec4<u32>,
    // Per-material fallback colors (nonresident ultimate fallback).
    colors: array<vec4<f32>, 4>,
}
@group(0) @binding(18) var<uniform> terrain_vt_uniforms: TerrainVTUniforms;

struct TerrainVTFeedbackEntry {
    tile_x: u32,
    tile_y: u32,
    mip_level: u32,
    frame_number: u32,
}
@group(0) @binding(19) var<storage, read_write> terrain_vt_feedback: array<TerrainVTFeedbackEntry>;

const TERRAIN_VT_MATERIAL_CAPACITY: u32 = 4u;

fn terrain_vt_enabled() -> bool {
    return terrain_vt_uniforms.config0.x > 0u;
}

fn terrain_vt_material_index(layer: f32) -> u32 {
    let material_count = max(terrain_vt_uniforms.config2.y, 1u);
    let clamped_layer = clamp(u32(max(layer, 0.0)), 0u, material_count - 1u);
    return min(clamped_layer, TERRAIN_VT_MATERIAL_CAPACITY - 1u);
}

fn terrain_vt_fallback_color(material_index: u32) -> vec4<f32> {
    return terrain_vt_uniforms.colors[min(material_index, TERRAIN_VT_MATERIAL_CAPACITY - 1u)];
}

fn terrain_vt_desired_mip(ddx_uv: vec2<f32>, ddy_uv: vec2<f32>) -> u32 {
    let virtual_size = vec2<f32>(
        f32(max(terrain_vt_uniforms.config1.x, 1u)),
        f32(max(terrain_vt_uniforms.config1.y, 1u)),
    );
    let footprint_x = max(length(ddx_uv * virtual_size), length(ddy_uv * virtual_size));
    let desired = max(log2(max(footprint_x, 1.0)), 0.0);
    return min(u32(desired), max(terrain_vt_uniforms.config2.x, 1u) - 1u);
}

fn terrain_vt_page_dims(mip_level: u32) -> vec2<u32> {
    let base_dims = vec2<u32>(
        max(terrain_vt_uniforms.config1.z, 1u),
        max(terrain_vt_uniforms.config1.w, 1u),
    );
    let divisor = 1u << mip_level;
    let bias = divisor - 1u;
    return max(
        (base_dims + vec2<u32>(bias, bias)) / vec2<u32>(divisor, divisor),
        vec2<u32>(1u, 1u),
    );
}

fn terrain_vt_page_table_layer(material_index: u32, mip_level: u32) -> i32 {
    let max_mip_levels = max(terrain_vt_uniforms.config2.x, 1u);
    return i32(material_index * max_mip_levels + mip_level);
}

fn terrain_vt_feedback_index(material_index: u32, mip_level: u32, tile_x: u32, tile_y: u32) -> u32 {
    let base_pages_x = max(terrain_vt_uniforms.config1.z, 1u);
    let base_pages_y = max(terrain_vt_uniforms.config1.w, 1u);
    return (((material_index * max(terrain_vt_uniforms.config2.x, 1u)) + mip_level) * base_pages_y + tile_y) * base_pages_x + tile_x;
}

fn terrain_vt_write_feedback(material_index: u32, mip_level: u32, tile_x: u32, tile_y: u32) {
    if (terrain_vt_uniforms.config2.w == 0u) {
        return;
    }
    let base_pages_x = max(terrain_vt_uniforms.config1.z, 1u);
    let base_pages_y = max(terrain_vt_uniforms.config1.w, 1u);
    if (tile_x >= base_pages_x || tile_y >= base_pages_y) {
        return;
    }
    let index = terrain_vt_feedback_index(material_index, mip_level, tile_x, tile_y);
    terrain_vt_feedback[index] = TerrainVTFeedbackEntry(
        tile_x,
        tile_y,
        mip_level,
        material_index + 1u,
    );
}

/// Exact port of native `sample_material_layer_uv`: non-VT falls back to the
/// material albedo array; VT computes the desired mip, records the desired
/// page in the feedback ring, then walks desired -> coarsest until a
/// resident page answers (ultimate fallback = per-material color). All
/// lookups use `textureLoad` / `textureSampleLevel` so the loop is
/// uniformity-safe; under VT binding 8/9 are the atlas + VT sampler.
fn tm_sample_material_layer_uv(
    uv: vec2<f32>,
    ddx_uv: vec2<f32>,
    ddy_uv: vec2<f32>,
    layer: f32,
) -> vec3<f32> {
    if (!terrain_vt_enabled()) {
        let layer_index = i32(layer);
        return textureSampleGrad(
            terrain_material_albedo,
            terrain_material_sampler,
            uv,
            layer_index,
            ddx_uv,
            ddy_uv,
        ).rgb;
    }

    let material_index = terrain_vt_material_index(layer);
    let virtual_size = vec2<f32>(
        f32(max(terrain_vt_uniforms.config1.x, 1u)),
        f32(max(terrain_vt_uniforms.config1.y, 1u)),
    );
    let tile_size = f32(max(terrain_vt_uniforms.config0.y, 1u));
    let tile_border = f32(terrain_vt_uniforms.config0.z);
    let atlas_size = f32(max(terrain_vt_uniforms.config0.w, 1u));
    let max_mip_levels = max(terrain_vt_uniforms.config2.x, 1u);
    let wrapped_uv = fract(uv);
    let virtual_texel = wrapped_uv * virtual_size;
    let desired_mip = terrain_vt_desired_mip(ddx_uv, ddy_uv);
    let desired_page_dims = terrain_vt_page_dims(desired_mip);
    let desired_page_size = vec2<f32>(
        tile_size * exp2(f32(desired_mip)),
        tile_size * exp2(f32(desired_mip)),
    );
    let desired_page = min(
        vec2<u32>(virtual_texel / desired_page_size),
        desired_page_dims - vec2<u32>(1u, 1u),
    );
    terrain_vt_write_feedback(material_index, desired_mip, desired_page.x, desired_page.y);

    var mip_level = desired_mip;
    loop {
        let page_dims = terrain_vt_page_dims(mip_level);
        let page_size = vec2<f32>(
            tile_size * exp2(f32(mip_level)),
            tile_size * exp2(f32(mip_level)),
        );
        let page = min(vec2<u32>(virtual_texel / page_size), page_dims - vec2<u32>(1u, 1u));
        let entry = textureLoad(
            terrain_vt_page_table,
            vec2<i32>(i32(page.x), i32(page.y)),
            terrain_vt_page_table_layer(material_index, mip_level),
            0,
        );
        if (entry.z > 0.5) {
            let page_origin = vec2<f32>(f32(page.x), f32(page.y)) * page_size;
            let texel_in_page = (virtual_texel - page_origin) / exp2(f32(mip_level));
            let inner_texel = clamp(
                texel_in_page,
                vec2<f32>(0.0, 0.0),
                vec2<f32>(tile_size - 1.0, tile_size - 1.0),
            );
            let atlas_uv = vec2<f32>(entry.x, entry.y)
                + (vec2<f32>(tile_border, tile_border) + inner_texel + vec2<f32>(0.5, 0.5))
                    / atlas_size;
            return textureSampleLevel(
                terrain_material_albedo,
                terrain_material_sampler,
                atlas_uv,
                0,
                0.0,
            ).rgb;
        }
        if (mip_level + 1u >= max_mip_levels) {
            break;
        }
        mip_level = mip_level + 1u;
    }

    return terrain_vt_fallback_color(material_index).rgb;
}
// #endif
// #endif
