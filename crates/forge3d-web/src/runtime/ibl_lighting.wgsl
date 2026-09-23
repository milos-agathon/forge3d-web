struct Forge3dIblUniform {
    enabled: u32,
    specular_mip_count: u32,
    pad0: vec2<u32>,
    intensity: f32,
    rotation_radians: f32,
    pad1: vec2<f32>,
};

@group(3) @binding(0) var forge3d_ibl_specular: texture_cube<f32>;
@group(3) @binding(1) var forge3d_ibl_irradiance: texture_cube<f32>;
@group(3) @binding(2) var forge3d_ibl_sampler: sampler;
@group(3) @binding(3) var forge3d_ibl_brdf_lut: texture_2d<f32>;
@group(3) @binding(4) var<uniform> forge3d_ibl: Forge3dIblUniform;

fn forge3d_ibl_rotate_y(direction: vec3<f32>, radians: f32) -> vec3<f32> {
    let c = cos(radians);
    let s = sin(radians);
    return vec3<f32>(
        direction.x * c + direction.z * s,
        direction.y,
        direction.z * c - direction.x * s,
    );
}

fn forge3d_eval_ibl(
    n: vec3<f32>,
    v: vec3<f32>,
    base_color: vec3<f32>,
    metallic: f32,
    roughness: f32,
) -> vec3<f32> {
    let rotation = forge3d_ibl.rotation_radians;
    let rotated_normal = forge3d_ibl_rotate_y(n, rotation);
    let rotated_reflection = forge3d_ibl_rotate_y(reflect(-v, n), rotation);
    let ndotv = clamp(dot(n, v), 0.0, 1.0);
    let rough = clamp(roughness, 0.0, 1.0);
    let mip_count = max(forge3d_ibl.specular_mip_count, 1u);
    let irradiance = textureSampleLevel(
        forge3d_ibl_irradiance,
        forge3d_ibl_sampler,
        rotated_normal,
        0.0,
    ).rgb;
    let specular_mip = rough * rough * f32(mip_count - 1u);
    let prefiltered = textureSampleLevel(
        forge3d_ibl_specular,
        forge3d_ibl_sampler,
        rotated_reflection,
        specular_mip,
    ).rgb;
    let brdf = textureSampleLevel(
        forge3d_ibl_brdf_lut,
        forge3d_ibl_sampler,
        vec2<f32>(ndotv, rough),
        0.0,
    ).rg;
    let f0 = forge3d_f0(base_color, metallic);
    let schlick = f0 + (max(vec3<f32>(1.0 - rough), f0) - f0) * pow(1.0 - ndotv, 5.0);
    let kD = (vec3<f32>(1.0) - schlick) * (1.0 - metallic);
    let diffuse = irradiance * base_color * kD;
    let specular = prefiltered * (schlick * brdf.x + brdf.y);
    return (diffuse + specular) * max(forge3d_ibl.intensity, 0.0);
}
