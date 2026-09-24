// Averages the accumulation sums (native `offline_resolve.wgsl`): beauty and
// albedo are divided by the sample count, normals are renormalized, and the
// unjittered reference depth is copied to a flat buffer for the denoiser.

struct ResolveParams {
    width: u32,
    height: u32,
    sample_count: u32,
    flags: u32,
};

const FLAG_SURFACE: u32 = 1u;

@group(0) @binding(0) var<storage, read> accum_color: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> accum_albedo: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> accum_normal: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> out_color: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> out_albedo: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> out_normal: array<vec4<f32>>;
@group(0) @binding(6) var depth_tex: texture_2d<f32>;
@group(0) @binding(7) var<storage, read_write> out_depth: array<f32>;
@group(0) @binding(8) var<uniform> params: ResolveParams;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.width || gid.y >= params.height) {
        return;
    }
    let index = gid.y * params.width + gid.x;
    let inv = 1.0 / f32(max(params.sample_count, 1u));
    out_color[index] = accum_color[index] * inv;
    out_depth[index] = textureLoad(depth_tex, vec2<i32>(gid.xy), 0).r;
    if ((params.flags & FLAG_SURFACE) != 0u) {
        out_albedo[index] = accum_albedo[index] * inv;
        var normal = accum_normal[index] * inv;
        let len_sq = dot(normal.xyz, normal.xyz);
        if (len_sq > 1e-12) {
            normal = vec4<f32>(normalize(normal.xyz), normal.w);
        }
        out_normal[index] = normal;
    }
}
