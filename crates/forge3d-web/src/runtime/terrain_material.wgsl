
// #if terrain_material
// Terrain PBR/POM material pipeline (W07): the land path of
// 1f4084a:src/shaders/terrain_pbr_pom.wgsl plus src/shaders/terrain_noise.wgsl.
//
// Screen mode keeps the native fullscreen frame quirks bit-for-bit (constant
// Z-up base normal, Y-up Sobel height normal, tangent-to-world POM product) so
// native goldens stay comparable. Perspective mode feeds the same shading from
// the true heightfield normal and a correct world-to-tangent POM frame.
//
// Browsers enforce derivative uniformity: every derivative is taken by the
// front-end functions before the POM march (a separate function), and
// `tm_shade` only uses explicit-gradient or explicit-level sampling.
// Derivatives are coarse, as in the native 1.34 terrain shader, so the edge,
// specular-AA and height-LOD terms are deterministic per 2x2 quad.

struct TerrainMaterialUniform {
    // x = enabled, y = albedo mode (0 material, 1 colormap, 2 mix),
    // z = colormap strength, w = output gamma
    control: vec4<f32>,
    // x = colormap sRGB decode, y = exact sRGB output EOTF,
    // z = roughness multiplier, w = hue variation strength
    flags: vec4<f32>,
    // x = specular AA enabled, y = sigma scale, z = variance threshold,
    // w = detail normal-map strength
    spec_aa: vec4<f32>,
    // x = scale, y = blend sharpness, z = normal strength, w = POM scale
    triplanar: vec4<f32>,
    // x = min steps, y = max steps, z = refine steps, w = POM flags
    pom_steps: vec4<f32>,
    layer_heights: vec4<f32>,
    layer_roughness: vec4<f32>,
    layer_metallic: vec4<f32>,
    // x = layer count, y = blend half width, z = lod bias, w = lod0 bias
    layer_control: vec4<f32>,
    // height min/max, slope min/max
    clamp0: vec4<f32>,
    // ambient min/max, shadow min/max
    clamp1: vec4<f32>,
    // occlusion min/max, lod level, anisotropy
    clamp2: vec4<f32>,
    // x = curve mode, y = strength, z = power, w = lambert contrast
    height_curve: vec4<f32>,
    // x = detail enabled, y = detail scale, z = normal strength, w = albedo noise
    detail0: vec4<f32>,
    // x = fade start, y = fade end, z = has detail normal map, w = mask bits
    detail1: vec4<f32>,
    // x = debug view
    debug: vec4<f32>,
    snow_params0: vec4<f32>,
    snow_params1: vec4<f32>,
    snow_color: vec4<f32>,
    snow_sss_tint: vec4<f32>,
    rock_params: vec4<f32>,
    rock_color: vec4<f32>,
    rock_sss_tint: vec4<f32>,
    wetness_params: vec4<f32>,
    wetness_sss_tint: vec4<f32>,
    variation_params0: vec4<f32>,
    snow_variation: vec4<f32>,
    rock_variation: vec4<f32>,
    wetness_variation: vec4<f32>,
    height_curve_lut: array<vec4<f32>, 64>,
};

@group(0) @binding(7) var<uniform> terrain_material: TerrainMaterialUniform;
@group(0) @binding(8) var terrain_material_albedo: texture_2d_array<f32>;
@group(0) @binding(9) var terrain_material_sampler: sampler;
// Layer 0: tangent-space detail normal map; layer 1: snow/rock/wetness masks.
@group(0) @binding(10) var terrain_material_aux: texture_2d_array<f32>;
@group(0) @binding(11) var terrain_material_aux_sampler: sampler;

const TM_PI: f32 = 3.14159265;
const TM_NOISE_MAX_OCTAVES: i32 = 8;
const TM_POM_MAX_STEPS: u32 = 128u;
const TM_POM_MAX_REFINE_STEPS: u32 = 32u;
const TM_SHADOW_IBL_FACTOR: f32 = 0.20;
const TM_AMBIENT_FLOOR: f32 = 0.18;

// ---------------------------------------------------------------------------
// terrain_noise.wgsl
// ---------------------------------------------------------------------------

fn tm_hash31(p: vec3<f32>) -> f32 {
    var p3 = fract(p * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn tm_hash33(p: vec3<f32>) -> vec3<f32> {
    let q = vec3<f32>(
        dot(p, vec3<f32>(127.1, 311.7, 74.7)),
        dot(p, vec3<f32>(269.5, 183.3, 246.1)),
        dot(p, vec3<f32>(113.5, 271.9, 124.6)),
    );
    return fract(sin(q) * 43758.5453);
}

fn tm_value_noise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let n000 = tm_hash31(i + vec3<f32>(0.0, 0.0, 0.0));
    let n100 = tm_hash31(i + vec3<f32>(1.0, 0.0, 0.0));
    let n010 = tm_hash31(i + vec3<f32>(0.0, 1.0, 0.0));
    let n110 = tm_hash31(i + vec3<f32>(1.0, 1.0, 0.0));
    let n001 = tm_hash31(i + vec3<f32>(0.0, 0.0, 1.0));
    let n101 = tm_hash31(i + vec3<f32>(1.0, 0.0, 1.0));
    let n011 = tm_hash31(i + vec3<f32>(0.0, 1.0, 1.0));
    let n111 = tm_hash31(i + vec3<f32>(1.0, 1.0, 1.0));
    let x0 = mix(n000, n100, u.x);
    let x1 = mix(n010, n110, u.x);
    let x2 = mix(n001, n101, u.x);
    let x3 = mix(n011, n111, u.x);
    let y0 = mix(x0, x1, u.y);
    let y1 = mix(x2, x3, u.y);
    return mix(y0, y1, u.z);
}

fn tm_fbm(p: vec3<f32>, octaves: i32) -> f32 {
    let clamped_octaves = clamp(octaves, 1, TM_NOISE_MAX_OCTAVES);
    var amplitude = 0.5;
    var frequency = 1.0;
    var sum = 0.0;
    var amplitude_sum = 0.0;
    for (var i = 0; i < TM_NOISE_MAX_OCTAVES; i = i + 1) {
        if (i >= clamped_octaves) {
            break;
        }
        sum = sum + tm_value_noise(p * frequency) * amplitude;
        amplitude_sum = amplitude_sum + amplitude;
        amplitude = amplitude * 0.5;
        frequency = frequency * 2.0;
    }
    return select(0.0, sum / amplitude_sum, amplitude_sum > 0.0);
}

fn tm_ridged_fbm(p: vec3<f32>, octaves: i32) -> f32 {
    let clamped_octaves = clamp(octaves, 1, TM_NOISE_MAX_OCTAVES);
    var amplitude = 0.5;
    var frequency = 1.0;
    var sum = 0.0;
    var amplitude_sum = 0.0;
    var ridge_weight = 1.0;
    for (var i = 0; i < TM_NOISE_MAX_OCTAVES; i = i + 1) {
        if (i >= clamped_octaves) {
            break;
        }
        let n = tm_value_noise(p * frequency);
        let ridge = 1.0 - abs(n * 2.0 - 1.0);
        let weighted = ridge * ridge * ridge_weight;
        sum = sum + weighted * amplitude;
        amplitude_sum = amplitude_sum + amplitude;
        ridge_weight = clamp(weighted * 1.8, 0.0, 1.0);
        amplitude = amplitude * 0.5;
        frequency = frequency * 2.0;
    }
    return select(0.0, sum / amplitude_sum, amplitude_sum > 0.0);
}

fn tm_cellular_distance(p: vec3<f32>) -> f32 {
    let base_cell = floor(p);
    let local = fract(p);
    var min_distance = 10.0;
    for (var z = -1; z <= 1; z = z + 1) {
        for (var y = -1; y <= 1; y = y + 1) {
            for (var x = -1; x <= 1; x = x + 1) {
                let offset = vec3<f32>(f32(x), f32(y), f32(z));
                let jitter = tm_hash33(base_cell + offset);
                let feature = offset + jitter - local;
                min_distance = min(min_distance, length(feature));
            }
        }
    }
    return clamp(min_distance / 1.7320508, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Heights, curves and normals
// ---------------------------------------------------------------------------

fn tm_curve_lut(t: f32) -> f32 {
    let index = u32(round(clamp(t, 0.0, 1.0) * 255.0));
    return terrain_material.height_curve_lut[index / 4u][index % 4u];
}

fn tm_apply_curve(t: f32) -> f32 {
    let mode = u32(terrain_material.height_curve.x + 0.5);
    let strength = clamp(terrain_material.height_curve.y, 0.0, 1.0);
    if (strength <= 0.0) {
        return t;
    }
    var curved = t;
    if (mode == 1u) {
        curved = pow(t, max(terrain_material.height_curve.z, 0.01));
    } else if (mode == 2u) {
        curved = t * t * (3.0 - 2.0 * t);
    } else if (mode == 3u) {
        curved = tm_curve_lut(t);
    }
    return mix(t, curved, strength);
}

/// Native `sample_height_geom`: clamp to the height range, then apply the curve.
fn tm_height_geom(raw_height: f32) -> f32 {
    let valid = select(params.domain_min, raw_height, is_valid_height(raw_height));
    let h_min = terrain_material.clamp0.x;
    let h_max = terrain_material.clamp0.y;
    let range = max(h_max - h_min, 1e-6);
    let t = clamp((valid - h_min) / range, 0.0, 1.0);
    return h_min + tm_apply_curve(t) * (h_max - h_min);
}

/// Height normalized to the height range, used by POM and occlusion.
fn tm_height_unit(raw_height: f32) -> f32 {
    let valid = select(params.domain_min, raw_height, is_valid_height(raw_height));
    let h_min = terrain_material.clamp0.x;
    let range = max(terrain_material.clamp0.y - h_min, 1e-6);
    return clamp((valid - h_min) / range, 0.0, 1.0);
}

fn tm_height_lod(duv_dx: vec2<f32>, duv_dy: vec2<f32>) -> f32 {
    let dims = vec2<f32>(textureDimensions(heightmap, 0));
    let max_lod = f32(textureNumLevels(heightmap) - 1u);
    let rho = max(length(duv_dx * dims), length(duv_dy * dims));
    return clamp(log2(max(rho, 1.0)), 0.0, max_lod);
}

/// Native `calculate_normal_lod_aware` on the unit screen tile (Y-up vector).
fn tm_screen_height_normal(uv: vec2<f32>, lod: f32) -> vec3<f32> {
    let dims = vec2<f32>(textureDimensions(heightmap, 0));
    let texel_uv = exp2(lod) / dims;
    let offset_x = vec2<f32>(texel_uv.x, 0.0);
    let offset_y = vec2<f32>(0.0, texel_uv.y);
    let tl = tm_height_geom(screen_height_sample(uv - offset_x - offset_y));
    let t = tm_height_geom(screen_height_sample(uv - offset_y));
    let tr = tm_height_geom(screen_height_sample(uv + offset_x - offset_y));
    let l = tm_height_geom(screen_height_sample(uv - offset_x));
    let r = tm_height_geom(screen_height_sample(uv + offset_x));
    let bl = tm_height_geom(screen_height_sample(uv - offset_x + offset_y));
    let b = tm_height_geom(screen_height_sample(uv + offset_y));
    let br = tm_height_geom(screen_height_sample(uv + offset_x + offset_y));
    let dx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    let dy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
    let vertical_scale = max(params.exaggeration * 0.5, 1e-3);
    return normalize(vec3<f32>(-dx / texel_uv.x, vertical_scale, -dy / texel_uv.y));
}

/// True Y-up heightfield normal on the physical grid (perspective mode).
fn tm_perspective_normal(uv: vec2<f32>) -> vec3<f32> {
    let dimensions = textureDimensions(heightmap);
    let max_texel = vec2<i32>(i32(dimensions.x) - 1, i32(dimensions.y) - 1);
    let scaled_uv = uv * vec2<f32>(f32(dimensions.x - 1u), f32(dimensions.y - 1u));
    let center = vec2<i32>(i32(round(scaled_uv.x)), i32(round(scaled_uv.y)));
    let center_height = tm_height_geom(height_at(center, max_texel));
    let left = tm_height_geom(height_or_center(center + vec2<i32>(-1, 0), max_texel, center_height));
    let right = tm_height_geom(height_or_center(center + vec2<i32>(1, 0), max_texel, center_height));
    let up = tm_height_geom(height_or_center(center + vec2<i32>(0, -1), max_texel, center_height));
    let down = tm_height_geom(height_or_center(center + vec2<i32>(0, 1), max_texel, center_height));
    let tangent_x = vec3<f32>(2.0 * params.spacing.x, (right - left) * params.exaggeration, 0.0);
    let tangent_z = vec3<f32>(0.0, (down - up) * params.exaggeration, 2.0 * params.spacing.y);
    return normalize(cross(tangent_z, tangent_x));
}

// ---------------------------------------------------------------------------
// Triplanar material set
// ---------------------------------------------------------------------------

fn tm_triplanar_weights(normal: vec3<f32>, blend_sharpness: f32) -> vec3<f32> {
    let abs_n = abs(normal);
    let sharpen = pow(abs_n + vec3<f32>(1e-4), vec3<f32>(blend_sharpness * 1.5));
    let weight_sum = sharpen.x + sharpen.y + sharpen.z;
    return sharpen / max(weight_sum, 1e-4);
}

fn tm_sample_triplanar(
    world_pos: vec3<f32>,
    normal: vec3<f32>,
    scale: f32,
    blend_sharpness: f32,
    layer: i32,
    dpdx_world: vec3<f32>,
    dpdy_world: vec3<f32>,
) -> vec3<f32> {
    let weights = tm_triplanar_weights(normal, blend_sharpness);
    let uv_x = world_pos.yz * scale;
    let uv_y = world_pos.xz * scale;
    let uv_z = world_pos.xy * scale;
    let ddx_world = dpdx_world * scale;
    let ddy_world = dpdy_world * scale;
    let color_x = textureSampleGrad(
        terrain_material_albedo, terrain_material_sampler, uv_x, layer, ddx_world.yz, ddy_world.yz,
    ).rgb;
    let color_y = textureSampleGrad(
        terrain_material_albedo, terrain_material_sampler, uv_y, layer, ddx_world.xz, ddy_world.xz,
    ).rgb;
    let color_z = textureSampleGrad(
        terrain_material_albedo, terrain_material_sampler, uv_z, layer, ddx_world.xy, ddy_world.xy,
    ).rgb;
    return color_x * weights.x + color_y * weights.y + color_z * weights.z;
}

fn tm_checker(uv: vec2<f32>, checker_scale: f32) -> f32 {
    let grid = floor(uv * checker_scale);
    return f32(i32(grid.x + grid.y) & 1);
}

struct TmMaterialSample {
    albedo: vec3<f32>,
    roughness: f32,
    metallic: f32,
};

fn tm_material_set(
    world_pos: vec3<f32>,
    triplanar_normal: vec3<f32>,
    height_norm: f32,
    slope_factor: f32,
    dpdx_world: vec3<f32>,
    dpdy_world: vec3<f32>,
) -> TmMaterialSample {
    let tri_scale = max(terrain_material.triplanar.x, 1e-3);
    let tri_blend = max(terrain_material.triplanar.y, 1.0);
    var layer_count = i32(terrain_material.layer_control.x + 0.5);
    if (layer_count < 1) {
        layer_count = 1;
    }
    let blend_half = max(terrain_material.layer_control.y, 1e-3);
    var weights = vec4<f32>(0.0);
    var weight_sum = 0.0;
    for (var idx = 0; idx < 4; idx = idx + 1) {
        if (idx < layer_count) {
            let center = terrain_material.layer_heights[idx];
            let dist = abs(height_norm - center);
            let sigma = blend_half * 1.5;
            let height_weight = exp(-dist * dist / (2.0 * sigma * sigma));
            var slope_mod = 1.0;
            if (idx == 0) {
                slope_mod = mix(1.0, 1.5, slope_factor);
            } else if (idx == 1) {
                slope_mod = mix(1.0, 0.5, slope_factor);
            }
            let w = height_weight * slope_mod;
            weights[idx] = w;
            weight_sum = weight_sum + w;
        }
    }
    if (weight_sum > 1e-5) {
        weights = weights / weight_sum;
    } else {
        weights = vec4<f32>(1.0, 0.0, 0.0, 0.0);
    }
    var result: TmMaterialSample;
    result.albedo = vec3<f32>(0.0);
    result.roughness = 0.0;
    result.metallic = 0.0;
    for (var idx = 0; idx < 4; idx = idx + 1) {
        if (idx < layer_count) {
            let weight = weights[idx];
            let sample_rgb = tm_sample_triplanar(
                world_pos, triplanar_normal, tri_scale, tri_blend, idx, dpdx_world, dpdy_world,
            );
            result.albedo = result.albedo + sample_rgb * weight;
            result.roughness = result.roughness + terrain_material.layer_roughness[idx] * weight;
            result.metallic = result.metallic + terrain_material.layer_metallic[idx] * weight;
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Micro-detail (P6)
// ---------------------------------------------------------------------------

/// Native 1.34 `build_tbn`: Y-up reference unless the normal is nearly Y
/// (1f4084a used the Z axis first, which degenerates for Z-up normals).
fn tm_build_tbn(normal: vec3<f32>) -> mat3x3<f32> {
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(normal.y) > 0.99);
    let tangent = normalize(cross(up, normal));
    let bitangent = cross(normal, tangent);
    return mat3x3<f32>(tangent, bitangent, normal);
}

fn tm_procedural_detail_normal(world_pos: vec3<f32>, scale: f32) -> vec3<f32> {
    let p = world_pos * scale;
    let eps = 0.1;
    let nx = tm_value_noise(p + vec3<f32>(eps, 0.0, 0.0)) - tm_value_noise(p - vec3<f32>(eps, 0.0, 0.0));
    let ny = tm_value_noise(p + vec3<f32>(0.0, eps, 0.0)) - tm_value_noise(p - vec3<f32>(0.0, eps, 0.0));
    let nz = tm_value_noise(p + vec3<f32>(0.0, 0.0, eps)) - tm_value_noise(p - vec3<f32>(0.0, 0.0, eps));
    let gradient = vec3<f32>(nx, ny, nz) * 2.0;
    return normalize(vec3<f32>(gradient.x, gradient.z, 1.0));
}

fn tm_blend_rnm(base_n: vec3<f32>, detail_n: vec3<f32>) -> vec3<f32> {
    let t = base_n + vec3<f32>(0.0, 0.0, 1.0);
    let u = detail_n * vec3<f32>(-1.0, -1.0, 1.0);
    return normalize(t * dot(t, u) - u * t.z);
}

fn tm_detail_fade(view_distance: f32, fade_start: f32, fade_end: f32) -> f32 {
    if (view_distance <= fade_start) {
        return 1.0;
    }
    if (view_distance >= fade_end) {
        return 0.0;
    }
    let t = (view_distance - fade_start) / (fade_end - fade_start);
    return 1.0 - t * t * (3.0 - 2.0 * t);
}

fn tm_detail_fade_start() -> f32 {
    return max(terrain_material.detail1.x, 0.0);
}

fn tm_detail_fade_end() -> f32 {
    return max(terrain_material.detail1.y, tm_detail_fade_start() + 1.0);
}

fn tm_apply_detail_normal(base_normal: vec3<f32>, world_pos: vec3<f32>, view_distance: f32) -> vec3<f32> {
    let detail_scale = max(terrain_material.detail0.y, 0.1);
    let detail_strength = clamp(terrain_material.detail0.z, 0.0, 1.0);
    let fade = tm_detail_fade(view_distance, tm_detail_fade_start(), tm_detail_fade_end());
    if (fade <= 0.0 || detail_strength <= 0.0) {
        return base_normal;
    }
    let weights = tm_triplanar_weights(base_normal, 4.0);
    let uv_scale = 1.0 / detail_scale;
    let detail_x = tm_procedural_detail_normal(vec3<f32>(0.0, world_pos.y, world_pos.z) * uv_scale, 1.0);
    let detail_y = tm_procedural_detail_normal(vec3<f32>(world_pos.x, 0.0, world_pos.z) * uv_scale, 1.0);
    let detail_z = tm_procedural_detail_normal(vec3<f32>(world_pos.x, world_pos.y, 0.0) * uv_scale, 1.0);
    let blended_detail = normalize(detail_x * weights.x + detail_y * weights.y + detail_z * weights.z);
    let tbn = tm_build_tbn(base_normal);
    let effective_strength = detail_strength * fade;
    let blended = tm_blend_rnm(
        base_normal,
        mix(vec3<f32>(0.0, 0.0, 1.0), blended_detail, effective_strength),
    );
    return normalize(tbn * blended);
}

/// Tangent-space detail normal map (DetailSettings.detail_normal_path /
/// detail_strength). Native binds this texture but never samples it.
fn tm_apply_detail_normal_map(
    base_normal: vec3<f32>,
    encoded: vec3<f32>,
    view_distance: f32,
) -> vec3<f32> {
    let detail_strength = clamp(terrain_material.spec_aa.w, 0.0, 1.0);
    let fade = tm_detail_fade(view_distance, tm_detail_fade_start(), tm_detail_fade_end());
    if (fade <= 0.0 || detail_strength <= 0.0) {
        return base_normal;
    }
    let decoded = encoded * 2.0 - vec3<f32>(1.0);
    if (dot(decoded, decoded) < 0.0001) {
        return base_normal;
    }
    let detail_tangent = normalize(decoded);
    if (abs(detail_tangent.x) < 0.01 && abs(detail_tangent.y) < 0.01 && detail_tangent.z > 0.99) {
        return base_normal;
    }
    let tbn = tm_build_tbn(base_normal);
    let blended = tm_blend_rnm(
        base_normal,
        mix(vec3<f32>(0.0, 0.0, 1.0), detail_tangent, detail_strength * fade),
    );
    return normalize(tbn * blended);
}

fn tm_albedo_noise(world_pos: vec3<f32>, noise_amplitude: f32) -> f32 {
    let noise = tm_value_noise(world_pos * 0.7);
    return 1.0 + (noise - 0.5) * 2.0 * noise_amplitude;
}

// ---------------------------------------------------------------------------
// Parallax occlusion mapping
// ---------------------------------------------------------------------------

fn tm_pom_height(uv: vec2<f32>) -> f32 {
    return tm_height_unit(screen_height_sample(uv));
}

fn tm_parallax_occlusion(
    uv: vec2<f32>,
    view_dir_tangent: vec3<f32>,
    height_scale: f32,
    min_steps: u32,
    max_steps: u32,
    refine_steps: u32,
) -> vec2<f32> {
    if (height_scale <= 0.0) {
        return uv;
    }
    let view_dir = normalize(view_dir_tangent);
    let min_s = clamp(max(min_steps, 1u), 1u, TM_POM_MAX_STEPS);
    let max_s = clamp(max(max_steps, min_s), min_s, TM_POM_MAX_STEPS);
    let refine_count = min(refine_steps, TM_POM_MAX_REFINE_STEPS);
    let blend = clamp(abs(view_dir.z), 0.0, 1.0);
    let steps_interp = mix(f32(max_s), f32(min_s), blend);
    let step_count = clamp(u32(steps_interp + 0.5), 1u, max_s);
    let step_size = 1.0 / f32(step_count);
    let dir_xy = view_dir.xy;
    if (length(dir_xy) < 1e-5) {
        return uv;
    }
    let parallax_dir = normalize(dir_xy) * height_scale;
    var current_uv = uv;
    var current_layer = 0.0;
    var current_height = tm_pom_height(current_uv);
    for (var i = 0u; i < TM_POM_MAX_STEPS; i = i + 1u) {
        if (i >= step_count || current_layer >= current_height) {
            break;
        }
        current_uv = current_uv - parallax_dir * step_size;
        current_layer = current_layer + step_size;
        current_height = tm_pom_height(current_uv);
    }
    var refine_step_size = step_size;
    for (var i = 0u; i < TM_POM_MAX_REFINE_STEPS; i = i + 1u) {
        if (i >= refine_count) {
            break;
        }
        let delta_uv = parallax_dir * refine_step_size * 0.5;
        refine_step_size = refine_step_size * 0.5;
        current_height = tm_pom_height(current_uv);
        if (current_layer >= current_height) {
            current_uv = current_uv - delta_uv;
            current_layer = current_layer - refine_step_size;
        } else {
            current_uv = current_uv + delta_uv;
            current_layer = current_layer + refine_step_size;
        }
    }
    return current_uv;
}

fn tm_pom(uv: vec2<f32>, view_dir_tangent: vec3<f32>) -> vec2<f32> {
    let pom_scale = max(terrain_material.triplanar.w, 0.0);
    let pom_flags = u32(terrain_material.pom_steps.w + 0.5);
    if ((pom_flags & 1u) == 0u || pom_scale <= 0.0) {
        return uv;
    }
    let min_steps = clamp(u32(terrain_material.pom_steps.x + 0.5), 1u, 128u);
    let max_steps = clamp(u32(terrain_material.pom_steps.y + 0.5), min_steps, 128u);
    let refine_steps = clamp(u32(max(terrain_material.pom_steps.z, 0.0)), 0u, 32u);
    return tm_parallax_occlusion(uv, view_dir_tangent, pom_scale, min_steps, max_steps, refine_steps);
}

// ---------------------------------------------------------------------------
// Material layers (M4 snow/rock/wetness, TV4 variation, TV10 subsurface)
// ---------------------------------------------------------------------------

struct TmNoise {
    snow_macro: f32,
    snow_detail: f32,
    rock_macro: f32,
    rock_detail: f32,
    wetness_macro: f32,
    wetness_detail: f32,
};

struct TmLayerWeights {
    snow: f32,
    rock: f32,
    wetness: f32,
};

struct TmSubsurface {
    strength: f32,
    tint: vec3<f32>,
};

/// Native `compute_terrain_attributes` on a Z-up normal: (slope, aspect).
fn tm_terrain_attributes(world_normal: vec3<f32>) -> vec2<f32> {
    let slope = acos(clamp(world_normal.z, -1.0, 1.0));
    let horizontal = vec2<f32>(world_normal.x, world_normal.y);
    var aspect = 0.0;
    if (length(horizontal) > 0.001) {
        aspect = atan2(horizontal.x, horizontal.y);
        if (aspect < 0.0) {
            aspect = aspect + 2.0 * TM_PI;
        }
    }
    return vec2<f32>(slope, aspect);
}

fn tm_material_noise(terrain_uv: vec2<f32>, height_norm: f32) -> TmNoise {
    var noise = TmNoise(0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
    if (terrain_material.variation_params0.w <= 0.5) {
        return noise;
    }
    let macro_scale = max(terrain_material.variation_params0.x, 0.001);
    let detail_scale = max(terrain_material.variation_params0.y, 0.001);
    let octaves = i32(terrain_material.variation_params0.z + 0.5);
    let macro_coords = vec3<f32>(terrain_uv * macro_scale, height_norm * 1.7);
    let detail_coords = vec3<f32>(terrain_uv * detail_scale, height_norm * 3.1);
    let detail_octaves = min(octaves + 1, TM_NOISE_MAX_OCTAVES);
    noise.snow_macro = tm_fbm(macro_coords, octaves);
    noise.snow_detail = tm_fbm(detail_coords + vec3<f32>(17.3, 9.1, 3.7), detail_octaves);
    noise.rock_macro = tm_ridged_fbm(macro_coords + vec3<f32>(31.7, 5.2, 11.9), octaves);
    noise.rock_detail = 1.0 - tm_cellular_distance(detail_coords + vec3<f32>(2.1, 13.4, 7.6));
    noise.wetness_macro = 1.0 - tm_cellular_distance(macro_coords + vec3<f32>(19.5, 23.1, 5.7));
    noise.wetness_detail = tm_fbm(detail_coords + vec3<f32>(41.0, 17.0, 29.0), detail_octaves);
    return noise;
}

fn tm_variation(
    base_weight: f32,
    macro_noise: f32,
    detail_noise: f32,
    macro_amplitude: f32,
    detail_amplitude: f32,
) -> f32 {
    let macro_delta = (macro_noise - 0.5) * 2.0 * macro_amplitude;
    let detail_delta = (detail_noise - 0.5) * 2.0 * detail_amplitude;
    let transition_boost = 0.35 + 0.65 * (1.0 - abs(base_weight * 2.0 - 1.0));
    return clamp(base_weight + (macro_delta + detail_delta) * transition_boost, 0.0, 1.0);
}

fn tm_snow_weight(altitude: f32, attrs: vec2<f32>, noise: TmNoise) -> f32 {
    if (terrain_material.snow_params1.z < 0.5) {
        return 0.0;
    }
    let slope = attrs.x;
    let aspect = attrs.y;
    let alt_min = terrain_material.snow_params0.x;
    let alt_blend = terrain_material.snow_params0.y;
    let altitude_factor = clamp((altitude - alt_min) / max(alt_blend, 0.001), 0.0, 1.0);
    let slope_max = terrain_material.snow_params0.z;
    let slope_blend = terrain_material.snow_params0.w;
    let slope_factor = 1.0 - clamp((slope - slope_max + slope_blend) / max(slope_blend, 0.001), 0.0, 1.0);
    let aspect_influence = terrain_material.snow_params1.x;
    let south_factor = cos(aspect);
    let aspect_factor = mix(1.0, 0.5 + 0.5 * south_factor, aspect_influence);
    return tm_variation(
        altitude_factor * slope_factor * aspect_factor,
        noise.snow_macro,
        noise.snow_detail,
        terrain_material.snow_variation.x,
        terrain_material.snow_variation.y,
    );
}

fn tm_rock_weight(attrs: vec2<f32>, noise: TmNoise) -> f32 {
    if (terrain_material.rock_params.w < 0.5) {
        return 0.0;
    }
    let slope_min = terrain_material.rock_params.x;
    let slope_blend = terrain_material.rock_params.y;
    return tm_variation(
        clamp((attrs.x - slope_min) / max(slope_blend, 0.001), 0.0, 1.0),
        noise.rock_macro,
        noise.rock_detail,
        terrain_material.rock_variation.x,
        terrain_material.rock_variation.y,
    );
}

fn tm_wetness_coverage(attrs: vec2<f32>, noise: TmNoise) -> f32 {
    if (terrain_material.wetness_params.z < 0.5) {
        return 0.0;
    }
    let slope_influence = terrain_material.wetness_params.y;
    let flat_factor = 1.0 - clamp(attrs.x / (TM_PI * 0.25), 0.0, 1.0);
    return tm_variation(
        flat_factor * slope_influence,
        noise.wetness_macro,
        noise.wetness_detail,
        terrain_material.wetness_variation.x,
        terrain_material.wetness_variation.y,
    );
}

fn tm_layer_weights(
    altitude: f32,
    attrs: vec2<f32>,
    noise: TmNoise,
    masks: vec3<f32>,
) -> TmLayerWeights {
    return TmLayerWeights(
        tm_snow_weight(altitude, attrs, noise) * masks.x,
        tm_rock_weight(attrs, noise) * masks.y,
        tm_wetness_coverage(attrs, noise) * masks.z,
    );
}

fn tm_subsurface_layer(state: TmSubsurface, weight: f32, strength: f32, tint: vec3<f32>) -> TmSubsurface {
    if (weight <= 0.0 || strength <= 0.0) {
        return state;
    }
    let coverage = clamp(weight, 0.0, 1.0);
    return TmSubsurface(mix(state.strength, strength, coverage), mix(state.tint, tint, coverage));
}

fn tm_resolve_subsurface(weights: TmLayerWeights) -> TmSubsurface {
    var state = TmSubsurface(0.0, vec3<f32>(1.0, 1.0, 1.0));
    state = tm_subsurface_layer(
        state, weights.wetness, terrain_material.wetness_params.w, terrain_material.wetness_sss_tint.rgb,
    );
    state = tm_subsurface_layer(
        state, weights.rock, terrain_material.rock_color.w, terrain_material.rock_sss_tint.rgb,
    );
    state = tm_subsurface_layer(
        state, weights.snow, terrain_material.snow_params1.w, terrain_material.snow_sss_tint.rgb,
    );
    return state;
}

fn tm_apply_layers(base_albedo: vec3<f32>, weights: TmLayerWeights) -> vec3<f32> {
    let darkening = 1.0 - clamp(weights.wetness, 0.0, 1.0) * terrain_material.wetness_params.x;
    var albedo = base_albedo * darkening;
    albedo = mix(albedo, terrain_material.rock_color.rgb, clamp(weights.rock, 0.0, 1.0));
    albedo = mix(albedo, terrain_material.snow_color.rgb, clamp(weights.snow, 0.0, 1.0));
    return albedo;
}

fn tm_evaluate_subsurface(
    state: TmSubsurface,
    albedo: vec3<f32>,
    normal: vec3<f32>,
    view_dir: vec3<f32>,
    light_dir: vec3<f32>,
    combined_shadow: f32,
    ibl_diffuse_factor: f32,
) -> vec3<f32> {
    if (state.strength <= 0.0) {
        return vec3<f32>(0.0, 0.0, 0.0);
    }
    let n_dot_l = clamp(dot(normal, light_dir), 0.0, 1.0);
    let wrap_width = 0.45 * state.strength;
    let wrapped = clamp((n_dot_l + wrap_width) / (1.0 + wrap_width), 0.0, 1.0);
    let wrap_boost = max(wrapped - n_dot_l, 0.0);
    let view_backscatter = pow(clamp(dot(view_dir, -light_dir), 0.0, 1.0), 4.0);
    let backscatter = view_backscatter * (0.25 + 0.75 * (1.0 - n_dot_l));
    let scatter_profile = max(wrap_boost * 1.35, backscatter * 0.30);
    let shadow_bleed = mix(0.20, 1.0, clamp(combined_shadow, 0.0, 1.0));
    let ambient_fill = ibl_diffuse_factor * (0.02 + 0.06 * state.strength) * (1.0 - n_dot_l * 0.5);
    let scatter_color = clamp(
        albedo * mix(vec3<f32>(1.0, 1.0, 1.0), state.tint, 0.85),
        vec3<f32>(0.0, 0.0, 0.0),
        vec3<f32>(1.5, 1.5, 1.5),
    );
    return scatter_color * (scatter_profile * shadow_bleed + ambient_fill) * (0.16 + 0.44 * state.strength);
}

// ---------------------------------------------------------------------------
// Lighting helpers
// ---------------------------------------------------------------------------

struct TmLight {
    // Travel direction in the shared Y-up frame.
    travel: vec3<f32>,
    intensity: f32,
};

/// First shadow-casting directional light; falls back to any directional.
fn tm_primary_light() -> TmLight {
    var light_travel = vec3<f32>(0.0, 0.0, 0.0);
    var light_color = vec3<f32>(0.0, 0.0, 0.0);
    var light_found = false;
    let light_total = min(forge3d_lighting.light_count, 64u);
    for (var i = 0u; i < light_total; i = i + 1u) {
        let light = forge3d_lights[i];
        if ((light.enabled & 1u) == 0u || light.kind != 0u) {
            continue;
        }
        if (!light_found || light.casts_shadow != 0u) {
            light_travel = light.direction_inner_cos.xyz;
            light_color = max(light.color_intensity.rgb, vec3<f32>(0.0))
                * max(light.color_intensity.a, 0.0);
            light_found = true;
            if (light.casts_shadow != 0u) {
                break;
            }
        }
    }
    return TmLight(light_travel, length(light_color));
}

struct TmIblSplit {
    diffuse: vec3<f32>,
    specular: vec3<f32>,
};

fn tm_ibl_split(
    n: vec3<f32>,
    v: vec3<f32>,
    base_color: vec3<f32>,
    roughness: f32,
    metallic: f32,
    f0: vec3<f32>,
) -> TmIblSplit {
    let rotation = forge3d_ibl.rotation_radians;
    let rotated_normal = forge3d_ibl_rotate_y(n, rotation);
    let rotated_reflection = forge3d_ibl_rotate_y(reflect(-v, n), rotation);
    let n_dot_v = clamp(dot(n, v), 0.0, 1.0);
    let rough = clamp(roughness, 0.0, 1.0);
    let one_minus_cos = clamp(1.0 - n_dot_v, 0.0, 1.0);
    let pow5 = one_minus_cos * one_minus_cos * one_minus_cos * one_minus_cos * one_minus_cos;
    let fresnel = f0 + (max(vec3<f32>(1.0 - rough), f0) - f0) * pow5;
    let k_d = (vec3<f32>(1.0) - fresnel) * (1.0 - metallic);
    let irradiance = textureSampleLevel(
        forge3d_ibl_irradiance, forge3d_ibl_sampler, rotated_normal, 0.0,
    ).rgb;
    let mip_count = max(forge3d_ibl.specular_mip_count, 1u);
    let mip_level = min(rough * rough * 9.0, f32(mip_count - 1u));
    let prefiltered = textureSampleLevel(
        forge3d_ibl_specular, forge3d_ibl_sampler, rotated_reflection, mip_level,
    ).rgb;
    let brdf = textureSampleLevel(
        forge3d_ibl_brdf_lut, forge3d_ibl_sampler, vec2<f32>(n_dot_v, rough), 0.0,
    ).rg;
    return TmIblSplit(k_d * base_color * irradiance, prefiltered * (fresnel * brdf.x + brdf.y));
}

fn tm_colormap(height_norm: f32) -> vec3<f32> {
    var rgb = sample_color_ramp(height_norm);
    if (params.render_mode == 1u) {
        rgb = screen_color_ramp(height_norm);
    }
    if (terrain_material.flags.x > 0.5) {
        return srgb_eotf_decode(rgb);
    }
    return rgb;
}

fn tm_linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

/// Native output encoding: exact sRGB EOTF or `pow(1/gamma)`, decoded again
/// when the canvas format re-encodes on store.
fn tm_output_encode(linear: vec3<f32>) -> vec3<f32> {
    var encoded: vec3<f32>;
    if (terrain_material.flags.y > 0.5) {
        encoded = tm_linear_to_srgb(clamp(linear, vec3<f32>(0.0), vec3<f32>(1.0)));
    } else {
        encoded = pow(
            clamp(linear, vec3<f32>(0.0), vec3<f32>(1.0)),
            vec3<f32>(1.0 / max(terrain_material.control.w, 0.1)),
        );
    }
    if (params.output_srgb == 1u) {
        return srgb_eotf_decode(encoded);
    }
    return encoded;
}

// ---------------------------------------------------------------------------
// Shared shading
// ---------------------------------------------------------------------------

struct TmSurface {
    uv: vec2<f32>,
    parallax_uv: vec2<f32>,
    world_pos: vec3<f32>,
    // Normal driving triplanar weights and slope (native `base_normal`).
    triplanar_normal: vec3<f32>,
    slope_factor: f32,
    // Z-up (slope, aspect) for material layers.
    attrs: vec2<f32>,
    altitude: f32,
    blended_normal: vec3<f32>,
    shading_normal: vec3<f32>,
    dndx: vec3<f32>,
    dndy: vec3<f32>,
    view_dir: vec3<f32>,
    view_distance: f32,
    light_dir: vec3<f32>,
    sun_intensity: f32,
    shadow_factor: f32,
    dpdx_world: vec3<f32>,
    dpdy_world: vec3<f32>,
    duv_dx: vec2<f32>,
    duv_dy: vec2<f32>,
    height_lod: f32,
    covered: bool,
};

const TM_DEBUG_MATERIAL_ALBEDO: u32 = 1u;
const TM_DEBUG_TRIPLANAR_WEIGHTS: u32 = 2u;
const TM_DEBUG_TRIPLANAR_CHECKER: u32 = 3u;
const TM_DEBUG_POM_OFFSET: u32 = 4u;
const TM_DEBUG_SPECULAR_AA_VARIANCE: u32 = 5u;
const TM_DEBUG_ROUGHNESS: u32 = 6u;
const TM_DEBUG_LAYER_WEIGHTS: u32 = 7u;
const TM_DEBUG_SUBSURFACE: u32 = 8u;

fn tm_shade(surface: TmSurface) -> TerrainSample {
    let raw = screen_height_sample(surface.parallax_uv);
    let height_sample = select(params.domain_min, raw, is_valid_height(raw));
    let height_clamped = clamp(height_sample, terrain_material.clamp0.x, terrain_material.clamp0.y);
    let height_norm = clamp((height_clamped - params.domain_min) * params.inv_domain_span, 0.0, 1.0);
    let pom_flags = u32(terrain_material.pom_steps.w + 0.5);
    var occlusion = 1.0;
    if ((pom_flags & 1u) != 0u && (pom_flags & 2u) != 0u) {
        occlusion = tm_height_unit(raw);
    }

    let material = tm_material_set(
        surface.world_pos,
        surface.triplanar_normal,
        height_norm,
        surface.slope_factor,
        surface.dpdx_world,
        surface.dpdy_world,
    );
    let overlay_rgb = tm_colormap(height_norm);
    let albedo_mode = u32(terrain_material.control.y + 0.5);
    let colormap_strength = clamp(terrain_material.control.z, 0.0, 1.0);
    var albedo = overlay_rgb;
    if (albedo_mode == 0u) {
        albedo = material.albedo;
    } else if (albedo_mode == 2u) {
        albedo = mix(material.albedo, overlay_rgb, colormap_strength);
    }
    albedo = clamp(albedo, vec3<f32>(0.0), vec3<f32>(1.0));

    let detail_enabled = terrain_material.detail0.x > 0.5;
    let albedo_noise = clamp(terrain_material.detail0.w, 0.0, 0.5);
    if (detail_enabled && albedo_noise > 0.0) {
        let albedo_fade = tm_detail_fade(surface.view_distance, tm_detail_fade_start(), tm_detail_fade_end());
        if (albedo_fade > 0.0) {
            albedo = clamp(
                albedo * tm_albedo_noise(surface.world_pos, albedo_noise * albedo_fade),
                vec3<f32>(0.0),
                vec3<f32>(1.0),
            );
        }
    }
    albedo = screen_hue_variation(albedo, surface.slope_factor, height_norm, terrain_material.flags.w);

    var masks = vec3<f32>(1.0);
    let mask_bits = u32(terrain_material.detail1.w + 0.5);
    if (mask_bits != 0u) {
        let mask_sample = textureSampleGrad(
            terrain_material_aux, terrain_material_aux_sampler, surface.uv, 1, surface.duv_dx, surface.duv_dy,
        ).rgb;
        masks = select(vec3<f32>(1.0), mask_sample, vec3<bool>(
            (mask_bits & 1u) != 0u,
            (mask_bits & 2u) != 0u,
            (mask_bits & 4u) != 0u,
        ));
    }
    let noise = tm_material_noise(surface.uv, height_norm);
    let layer_weights = tm_layer_weights(surface.altitude, surface.attrs, noise, masks);
    let subsurface = tm_resolve_subsurface(layer_weights);
    albedo = tm_apply_layers(albedo, layer_weights);
    occlusion = clamp(occlusion, terrain_material.clamp2.x, terrain_material.clamp2.y);

    // P3 split roughness: Toksvig only widens the specular lobe.
    var specular_roughness = material.roughness;
    var specaa_sigma2 = 0.0;
    if (terrain_material.spec_aa.x > 0.5) {
        let raw_variance = 0.5 * (dot(surface.dndx, surface.dndx) + dot(surface.dndy, surface.dndy));
        let sigma_scale = max(terrain_material.spec_aa.y, 1.0);
        let effective_variance = max(raw_variance - terrain_material.spec_aa.z, 0.0);
        specaa_sigma2 = clamp(effective_variance * sigma_scale, 0.0, 1.0);
        let r2 = specular_roughness * specular_roughness;
        specular_roughness = sqrt(r2 + specaa_sigma2 * (1.0 - r2));
    }
    let roughness_mult = max(terrain_material.flags.z, 0.001);
    specular_roughness = clamp(specular_roughness * roughness_mult, 0.25, 1.0);
    let metallic = clamp(material.metallic, 0.0, 1.0);
    let f0 = mix(vec3<f32>(0.04, 0.04, 0.04), albedo, metallic);

    let debug_view = u32(terrain_material.debug.x + 0.5);
    if (debug_view != 0u) {
        var debug_rgb = vec3<f32>(0.0);
        if (debug_view == TM_DEBUG_MATERIAL_ALBEDO) {
            debug_rgb = material.albedo;
        } else if (debug_view == TM_DEBUG_TRIPLANAR_WEIGHTS) {
            debug_rgb = tm_triplanar_weights(surface.triplanar_normal, max(terrain_material.triplanar.y, 1.0));
        } else if (debug_view == TM_DEBUG_TRIPLANAR_CHECKER) {
            let weights = tm_triplanar_weights(surface.triplanar_normal, max(terrain_material.triplanar.y, 1.0));
            let scale = max(terrain_material.triplanar.x, 1e-3);
            debug_rgb = vec3<f32>(
                tm_checker(surface.world_pos.yz * scale, 8.0) * weights.x
                    + tm_checker(surface.world_pos.xz * scale, 8.0) * weights.y
                    + tm_checker(surface.world_pos.xy * scale, 8.0) * weights.z,
            );
        } else if (debug_view == TM_DEBUG_POM_OFFSET) {
            debug_rgb = vec3<f32>(clamp(length(surface.parallax_uv - surface.uv) * 10.0, 0.0, 1.0));
        } else if (debug_view == TM_DEBUG_SPECULAR_AA_VARIANCE) {
            debug_rgb = vec3<f32>(clamp(specaa_sigma2 * 20.0, 0.0, 1.0));
        } else if (debug_view == TM_DEBUG_ROUGHNESS) {
            debug_rgb = vec3<f32>(specular_roughness);
        } else if (debug_view == TM_DEBUG_LAYER_WEIGHTS) {
            debug_rgb = vec3<f32>(layer_weights.snow, layer_weights.rock, layer_weights.wetness);
        } else if (debug_view == TM_DEBUG_SUBSURFACE) {
            debug_rgb = subsurface.tint * subsurface.strength;
        }
        var debug_sample: TerrainSample;
        debug_sample.radiance = debug_rgb;
        debug_sample.albedo = albedo;
        debug_sample.normal = surface.shading_normal;
        debug_sample.covered = surface.covered;
        return debug_sample;
    }

    // Terrain land composition (P2-S4 structure).
    let shadow_clamped = max(surface.shadow_factor, 0.30);
    let sun_vis = max(analysis_sample(surface.uv, 2u), 0.30);
    let combined_shadow = shadow_clamped * sun_vis;
    var ao_clamped = max(analysis_sample(surface.uv, 1u), 0.65);
    ao_clamped = ao_clamped * max(occlusion, 0.65);
    let ao_shadow_factor = ao_clamped * combined_shadow;

    let n_dot_l = max(dot(surface.shading_normal, surface.light_dir), 0.0);
    let ambient_interp = mix(0.32, 0.10, n_dot_l);
    let sun_contrib = (0.36 - 0.10) * n_dot_l * surface.sun_intensity;
    let base_diffuse = ambient_interp + sun_contrib;
    let slope_steepness = 1.0 - abs(surface.shading_normal.y);
    let normal_gradient = length(surface.dndx) + length(surface.dndy);
    let edge_signal = slope_steepness * 0.3 + normal_gradient * 15.0;
    let edge_bright = clamp(edge_signal * (n_dot_l + 0.3), 0.0, 0.25);
    let edge_dark = clamp(edge_signal * (1.0 - n_dot_l) * 0.5, 0.0, 0.15);
    let diffuse_raw = base_diffuse + edge_bright - edge_dark;
    let diffuse_lit = diffuse_raw * ao_shadow_factor;

    let ibl_split = tm_ibl_split(
        surface.shading_normal,
        surface.view_dir,
        albedo,
        specular_roughness,
        metallic,
        f0,
    );
    let ibl_diffuse_factor = length(ibl_split.diffuse) * forge3d_ibl.intensity;
    let ibl_term = ibl_diffuse_factor * TM_AMBIENT_FLOOR * 0.35;
    let terrain_sss = tm_evaluate_subsurface(
        subsurface,
        albedo,
        surface.shading_normal,
        surface.view_dir,
        surface.light_dir,
        combined_shadow,
        ibl_diffuse_factor,
    );
    let lighting_factor = diffuse_lit + ibl_term;
    let lit_albedo = albedo * lighting_factor;
    let spec_contrib = ibl_split.specular * forge3d_ibl.intensity * 0.12;
    let spec_capped = min(spec_contrib, albedo * 0.20);
    var shaded = lit_albedo + spec_capped + terrain_sss;
    shaded = shaded * max(forge3d_lighting.exposure, 0.0);

    var result: TerrainSample;
    result.radiance = shaded;
    result.albedo = albedo;
    result.normal = surface.shading_normal;
    result.covered = surface.covered;
    return result;
}

fn tm_detail_normals(
    blended_normal: vec3<f32>,
    world_pos: vec3<f32>,
    uv: vec2<f32>,
    view_distance: f32,
    duv_dx: vec2<f32>,
    duv_dy: vec2<f32>,
) -> vec3<f32> {
    var shading_normal = blended_normal;
    if (terrain_material.detail0.x > 0.5) {
        shading_normal = tm_apply_detail_normal(shading_normal, world_pos, view_distance);
    }
    if (terrain_material.detail1.z > 0.5) {
        let encoded = textureSampleGrad(
            terrain_material_aux, terrain_material_aux_sampler, uv, 0, duv_dx, duv_dy,
        ).rgb;
        shading_normal = tm_apply_detail_normal_map(shading_normal, encoded, view_distance);
    }
    return shading_normal;
}

/// Screen mode: the native fullscreen frame (Z-up tile, Y-up height normal).
fn tm_screen_sample(input: VertexOutput) -> TerrainSample {
    let uv = input.uv;
    let world_pos = input.world_position;
    let dpdx_world = dpdxCoarse(world_pos);
    let dpdy_world = dpdyCoarse(world_pos);
    let duv_dx = dpdxCoarse(uv);
    let duv_dy = dpdyCoarse(uv);
    let height_lod = tm_height_lod(duv_dx, duv_dy);

    let base_normal = vec3<f32>(0.0, 0.0, 1.0);
    let lod_fade = 1.0 - smoothstep(1.0, 4.0, height_lod);
    let normal_strength = clamp(terrain_material.triplanar.z, 0.25, 4.0);
    let height_normal = tm_screen_height_normal(uv, height_lod);
    let amplified = normalize(base_normal + (height_normal - base_normal) * normal_strength);
    let mixed = mix(base_normal, amplified, lod_fade);
    let blended_normal = mixed / max(length(mixed), 1e-5);

    let view_vector = camera.camera_position.xyz - world_pos;
    let view_dir = normalize(view_vector);
    let view_distance = length(view_vector);
    let shading_normal = tm_detail_normals(blended_normal, world_pos, uv, view_distance, duv_dx, duv_dy);
    let dndx = dpdxCoarse(shading_normal);
    let dndy = dpdyCoarse(shading_normal);

    // Native multiplies the tangent-to-world matrix by the view vector.
    let tbn = tm_build_tbn(blended_normal);
    let parallax_uv = clamp(tm_pom(uv, tbn * view_dir), vec2<f32>(0.0), vec2<f32>(1.0));

    let light = tm_primary_light();
    let light_dir = forge3d_safe_direction(vec3<f32>(-light.travel.x, light.travel.z, -light.travel.y));
    // Native shadow receivers use the unparallaxed texture coordinate.
    let receiver_raw = screen_height_sample(uv);
    let receiver_height = clamp(
        select(params.domain_min, receiver_raw, is_valid_height(receiver_raw)),
        terrain_material.clamp0.x,
        terrain_material.clamp0.y,
    );
    let receiver_norm = clamp((receiver_height - params.domain_min) * params.inv_domain_span, 0.0, 1.0);
    let shadow_visibility = terrain_screen_shadow(uv, receiver_norm, blended_normal, light_dir);

    var surface: TmSurface;
    surface.uv = uv;
    surface.parallax_uv = parallax_uv;
    surface.world_pos = world_pos;
    surface.triplanar_normal = base_normal;
    surface.slope_factor = clamp(1.0 - abs(base_normal.y), terrain_material.clamp0.z, terrain_material.clamp0.w);
    surface.attrs = tm_terrain_attributes(base_normal);
    surface.altitude = world_pos.z;
    surface.blended_normal = blended_normal;
    surface.shading_normal = shading_normal;
    surface.dndx = dndx;
    surface.dndy = dndy;
    surface.view_dir = view_dir;
    surface.view_distance = view_distance;
    surface.light_dir = light_dir;
    surface.sun_intensity = light.intensity;
    surface.shadow_factor = mix(1.0 - TM_SHADOW_IBL_FACTOR, 1.0, shadow_visibility);
    surface.dpdx_world = dpdx_world;
    surface.dpdy_world = dpdy_world;
    surface.duv_dx = duv_dx;
    surface.duv_dy = duv_dy;
    surface.height_lod = height_lod;
    surface.covered = is_valid_height(screen_height_sample(uv));
    return tm_shade(surface);
}

// #if terrain_perspective
/// Perspective mode: the same shading on the true Y-up heightfield.
fn tm_perspective_sample(input: VertexOutput) -> TerrainSample {
    let uv = input.uv;
    let world_pos = input.world_position;
    let dpdx_world = dpdxCoarse(world_pos);
    let dpdy_world = dpdyCoarse(world_pos);
    let duv_dx = dpdxCoarse(uv);
    let duv_dy = dpdyCoarse(uv);
    let height_lod = tm_height_lod(duv_dx, duv_dy);

    let up = vec3<f32>(0.0, 1.0, 0.0);
    let geometric_normal = tm_perspective_normal(uv);
    let lod_fade = 1.0 - smoothstep(1.0, 4.0, height_lod);
    let normal_strength = clamp(terrain_material.triplanar.z, 0.25, 4.0);
    let amplified = normalize(up + (geometric_normal - up) * normal_strength);
    let mixed = mix(up, amplified, lod_fade);
    let blended_normal = mixed / max(length(mixed), 1e-5);

    var view_vector = camera.camera_position.xyz - world_pos;
    var view_distance = length(view_vector);
    // camera_forward.w flags an orthographic camera: parallel view rays.
    if (camera.camera_forward.w > 0.5) {
        view_vector = -camera.camera_forward.xyz;
        view_distance = abs(dot(camera.camera_forward.xyz, world_pos - camera.camera_position.xyz));
    }
    let view_dir = forge3d_safe_direction(view_vector);
    let shading_normal = tm_detail_normals(blended_normal, world_pos, uv, view_distance, duv_dx, duv_dy);
    let dndx = dpdxCoarse(shading_normal);
    let dndy = dpdyCoarse(shading_normal);

    // Heightfield tangent frame: +U along world +X, +V along world +Z.
    let view_dir_tangent = vec3<f32>(view_dir.x, view_dir.z, view_dir.y);
    let parallax_uv = clamp(tm_pom(uv, view_dir_tangent), vec2<f32>(0.0), vec2<f32>(1.0));

    let light = tm_primary_light();
    let light_dir = forge3d_safe_direction(-light.travel);
    let view_depth = dot(camera.camera_forward.xyz, world_pos - camera.camera_position.xyz);
    let shadow_visibility = forge3d_shadow_visibility(world_pos, blended_normal, view_depth);

    var surface: TmSurface;
    surface.uv = uv;
    surface.parallax_uv = parallax_uv;
    surface.world_pos = world_pos;
    surface.triplanar_normal = geometric_normal;
    surface.slope_factor = clamp(
        1.0 - abs(geometric_normal.y),
        terrain_material.clamp0.z,
        terrain_material.clamp0.w,
    );
    // Z-up view of the Y-up normal: north is -Z.
    surface.attrs = tm_terrain_attributes(
        vec3<f32>(geometric_normal.x, -geometric_normal.z, geometric_normal.y),
    );
    surface.altitude = tm_height_geom(input.height) * params.exaggeration;
    surface.blended_normal = blended_normal;
    surface.shading_normal = shading_normal;
    surface.dndx = dndx;
    surface.dndy = dndy;
    surface.view_dir = view_dir;
    surface.view_distance = view_distance;
    surface.light_dir = light_dir;
    surface.sun_intensity = light.intensity;
    surface.shadow_factor = mix(1.0 - TM_SHADOW_IBL_FACTOR, 1.0, shadow_visibility);
    surface.dpdx_world = dpdx_world;
    surface.dpdy_world = dpdy_world;
    surface.duv_dx = duv_dx;
    surface.duv_dy = duv_dy;
    surface.height_lod = height_lod;
    surface.covered = is_valid_height(input.height);
    var result = tm_shade(surface);
    if (!result.covered) {
        result.radiance = color_ramp.clear_color.xyz;
    }
    return result;
}
// #endif

fn tm_display(sample: TerrainSample) -> vec4<f32> {
    if (!sample.covered) {
        return vec4<f32>(color_ramp.clear_color.xyz, 1.0);
    }
    if (u32(terrain_material.debug.x + 0.5) != 0u) {
        // Debug views store their raw value in every canvas format.
        let raw = clamp(sample.radiance, vec3<f32>(0.0), vec3<f32>(1.0));
        return vec4<f32>(select(raw, srgb_eotf_decode(raw), params.output_srgb == 1u), 1.0);
    }
    return vec4<f32>(tm_output_encode(tonemap_filmic_terrain(sample.radiance)), 1.0);
}
// #endif
