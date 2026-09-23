struct IblPassUniform {
    src_width: u32,
    src_height: u32,
    face_size: u32,
    mip_level: u32,
    roughness: f32,
    sample_count: u32,
    lut_size: u32,
    pad0: u32,
};

const IBL_PI: f32 = 3.141592653589793;
const IBL_TWO_PI: f32 = 6.283185307179586;
const IBL_INV_U32_RANGE: f32 = 2.3283064365386963e-10;
const IBL_FP16_MAX: f32 = 65504.0;

@group(0) @binding(0) var ibl_src_equirect: texture_2d<f32>;
@group(0) @binding(1) var ibl_env_cube: texture_cube<f32>;
@group(0) @binding(2) var ibl_dst_array: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> ibl_pass: IblPassUniform;
@group(0) @binding(4) var ibl_cube_sampler: sampler;
@group(0) @binding(5) var ibl_dst_lut: texture_storage_2d<rgba16float, write>;

fn ibl_cube_direction(face: u32, xy: vec2<u32>, size: u32) -> vec3<f32> {
    let u = (f32(xy.x) + 0.5) / f32(size) * 2.0 - 1.0;
    let v = (f32(xy.y) + 0.5) / f32(size) * 2.0 - 1.0;
    switch face {
        case 0u: { return vec3<f32>(1.0, -v, -u); }
        case 1u: { return vec3<f32>(-1.0, -v, u); }
        case 2u: { return vec3<f32>(u, 1.0, v); }
        case 3u: { return vec3<f32>(u, -1.0, -v); }
        case 4u: { return vec3<f32>(u, -v, 1.0); }
        default: { return vec3<f32>(-u, -v, -1.0); }
    }
}

fn ibl_hammersley(index: u32, count: u32) -> vec2<f32> {
    return vec2<f32>(
        f32(index) / f32(count),
        f32(reverseBits(index)) * IBL_INV_U32_RANGE,
    );
}

fn ibl_tangent_frame(n: vec3<f32>) -> mat3x3<f32> {
    var up = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(n.y) > 0.999) {
        up = vec3<f32>(1.0, 0.0, 0.0);
    }
    let t = normalize(cross(up, n));
    let b = cross(n, t);
    return mat3x3<f32>(t, b, n);
}

fn ibl_importance_ggx(xi: vec2<f32>, roughness: f32, n: vec3<f32>) -> vec3<f32> {
    let a = max(roughness * roughness, 1e-8);
    let phi = IBL_TWO_PI * xi.x;
    let cos_theta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
    let sin_theta = sqrt(max(1.0 - cos_theta * cos_theta, 0.0));
    let local = vec3<f32>(cos(phi) * sin_theta, sin(phi) * sin_theta, cos_theta);
    let frame = ibl_tangent_frame(n);
    return normalize(frame * local);
}

fn ibl_geometry_smith_ibl(roughness: f32, ndotv: f32, ndotl: f32) -> f32 {
    let a = roughness * roughness;
    let k = a * 0.5;
    let denom = max(ndotv * (1.0 - k) + k, 1e-6) * max(ndotl * (1.0 - k) + k, 1e-6);
    return clamp(ndotv * ndotl / denom, 0.0, 1e6);
}

@compute @workgroup_size(8, 8, 1)
fn equirect_to_cube(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= ibl_pass.face_size || id.y >= ibl_pass.face_size || id.z > 5u) {
        return;
    }
    let dir = ibl_cube_direction(id.z, id.xy, ibl_pass.face_size);
    let u = atan2(dir.z, dir.x) * (0.5 / IBL_PI) + 0.5;
    let v = acos(clamp(dir.y, -1.0, 1.0)) / IBL_PI;
    let x = min(u32(clamp(u, 0.0, 1.0) * f32(ibl_pass.src_width)), ibl_pass.src_width - 1u);
    let y = min(u32(clamp(v, 0.0, 1.0) * f32(ibl_pass.src_height)), ibl_pass.src_height - 1u);
    let texel = textureLoad(ibl_src_equirect, vec2<i32>(i32(x), i32(y)), 0);
    let stored = clamp(texel.rgb, vec3<f32>(0.0), vec3<f32>(IBL_FP16_MAX));
    textureStore(ibl_dst_array, vec2<i32>(id.xy), i32(id.z), vec4<f32>(stored, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn irradiance_convolve(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= ibl_pass.face_size || id.y >= ibl_pass.face_size || id.z > 5u) {
        return;
    }
    let n = ibl_cube_direction(id.z, id.xy, ibl_pass.face_size);
    let frame = ibl_tangent_frame(n);
    let count = max(ibl_pass.sample_count, 1u);
    var acc = vec3<f32>(0.0);
    for (var i = 0u; i < count; i += 1u) {
        let xi = ibl_hammersley(i, count);
        let cos_theta = sqrt(1.0 - xi.x);
        let sin_theta = sqrt(max(xi.x, 0.0));
        let phi = IBL_TWO_PI * xi.y;
        let local = vec3<f32>(cos(phi) * sin_theta, sin(phi) * sin_theta, cos_theta);
        let dir = normalize(frame * local);
        acc += textureSampleLevel(ibl_env_cube, ibl_cube_sampler, dir, 0.0).rgb;
    }
    let irradiance = clamp(
        acc / f32(count) * IBL_PI,
        vec3<f32>(0.0),
        vec3<f32>(IBL_FP16_MAX),
    );
    textureStore(ibl_dst_array, vec2<i32>(id.xy), i32(id.z), vec4<f32>(irradiance, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn specular_prefilter(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= ibl_pass.face_size || id.y >= ibl_pass.face_size || id.z > 5u) {
        return;
    }
    let n = ibl_cube_direction(id.z, id.xy, ibl_pass.face_size);
    let roughness = clamp(ibl_pass.roughness, 0.0, 1.0);
    let count = max(ibl_pass.sample_count, 1u);
    var acc = vec3<f32>(0.0);
    var weight = 0.0;
    for (var i = 0u; i < count; i += 1u) {
        let xi = ibl_hammersley(i, count);
        let h = ibl_importance_ggx(xi, roughness, n);
        let l = normalize(2.0 * dot(n, h) * h - n);
        let ndotl = dot(n, l);
        if (ndotl > 0.0) {
            acc += textureSampleLevel(ibl_env_cube, ibl_cube_sampler, l, 0.0).rgb * ndotl;
            weight += ndotl;
        }
    }
    let prefiltered = clamp(
        acc / max(weight, 1e-6),
        vec3<f32>(0.0),
        vec3<f32>(IBL_FP16_MAX),
    );
    textureStore(ibl_dst_array, vec2<i32>(id.xy), i32(id.z), vec4<f32>(prefiltered, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn brdf_integrate(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= ibl_pass.lut_size || id.y >= ibl_pass.lut_size) {
        return;
    }
    let ndotv = clamp((f32(id.x) + 0.5) / f32(ibl_pass.lut_size), 1e-3, 1.0);
    let roughness = clamp((f32(id.y) + 0.5) / f32(ibl_pass.lut_size), 0.0, 1.0);
    let n = vec3<f32>(0.0, 0.0, 1.0);
    let v = vec3<f32>(sqrt(max(1.0 - ndotv * ndotv, 0.0)), 0.0, ndotv);
    let count = max(ibl_pass.sample_count, 1u);
    var scale = 0.0;
    var bias = 0.0;
    for (var i = 0u; i < count; i += 1u) {
        let xi = ibl_hammersley(i, count);
        let h = ibl_importance_ggx(xi, roughness, n);
        let l = normalize(2.0 * dot(v, h) * h - v);
        let ndotl = max(l.z, 0.0);
        if (ndotl > 0.0) {
            let ndoth = max(h.z, 1e-6);
            let vdoth = max(dot(v, h), 0.0);
            let geometry = ibl_geometry_smith_ibl(roughness, ndotv, ndotl);
            let visibility = geometry * vdoth / (ndoth * ndotv);
            let fresnel = pow(1.0 - vdoth, 5.0);
            scale += (1.0 - fresnel) * visibility;
            bias += fresnel * visibility;
        }
    }
    let lut = clamp(
        vec2<f32>(scale / f32(count), bias / f32(count)),
        vec2<f32>(0.0),
        vec2<f32>(IBL_FP16_MAX),
    );
    textureStore(
        ibl_dst_lut,
        vec2<i32>(id.xy),
        vec4<f32>(lut.x, lut.y, 0.0, 1.0),
    );
}
