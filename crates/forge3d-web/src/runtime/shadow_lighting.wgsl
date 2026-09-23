struct Forge3dShadowUniform {
    matrices: array<mat4x4<f32>, 4>,
    splits: vec4<f32>,
    light_direction: vec4<f32>,
    params0: vec4<f32>, // mapSize, invMapSize, depthBias, normalBias
    params1: vec4<f32>, // slopeBias, softness, blockerRadius, filterRadius
    params2: vec4<f32>, // lightSize, momentBias, bleedReduction, evsmPositive
    params3: vec4<f32>, // evsmNegative, blendRange, maxDistance, splitLambda
    control: vec4<u32>, // enabled, filter, cascadeCount, debugMode
};

@group(3) @binding(5) var forge3d_shadow_depth: texture_depth_2d_array;
@group(3) @binding(6) var forge3d_shadow_compare: sampler_comparison;
@group(3) @binding(7) var forge3d_shadow_sampler: sampler;
@group(3) @binding(8) var forge3d_shadow_moments: texture_2d_array<f32>;
@group(3) @binding(9) var<uniform> forge3d_shadows: Forge3dShadowUniform;

const FORGE3D_SHADOW_CASCADE_COLORS: array<vec3<f32>, 4> = array<vec3<f32>, 4>(
    vec3<f32>(1.0, 0.15, 0.15),
    vec3<f32>(0.15, 1.0, 0.15),
    vec3<f32>(0.2, 0.45, 1.0),
    vec3<f32>(1.0, 1.0, 0.2),
);

fn forge3d_shadow_enabled() -> bool {
    return forge3d_shadows.control.x != 0u;
}

fn forge3d_shadow_cascade_count() -> u32 {
    return max(forge3d_shadows.control.z, 1u);
}

fn forge3d_shadow_cascade_index(view_depth: f32) -> u32 {
    let count = forge3d_shadow_cascade_count();
    var index = count - 1u;
    for (var i = 0u; i < count; i = i + 1u) {
        if (view_depth <= forge3d_shadows.splits[i]) {
            index = i;
            break;
        }
    }
    return index;
}

fn forge3d_shadow_project(
    world_position: vec3<f32>,
    normal: vec3<f32>,
    cascade: u32,
) -> vec4<f32> {
    let offset_position = world_position
        + normal * forge3d_shadows.params0.w
        + forge3d_shadows.light_direction.xyz * forge3d_shadows.light_direction.w;
    let clip =
        forge3d_shadows.matrices[cascade] * vec4<f32>(offset_position, 1.0);
    return vec4<f32>(
        vec3<f32>(clip.x / clip.w * 0.5 + 0.5, clip.y / clip.w * -0.5 + 0.5, clip.z / clip.w),
        clip.w,
    );
}

fn forge3d_shadow_uv_in_bounds(uv: vec2<f32>) -> bool {
    return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}

fn forge3d_shadow_compare_sample(shadow_uv: vec2<f32>, cascade: u32, depth: f32) -> f32 {
    return textureSampleCompare(
        forge3d_shadow_depth,
        forge3d_shadow_compare,
        shadow_uv,
        i32(cascade),
        depth,
    );
}

fn forge3d_shadow_pcf(
    shadow_uv: vec2<f32>,
    cascade: u32,
    depth: f32,
    radius_texels: f32,
) -> f32 {
    let radius = clamp(radius_texels, 0.0, 3.0);
    var total = 0.0;
    var weight = 0.0;
    for (var y = -3; y <= 3; y = y + 1) {
        for (var x = -3; x <= 3; x = x + 1) {
            let inside = abs(f32(x)) <= radius && abs(f32(y)) <= radius;
            let w = select(0.0, 1.0, inside);
            let offset = vec2<f32>(f32(x), f32(y)) * forge3d_shadows.params0.y;
            total += forge3d_shadow_compare_sample(shadow_uv + offset, cascade, depth) * w;
            weight += w;
        }
    }
    return total / max(weight, 1.0);
}

fn forge3d_shadow_pcss(
    shadow_uv: vec2<f32>,
    cascade: u32,
    depth: f32,
) -> f32 {
    var blocker_sum = 0.0;
    var blocker_count = 0.0;
    let search_radius = clamp(forge3d_shadows.params1.z, 1.0, 2.0);
    for (var y = -2; y <= 2; y = y + 1) {
        for (var x = -2; x <= 2; x = x + 1) {
            let offset = vec2<i32>(x, y);
            let texel = clamp(
                vec2<i32>(shadow_uv * forge3d_shadows.params0.x) + offset,
                vec2<i32>(0, 0),
                vec2<i32>(i32(forge3d_shadows.params0.x) - 1),
            );
            let stored = textureLoad(
                forge3d_shadow_depth,
                texel,
                i32(cascade),
                0,
            );
            let inside = abs(f32(x)) <= search_radius && abs(f32(y)) <= search_radius;
            let is_blocker = inside && stored < depth;
            blocker_sum += select(0.0, stored, is_blocker);
            blocker_count += select(0.0, 1.0, is_blocker);
        }
    }
    let blocker_depth = blocker_sum / max(blocker_count, 1.0);
    let penumbra = clamp(
        (depth - blocker_depth) / max(blocker_depth, 1e-4) * forge3d_shadows.params2.x,
        0.0,
        1.0,
    );
    let radius = clamp(
        penumbra * forge3d_shadows.params1.w * 2.0 + 1.0,
        1.0,
        3.0,
    );
    let filtered = forge3d_shadow_pcf(shadow_uv, cascade, depth, radius);
    return select(filtered, 1.0, blocker_count < 0.5);
}

fn forge3d_shadow_moment(texel: vec2<i32>, cascade: u32) -> vec4<f32> {
    return textureLoad(forge3d_shadow_moments, texel, i32(cascade), 0);
}

fn forge3d_shadow_moments_3x3(shadow_uv: vec2<f32>, cascade: u32) -> vec4<f32> {
    let map_size = i32(forge3d_shadows.params0.x);
    let center = vec2<i32>(shadow_uv * forge3d_shadows.params0.x);
    var sum = vec4<f32>(0.0);
    for (var y = -1; y <= 1; y = y + 1) {
        for (var x = -1; x <= 1; x = x + 1) {
            let texel = clamp(
                center + vec2<i32>(x, y),
                vec2<i32>(0, 0),
                vec2<i32>(map_size - 1, map_size - 1),
            );
            sum += forge3d_shadow_moment(texel, cascade);
        }
    }
    return sum * (1.0 / 9.0);
}

fn forge3d_shadow_chebyshev(m1: f32, m2: f32, depth: f32) -> f32 {
    if (depth <= m1 + forge3d_shadows.params2.y) {
        return 1.0;
    }
    let variance = max(m2 - m1 * m1, forge3d_shadows.params2.y);
    let d = depth - m1;
    var p_max = variance / (variance + d * d);
    let reduce = forge3d_shadows.params2.z;
    p_max = clamp((p_max - reduce) / (1.0 - reduce), 0.0, 1.0);
    return p_max;
}

fn forge3d_shadow_vsm(shadow_uv: vec2<f32>, cascade: u32, depth: f32) -> f32 {
    let moments = forge3d_shadow_moments_3x3(shadow_uv, cascade);
    return forge3d_shadow_chebyshev(moments.x, moments.y, depth);
}

fn forge3d_shadow_evsm(shadow_uv: vec2<f32>, cascade: u32, depth: f32) -> f32 {
    let moments = forge3d_shadow_moments_3x3(shadow_uv, cascade);
    let positive = exp(min(forge3d_shadows.params2.w * depth, 10.0));
    let negative = -exp(-min(forge3d_shadows.params3.x * depth, 10.0));
    let p_positive = forge3d_shadow_chebyshev(moments.x, moments.y, positive);
    let p_negative = forge3d_shadow_chebyshev(moments.z, moments.w, negative);
    return min(p_positive, p_negative);
}

fn forge3d_shadow_msm(shadow_uv: vec2<f32>, cascade: u32, depth: f32) -> f32 {
    let moments = forge3d_shadow_moments_3x3(shadow_uv, cascade);
    let moment_bias = clamp(forge3d_shadows.params2.y, 0.0, 0.1);
    let b = mix(moments, vec4<f32>(0.0, 0.375, 0.0, 0.375), moment_bias);
    let z = depth;

    let d22 = b.y - b.x * b.x;
    if (d22 < 1e-8) {
        return forge3d_shadow_vsm(shadow_uv, cascade, depth);
    }
    let inv_d22 = 1.0 / d22;
    let l32_d22 = b.z - b.x * b.y;
    let l32 = l32_d22 * inv_d22;
    let squared_depth_variance = b.w - b.y * b.y;
    let d33_d22 = squared_depth_variance * d22 - l32_d22 * l32_d22;
    if (d33_d22 < 1e-8) {
        return forge3d_shadow_vsm(shadow_uv, cascade, depth);
    }

    var c = vec3<f32>(1.0, z, z * z);
    c.y -= b.x;
    c.z -= b.y + l32 * c.y;
    c.y *= inv_d22;
    c.z *= d22 / d33_d22;
    c.y -= l32 * c.z;
    c.x -= c.y * b.x + c.z * b.y;

    if (abs(c.z) < 1e-8) {
        return forge3d_shadow_vsm(shadow_uv, cascade, depth);
    }
    let p = c.y / c.z;
    let q = c.x / c.z;
    let discriminant = p * p * 0.25 - q;
    if (discriminant < 1e-10) {
        return forge3d_shadow_vsm(shadow_uv, cascade, depth);
    }
    let root = sqrt(discriminant);
    let z2 = -p * 0.5 - root;
    let z3 = -p * 0.5 + root;

    var visibility: f32;
    if (z3 < z) {
        let quotient =
            (z2 * z3 - b.x * (z2 + z3) + b.y) / ((z3 - z) * (z - z2));
        visibility = clamp(-quotient, 0.0, 1.0);
    } else if (z2 < z) {
        let quotient =
            (z * z3 - b.x * (z + z3) + b.y) / ((z3 - z2) * (z - z2));
        visibility = clamp(1.0 - quotient, 0.0, 1.0);
    } else {
        visibility = 1.0;
    }
    let reduce = forge3d_shadows.params2.z;
    return clamp((visibility - reduce) / (1.0 - reduce), 0.0, 1.0);
}

fn forge3d_shadow_sample(
    world_position: vec3<f32>,
    normal: vec3<f32>,
    cascade: u32,
) -> f32 {
    let projected = forge3d_shadow_project(world_position, normal, cascade);
    let shadow_uv = clamp(projected.xy, vec2<f32>(0.0), vec2<f32>(1.0));
    let depth = clamp(projected.z, 0.0, 1.0);
    var sampled = 1.0;
    switch forge3d_shadows.control.y {
        // #if shadow_filter_0
        case 0u: {
            sampled = forge3d_shadow_compare_sample(shadow_uv, cascade, depth);
        }
        // #endif
        // #if shadow_filter_1
        case 1u: {
            let radius = clamp(
                forge3d_shadows.params1.y + forge3d_shadows.params1.w * 0.5,
                1.0,
                3.0,
            );
            sampled = forge3d_shadow_pcf(shadow_uv, cascade, depth, radius);
        }
        // #endif
        // #if shadow_filter_2
        case 2u: {
            sampled = forge3d_shadow_pcss(shadow_uv, cascade, depth);
        }
        // #endif
        // #if shadow_filter_3
        case 3u: {
            sampled = forge3d_shadow_vsm(shadow_uv, cascade, depth);
        }
        // #endif
        // #if shadow_filter_4
        case 4u: {
            sampled = forge3d_shadow_evsm(shadow_uv, cascade, depth);
        }
        // #endif
        // #if shadow_filter_5
        default: {
            sampled = forge3d_shadow_msm(shadow_uv, cascade, depth);
        }
        // #else
        default: {}
        // #endif
    }
    let in_bounds = forge3d_shadow_uv_in_bounds(projected.xy)
        && projected.z >= 0.0
        && projected.z <= 1.0
        && abs(projected.w) > 1e-6;
    return select(sampled, 1.0, !in_bounds);
}

fn forge3d_shadow_visibility(
    world_position: vec3<f32>,
    normal: vec3<f32>,
    view_depth: f32,
) -> f32 {
    if (!forge3d_shadow_enabled()) {
        return 1.0;
    }
    // #if shadows
    let count = forge3d_shadow_cascade_count();
    let cascade = forge3d_shadow_cascade_index(view_depth);
    let visibility = forge3d_shadow_sample(world_position, normal, cascade);
    let blend = clamp(forge3d_shadows.params3.y, 0.0, 1.0);
    let can_blend = blend > 0.0 && cascade + 1u < count;
    let next_cascade = min(cascade + 1u, count - 1u);
    let next = forge3d_shadow_sample(world_position, normal, next_cascade);
    let boundary = forge3d_shadows.splits[cascade];
    let width = max(boundary * blend, 1e-5);
    let weight = select(
        0.0,
        clamp((view_depth - (boundary - width)) / width, 0.0, 1.0),
        can_blend,
    );
    return mix(visibility, next, weight);
    // #else
    return 1.0;
    // #endif
}

fn forge3d_shadow_debug_color(
    base_color: vec3<f32>,
    world_position: vec3<f32>,
    normal: vec3<f32>,
    view_depth: f32,
) -> vec3<f32> {
    let mode = forge3d_shadows.control.w;
    // #if shadow_debug_cascades
    if (mode == 1u) {
        let cascade = forge3d_shadow_cascade_index(view_depth);
        let tint = FORGE3D_SHADOW_CASCADE_COLORS[cascade];
        return base_color * 0.35 + tint * 0.65;
    }
    // #endif
    // #if shadow_debug_factor
    if (mode == 2u) {
        let visibility = forge3d_shadow_visibility(world_position, normal, view_depth);
        return vec3<f32>(visibility);
    }
    // #endif
    return base_color;
}
