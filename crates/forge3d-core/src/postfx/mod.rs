//! W11 ordered linear-HDR graph contracts and CPU reference mathematics.
//! Native source anchors: bf8db93 screen_space_effects, bloom, dof, taa and
//! tonemap. Reprojection adds explicit ID/depth rejection missing in native TAA.
mod reference;
use crate::error::{Forge3dError, Result};
pub use reference::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EffectKind {
    Ssao,
    Gtao,
    Ssgi,
    Ssr,
    Bloom,
    Dof,
    MotionBlur,
    Taa,
    AccumulationAa,
    Denoise,
    Tonemap,
    Lens,
}
impl EffectKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Ssao => "ssao",
            Self::Gtao => "gtao",
            Self::Ssgi => "ssgi",
            Self::Ssr => "ssr",
            Self::Bloom => "bloom",
            Self::Dof => "dof",
            Self::MotionBlur => "motion-blur",
            Self::Taa => "taa",
            Self::AccumulationAa => "accumulation-aa",
            Self::Denoise => "denoise",
            Self::Tonemap => "tonemap",
            Self::Lens => "lens",
        }
    }
    pub fn temporal(self) -> bool {
        matches!(
            self,
            Self::Ssao | Self::Gtao | Self::Ssgi | Self::Ssr | Self::Taa | Self::AccumulationAa
        )
    }
}
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ColorLut {
    pub size: u32,
    pub data: Vec<f32>,
}
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Effect {
    pub id: String,
    pub kind: EffectKind,
    pub enabled: bool,
    pub params: [f32; 16],
    pub quality: String,
    pub operator: String,
    pub lut: Option<ColorLut>,
}
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebugView {
    pub view: String,
    pub effect_id: Option<String>,
    pub hzb_mip: u32,
}
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PostFxConfig {
    pub effects: Vec<Effect>,
    pub debug: DebugView,
}

fn invalid(message: impl Into<String>) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: "postFx".into(),
        message: message.into(),
    }
}
impl PostFxConfig {
    pub fn active(&self) -> bool {
        self.effects.iter().any(|e| e.enabled)
    }
    pub fn validate(&self) -> Result<()> {
        if self.effects.len() > 17 {
            return Err(invalid(
                "at most 16 effects plus display resolve are allowed",
            ));
        }
        let mut ids = BTreeSet::new();
        let (mut tonemap, mut lens, mut aa) = (false, false, false);
        for e in &self.effects {
            if e.id.is_empty()
                || e.id.len() > 64
                || !e
                    .id
                    .bytes()
                    .all(|x| x.is_ascii_alphanumeric() || x == b'-' || x == b'_')
                || !ids.insert(&e.id)
            {
                return Err(invalid("effect IDs must be unique ASCII identifiers"));
            }
            if !["low", "medium", "high", "ultra"].contains(&e.quality.as_str()) {
                return Err(invalid("invalid quality"));
            }
            if ![
                "none",
                "reinhard",
                "reinhard-extended",
                "aces",
                "uncharted2",
                "exposure",
                "display",
            ]
            .contains(&e.operator.as_str())
            {
                return Err(invalid("invalid tonemap operator"));
            }
            if e.params.iter().any(|x| !x.is_finite()) {
                return Err(invalid("effect parameters must be finite"));
            }
            if e.params[14] != 0. || e.params[15] != 0. {
                return Err(invalid("reserved jitter parameters must be zero"));
            }
            let check = |i: usize, lo: f32, hi: f32, integer: bool| -> Result<()> {
                let x = e.params[i];
                if x < lo || x > hi || (integer && x.fract() != 0.0) {
                    Err(invalid(format!(
                        "{}.params[{i}] outside [{lo}, {hi}]",
                        e.id
                    )))
                } else {
                    Ok(())
                }
            };
            match e.kind {
                EffectKind::Ssao | EffectKind::Gtao => {
                    check(0, 0.0001, 10000., false)?;
                    check(1, 0., 100., false)?;
                    check(2, 0., 10., false)?;
                    check(3, 4., 64., true)?;
                    check(4, 0., 8., true)?;
                    check(5, 0., 0.99, false)?;
                }
                EffectKind::Ssgi | EffectKind::Ssr => {
                    check(0, 0.001, 100000., false)?;
                    check(1, 0.00001, 1000., false)?;
                    check(2, 0., 10., false)?;
                    check(3, 4., 128., true)?;
                    check(4, 1., 16., true)?;
                    check(5, 0., 0.99, false)?;
                    check(6, 0., 8., true)?;
                    for i in 8..11 {
                        check(i, 0., 65504., false)?;
                    }
                }
                EffectKind::Bloom => {
                    check(0, 0., 65504., false)?;
                    check(1, 0., 1., false)?;
                    check(2, 0., 10., false)?;
                    check(3, 0., 10., false)?;
                    check(4, 1., 3., true)?;
                    let passes = match e.quality.as_str() {
                        "high" => 2.,
                        "ultra" => 3.,
                        _ => 1.,
                    };
                    if e.params[4] != passes {
                        return Err(invalid("bloom quality lane mismatch"));
                    }
                }
                EffectKind::Dof => {
                    check(0, 0., 1., false)?;
                    check(1, 0.001, 100000., false)?;
                    check(2, 0.001, 1000., false)?;
                    check(3, 0.001, 1000., false)?;
                    check(4, 0., 64., false)?;
                    check(5, 0., 10., false)?;
                    check(6, 8., 32., true)?;
                    check(7, -std::f32::consts::TAU, std::f32::consts::TAU, false)?;
                    check(8, -1.5, 1.5, false)?;
                    check(9, -1.5, 1.5, false)?;
                    check(10, 0., 3., true)?;
                    let quality = ["low", "medium", "high", "ultra"][e.params[10] as usize];
                    let samples = [8., 16., 24., 32.][e.params[10] as usize];
                    if e.quality != quality || e.params[6] != samples {
                        return Err(invalid("DoF quality lane mismatch"));
                    }
                }
                EffectKind::MotionBlur => {
                    check(0, 0., 2., false)?;
                    check(1, 2., 64., true)?;
                    check(2, 0., 256., false)?;
                }
                EffectKind::Taa => {
                    check(0, 0., 0.99, false)?;
                    check(1, 0.1, 4., false)?;
                    check(2, 0., 1000., false)?;
                    check(3, 0.000001, 1., false)?;
                    check(4, 0., 1., true)?;
                }
                EffectKind::AccumulationAa => {
                    check(0, 1., 4096., true)?;
                    check(1, 0., 1., true)?;
                }
                EffectKind::Denoise => {
                    check(0, 1., 5., true)?;
                    check(1, 0.0001, 100., false)?;
                    check(2, 0.000001, 100., false)?;
                    check(3, 0.0001, 2., false)?;
                }
                EffectKind::Tonemap => {
                    check(0, -20., 20., false)?;
                    check(1, 0.0001, 65504., false)?;
                    check(2, 0., 4., false)?;
                    check(3, 0., 1., false)?;
                    check(5, 0., 6., true)?;
                    if e.params[2] > 0. && e.params[2] < 0.1 {
                        return Err(invalid("gamma must be 0 or >= 0.1"));
                    }
                    let expected = [
                        "none",
                        "reinhard",
                        "reinhard-extended",
                        "aces",
                        "uncharted2",
                        "exposure",
                        "display",
                    ][e.params[5] as usize];
                    if expected != e.operator {
                        return Err(invalid("tonemap operator lane mismatch"));
                    }
                }
                EffectKind::Lens => {
                    check(0, -1., 1., false)?;
                    check(1, -0.2, 0.2, false)?;
                    check(2, 0., 1., false)?;
                    check(3, 0., 2., false)?;
                    check(4, 0.0001, 2., false)?;
                }
            }
            if let Some(lut) = &e.lut {
                if e.kind != EffectKind::Tonemap
                    || !(2..=64).contains(&lut.size)
                    || lut.data.len()
                        != lut.size as usize * lut.size as usize * lut.size as usize * 3
                    || lut
                        .data
                        .iter()
                        .any(|x| !x.is_finite() || !(0.0..=1.0).contains(x))
                    || e.params[4] != lut.size as f32
                {
                    return Err(invalid("invalid linear RGB LUT"));
                }
            } else if e.kind == EffectKind::Tonemap && e.params[4] != 0. {
                return Err(invalid("LUT size without LUT"));
            }
            if !e.enabled {
                continue;
            }
            if lens || tonemap && e.kind != EffectKind::Lens {
                return Err(invalid(
                    "HDR effects must precede tonemap; lens must be last",
                ));
            }
            if e.kind == EffectKind::Tonemap {
                tonemap = true;
            }
            if e.kind == EffectKind::Lens {
                lens = true;
            }
            if matches!(e.kind, EffectKind::Taa | EffectKind::AccumulationAa) {
                if aa {
                    return Err(invalid("only one antialiasing history is allowed"));
                }
                aa = true;
            }
        }
        if self.active() && !tonemap {
            return Err(invalid("active chain requires a final tonemap"));
        }
        if ![
            "none", "color", "depth", "normal", "albedo", "motion", "hzb", "effect",
        ]
        .contains(&self.debug.view.as_str())
            || self.debug.hzb_mip > 31
        {
            return Err(invalid("invalid debug view"));
        }
        if let Some(id) = &self.debug.effect_id {
            if !self.effects.iter().any(|e| e.enabled && &e.id == id) {
                return Err(invalid("debug effect ID must name an enabled effect"));
            }
        }
        if self.debug.view == "effect" && self.debug.effect_id.is_none() {
            return Err(invalid("effect debug requires effect ID"));
        }
        Ok(())
    }
    pub fn pass_order(&self) -> Vec<String> {
        let mut result = vec![
            "gbuffer:primary".into(),
            "gbuffer:surface".into(),
            "hzb".into(),
        ];
        for e in self.effects.iter().filter(|e| e.enabled) {
            let parts: &[&str] = match e.kind {
                EffectKind::Ssao | EffectKind::Gtao | EffectKind::Ssgi | EffectKind::Ssr => &[
                    "trace",
                    "bilateral-x",
                    "bilateral-y",
                    "temporal",
                    "composite",
                ],
                EffectKind::Bloom => {
                    result.push(format!("{}:brightpass", e.id));
                    for level in 0..e.params[4] as u32 {
                        result.push(format!("{}:blur-{level}-x", e.id));
                        result.push(format!("{}:blur-{level}-y", e.id));
                    }
                    result.push(format!("{}:composite", e.id));
                    continue;
                }
                EffectKind::Denoise => {
                    for step in 0..e.params[0] as u32 {
                        result.push(format!("{}:atrous-{step}", e.id));
                    }
                    continue;
                }
                _ => &["resolve"],
            };
            result.extend(parts.iter().map(|part| format!("{}:{part}", e.id)));
        }
        result.push("output:srgb".into());
        result.push("overlay".into());
        result
    }
}

/// A resize, cut, topology edit or explicit reset starts the sequence afresh.
#[derive(Debug, Clone)]
pub struct TemporalState {
    pub frames: u32,
    pub reason: &'static str,
    pub previous: Option<crate::camera::CameraInput>,
}
impl Default for TemporalState {
    fn default() -> Self {
        Self {
            frames: 0,
            reason: "first-frame",
            previous: None,
        }
    }
}
impl TemporalState {
    pub fn reset(&mut self, reason: &'static str) {
        self.frames = 0;
        self.reason = reason;
        self.previous = None;
    }
    pub fn advance(&mut self, camera: crate::camera::CameraInput) {
        self.frames = self.frames.saturating_add(1);
        self.previous = Some(camera);
    }
    pub fn camera_cut(&self, camera: &crate::camera::CameraInput) -> bool {
        self.previous.is_some_and(|old| {
            let displacement = (glam::Vec3::from_array(camera.position)
                - glam::Vec3::from_array(old.position))
            .length();
            let a = (glam::Vec3::from_array(old.target) - glam::Vec3::from_array(old.position))
                .normalize_or_zero();
            let b = (glam::Vec3::from_array(camera.target)
                - glam::Vec3::from_array(camera.position))
            .normalize_or_zero();
            displacement > (old.far - old.near) * 0.1
                || a.dot(b) < 0.5
                || old.projection != camera.projection
                || (old.fov_y_degrees - camera.fov_y_degrees).abs() > 5.
                || old.near != camera.near
                || old.far != camera.far
        })
    }
}
#[cfg(test)]
mod tests;
