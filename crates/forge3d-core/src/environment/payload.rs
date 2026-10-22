//! Environment payload ABI. Offsets are float indices, shared with WGSL.
use super::Environment;
macro_rules! schema {
    ($($name:ident = $value:literal;)*) => {
        $(pub const $name:usize = $value;)*
        pub const WGSL_LAYOUT:&str = concat!($("const ",stringify!($name),":u32=",stringify!($value),"u;\n",)*);
    }
}
schema! {
    VOLUME_CAPACITY = 8;
    VOLUME_STRIDE = 16;
    WATER_CAPACITY = 4;
    WATER_BASE = 128;
    WATER_STRIDE = 48;
    HEADER_FLOATS = 320;
    VOLUME_MIN = 0;
    VOLUME_DENSITY = 3;
    VOLUME_MAX = 4;
    VOLUME_ANISOTROPY = 7;
    VOLUME_COLOR = 8;
    VOLUME_OFFSET = 11;
    VOLUME_DIMENSIONS = 12;
    WATER_BOUNDS = 0;
    WATER_PROPERTIES = 4;
    WATER_SHALLOW = 8;
    WATER_DEEP = 12;
    WATER_WAVES = 16;
    WATER_REFLECTION = 20;
    WATER_FOAM_FLOW = 24;
    WATER_MASK = 28;
    WATER_MASK_HEIGHT = 29;
    WATER_MASK_OFFSET = 30;
    WATER_TINT = 32;
    WATER_CONTROLS = 36;
    WATER_RIPPLE_SPEED = 37;
    WATER_DISTORTION = 40;
    WATER_FOAM_NOISE = 41;
    WATER_TERRAIN_MASK = 42;
}
pub const WGSL_ACCESSORS:&str = "fn volume_base(index:u32)->u32{return index*VOLUME_STRIDE;}\nfn water_base(index:u32)->u32{return WATER_BASE+index*WATER_STRIDE;}\n";
pub fn exact_offset(offset: usize) -> Result<f32, String> {
    if offset > u32::MAX as usize || (offset as f32) as u64 != offset as u64 {
        return Err("environment payload offset is not exactly representable as f32".into());
    }
    Ok(offset as f32)
}
pub struct Layout {
    pub volume_offsets: Vec<usize>,
    pub water_offsets: Vec<usize>,
    pub floats: usize,
}
impl Layout {
    pub fn new(s: &Environment) -> Result<Self, String> {
        if s.volumes.len() > VOLUME_CAPACITY || s.water.len() > WATER_CAPACITY {
            return Err("environment payload descriptor capacity exceeded".into());
        }
        let mut floats = HEADER_FLOATS;
        let mut offsets = |lengths: Vec<usize>| -> Result<Vec<usize>, String> {
            lengths
                .into_iter()
                .map(|len| {
                    exact_offset(floats)?;
                    let offset = floats;
                    floats = floats
                        .checked_add(len)
                        .ok_or("environment payload size overflow")?;
                    Ok(offset)
                })
                .collect()
        };
        let volume_offsets = offsets(s.volumes.iter().map(|v| v.data.len()).collect())?;
        let water_offsets = offsets(s.water.iter().map(|w| w.mask.len()).collect())?;
        Ok(Self {
            volume_offsets,
            water_offsets,
            floats,
        })
    }
    pub fn bytes(&self) -> u64 {
        self.floats as u64 * 4
    }
}
pub fn float_count(s: &Environment) -> usize {
    HEADER_FLOATS
        .saturating_add(
            s.volumes
                .iter()
                .fold(0usize, |sum, v| sum.saturating_add(v.data.len())),
        )
        .saturating_add(
            s.water
                .iter()
                .fold(0usize, |sum, w| sum.saturating_add(w.mask.len())),
        )
}
pub fn encode(s: &Environment) -> Result<Vec<f32>, String> {
    let layout = Layout::new(s)?;
    let mut out = vec![0.; HEADER_FLOATS];
    for (i, v) in s.volumes.iter().enumerate() {
        let b = i * VOLUME_STRIDE;
        let offset = layout.volume_offsets[i];
        out.extend_from_slice(&v.data);
        out[b..b + VOLUME_DENSITY].copy_from_slice(&v.bounds[..3]);
        out[b + VOLUME_DENSITY] = v.density;
        out[b + VOLUME_MAX..b + VOLUME_ANISOTROPY].copy_from_slice(&v.bounds[3..]);
        out[b + VOLUME_ANISOTROPY] = v.anisotropy;
        out[b + VOLUME_COLOR..b + VOLUME_OFFSET].copy_from_slice(&v.color);
        out[b + VOLUME_OFFSET] = exact_offset(offset)?;
        out[b + VOLUME_DIMENSIONS..b + VOLUME_DIMENSIONS + 3]
            .copy_from_slice(&v.dimensions.map(|x| x as f32));
    }
    for (i, w) in s.water.iter().enumerate() {
        let b = WATER_BASE + i * WATER_STRIDE;
        let offset = layout.water_offsets[i];
        out.extend_from_slice(&w.mask);
        out[b..b + WATER_PROPERTIES].copy_from_slice(&w.bounds);
        out[b + WATER_PROPERTIES..b + WATER_SHALLOW].copy_from_slice(&[
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
        out[b + WATER_SHALLOW..b + WATER_SHALLOW + 3].copy_from_slice(&w.shallow_color);
        out[b + WATER_DEEP..b + WATER_DEEP + 3].copy_from_slice(&w.deep_color);
        out[b + WATER_WAVES..b + WATER_REFLECTION].copy_from_slice(&[
            w.wave_amplitude,
            w.wave_frequency,
            w.wave_speed,
            w.ripple_scale,
        ]);
        out[b + WATER_REFLECTION..b + WATER_FOAM_FLOW].copy_from_slice(&[
            w.reflection_strength,
            w.roughness,
            match w.reflection.as_str() {
                "screen" => 1.,
                "planar" => 2.,
                _ => 0.,
            },
            w.fresnel_power,
        ]);
        out[b + WATER_FOAM_FLOW..b + WATER_MASK].copy_from_slice(&[
            w.foam_width,
            w.foam_intensity,
            w.flow[0],
            w.flow[1],
        ]);
        out[b + WATER_MASK..b + WATER_TINT].copy_from_slice(&[
            w.mask_dimensions[0] as f32,
            w.mask_dimensions[1] as f32,
            exact_offset(offset)?,
            0.,
        ]);
        out[b + WATER_TINT..b + WATER_CONTROLS].copy_from_slice(&[
            w.tint_color[0],
            w.tint_color[1],
            w.tint_color[2],
            w.tint_strength,
        ]);
        out[b + WATER_CONTROLS..b + WATER_DISTORTION].copy_from_slice(&[
            w.hue_shift,
            w.ripple_speed,
            w.refraction_strength,
            w.shore_attenuation_width,
        ]);
        out[b + WATER_DISTORTION] = w.wave_distortion_strength;
        out[b + WATER_FOAM_NOISE] = w.foam_noise_scale;
        out[b + WATER_TERRAIN_MASK] = u32::from(w.terrain_mask) as f32;
    }
    debug_assert_eq!(out.len(), layout.floats);
    Ok(out)
}

#[cfg(test)]
mod tests;
