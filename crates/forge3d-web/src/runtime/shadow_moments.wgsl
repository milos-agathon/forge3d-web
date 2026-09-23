struct MomentsUniform {
    mode: u32,
    layers: u32,
    positive_exponent: f32,
    negative_exponent: f32,
};

@group(0) @binding(0) var src_depth: texture_depth_2d_array;
@group(0) @binding(1) var dst_moments: texture_storage_2d_array<rgba32float, write>;
@group(0) @binding(2) var<uniform> moments: MomentsUniform;

@compute @workgroup_size(8, 8, 1)
fn moments_encode(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(dst_moments);
    if (id.x >= dims.x || id.y >= dims.y || id.z >= textureNumLayers(dst_moments)) {
        return;
    }
    let z = clamp(
        textureLoad(src_depth, vec2<i32>(id.xy), i32(id.z), 0),
        0.0,
        1.0,
    );
    var encoded: vec4<f32>;
    switch moments.mode {
        case 3u: {
            encoded = vec4<f32>(z, z * z, 0.0, 0.0);
        }
        case 4u: {
            let positive = exp(min(moments.positive_exponent * z, 10.0));
            let negative = -exp(-min(moments.negative_exponent * z, 10.0));
            encoded = vec4<f32>(
                positive,
                positive * positive,
                negative,
                negative * negative,
            );
        }
        default: {
            encoded = vec4<f32>(z, z * z, z * z * z, z * z * z * z);
        }
    }
    textureStore(dst_moments, vec2<i32>(id.xy), i32(id.z), encoded);
}
