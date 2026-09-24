struct PackedLight {
    kind: u32,
    enabled: u32,
    casts_shadow: u32,
    falloff_mode: u32,
    color_intensity: vec4<f32>,
    position_range: vec4<f32>,
    direction_inner_cos: vec4<f32>,
    right_width: vec4<f32>,
    up_height: vec4<f32>,
    soft_params: vec4<f32>,
};
struct LightingUniform {
    light_count: u32,
    area_mode: u32,
    area_sample_count: u32,
    debug_bounds: u32,
    exposure: f32,
    ltc_lut_size: f32,
    _pad: vec2<f32>,
};
struct PackedMaterial {
    brdf: u32,
    effective_brdf: u32,
    route_kind: u32,
    flags: u32,
    base_color: vec4<f32>,
    surface: vec4<f32>,
    lobes: vec4<f32>,
};
struct MaterialUniform {
    material_count: u32,
    default_index: u32,
    _pad: vec2<u32>,
};
@group(1) @binding(0) var<storage, read> forge3d_lights: array<PackedLight>;
@group(1) @binding(1) var<uniform> forge3d_lighting: LightingUniform;
@group(1) @binding(2) var forge3d_ltc_matrix: texture_2d<f32>;
@group(1) @binding(3) var forge3d_ltc_amplitude: texture_2d<f32>;
@group(1) @binding(4) var forge3d_ltc_sampler: sampler;
@group(1) @binding(5) var<storage, read> forge3d_materials: array<PackedMaterial>;
@group(1) @binding(6) var<uniform> forge3d_material_meta: MaterialUniform;

// flags bits 0-4: base color, normal, metallic-roughness, occlusion, emissive.
@group(2) @binding(0) var forge3d_tex_base_color: texture_2d<f32>;
@group(2) @binding(1) var forge3d_tex_normal: texture_2d<f32>;
@group(2) @binding(2) var forge3d_tex_metallic_roughness: texture_2d<f32>;
@group(2) @binding(3) var forge3d_tex_occlusion: texture_2d<f32>;
@group(2) @binding(4) var forge3d_tex_emissive: texture_2d<f32>;
@group(2) @binding(5) var forge3d_tex_sampler: sampler;

fn forge3d_material(index: u32) -> PackedMaterial {
    if (index < forge3d_material_meta.material_count) {
        return forge3d_materials[index];
    }
    return forge3d_materials[forge3d_material_meta.default_index];
}

fn forge3d_material_alpha(index: u32, uv: vec2<f32>) -> f32 {
    let material = forge3d_material(index);
    var alpha = material.base_color.a;
    // #if tex_base
    let texel = textureSample(
        forge3d_tex_base_color,
        forge3d_tex_sampler,
        uv,
    );
    if ((material.flags & 1u) != 0u) {
        alpha = alpha * texel.a;
    }
    // #endif
    return alpha;
}

fn forge3d_safe_direction(v: vec3<f32>) -> vec3<f32> {
    let len = length(v);
    if (len > 1e-6) {
        return v / len;
    }
    return vec3<f32>(0.0, 1.0, 0.0);
}

fn forge3d_radial_falloff(
    distance: f32,
    range: f32,
    inner_radius: f32,
    edge_softness: f32,
    mode: u32,
    exponent: f32,
) -> f32 {
    if (distance <= inner_radius) {
        return 1.0;
    }
    if (distance <= range) {
        let x = clamp(
            (distance - inner_radius) / max(range - inner_radius, 1e-5),
            0.0,
            1.0,
        );
        switch mode {
            case 0u: {
                return 1.0 - x;
            }
            case 2u: {
                let t = 1.0 - x;
                return t * t * t;
            }
            case 3u: {
                return exp(-exponent * x);
            }
            default: {
                let t = 1.0 - x;
                return t * t;
            }
        }
    }
    var at_one = 0.0;
    if (mode == 3u) {
        at_one = exp(-exponent);
    }
    let edge_fade = 1.0 - (distance - range) / max(edge_softness, 1e-5);
    return at_one * max(edge_fade, 0.0);
}

fn forge3d_evaluate_lighting(
    vertex_color: vec3<f32>,
    world_position: vec3<f32>,
    surface_normal: vec3<f32>,
    view_direction: vec3<f32>,
    material_index: u32,
    uv: vec2<f32>,
    tangent: vec4<f32>,
    view_depth: f32,
) -> vec3<f32> {
    let material = forge3d_material(material_index);
    // #if tex_base
    let tex_base = textureSample(
        forge3d_tex_base_color,
        forge3d_tex_sampler,
        uv,
    );
    // #endif
    // #if tex_normal
    let tex_normal = textureSample(
        forge3d_tex_normal,
        forge3d_tex_sampler,
        uv,
    );
    // #endif
    // #if tex_metallic_roughness
    let tex_mr = textureSample(
        forge3d_tex_metallic_roughness,
        forge3d_tex_sampler,
        uv,
    );
    // #endif
    // #if tex_occlusion
    let tex_occlusion = textureSample(
        forge3d_tex_occlusion,
        forge3d_tex_sampler,
        uv,
    );
    // #endif
    // #if tex_emissive
    let tex_emissive = textureSample(
        forge3d_tex_emissive,
        forge3d_tex_sampler,
        uv,
    );
    // #endif
    var base_color = vertex_color * material.base_color.rgb;
    // #if tex_base
    if ((material.flags & 1u) != 0u) {
        base_color = base_color * tex_base.rgb;
    }
    // #endif
    var n = forge3d_safe_direction(surface_normal);
    // #if tex_normal
    if ((material.flags & 2u) != 0u) {
        let mapped = tex_normal.xyz * 2.0 - vec3<f32>(1.0);
        let t = forge3d_safe_direction(tangent.xyz);
        let bitangent = cross(n, t) * tangent.w;
        n = forge3d_safe_direction(
            t * mapped.x + bitangent * mapped.y + n * mapped.z,
        );
    }
    // #endif
    var surface = material.surface;
    // #if tex_metallic_roughness
    if ((material.flags & 4u) != 0u) {
        surface.x = surface.x * tex_mr.b;
        surface.y = surface.y * tex_mr.g;
    }
    // #endif
    let v = forge3d_safe_direction(view_direction);
    let shadow_visibility = forge3d_shadow_visibility(world_position, n, view_depth);
    var shadow_caster_consumed = false;
    var direct = vec3<f32>(0.0);
    var debug_hit = false;
    let count = min(forge3d_lighting.light_count, 64u);
    for (var i = 0u; i < count; i = i + 1u) {
        let light = forge3d_lights[i];
        // enabled bit 0 = emitting; bit 1 = rect two-sided (not casts_shadow).
        if ((light.enabled & 1u) == 0u) {
            continue;
        }
        let color_intensity = max(light.color_intensity.rgb, vec3<f32>(0.0))
            * max(light.color_intensity.a, 0.0);
        var contribution = vec3<f32>(0.0);
        var light_distance = 0.0;
        var finite_light = true;
        switch light.kind {
            // #if light_directional
            case 0u: {
                finite_light = false;
                let to_light = forge3d_safe_direction(-light.direction_inner_cos.xyz);
                let lambert = max(dot(n, to_light), 0.0);
                contribution = forge3d_eval_brdf(
                    material.effective_brdf,
                    base_color,
                    surface,
                    material.lobes,
                    n,
                    v,
                    to_light,
                ) * color_intensity * lambert;
                if (!shadow_caster_consumed && light.casts_shadow != 0u) {
                    shadow_caster_consumed = true;
                    contribution = contribution * shadow_visibility;
                }
            }
            // #endif
            // #if light_point_spot
            case 1u, 2u: {
                let range = max(light.position_range.a, 1e-5);
                let edge_softness = light.soft_params.y;
                let to_source = light.position_range.xyz - world_position;
                light_distance = length(to_source);
                if (light_distance > range + edge_softness) {
                    continue;
                }
                let to_light = to_source / max(light_distance, 1e-6);
                var falloff = forge3d_radial_falloff(
                    light_distance,
                    range,
                    light.soft_params.x,
                    edge_softness,
                    light.falloff_mode,
                    light.soft_params.z,
                );
                if (light.kind == 2u) {
                    let inner_cos = light.direction_inner_cos.w;
                    let outer_cos = light.soft_params.w;
                    let cone_cos = dot(
                        forge3d_safe_direction(light.direction_inner_cos.xyz),
                        -to_light,
                    );
                    let span = max(inner_cos - outer_cos, 1e-5);
                    let t = clamp((cone_cos - outer_cos) / span, 0.0, 1.0);
                    falloff = falloff * t * t * (3.0 - 2.0 * t);
                }
                falloff = falloff / max(light_distance * light_distance, 1.0);
                let lambert = max(dot(n, to_light), 0.0);
                contribution = forge3d_eval_brdf(
                    material.effective_brdf,
                    base_color,
                    surface,
                    material.lobes,
                    n,
                    v,
                    to_light,
                ) * color_intensity * lambert * falloff;
            }
            // #endif
            // #if light_rect
            default: {
                let center = light.position_range.xyz;
                let range = max(light.position_range.a, 1e-5);
                let edge_softness = light.soft_params.y;
                let rect_normal = forge3d_safe_direction(light.direction_inner_cos.xyz);
                let to_fragment = world_position - center;
                light_distance = length(to_fragment);
                if (light_distance > range + edge_softness) {
                    continue;
                }
                let two_sided = (light.enabled & 2u) != 0u;
                if (!two_sided && dot(to_fragment, rect_normal) < 0.0) {
                    continue;
                }
                let right = forge3d_safe_direction(light.right_width.xyz);
                let up = forge3d_safe_direction(light.up_height.xyz);
                let half_width = max(light.right_width.a, 0.0) * 0.5;
                let half_height = max(light.up_height.a, 0.0) * 0.5;
                let area = max(
                    light.right_width.a * light.up_height.a,
                    1e-5,
                );
                var rect_term = 0.0;
                if (forge3d_lighting.area_mode == 0u) {
                    let closest = center
                        + right * clamp(dot(-to_fragment, right), -half_width, half_width)
                        + up * clamp(dot(-to_fragment, up), -half_height, half_height);
                    let to_closest = closest - world_position;
                    let closest_distance = length(to_closest);
                    let to_light = to_closest / max(closest_distance, 1e-6);
                    let angle = clamp(abs(dot(n, to_light)), 0.0, 1.0);
                    let lut_coord = vec2<i32>(
                        clamp(i32(angle * 63.0), 0, 63),
                        32,
                    );
                    let matrix_term = textureLoad(
                        forge3d_ltc_matrix,
                        lut_coord,
                        0,
                    );
                    let amplitude_term = textureLoad(
                        forge3d_ltc_amplitude,
                        lut_coord,
                        0,
                    ).r;
                    let lobe = max(
                        matrix_term.x * matrix_term.y
                            - matrix_term.z * matrix_term.w,
                        0.0,
                    );
                    let area_factor = area
                        / (closest_distance * closest_distance + area);
                    rect_term = area_factor
                        * max(amplitude_term * lobe, 0.0)
                        * max(dot(n, to_light), 0.0);
                } else {
                    let sample_count = min(forge3d_lighting.area_sample_count, 16u);
                    var accumulated = 0.0;
                    var sampled = 0.0;
                    for (var sample_index = 0u; sample_index < 16u; sample_index = sample_index + 1u) {
                        if (sample_index >= sample_count) {
                            continue;
                        }
                        let strata_x = f32(sample_index % 4u) + 0.5;
                        let strata_y = f32(sample_index / 4u) + 0.5;
                        let sample_point = center
                            + right * ((strata_x * 0.25 - 0.5) * light.right_width.a)
                            + up * ((strata_y * 0.25 - 0.5) * light.up_height.a);
                        let to_sample = sample_point - world_position;
                        let sample_distance = length(to_sample);
                        let to_light = to_sample / max(sample_distance, 1e-6);
                        accumulated = accumulated
                            + max(dot(n, to_light), 0.0)
                                / max(sample_distance * sample_distance, 1.0);
                        sampled = sampled + 1.0;
                    }
                    rect_term = accumulated / max(sampled, 1.0);
                }
                contribution = forge3d_eval_brdf(
                    material.effective_brdf,
                    base_color,
                    surface,
                    material.lobes,
                    n,
                    v,
                    forge3d_safe_direction(-to_fragment),
                ) * color_intensity * rect_term;
            }
            // #else
            default: {
                continue;
            }
            // #endif
        }
        // #if light_debug_bounds
        if (
            finite_light
            && forge3d_lighting.debug_bounds != 0u
        ) {
            let effective = max(
                light.position_range.a + light.soft_params.y,
                1e-5,
            );
            if (abs(light_distance - effective) / effective <= 0.02) {
                debug_hit = true;
            }
        }
        // #endif
        direct = direct + max(contribution, vec3<f32>(0.0));
    }
    // #if ibl
    let ibl_ambient = forge3d_eval_ibl(n, v, base_color, surface.x, surface.y);
    var ambient = select(base_color * 0.08, ibl_ambient, forge3d_ibl.enabled != 0u);
    // #else
    var ambient = base_color * 0.08;
    // #endif
    // #if tex_occlusion
    if ((material.flags & 8u) != 0u) {
        ambient = ambient * tex_occlusion.r;
    }
    // #endif
    var result = (ambient + direct) * max(forge3d_lighting.exposure, 0.0);
    // #if tex_emissive
    if ((material.flags & 16u) != 0u) {
        result = result + tex_emissive.rgb;
    }
    // #endif
    if (debug_hit) {
        result = mix(result, vec3<f32>(1.0, 0.0, 1.0), 0.75);
    }
    result = forge3d_shadow_debug_color(result, world_position, n, view_depth);
    return max(result, vec3<f32>(0.0));
}

// #if capture
// Capture AOV helpers: the material base color and shading normal exactly as
// forge3d_evaluate_lighting resolves them, before any light is applied.
fn forge3d_surface_albedo(vertex_color: vec3<f32>, material_index: u32, uv: vec2<f32>) -> vec3<f32> {
    let material = forge3d_material(material_index);
    var base_color = vertex_color * material.base_color.rgb;
    // #if tex_base
    let tex_base = textureSample(forge3d_tex_base_color, forge3d_tex_sampler, uv);
    if ((material.flags & 1u) != 0u) {
        base_color = base_color * tex_base.rgb;
    }
    // #endif
    return base_color;
}

fn forge3d_surface_normal(
    surface_normal: vec3<f32>,
    tangent: vec4<f32>,
    material_index: u32,
    uv: vec2<f32>,
) -> vec3<f32> {
    let material = forge3d_material(material_index);
    var n = forge3d_safe_direction(surface_normal);
    // #if tex_normal
    let tex_normal = textureSample(forge3d_tex_normal, forge3d_tex_sampler, uv);
    if ((material.flags & 2u) != 0u) {
        let mapped = tex_normal.xyz * 2.0 - vec3<f32>(1.0);
        let t = forge3d_safe_direction(tangent.xyz);
        let bitangent = cross(n, t) * tangent.w;
        n = forge3d_safe_direction(t * mapped.x + bitangent * mapped.y + n * mapped.z);
    }
    // #endif
    return n;
}
// #endif
