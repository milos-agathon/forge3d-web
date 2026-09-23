struct ShadowDepthUniform {
    matrix: mat4x4<f32>,
};

struct TerrainParamsUniform {
    spacing: vec2<f32>,
    exaggeration: f32,
    domain_min: f32,
    inv_domain_span: f32,
    nodata_value: f32,
    has_nodata: f32,
    debug_view: u32,
    render_mode: u32,
    output_srgb: u32,
    _params_pad: vec2<u32>,
};

@group(0) @binding(0) var<uniform> scene_depth: ShadowDepthUniform;

@group(0) @binding(0) var terrain_heightmap: texture_2d<f32>;
@group(0) @binding(1) var terrain_sampler: sampler;
@group(0) @binding(2) var<uniform> terrain_params: TerrainParamsUniform;
@group(0) @binding(3) var<uniform> terrain_depth: ShadowDepthUniform;

fn is_nan_height(value: f32) -> bool {
    let bits = bitcast<u32>(value);
    return (bits & 0x7f800000u) == 0x7f800000u && (bits & 0x007fffffu) != 0u;
}

fn is_valid_height(value: f32) -> bool {
    if (is_nan_height(value)) {
        return false;
    }
    if (terrain_params.has_nodata > 0.5 && value == terrain_params.nodata_value) {
        return false;
    }
    return true;
}

@vertex
fn vs_scene_depth(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
    return scene_depth.matrix * vec4<f32>(position, 1.0);
}

@vertex
fn vs_terrain_depth(
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
) -> @builtin(position) vec4<f32> {
    let raw_height = textureSampleLevel(terrain_heightmap, terrain_sampler, uv, 0.0).r;
    let height = select(terrain_params.domain_min, raw_height, is_valid_height(raw_height));
    if (terrain_params.render_mode == 1u) {
        // Historical screen-mode caster: the native depth pass packs
        // [terrain_spacing, height_exag, height_min, height_max] into a uniform
        // the shader reads as [min_h, h_range, terrain_width, z_scale], so the
        // caster collapses to zero X/Z extent (terrain_width == height_min).
        let dims = textureDimensions(terrain_heightmap, 0);
        let span = terrain_params.spacing.x * f32(dims.x - 1u);
        let domain_max = terrain_params.domain_min + 1.0 / terrain_params.inv_domain_span;
        let world_position = vec3<f32>(
            uv.x * terrain_params.domain_min,
            (raw_height - span) * domain_max,
            uv.y * terrain_params.domain_min,
        );
        return terrain_depth.matrix * vec4<f32>(world_position, 1.0);
    }
    let world_position = vec3<f32>(
        position.x,
        position.y + (height - terrain_params.domain_min) * terrain_params.exaggeration,
        position.z,
    );
    return terrain_depth.matrix * vec4<f32>(world_position, 1.0);
}
