// Mean Rec. 709 luminance of each 4x4 block of the averaged accumulation
// (native `offline_luminance.wgsl`).

struct LuminanceParams {
    width: u32,
    height: u32,
    sample_count: u32,
    _pad: u32,
};

@group(0) @binding(0) var<storage, read> accum_color: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> luminance_out: array<f32>;
@group(0) @binding(2) var<uniform> params: LuminanceParams;

fn luminance(rgb: vec3<f32>) -> f32 {
    return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let out_width = (params.width + 3u) / 4u;
    let out_height = (params.height + 3u) / 4u;
    if (gid.x >= out_width || gid.y >= out_height) {
        return;
    }
    let inv = 1.0 / f32(max(params.sample_count, 1u));
    var sum = 0.0;
    var count = 0u;
    for (var dy = 0u; dy < 4u; dy = dy + 1u) {
        for (var dx = 0u; dx < 4u; dx = dx + 1u) {
            let x = gid.x * 4u + dx;
            let y = gid.y * 4u + dy;
            if (x < params.width && y < params.height) {
                let value = accum_color[y * params.width + x] * inv;
                sum = sum + luminance(value.rgb);
                count = count + 1u;
            }
        }
    }
    luminance_out[gid.y * out_width + gid.x] = sum / f32(max(count, 1u));
}
