// Adds one capture sample to the offline accumulation sums (native
// `offline_accumulate.wgsl`, storage-buffer form). The overlay layer holds
// premultiplied overlays and composites over the HDR color like the display
// overlay pass.

struct AccumulateParams {
    width: u32,
    height: u32,
    sample_index: u32,
    flags: u32,
};

const FLAG_SURFACE: u32 = 1u;
const FLAG_OVERLAY: u32 = 2u;
const FLAG_RESET: u32 = 4u;

@group(0) @binding(0) var color_tex: texture_2d<f32>;
@group(0) @binding(1) var overlay_tex: texture_2d<f32>;
@group(0) @binding(2) var albedo_tex: texture_2d<f32>;
@group(0) @binding(3) var normal_tex: texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> accum_color: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> accum_albedo: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> accum_normal: array<vec4<f32>>;
@group(0) @binding(7) var<uniform> params: AccumulateParams;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.width || gid.y >= params.height) {
        return;
    }
    let coords = vec2<i32>(gid.xy);
    let index = gid.y * params.width + gid.x;
    var color = textureLoad(color_tex, coords, 0);
    if ((params.flags & FLAG_OVERLAY) != 0u) {
        let overlay = textureLoad(overlay_tex, coords, 0);
        color = vec4<f32>(
            overlay.rgb + color.rgb * (1.0 - overlay.a),
            overlay.a + color.a * (1.0 - overlay.a),
        );
    }
    let reset = (params.flags & FLAG_RESET) != 0u;
    if (reset) {
        accum_color[index] = color;
    } else {
        accum_color[index] = accum_color[index] + color;
    }
    if ((params.flags & FLAG_SURFACE) != 0u) {
        let albedo = textureLoad(albedo_tex, coords, 0);
        let normal = textureLoad(normal_tex, coords, 0);
        if (reset) {
            accum_albedo[index] = albedo;
            accum_normal[index] = normal;
        } else {
            accum_albedo[index] = accum_albedo[index] + albedo;
            accum_normal[index] = accum_normal[index] + normal;
        }
    }
}
