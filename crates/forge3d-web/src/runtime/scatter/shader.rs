use crate::runtime::scene::pipelines::WORLD_SHADER;
use crate::runtime::shader_variants::{specialize, ShaderFeatures};
pub(super) fn shader(features: ShaderFeatures) -> String {
    let input = "@location(7) instance_row0: vec4<f32>,\n@location(8) instance_row1: vec4<f32>,\n@location(9) instance_row2: vec4<f32>,\n@location(10) instance_row3: vec4<f32>,\n@location(11) instance_meta: vec4<f32>,\n";
    let source = WORLD_SHADER.replacen("struct VertexInput {", &format!("struct VertexInput {{\n{input}"), 1)
        .replace("output.position = camera.view_projection * vec4<f32>(input.position, 1.0);", VERTEX)
        .replace("output.normal = input.normal;", "output.normal = scatter_normal;")
        .replace("output.world_position = input.position;", "output.world_position = scatter_position;")
        .replace("output.previous_position = input.previous_position;", "output.previous_position = scatter_previous_position;")
        .replace("output.object_id = input.object_id;", "output.object_id = u32(input.instance_meta.x);")
        .replace("return vec4<f32>(lit, alpha);", "return scatter_shade(lit, alpha, input.world_position, forge3d_safe_direction(input.normal));")
        .replace("var output: CaptureSurfaceOutput;", "let visibility = scatter_shade(vec3<f32>(1.0), 1.0, input.world_position, forge3d_safe_direction(input.normal));\nvar output: CaptureSurfaceOutput;");
    specialize(&format!("{source}\n{HELPERS}"), features)
}
const VERTEX: &str = r#"
    let matrix = transpose(mat4x4<f32>(input.instance_row0, input.instance_row1, input.instance_row2, input.instance_row3));
    var scatter_position = (matrix * vec4<f32>(input.position, 1.0)).xyz;
    var scatter_previous_position = scatter_position;
    let c0 = matrix[0].xyz; let c1 = matrix[1].xyz; let c2 = matrix[2].xyz;
    let determinant = dot(c0, cross(c1, c2));
    var scatter_normal = forge3d_safe_direction((cross(c1, c2) * input.normal.x + cross(c2, c0) * input.normal.y + cross(c0, c1) * input.normal.z) / determinant);
    let amplitude = length(scatter_settings.wind_vector.xyz);
    if (amplitude > 1e-6) {
        let normalized_height = clamp(input.position.y / max(scatter_settings.wind_vector.w, 1e-4), 0.0, 1.0);
        let bend = smoothstep(scatter_settings.wind_fade.x, scatter_settings.wind_fade.x + scatter_settings.wind_fade.y, normalized_height);
        let direction_local = scatter_settings.wind_vector.xyz / amplitude;
        let direction_world = normalize((matrix * vec4<f32>(direction_local, 0.0)).xyz);
        let spatial = dot(scatter_position, direction_world) * 0.1;
        let sway = sin(scatter_settings.wind_phase.x + spatial) * (1.0 - scatter_settings.wind_phase.w) * amplitude;
        let gust = sin(scatter_settings.wind_phase.y + spatial * 0.37) * scatter_settings.wind_phase.z;
        let old_sway = sin(scatter_settings.previous_phase.x + spatial) * (1.0 - scatter_settings.previous_phase.w) * amplitude;
        let old_gust = sin(scatter_settings.previous_phase.y + spatial * 0.37) * scatter_settings.previous_phase.z;
        var old_displacement = (matrix * vec4<f32>(direction_local * (old_sway + old_gust) * bend, 0.0)).xyz;
        var displacement = (matrix * vec4<f32>(direction_local * (sway + gust) * bend, 0.0)).xyz;
        if (scatter_settings.wind_fade.w > scatter_settings.wind_fade.z) {
            displacement *= 1.0 - smoothstep(scatter_settings.wind_fade.z, scatter_settings.wind_fade.w, distance(scatter_position, camera.camera_position.xyz));
            old_displacement *= 1.0 - smoothstep(scatter_settings.wind_fade.z, scatter_settings.wind_fade.w, distance(scatter_position, camera.camera_position.xyz));
        }
        scatter_position += displacement;
        scatter_previous_position += old_displacement;
        scatter_normal = normalize(scatter_normal + direction_world * length(displacement) * 0.3 * max(dot(scatter_normal, normalize(c1)), 0.0));
    }
    output.position = camera.view_projection * vec4<f32>(scatter_position, 1.0);
"#;
const HELPERS: &str = r#"
struct ScatterSettings {
    wind_phase: vec4<f32>, wind_vector: vec4<f32>, wind_fade: vec4<f32>,
    blend: vec4<f32>, contact: vec4<f32>, height_mapping: vec4<f32>, height_scale: vec4<f32>, streaming: vec4<u32>,
    previous_phase: vec4<f32>,
}
@group(0) @binding(1) var<uniform> scatter_settings: ScatterSettings;
@group(0) @binding(2) var scatter_height: texture_2d<f32>;
@group(0) @binding(3) var scatter_pages: texture_2d_array<u32>;
fn scatter_height_load(texel: vec2<i32>) -> f32 {
    let dims = vec2<i32>(scatter_settings.streaming.xy);
    let tc0 = clamp(texel, vec2<i32>(0), dims - vec2<i32>(1));
    let levels = u32(scatter_settings.height_scale.z);
    if (levels == 0u) { return textureLoad(scatter_height, tc0, 0).r; }
    for (var lod = 0u; lod < levels; lod++) {
        let tc = tc0 >> vec2<u32>(lod); let tile_size = scatter_settings.streaming.z;
        let entry = textureLoad(scatter_pages, tc / i32(tile_size), i32(lod), 0).r;
        if (entry != 0u) {
            let slot = entry - 1u;
            let origin = vec2<u32>(slot % scatter_settings.streaming.w, slot / scatter_settings.streaming.w) * tile_size;
            return textureLoad(scatter_height, vec2<i32>(origin + vec2<u32>(tc) % tile_size), 0).r;
        }
    }
    return 0.0;
}
fn scatter_height_delta(position: vec3<f32>) -> f32 {
    let uv = clamp((position.xz - scatter_settings.height_mapping.xy) * scatter_settings.height_mapping.zw, vec2<f32>(0.0), vec2<f32>(1.0));
    let coord = uv * vec2<f32>(scatter_settings.streaming.xy - vec2<u32>(1));
    let base = vec2<i32>(floor(coord)); let frac = fract(coord);
    let h = mix(mix(scatter_height_load(base), scatter_height_load(base + vec2<i32>(1,0)), frac.x), mix(scatter_height_load(base + vec2<i32>(0,1)), scatter_height_load(base + vec2<i32>(1,1)), frac.x), frac.y);
    return position.y - (h - scatter_settings.height_scale.x) * scatter_settings.height_scale.y;
}
fn scatter_shade(lit: vec3<f32>, initial_alpha: f32, position: vec3<f32>, normal: vec3<f32>) -> vec4<f32> {
    var alpha = initial_alpha; var shaded = lit;
    if (scatter_settings.height_scale.w > 0.5) {
        let delta = scatter_height_delta(position);
        if (scatter_settings.blend.x > 0.5) { alpha *= smoothstep(-max(scatter_settings.blend.y,1e-4), max(scatter_settings.blend.z,1e-4), delta); }
        if (scatter_settings.contact.x > 0.5) {
            let proximity = 1.0 - smoothstep(0.0, max(scatter_settings.contact.y,1e-4), abs(delta));
            let sides = mix(1.0, clamp(1.0 - abs(normal.y), 0.0, 1.0), scatter_settings.contact.w);
            shaded *= 1.0 - proximity * sides * scatter_settings.contact.z;
        }
    }
    if (alpha <= 1e-3) { discard; }
    return vec4<f32>(shaded, alpha);
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scatter_display_and_capture_variants_validate() {
        for flags in [ShaderFeatures::from_bits(0), ShaderFeatures::ALL] {
            let source = shader(flags);
            let module = naga::front::wgsl::parse_str(&source)
                .unwrap_or_else(|e| panic!("{}", e.emit_to_string(&source)));
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::all(),
            )
            .validate(&module)
            .unwrap();
        }
    }
}
