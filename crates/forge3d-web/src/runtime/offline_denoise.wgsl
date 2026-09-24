// One A-trous iteration of the AOV-guided denoiser. Weights and evaluation
// order match `forge3d_core::offline::denoise::atrous_denoise` (B3-spline
// taps, guide color/albedo, normal angle and depth terms; out-of-image taps
// skipped).

struct DenoiseParams {
    width: u32,
    height: u32,
    step: u32,
    flags: u32,
    sigma_color: f32,
    sigma_albedo: f32,
    sigma_normal: f32,
    sigma_depth: f32,
    // edge_stopping / (noise_sigma + 1e-6), precomputed on the CPU.
    edge_scale: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

const FLAG_ALBEDO_TERM: u32 = 1u;
const FLAG_NORMAL: u32 = 2u;
const FLAG_DEPTH: u32 = 4u;
const FLAG_EDGE: u32 = 8u;

fn luminance(rgb: vec3<f32>) -> f32 {
    return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

@group(0) @binding(0) var<storage, read> input_color: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> output_color: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> guide: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> normals: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> depths: array<f32>;
@group(0) @binding(5) var<uniform> params: DenoiseParams;

fn tap_weight(index: i32) -> f32 {
    switch index {
        case 0, 4: {
            return 0.0625;
        }
        case 1, 3: {
            return 0.25;
        }
        default: {
            return 0.375;
        }
    }
}

fn unit_normal(index: u32) -> vec3<f32> {
    let n = normals[index].xyz;
    return n / max(length(n), 1e-8);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.width || gid.y >= params.height) {
        return;
    }
    let w = i32(params.width);
    let h = i32(params.height);
    let step = i32(params.step);
    let center = gid.y * params.width + gid.x;
    let guide_center = guide[center].rgb;
    let normal_center = unit_normal(center);
    let depth_center = depths[center];
    let lum_center = luminance(input_color[center].rgb);
    let inv_color = 1.0 / (2.0 * params.sigma_color * params.sigma_color + 1e-8);
    let inv_albedo = 1.0 / (2.0 * params.sigma_albedo * params.sigma_albedo + 1e-8);
    let inv_normal = 1.0 / (2.0 * params.sigma_normal * params.sigma_normal + 1e-8);
    let inv_depth = 1.0 / (2.0 * params.sigma_depth * params.sigma_depth + 1e-8);
    var accum = vec3<f32>(0.0);
    var weight_sum = 0.0;
    for (var ky = 0; ky < 5; ky = ky + 1) {
        let sy = i32(gid.y) + (ky - 2) * step;
        if (sy < 0 || sy >= h) {
            continue;
        }
        for (var kx = 0; kx < 5; kx = kx + 1) {
            let sx = i32(gid.x) + (kx - 2) * step;
            if (sx < 0 || sx >= w) {
                continue;
            }
            let tap = u32(sy * w + sx);
            let diff = guide[tap].rgb - guide_center;
            let guide_dist = dot(diff, diff);
            var weight = tap_weight(ky) * tap_weight(kx) * exp(-guide_dist * inv_color);
            if ((params.flags & FLAG_ALBEDO_TERM) != 0u) {
                weight = weight * exp(-guide_dist * inv_albedo);
            }
            if ((params.flags & FLAG_NORMAL) != 0u) {
                let cos_angle = clamp(dot(unit_normal(tap), normal_center), -1.0, 1.0);
                let angle = acos(cos_angle);
                weight = weight * exp(-(angle * angle) * inv_normal);
            }
            if ((params.flags & FLAG_DEPTH) != 0u) {
                let dd = depths[tap] - depth_center;
                weight = weight * exp(-(dd * dd) * inv_depth);
            }
            if ((params.flags & FLAG_EDGE) != 0u) {
                let dl = abs(luminance(input_color[tap].rgb) - lum_center);
                weight = weight * exp(-dl * params.edge_scale);
            }
            accum = accum + input_color[tap].rgb * weight;
            weight_sum = weight_sum + weight;
        }
    }
    output_color[center] = vec4<f32>(accum / max(weight_sum, 1e-8), input_color[center].a);
}
