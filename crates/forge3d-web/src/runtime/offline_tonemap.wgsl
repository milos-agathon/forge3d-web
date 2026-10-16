// HDR -> RGBA8 resolve (native `tonemap_terrain_offline.wgsl` operators plus
// the `display` lane that reproduces the realtime surface encode per pixel).

struct TonemapParams {
    width: u32,
    height: u32,
    lane: u32,
    flags: u32,
    white_point: f32,
    terrain_id: u32,
    _pad: vec2<u32>,
};

const FLAG_SCREEN_TERRAIN: u32 = 1u;
const FLAG_SURFACE_SRGB: u32 = 2u;
const LANE_DISPLAY: u32 = 6u;

@group(0) @binding(0) var<storage, read> hdr: array<vec4<f32>>;
@group(0) @binding(1) var id_tex: texture_2d<u32>;
@group(0) @binding(2) var<storage, read_write> ldr: array<u32>;
@group(0) @binding(3) var<uniform> params: TonemapParams;

fn linear_to_srgb(color: vec3<f32>) -> vec3<f32> {
    let lo = color * 12.92;
    let hi = 1.055 * pow(color, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(hi, lo, color <= vec3<f32>(0.0031308));
}

fn reinhard(color: vec3<f32>) -> vec3<f32> {
    return color / (vec3<f32>(1.0) + color);
}

fn reinhard_extended(color: vec3<f32>, white: f32) -> vec3<f32> {
    return color * (vec3<f32>(1.0) + color / (white * white)) / (vec3<f32>(1.0) + color);
}

fn aces(color: vec3<f32>) -> vec3<f32> {
    return clamp(
        (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14),
        vec3<f32>(0.0),
        vec3<f32>(1.0),
    );
}

fn uncharted2_partial(x: vec3<f32>) -> vec3<f32> {
    let a = 0.15;
    let b = 0.50;
    let c = 0.10;
    let d = 0.20;
    let e = 0.02;
    let f = 0.30;
    return ((x * (x * a + vec3<f32>(c * b)) + vec3<f32>(d * e))
        / (x * (x * a + b) + vec3<f32>(d * f))) - vec3<f32>(e / f);
}

fn uncharted2(color: vec3<f32>, white: f32) -> vec3<f32> {
    return uncharted2_partial(color) / uncharted2_partial(vec3<f32>(white));
}

fn filmic_terrain(color: vec3<f32>) -> vec3<f32> {
    let a = 0.22;
    let b = 0.30;
    let c = 0.10;
    let d = 0.20;
    let e = 0.01;
    let f = 0.30;
    let w = 11.2;
    let x = max(color, vec3<f32>(0.0));
    let curve = ((x * (a * x + vec3<f32>(c * b)) + vec3<f32>(d * e))
        / (x * (a * x + vec3<f32>(b)) + vec3<f32>(d * f))) - vec3<f32>(e / f);
    let white = ((w * (a * w + c * b) + d * e) / (w * (a * w + b) + d * f)) - e / f;
    return clamp(curve / white, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn map_color(color: vec3<f32>, id: u32) -> vec3<f32> {
    let unit = vec3<f32>(1.0);
    switch params.lane {
        case 0u: {
            return linear_to_srgb(clamp(reinhard(color), vec3<f32>(0.0), unit));
        }
        case 1u: {
            return linear_to_srgb(clamp(reinhard_extended(color, params.white_point), vec3<f32>(0.0), unit));
        }
        case 2u: {
            return linear_to_srgb(clamp(aces(color), vec3<f32>(0.0), unit));
        }
        case 3u: {
            return linear_to_srgb(clamp(uncharted2(color, params.white_point), vec3<f32>(0.0), unit));
        }
        case 4u: {
            return linear_to_srgb(clamp(unit - exp(-color), vec3<f32>(0.0), unit));
        }
        case 5u: {
            return linear_to_srgb(clamp(filmic_terrain(color), vec3<f32>(0.0), unit));
        }
        default: {
            // Display: screen-mode terrain uses the native filmic curve and
            // 2.2 gamma; everything else is the clamped linear surface value.
            if ((params.flags & FLAG_SCREEN_TERRAIN) != 0u && id == params.terrain_id) {
                return pow(clamp(filmic_terrain(color), vec3<f32>(0.0), unit), vec3<f32>(1.0 / 2.2));
            }
            let clamped = clamp(color, vec3<f32>(0.0), unit);
            if ((params.flags & FLAG_SURFACE_SRGB) != 0u) {
                return linear_to_srgb(clamped);
            }
            return clamped;
        }
    }
}

fn quantize(value: f32) -> u32 {
    return u32(floor(clamp(value, 0.0, 1.0) * 255.0 + 0.5));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.width || gid.y >= params.height) {
        return;
    }
    let index = gid.y * params.width + gid.x;
    let value = hdr[index];
    let id = textureLoad(id_tex, vec2<i32>(gid.xy), 0).r;
    let mapped = map_color(value.rgb, id);
    ldr[index] = quantize(mapped.r)
        | (quantize(mapped.g) << 8u)
        | (quantize(mapped.b) << 16u)
        | (quantize(value.a) << 24u);
}
