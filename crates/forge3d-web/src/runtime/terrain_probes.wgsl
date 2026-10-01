// #if probes
// W09 vec4 storage ABI v2: eight headers, irradiance records, reflection
// positions, then mip-major reflection cubemaps.
@group(1) @binding(3) var<storage, read> local_probes: array<vec4<f32>>;

struct LocalProbeLighting {
    irradiance: vec3<f32>,
    reflection: vec3<f32>,
    weight: f32,
    reflection_weight: f32,
}

struct LocalProbeBlend {
    ids: vec4<u32>,
    weights: vec4<f32>,
    edge_weight: f32,
    valid: bool,
}

fn local_probe_grid_blend(
    origin: vec2<f32>,
    spacing: vec2<f32>,
    dims: vec2<u32>,
    edge_blend: vec2<f32>,
    position: vec3<f32>,
) -> LocalProbeBlend {
    var result = LocalProbeBlend(vec4<u32>(0u), vec4<f32>(0.0), 0.0, false);
    if (any(dims == vec2<u32>(0u))) {
        return result;
    }
    let uv = (position.xz - origin) / spacing;
    let extent = vec2<f32>(dims - vec2<u32>(1u));
    let sample_uv = clamp(uv, vec2<f32>(0.0), extent);
    let p0 = vec2<u32>(floor(sample_uv));
    let p1 = min(p0 + vec2<u32>(1u), dims - vec2<u32>(1u));
    let frac = fract(sample_uv);
    result.ids = vec4<u32>(
        p0.y * dims.x + p0.x,
        p0.y * dims.x + p1.x,
        p1.y * dims.x + p0.x,
        p1.y * dims.x + p1.x,
    );
    result.weights = vec4<f32>(
        (1.0 - frac.x) * (1.0 - frac.y),
        frac.x * (1.0 - frac.y),
        (1.0 - frac.x) * frac.y,
        frac.x * frac.y,
    );
    let edge_distance = min(uv, extent - uv) * spacing;
    let edge = select(vec2<f32>(1.0), clamp(edge_distance / max(edge_blend, vec2<f32>(1e-6)), vec2<f32>(0.0), vec2<f32>(1.0)), dims > vec2<u32>(1u));
    result.edge_weight = min(edge.x, edge.y);
    result.valid = true;
    return result;
}

fn local_probe_sh(index: u32, normal: vec3<f32>) -> vec3<f32> {
    let n = normal.xzy;
    let basis = array<f32, 9>(
        0.282095,
        0.488603 * n.y,
        0.488603 * n.z,
        0.488603 * n.x,
        1.092548 * n.x * n.y,
        1.092548 * n.y * n.z,
        0.315392 * (3.0 * n.z * n.z - 1.0),
        1.092548 * n.x * n.z,
        0.546274 * (n.x * n.x - n.y * n.y),
    );
    let base = u32(local_probes[6].x) + index * 10u + 1u;
    var result = vec3<f32>(0.0);
    for (var k = 0u; k < 9u; k++) {
        result += local_probes[base + k].rgb * basis[k];
    }
    return max(result, vec3<f32>(0.0));
}

fn local_probe_cube_uv(direction: vec3<f32>) -> vec3<f32> {
    let d = normalize(direction);
    let a = abs(d);
    var face = 0.0;
    var uv = vec2<f32>(0.0);
    if (a.x >= a.y && a.x >= a.z) {
        if (d.x >= 0.0) { face = 0.0; uv = vec2<f32>(-d.z, -d.y) / a.x; }
        else { face = 1.0; uv = vec2<f32>(d.z, -d.y) / a.x; }
    } else if (a.y >= a.z) {
        if (d.y >= 0.0) { face = 2.0; uv = vec2<f32>(d.x, d.z) / a.y; }
        else { face = 3.0; uv = vec2<f32>(d.x, -d.z) / a.y; }
    } else {
        if (d.z >= 0.0) { face = 4.0; uv = vec2<f32>(d.x, -d.y) / a.z; }
        else { face = 5.0; uv = vec2<f32>(-d.x, -d.y) / a.z; }
    }
    return vec3<f32>(uv * 0.5 + 0.5, face);
}

fn local_probe_mip(index: u32, direction: vec3<f32>, level: u32) -> vec3<f32> {
    let count = u32(local_probes[3].z);
    let base_size = u32(local_probes[2].z);
    var offset = u32(local_probes[6].z);
    for (var l = 0u; l < level; l++) {
        let size = max(1u, base_size >> l);
        offset += count * 6u * size * size;
    }
    let size = max(1u, base_size >> level);
    let coordinate = local_probe_cube_uv(direction);
    let pixel = clamp(coordinate.xy * f32(size) - vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(f32(size - 1u)));
    let p0 = vec2<u32>(floor(pixel));
    let p1 = min(p0 + vec2<u32>(1u), vec2<u32>(size - 1u));
    let frac = fract(pixel);
    offset += (index * 6u + u32(coordinate.z)) * size * size;
    return mix(
        mix(local_probes[offset + p0.y * size + p0.x].rgb, local_probes[offset + p0.y * size + p1.x].rgb, frac.x),
        mix(local_probes[offset + p1.y * size + p0.x].rgb, local_probes[offset + p1.y * size + p1.x].rgb, frac.x),
        frac.y,
    );
}

fn local_probe_reflection(
    index: u32,
    position: vec3<f32>,
    direction: vec3<f32>,
    roughness: f32,
) -> vec3<f32> {
    let center = local_probes[u32(local_probes[6].y) + index].xyz;
    let spacing = local_probes[4].zw;
    var projected = direction;
    if (local_probes[7].z > 0.0 && local_probes[7].w > 0.0) {
        let dims = vec2<u32>(local_probes[5].xy);
        let half_xz = select(max(local_probes[7].zw,vec2<f32>(1e-3))*0.5,max(spacing*0.5,vec2<f32>(1e-3)),dims>vec2<u32>(1u));
        let box_min = vec3<f32>(center.x-half_xz.x,local_probes[7].x,center.z-half_xz.y);
        let box_max = vec3<f32>(center.x+half_xz.x,local_probes[7].y,center.z+half_xz.y);
        let dir = normalize(direction);
        let travel_axes = select(select(vec3<f32>(1e9),(box_min-position)/dir,dir<vec3<f32>(-1e-4)),(box_max-position)/dir,dir>vec3<f32>(1e-4));
        let travel = max(min(travel_axes.x,min(travel_axes.y,travel_axes.z)),0.0);
        let corrected = position + dir*travel - center;
        projected = select(dir,normalize(corrected),dot(corrected,corrected)>1e-8);
    } else {
        let half_extent = vec3<f32>(spacing.x,max(spacing.x,spacing.y),spacing.y)*0.5;
        let safe = select(vec3<f32>(1e-6),direction,abs(direction)>vec3<f32>(1e-6));
        let exit = max((center-half_extent-position)/safe,(center+half_extent-position)/safe);
        let distance = min(exit.x,min(exit.y,exit.z));
        if(distance>0.0 && all(abs(position-center)<=half_extent)){projected=position+direction*distance-center;}
    }
    let mip = roughness * roughness * max(local_probes[2].w - 1.0, 0.0);
    let l0 = u32(floor(mip));
    let l1 = min(l0 + 1u, u32(local_probes[2].w) - 1u);
    return mix(local_probe_mip(index, projected.xzy, l0), local_probe_mip(index, projected.xzy, l1), fract(mip));
}

fn local_probe_lighting(
    position: vec3<f32>,
    normal: vec3<f32>,
    view: vec3<f32>,
    roughness: f32,
) -> LocalProbeLighting {
    var result = LocalProbeLighting(vec3<f32>(0.0), vec3<f32>(0.0), 0.0, 0.0);
    let irradiance_count = u32(local_probes[3].x);
    let reflection_count = u32(local_probes[3].z);
    if (irradiance_count > 0u) {
        let blend = local_probe_grid_blend(
            local_probes[0].xy,
            local_probes[0].zw,
            vec2<u32>(local_probes[1].xy),
            local_probes[2].xy,
            position,
        );
        if (blend.valid) {
            for (var corner = 0u; corner < 4u; corner++) {
                let id = blend.ids[corner];
                if (id < irradiance_count) {
                    result.irradiance += local_probe_sh(id, normal) * blend.weights[corner];
                }
            }
            result.weight = blend.edge_weight * local_probes[1].z;
        }
    }
    if (reflection_count > 0u) {
        let blend = local_probe_grid_blend(
            local_probes[4].xy,
            local_probes[4].zw,
            vec2<u32>(local_probes[5].xy),
            local_probes[5].zw,
            position,
        );
        if (blend.valid) {
            for (var corner = 0u; corner < 4u; corner++) {
                let id = blend.ids[corner];
                if (id < reflection_count) {
                    result.reflection += local_probe_reflection(
                        id,
                        position,
                        reflect(-view, normal),
                        roughness,
                    ) * blend.weights[corner];
                }
            }
            result.reflection_weight = blend.edge_weight * local_probes[1].w;
        }
    }
    return result;
}

fn local_probe_debug(value: vec3<f32>, sample: LocalProbeLighting) -> vec3<f32> {
    let debug = u32(local_probes[3].y);
    if (debug == 1u) { return sample.irradiance * sample.weight; }
    if (debug == 2u) { return sample.reflection * sample.reflection_weight; }
    if (debug == 3u) { return vec3<f32>(sample.weight); }
    return value;
}
// #endif
