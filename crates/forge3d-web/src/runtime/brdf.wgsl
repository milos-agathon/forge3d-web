const FORGE3D_PI: f32 = 3.141592653589793;

fn forge3d_saturate(value: f32) -> f32 {
    return clamp(value, 0.0, 1.0);
}

fn forge3d_brdf_safe(v: vec3<f32>) -> vec3<f32> {
    let len = length(v);
    if (len > 1e-6) {
        return v / len;
    }
    return vec3<f32>(0.0, 1.0, 0.0);
}

fn forge3d_half_vector(v: vec3<f32>, l: vec3<f32>) -> vec3<f32> {
    return forge3d_brdf_safe(v + l);
}

fn forge3d_f0(base_color: vec3<f32>, metallic: f32) -> vec3<f32> {
    return vec3<f32>(0.04) + (base_color - vec3<f32>(0.04)) * metallic;
}

fn forge3d_schlick(cos_theta: f32, f0: vec3<f32>) -> vec3<f32> {
    let factor = pow(1.0 - forge3d_saturate(cos_theta), 5.0);
    return f0 + factor * (vec3<f32>(1.0) - f0);
}

fn forge3d_diffuse_lambert(base_color: vec3<f32>, metallic: f32) -> vec3<f32> {
    return base_color * ((1.0 - metallic) / FORGE3D_PI);
}

fn forge3d_ggx_distribution(roughness: f32, ndoth: f32) -> f32 {
    let alpha = max(roughness, 1e-3);
    let alpha2 = alpha * alpha;
    let denom = ndoth * ndoth * (alpha2 - 1.0) + 1.0;
    return alpha2 / (FORGE3D_PI * max(denom * denom, 1e-12));
}

fn forge3d_beckmann_distribution(roughness: f32, ndoth: f32) -> f32 {
    let alpha2 = max(roughness * roughness, 1e-4);
    let nh2 = max(ndoth * ndoth, 1e-8);
    let tan2 = (1.0 - nh2) / nh2;
    return exp(-tan2 / alpha2) / (FORGE3D_PI * alpha2 * nh2 * nh2);
}

fn forge3d_smith_g1(ndotx: f32, k: f32) -> f32 {
    return ndotx / max(ndotx * (1.0 - k) + k, 1e-6);
}

fn forge3d_cook_torrance(
    base_color: vec3<f32>,
    surface: vec4<f32>,
    n: vec3<f32>,
    v: vec3<f32>,
    l: vec3<f32>,
    beckmann: bool,
) -> vec3<f32> {
    let h = forge3d_half_vector(v, l);
    let ndoth = forge3d_saturate(dot(n, h));
    let ndotl = max(dot(n, l), 1e-6);
    let ndotv = max(dot(n, v), 1e-6);
    let vdoth = forge3d_saturate(dot(v, h));
    var d = forge3d_ggx_distribution(surface.y, ndoth);
    if (beckmann) {
        d = forge3d_beckmann_distribution(surface.y, ndoth);
    }
    let k = max(surface.y, 1e-3) * 0.5;
    let g = min(forge3d_smith_g1(ndotl, k) * forge3d_smith_g1(ndotv, k), 1.0);
    let f = forge3d_schlick(vdoth, forge3d_f0(base_color, surface.x));
    let spec_scale = (d * g) / (4.0 * ndotv * ndotl);
    let diffuse = forge3d_diffuse_lambert(base_color, surface.x);
    return diffuse * (vec3<f32>(1.0) - f) + f * spec_scale;
}

fn forge3d_oren_nayar(
    base_color: vec3<f32>,
    surface: vec4<f32>,
    n: vec3<f32>,
    v: vec3<f32>,
    l: vec3<f32>,
) -> vec3<f32> {
    let ndotl = forge3d_saturate(dot(n, l));
    let ndotv = forge3d_saturate(dot(n, v));
    let sigma2 = surface.y * surface.y;
    let a = 1.0 - sigma2 / (2.0 * (sigma2 + 0.33));
    let b = 0.45 * sigma2 / (sigma2 + 0.09);
    let lt = l - n * ndotl;
    let vt = v - n * ndotv;
    let lt_len = length(lt);
    let vt_len = length(vt);
    var cos_phi = 0.0;
    if (lt_len * vt_len > 1e-8) {
        cos_phi = dot(lt, vt) / (lt_len * vt_len);
    }
    let theta_l = acos(clamp(ndotl, -1.0, 1.0));
    let theta_v = acos(clamp(ndotv, -1.0, 1.0));
    let alpha = max(theta_l, theta_v);
    let beta = min(theta_l, theta_v);
    let sin_alpha_tan_beta = sin(alpha) * tan(beta);
    let term = a + b * max(cos_phi, 0.0) * max(sin_alpha_tan_beta, 0.0);
    return base_color * (max(term, 0.0) / FORGE3D_PI);
}

fn forge3d_phong(
    base_color: vec3<f32>,
    surface: vec4<f32>,
    n: vec3<f32>,
    v: vec3<f32>,
    l: vec3<f32>,
) -> vec3<f32> {
    let h = forge3d_half_vector(v, l);
    let ndoth = forge3d_saturate(dot(n, h));
    let vdoth = forge3d_saturate(dot(v, h));
    let rough4 = surface.y * surface.y * surface.y * surface.y;
    let exponent = clamp(2.0 / max(rough4, 1e-4) - 2.0, 1.0, 4096.0);
    let f = forge3d_schlick(vdoth, forge3d_f0(base_color, surface.x));
    let spec_scale = (exponent + 2.0) / (2.0 * FORGE3D_PI) * pow(ndoth, exponent);
    let diffuse = forge3d_diffuse_lambert(base_color, surface.x);
    return diffuse * (vec3<f32>(1.0) - f) + f * spec_scale;
}

fn forge3d_disney(
    base_color: vec3<f32>,
    surface: vec4<f32>,
    lobes: vec4<f32>,
    n: vec3<f32>,
    v: vec3<f32>,
    l: vec3<f32>,
) -> vec3<f32> {
    let h = forge3d_half_vector(v, l);
    let ndotl = forge3d_saturate(dot(n, l));
    let ndotv = forge3d_saturate(dot(n, v));
    let ndoth = forge3d_saturate(dot(n, h));
    let vdoth = forge3d_saturate(dot(v, h));
    let fl = pow(1.0 - ndotl, 5.0);
    let fv = pow(1.0 - ndotv, 5.0);
    let fd90 = 0.5 + 2.0 * surface.y * vdoth * vdoth;
    let diffuse_weight = (1.0 + (fd90 - 1.0) * fl) * (1.0 + (fd90 - 1.0) * fv);
    let fss90 = vdoth * vdoth * surface.y;
    let subsurface_weight = (1.0 + (fss90 - 1.0) * fl) * (1.0 + (fss90 - 1.0) * fv);
    let diffuse = base_color * ((1.0 - surface.x) / FORGE3D_PI)
        * ((1.0 - lobes.x) * diffuse_weight + lobes.x * subsurface_weight * 0.5);
    let sheen_tint = vec3<f32>(1.0) - 0.5 * (vec3<f32>(1.0) - base_color);
    let sheen = sheen_tint * (surface.z * pow(1.0 - vdoth, 5.0) / FORGE3D_PI);
    let d = forge3d_ggx_distribution(surface.y, ndoth);
    let k = max(surface.y, 1e-3) * 0.5;
    let g = min(
        forge3d_smith_g1(max(ndotl, 1e-6), k) * forge3d_smith_g1(max(ndotv, 1e-6), k),
        1.0,
    );
    let f = forge3d_schlick(vdoth, forge3d_f0(base_color, surface.x));
    let spec_scale = (d * g) / (4.0 * max(ndotv, 1e-6) * max(ndotl, 1e-6));
    let coat_d = forge3d_ggx_distribution(0.25, ndoth);
    let coat_f = 0.04 + 0.96 * pow(1.0 - vdoth, 5.0);
    let coat_scale = surface.w * 0.25 * coat_d * g
        / (4.0 * max(ndotv, 1e-6) * max(ndotl, 1e-6));
    return diffuse + sheen + f * spec_scale + vec3<f32>(coat_f * coat_scale);
}

fn forge3d_ashikhmin(
    base_color: vec3<f32>,
    surface: vec4<f32>,
    lobes: vec4<f32>,
    n: vec3<f32>,
    v: vec3<f32>,
    l: vec3<f32>,
) -> vec3<f32> {
    let h = forge3d_half_vector(v, l);
    let ndotl = max(dot(n, l), 1e-6);
    let ndotv = max(dot(n, v), 1e-6);
    let ndoth = forge3d_saturate(dot(n, h));
    let vdoth = max(dot(v, h), 1e-6);
    let f = forge3d_schlick(vdoth, forge3d_f0(base_color, surface.x));
    let diffuse_scale = (28.0 / (23.0 * FORGE3D_PI))
        * (1.0 - 0.04)
        * (1.0 - surface.x)
        * (1.0 - pow(1.0 - ndotl * 0.5, 5.0))
        * (1.0 - pow(1.0 - ndotv * 0.5, 5.0));
    let diffuse = base_color * diffuse_scale;
    let alpha2 = max(surface.y * surface.y, 1e-4);
    let exponent = clamp((1.0 / alpha2) * (1.0 + abs(lobes.y)), 1.0, 2048.0);
    let spec_scale = (exponent + 1.0) / (8.0 * FORGE3D_PI)
        * pow(ndoth, exponent)
        / (vdoth * max(ndotl, ndotv));
    return diffuse + f * spec_scale;
}

fn forge3d_ward(
    base_color: vec3<f32>,
    surface: vec4<f32>,
    lobes: vec4<f32>,
    n: vec3<f32>,
    v: vec3<f32>,
    l: vec3<f32>,
) -> vec3<f32> {
    let h = forge3d_half_vector(v, l);
    let ndotl = max(dot(n, l), 1e-4);
    let ndotv = max(dot(n, v), 1e-4);
    let ndoth = max(dot(n, h), 1e-4);
    let alpha2 = max(surface.y * surface.y * (1.0 - 0.9 * abs(lobes.y)), 1e-4);
    let tan2 = (1.0 - ndoth * ndoth) / (ndoth * ndoth);
    let f = forge3d_schlick(forge3d_saturate(dot(v, h)), forge3d_f0(base_color, surface.x));
    let spec_scale = exp(-tan2 / alpha2)
        / (4.0 * FORGE3D_PI * alpha2 * sqrt(ndotl * ndotv));
    let diffuse = forge3d_diffuse_lambert(base_color, surface.x);
    return diffuse * (vec3<f32>(1.0) - f) + f * spec_scale;
}

fn forge3d_toon(
    base_color: vec3<f32>,
    surface: vec4<f32>,
    n: vec3<f32>,
    l: vec3<f32>,
) -> vec3<f32> {
    let ndotl = forge3d_saturate(dot(n, l));
    let quantized = floor(ndotl * 3.0 + 0.5) / 3.0;
    let level = 0.3 + 0.7 * clamp(quantized, 0.0, 1.0);
    return forge3d_diffuse_lambert(base_color, surface.x) * level;
}

fn forge3d_minnaert(
    base_color: vec3<f32>,
    surface: vec4<f32>,
    lobes: vec4<f32>,
    n: vec3<f32>,
    v: vec3<f32>,
    l: vec3<f32>,
) -> vec3<f32> {
    let ndotl = forge3d_saturate(dot(n, l));
    let ndotv = forge3d_saturate(dot(n, v));
    let darkening = clamp(abs(lobes.y), 0.0, 1.0);
    let factor = pow(ndotl, darkening) * pow(ndotv, 1.0 - darkening);
    return forge3d_diffuse_lambert(base_color, surface.x) * factor;
}

// Effective BRDF dispatch; route_kind is diagnostic-only on the GPU.
fn forge3d_eval_brdf(
    model: u32,
    base_color: vec3<f32>,
    surface: vec4<f32>,
    lobes: vec4<f32>,
    n: vec3<f32>,
    v: vec3<f32>,
    l: vec3<f32>,
) -> vec3<f32> {
    switch model {
        case 0u: {
            return forge3d_diffuse_lambert(base_color, surface.x);
        }
        case 1u: {
            return forge3d_phong(base_color, surface, n, v, l);
        }
        case 2u: {
            return forge3d_phong(base_color, surface, n, v, l);
        }
        case 3u: {
            return forge3d_oren_nayar(base_color, surface, n, v, l);
        }
        case 4u: {
            return forge3d_cook_torrance(base_color, surface, n, v, l, false);
        }
        case 5u: {
            return forge3d_cook_torrance(base_color, surface, n, v, l, true);
        }
        case 6u: {
            return forge3d_disney(base_color, surface, lobes, n, v, l);
        }
        case 11u: {
            return forge3d_disney(base_color, surface, lobes, n, v, l);
        }
        case 7u: {
            return forge3d_ashikhmin(base_color, surface, lobes, n, v, l);
        }
        case 12u: {
            return forge3d_ashikhmin(base_color, surface, lobes, n, v, l);
        }
        case 8u: {
            return forge3d_ward(base_color, surface, lobes, n, v, l);
        }
        case 9u: {
            return forge3d_toon(base_color, surface, n, l);
        }
        case 10u: {
            return forge3d_minnaert(base_color, surface, lobes, n, v, l);
        }
        default: {
            return forge3d_diffuse_lambert(base_color, surface.x);
        }
    }
}
