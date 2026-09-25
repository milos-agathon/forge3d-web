// WebGPU IBL precompute. Every pass is a verbatim port of the native
// Forge3D shaders (1f4084a:src/shaders/ibl_equirect.wgsl,
// ibl_prefilter.wgsl and ibl_brdf.wgsl), including their saturated outputs,
// sample schedules and the native split-sum geometry term, so terrain and
// mesh IBL match native renders.
struct IblPassUniform {
    src_width: u32,
    src_height: u32,
    face_size: u32,
    mip_level: u32,
    roughness: f32,
    sample_count: u32,
    lut_size: u32,
    // Native `max_mip_levels`: the specular mip count (PDF-based source LOD).
    max_mip_levels: u32,
};

const IBL_PI: f32 = 3.14159265359;
const IBL_TWO_PI: f32 = 6.28318530718;

@group(0) @binding(0) var ibl_src_equirect: texture_2d<f32>;
@group(0) @binding(1) var ibl_env_cube: texture_cube<f32>;
@group(0) @binding(2) var ibl_dst_array: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> ibl_pass: IblPassUniform;
@group(0) @binding(4) var ibl_cube_sampler: sampler;
@group(0) @binding(5) var ibl_dst_lut: texture_storage_2d<rgba16float, write>;
// Native equirect sampler: linear, repeat on U, clamp on V.
@group(0) @binding(6) var ibl_equirect_sampler: sampler;

fn ibl_uv_to_direction(uv: vec2<f32>, face: u32) -> vec3<f32> {
    let coord = uv * 2.0 - vec2<f32>(1.0, 1.0);
    switch face {
        case 0u: { return normalize(vec3<f32>(1.0, -coord.y, -coord.x)); }
        case 1u: { return normalize(vec3<f32>(-1.0, -coord.y, coord.x)); }
        case 2u: { return normalize(vec3<f32>(coord.x, 1.0, coord.y)); }
        case 3u: { return normalize(vec3<f32>(coord.x, -1.0, -coord.y)); }
        case 4u: { return normalize(vec3<f32>(coord.x, -coord.y, 1.0)); }
        default: { return normalize(vec3<f32>(-coord.x, -coord.y, -1.0)); }
    }
}

fn ibl_texel_uv(xy: vec2<u32>, size: u32) -> vec2<f32> {
    return (vec2<f32>(f32(xy.x), f32(xy.y)) + 0.5) / f32(size);
}

fn ibl_hammersley(i: u32, n: u32) -> vec2<f32> {
    var bits = i;
    bits = (bits << 16u) | (bits >> 16u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
    bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    return vec2<f32>(f32(i) / f32(n), f32(bits) * 2.3283064365386963e-10);
}

/// Native `importance_sample_ggx` in the Z-up tangent frame of `normal`.
fn ibl_importance_ggx(xi: vec2<f32>, normal: vec3<f32>, roughness: f32) -> vec3<f32> {
    let a = roughness * roughness;
    let phi = IBL_TWO_PI * xi.x;
    let cos_theta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
    let sin_theta = sqrt(1.0 - cos_theta * cos_theta);
    let h = vec3<f32>(cos(phi) * sin_theta, sin(phi) * sin_theta, cos_theta);
    let up = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(normal.z) < 0.999);
    let tangent = normalize(cross(up, normal));
    let bitangent = cross(normal, tangent);
    return normalize(tangent * h.x + bitangent * h.y + normal * h.z);
}

@compute @workgroup_size(8, 8, 1)
fn equirect_to_cube(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= ibl_pass.face_size || id.y >= ibl_pass.face_size || id.z > 5u) {
        return;
    }
    let dir = ibl_uv_to_direction(ibl_texel_uv(id.xy, ibl_pass.face_size), id.z);
    let d = normalize(dir);
    let u = atan2(d.z, d.x) / IBL_TWO_PI + 0.5;
    let v = acos(clamp(d.y, -1.0, 1.0)) / IBL_PI;
    let color = textureSampleLevel(
        ibl_src_equirect,
        ibl_equirect_sampler,
        vec2<f32>(fract(u), clamp(v, 0.0, 1.0)),
        0.0,
    );
    textureStore(ibl_dst_array, vec2<i32>(id.xy), i32(id.z), color);
}

@compute @workgroup_size(8, 8, 1)
fn irradiance_convolve(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= ibl_pass.face_size || id.y >= ibl_pass.face_size || id.z > 5u) {
        return;
    }
    let normal = ibl_uv_to_direction(ibl_texel_uv(id.xy, ibl_pass.face_size), id.z);
    var irradiance = vec3<f32>(0.0);
    let sample_count = max(ibl_pass.sample_count, 1u);
    for (var i = 0u; i < sample_count; i = i + 1u) {
        let xi = ibl_hammersley(i, sample_count);
        let phi = IBL_TWO_PI * xi.x;
        let cos_theta = sqrt(1.0 - xi.y);
        let sin_theta = sqrt(1.0 - cos_theta * cos_theta);
        let local = vec3<f32>(cos(phi) * sin_theta, sin(phi) * sin_theta, cos_theta);
        let up = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(normal.z) < 0.999);
        let tangent = normalize(cross(up, normal));
        let bitangent = cross(normal, tangent);
        let sample_dir = normalize(tangent * local.x + bitangent * local.y + normal * local.z);
        irradiance += textureSampleLevel(ibl_env_cube, ibl_cube_sampler, sample_dir, 0.0).rgb * local.z;
    }
    irradiance = saturate(IBL_PI * irradiance / f32(sample_count));
    textureStore(ibl_dst_array, vec2<i32>(id.xy), i32(id.z), vec4<f32>(irradiance, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn specular_prefilter(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= ibl_pass.face_size || id.y >= ibl_pass.face_size || id.z > 5u) {
        return;
    }
    let normal = ibl_uv_to_direction(ibl_texel_uv(id.xy, ibl_pass.face_size), id.z);
    let view_dir = normal;
    var prefiltered = vec3<f32>(0.0);
    var total_weight = 0.0;
    let roughness = clamp(ibl_pass.roughness, 0.0, 1.0);
    let sample_count = max(ibl_pass.sample_count, 1u);
    for (var i = 0u; i < sample_count; i = i + 1u) {
        let xi = ibl_hammersley(i, sample_count);
        let half_dir = ibl_importance_ggx(xi, normal, roughness);
        let light_dir = normalize(2.0 * dot(view_dir, half_dir) * half_dir - view_dir);
        let n_dot_l = max(dot(normal, light_dir), 0.0);
        if (n_dot_l > 0.0) {
            let n_dot_h = max(dot(normal, half_dir), 0.0);
            let v_dot_h = max(dot(view_dir, half_dir), 0.0);
            let d = roughness * roughness;
            let pdf = (d * d * n_dot_h) / max(4.0 * v_dot_h, 1e-4) + 1e-4;
            let resolution = f32(ibl_pass.face_size);
            let sa_texel = 4.0 * IBL_PI / (6.0 * resolution * resolution);
            let sa_sample = 1.0 / (f32(sample_count) * pdf);
            let lod = 0.5 * log2(sa_sample / sa_texel);
            let mip = clamp(lod, 0.0, f32(max(ibl_pass.max_mip_levels, 1u) - 1u));
            prefiltered += textureSampleLevel(ibl_env_cube, ibl_cube_sampler, light_dir, mip).rgb * n_dot_l;
            total_weight += n_dot_l;
        }
    }
    prefiltered = saturate(prefiltered / max(total_weight, 1e-3));
    textureStore(ibl_dst_array, vec2<i32>(id.xy), i32(id.z), vec4<f32>(prefiltered, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn brdf_integrate(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = ibl_pass.lut_size;
    if (id.x >= size || id.y >= size) {
        return;
    }
    let uv = (vec2<f32>(f32(id.x), f32(id.y)) + 0.5) / f32(size);
    let n_dot_v = clamp(uv.x, 0.0, 1.0);
    let roughness = clamp(uv.y, 0.0, 1.0);
    let sin_theta = sqrt(max(1.0 - n_dot_v * n_dot_v, 0.0));
    let view = vec3<f32>(sin_theta, 0.0, n_dot_v);
    var a = 0.0;
    var b = 0.0;
    let sample_count = max(ibl_pass.sample_count, 1u);
    for (var i = 0u; i < sample_count; i = i + 1u) {
        let xi = ibl_hammersley(i, sample_count);
        // Native samples the half vector in the fixed Z-up frame.
        let alpha = roughness * roughness;
        let phi = IBL_TWO_PI * xi.x;
        let cos_theta = sqrt((1.0 - xi.y) / (1.0 + (alpha * alpha - 1.0) * xi.y));
        let sin_t = sqrt(1.0 - cos_theta * cos_theta);
        let half_vector = vec3<f32>(cos(phi) * sin_t, sin(phi) * sin_t, cos_theta);
        let light_dir = normalize(2.0 * dot(view, half_vector) * half_vector - view);
        let n_dot_l = max(light_dir.z, 0.0);
        let n_dot_h = max(half_vector.z, 0.0);
        let v_dot_h = max(dot(view, half_vector), 0.0);
        if (n_dot_l > 0.0) {
            // Native split-sum term (not the Smith geometry integral).
            let g = (2.0 * n_dot_h * n_dot_v) / max(v_dot_h, 1e-5);
            let g_vis = g / max(n_dot_l, 1e-5);
            let fresnel = pow(1.0 - v_dot_h, 5.0);
            a += (1.0 - fresnel) * g_vis;
            b += fresnel * g_vis;
        }
    }
    a = saturate(a / f32(sample_count));
    b = saturate(b / f32(sample_count));
    textureStore(ibl_dst_lut, vec2<i32>(id.xy), vec4<f32>(a, b, 0.0, 0.0));
}
