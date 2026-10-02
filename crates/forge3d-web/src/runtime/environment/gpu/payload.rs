use super::*;
pub(super) fn pack(s: &Environment) -> Vec<f32> {
    let mut out = vec![0.; 320];
    for (i, v) in s.volumes.iter().enumerate() {
        let b = i * 16;
        let offset = out.len();
        out.extend_from_slice(&v.data);
        out[b..b + 3].copy_from_slice(&v.bounds[..3]);
        out[b + 3] = v.density;
        out[b + 4..b + 7].copy_from_slice(&v.bounds[3..]);
        out[b + 7] = v.anisotropy;
        out[b + 8..b + 11].copy_from_slice(&v.color);
        out[b + 11] = offset as f32;
        out[b + 12..b + 15].copy_from_slice(&v.dimensions.map(|x| x as f32));
    }
    for (i, w) in s.water.iter().enumerate() {
        let b = 128 + i * 48;
        let offset = out.len();
        out.extend_from_slice(&w.mask);
        out[b..b + 4].copy_from_slice(&w.bounds);
        out[b + 4..b + 8].copy_from_slice(&[
            w.height,
            w.alpha,
            w.depth_scale,
            match w.mode.as_str() {
                "disabled" => 0.,
                "transparent" => 1.,
                "reflective" => 2.,
                _ => 3.,
            },
        ]);
        out[b + 8..b + 11].copy_from_slice(&w.shallow_color);
        out[b + 12..b + 15].copy_from_slice(&w.deep_color);
        out[b + 16..b + 20].copy_from_slice(&[
            w.wave_amplitude,
            w.wave_frequency,
            w.wave_speed,
            w.ripple_scale,
        ]);
        out[b + 20..b + 24].copy_from_slice(&[
            w.reflection_strength,
            w.roughness,
            match w.reflection.as_str() {
                "screen" => 1.,
                "planar" => 2.,
                _ => 0.,
            },
            w.fresnel_power,
        ]);
        out[b + 24..b + 28].copy_from_slice(&[
            w.foam_width,
            w.foam_intensity,
            w.flow[0],
            w.flow[1],
        ]);
        out[b + 28..b + 32].copy_from_slice(&[
            w.mask_dimensions[0] as f32,
            w.mask_dimensions[1] as f32,
            offset as f32,
            0.,
        ]);
        out[b + 32..b + 36].copy_from_slice(&[
            w.tint_color[0],
            w.tint_color[1],
            w.tint_color[2],
            w.tint_strength,
        ]);
        out[b + 36..b + 40].copy_from_slice(&[
            w.hue_shift,
            w.ripple_speed,
            w.refraction_strength,
            w.shore_attenuation_width,
        ]);
        out[b + 40] = w.wave_distortion_strength;
        out[b + 41] = w.foam_noise_scale;
        out[b + 42] = u32::from(w.terrain_mask) as f32;
    }
    out
}
