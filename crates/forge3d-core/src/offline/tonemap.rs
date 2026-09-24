//! CPU reference of the offline HDR -> RGBA8 resolve.
//!
//! The native operators (`tonemap_terrain_offline.wgsl`) are ported
//! verbatim. `Display` is the browser addition that reproduces the realtime
//! display encode exactly, so a one-sample offline frame equals a screenshot:
//! world and perspective-terrain pixels are clamped linear radiance while
//! screen-mode terrain pixels pass through the native filmic curve and the
//! historical 2.2 gamma.

use crate::error::{Forge3dError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TonemapOperator {
    Display,
    Reinhard,
    ReinhardExtended,
    Aces,
    Uncharted2,
    Exposure,
    FilmicTerrain,
}

impl TonemapOperator {
    pub fn parse(name: &str) -> Result<Self> {
        Ok(match name {
            "display" => Self::Display,
            "reinhard" => Self::Reinhard,
            "reinhard-extended" => Self::ReinhardExtended,
            "aces" => Self::Aces,
            "uncharted2" => Self::Uncharted2,
            "exposure" => Self::Exposure,
            "filmic-terrain" => Self::FilmicTerrain,
            other => {
                return Err(Forge3dError::InvalidInput {
                    field: "tonemap.operator".to_string(),
                    message: format!(
                        "unknown operator {other:?}; expected display, reinhard, reinhard-extended, aces, uncharted2, exposure or filmic-terrain"
                    ),
                })
            }
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Display => "display",
            Self::Reinhard => "reinhard",
            Self::ReinhardExtended => "reinhard-extended",
            Self::Aces => "aces",
            Self::Uncharted2 => "uncharted2",
            Self::Exposure => "exposure",
            Self::FilmicTerrain => "filmic-terrain",
        }
    }

    /// Shader lane; native operators keep their native `operator_index`.
    pub fn lane(self) -> u32 {
        match self {
            Self::Reinhard => 0,
            Self::ReinhardExtended => 1,
            Self::Aces => 2,
            Self::Uncharted2 => 3,
            Self::Exposure => 4,
            Self::FilmicTerrain => 5,
            Self::Display => 6,
        }
    }
}

/// Per-pixel display encode selected by the ID AOV in `Display` mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayEncode {
    /// Clamp linear radiance (world geometry, perspective terrain, background)
    /// written to a unorm surface.
    Linear,
    /// The same radiance written to an sRGB surface (hardware encode).
    LinearSrgb,
    /// Native screen-mode terrain: filmic curve then 2.2 gamma.
    ScreenFilmic,
}

pub fn reinhard(c: f32) -> f32 {
    c / (1.0 + c)
}

pub fn reinhard_extended(c: f32, white: f32) -> f32 {
    c * (1.0 + c / (white * white)) / (1.0 + c)
}

pub fn aces(c: f32) -> f32 {
    let (a, b, cc, d, e) = (2.51, 0.03, 2.43, 0.59, 0.14);
    ((c * (a * c + b)) / (c * (cc * c + d) + e)).clamp(0.0, 1.0)
}

fn uncharted2_partial(x: f32) -> f32 {
    let (a, b, c, d, e, f) = (0.15, 0.50, 0.10, 0.20, 0.02, 0.30);
    ((x * (x * a + c * b) + d * e) / (x * (x * a + b) + d * f)) - e / f
}

pub fn uncharted2(c: f32, white: f32) -> f32 {
    uncharted2_partial(c) / uncharted2_partial(white)
}

pub fn exposure(c: f32) -> f32 {
    1.0 - (-c).exp()
}

pub fn filmic_terrain(c: f32) -> f32 {
    let (a, b, cc, d, e, f, w) = (0.22, 0.30, 0.10, 0.20, 0.01, 0.30, 11.2);
    let x = c.max(0.0);
    let curve = ((x * (a * x + cc * b) + d * e) / (x * (a * x + b) + d * f)) - e / f;
    let white = ((w * (a * w + cc * b) + d * e) / (w * (a * w + b) + d * f)) - e / f;
    (curve / white).clamp(0.0, 1.0)
}

pub fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// Maps one HDR RGB triple to display-encoded `[0, 1]` values.
pub fn tonemap_rgb(
    rgb: [f32; 3],
    operator: TonemapOperator,
    white_point: f32,
    encode: DisplayEncode,
) -> [f32; 3] {
    let map = |c: f32| -> f32 {
        match operator {
            TonemapOperator::Display => match encode {
                DisplayEncode::Linear => c.clamp(0.0, 1.0),
                DisplayEncode::LinearSrgb => linear_to_srgb(c.clamp(0.0, 1.0)),
                DisplayEncode::ScreenFilmic => filmic_terrain(c).clamp(0.0, 1.0).powf(1.0 / 2.2),
            },
            TonemapOperator::Reinhard => linear_to_srgb(reinhard(c).clamp(0.0, 1.0)),
            TonemapOperator::ReinhardExtended => {
                linear_to_srgb(reinhard_extended(c, white_point).clamp(0.0, 1.0))
            }
            TonemapOperator::Aces => linear_to_srgb(aces(c).clamp(0.0, 1.0)),
            TonemapOperator::Uncharted2 => {
                linear_to_srgb(uncharted2(c, white_point).clamp(0.0, 1.0))
            }
            TonemapOperator::Exposure => linear_to_srgb(exposure(c).clamp(0.0, 1.0)),
            TonemapOperator::FilmicTerrain => linear_to_srgb(filmic_terrain(c).clamp(0.0, 1.0)),
        }
    };
    [map(rgb[0]), map(rgb[1]), map(rgb[2])]
}

/// Unorm8 quantization used by the GPU resolve (round to nearest).
pub fn quantize_unorm8(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u8
}
