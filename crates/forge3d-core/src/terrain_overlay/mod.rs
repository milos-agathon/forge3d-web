//! W08/T11 `terrain_overlay` — GPU-free draped raster overlays.
//!
//! Pure-Rust port of the native overlay contract
//! (`python/forge3d/terrain_params.py` OverlayBlendMode / OverlayLayerConfig /
//! OverlaySettings + `src/viewer/terrain/overlay/{sampling,stack/composite}.rs`).
//!
//! Overlays modify terrain albedo BEFORE lighting (lit, shadowed, AO'd;
//! specular unaffected). Validation messages match the native wording
//! verbatim.

pub mod crs;

#[cfg(test)]
mod tests;

pub use crs::{crs_transform, normalize_crs, TerrainGeoreference};

use crate::error::{Forge3dError, Result};

fn invalid(field: &str, message: String) -> Forge3dError {
    Forge3dError::InvalidInput {
        field: field.to_string(),
        message,
    }
}

/// Maximum composited overlay layers (native capacity).
pub const MAX_VISIBLE_LAYERS: usize = 8;

/// Blend mode for overlay compositing (native `OverlayBlendMode` strings).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum OverlayBlendMode {
    /// `dst*(1-a) + src*a`.
    #[default]
    Normal,
    /// `dst*(1-a) + dst*src*a`.
    Multiply,
    /// `dst*(1-a) + ov*a`, `ov = b < 0.5 ? 2*b*s : 1 - 2*(1-b)*(1-s)`.
    Overlay,
}

impl OverlayBlendMode {
    /// Parse `"normal" | "multiply" | "overlay"`.
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "normal" => Ok(Self::Normal),
            "multiply" => Ok(Self::Multiply),
            "overlay" => Ok(Self::Overlay),
            _ => Err(invalid(
                "overlay.blend_mode",
                format!("blend_mode must be one of ['multiply', 'normal', 'overlay'], got '{s}'"),
            )),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Multiply => "multiply",
            Self::Overlay => "overlay",
        }
    }
}

/// RGBA8 overlay source image (color sRGB-encoded, straight alpha).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayImage {
    pub width: u32,
    pub height: u32,
    /// Row-major RGBA8, `width * height * 4` bytes; row 0 is the layer's
    /// maxy (north) edge.
    pub rgba: Vec<u8>,
}

impl OverlayImage {
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Result<Self> {
        let expected = width as usize * height as usize * 4;
        if width < 1 || height < 1 {
            return Err(invalid(
                "overlay.image",
                format!("overlay image width and height must be >= 1, got {width}x{height}"),
            ));
        }
        if rgba.len() != expected {
            return Err(invalid(
                "overlay.image",
                format!(
                    "overlay image must be {width}x{height} RGBA8 ({expected} bytes), got {}",
                    rgba.len()
                ),
            ));
        }
        Ok(Self {
            width,
            height,
            rgba,
        })
    }
}

/// Where a layer image sits on the terrain.
#[derive(Debug, Clone, PartialEq)]
pub enum OverlayPlacement {
    /// Terrain-UV extent `[u_min, v_min, u_max, v_max]`; default
    /// `[0.0, 0.0, 1.0, 1.0]` (full coverage).
    Uv([f32; 4]),
    /// CRS-bounded placement: `bounds = [minx, miny, maxx, maxy]` in `crs`.
    Crs { crs: String, bounds: [f64; 4] },
}

impl Default for OverlayPlacement {
    fn default() -> Self {
        Self::Uv([0.0, 0.0, 1.0, 1.0])
    }
}

impl OverlayPlacement {
    /// Validated UV extent.
    pub fn uv(extent: [f32; 4]) -> Result<Self> {
        let [u_min, v_min, u_max, v_max] = extent;
        if !(u_min < u_max && v_min < v_max) {
            return Err(invalid(
                "overlay.extent",
                "extent must have u_min < u_max and v_min < v_max".to_string(),
            ));
        }
        Ok(Self::Uv(extent))
    }

    /// Validated UV extent from a slice; enforces the 4-tuple shape like
    /// the native `extent must be (u_min, v_min, u_max, v_max)` check.
    pub fn uv_slice(extent: &[f32]) -> Result<Self> {
        if extent.len() != 4 {
            return Err(invalid(
                "overlay.extent",
                "extent must be (u_min, v_min, u_max, v_max)".to_string(),
            ));
        }
        Self::uv([extent[0], extent[1], extent[2], extent[3]])
    }
}

/// A single draped overlay layer (native `OverlayLayerConfig` + raster data).
#[derive(Debug, Clone, PartialEq)]
pub struct OverlayLayer {
    pub name: String,
    pub image: OverlayImage,
    pub placement: OverlayPlacement,
    /// Opacity 0.0 (transparent) .. 1.0 (opaque); default 1.0.
    pub opacity: f32,
    pub blend_mode: OverlayBlendMode,
    /// Default true.
    pub visible: bool,
    /// Stacking order (lower = behind, higher = in front); default 0.
    pub z_order: i32,
}

impl OverlayLayer {
    /// Construct with native defaults (placement full-UV, opacity 1.0,
    /// Normal blend, visible, z_order 0) and validate `name`.
    pub fn new(name: impl Into<String>, image: OverlayImage) -> Result<Self> {
        let layer = Self {
            name: name.into(),
            image,
            placement: OverlayPlacement::default(),
            opacity: 1.0,
            blend_mode: OverlayBlendMode::Normal,
            visible: true,
            z_order: 0,
        };
        layer.validate()?;
        Ok(layer)
    }

    pub fn with_placement(mut self, placement: OverlayPlacement) -> Self {
        self.placement = placement;
        self
    }

    pub fn with_opacity(mut self, opacity: f32) -> Self {
        self.opacity = opacity;
        self
    }

    pub fn with_blend_mode(mut self, blend_mode: OverlayBlendMode) -> Self {
        self.blend_mode = blend_mode;
        self
    }

    pub fn with_visible(mut self, visible: bool) -> Self {
        self.visible = visible;
        self
    }

    pub fn with_z_order(mut self, z_order: i32) -> Self {
        self.z_order = z_order;
        self
    }

    /// Native `OverlayLayerConfig.__post_init__` validation.
    pub fn validate(&self) -> Result<()> {
        if self.name.is_empty() {
            return Err(invalid(
                "overlay.name",
                "name must be non-empty".to_string(),
            ));
        }
        if !(0.0..=1.0).contains(&self.opacity) {
            return Err(invalid(
                "overlay.opacity",
                "opacity must be in [0.0, 1.0]".to_string(),
            ));
        }
        if let OverlayPlacement::Uv(e) = &self.placement {
            if !(e[0] < e[2] && e[1] < e[3]) {
                return Err(invalid(
                    "overlay.extent",
                    "extent must have u_min < u_max and v_min < v_max".to_string(),
                ));
            }
        }
        if let OverlayPlacement::Crs { bounds, .. } = &self.placement {
            if !(bounds[0] < bounds[2] && bounds[1] < bounds[3]) {
                return Err(invalid(
                    "overlay.extent",
                    "extent must have u_min < u_max and v_min < v_max".to_string(),
                ));
            }
        }
        Ok(())
    }

    /// Native visible-layer predicate: `visible && opacity > 0.001`.
    pub fn is_effectively_visible(&self) -> bool {
        self.visible && self.opacity > 0.001
    }
}

/// Terrain overlay stack configuration (native `OverlaySettings`).
#[derive(Debug, Clone, PartialEq)]
pub struct OverlaySettings {
    /// Default false — disabled for backward compatibility.
    pub enabled: bool,
    /// Global opacity multiplier for all layers; default 1.0.
    pub global_opacity: f32,
    pub layers: Vec<OverlayLayer>,
    /// Composite texture resolution relative to terrain; default 1.0.
    pub resolution_scale: f32,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            global_opacity: 1.0,
            layers: Vec::new(),
            resolution_scale: 1.0,
        }
    }
}

impl OverlaySettings {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_layers(layers: Vec<OverlayLayer>) -> Self {
        Self {
            layers,
            ..Default::default()
        }
    }

    /// Native `OverlaySettings.__post_init__` + per-layer validation + the
    /// 8-visible-layer capacity check.
    pub fn validate(&self) -> Result<()> {
        if !(0.0..=1.0).contains(&self.global_opacity) {
            return Err(invalid(
                "overlay.global_opacity",
                "global_opacity must be in [0.0, 1.0]".to_string(),
            ));
        }
        if !(0.1..=2.0).contains(&self.resolution_scale) {
            return Err(invalid(
                "overlay.resolution_scale",
                "resolution_scale must be in [0.1, 2.0]".to_string(),
            ));
        }
        for layer in &self.layers {
            layer.validate()?;
        }
        let visible = self
            .layers
            .iter()
            .filter(|l| l.is_effectively_visible())
            .count();
        if visible > MAX_VISIBLE_LAYERS {
            return Err(invalid(
                "overlay.visible_layers",
                format!(
                    "overlay supports at most {MAX_VISIBLE_LAYERS} visible layers, got {visible}"
                ),
            ));
        }
        Ok(())
    }

    /// Any layer with `visible && opacity > 0.001`.
    pub fn has_visible_layers(&self) -> bool {
        self.layers.iter().any(|l| l.is_effectively_visible())
    }

    pub fn layer_count(&self) -> usize {
        self.layers.len()
    }

    /// Visible layers sorted by `z_order`, stable by input index (native
    /// `visible_layers` ordering).
    pub fn visible_layers(&self) -> Vec<&OverlayLayer> {
        let mut out: Vec<&OverlayLayer> = self
            .layers
            .iter()
            .filter(|l| l.is_effectively_visible())
            .collect();
        out.sort_by_key(|l| l.z_order);
        out
    }
}

/// Native `sample_bilinear` — bilinear sample of an RGBA8 image at
/// `(u, v)`, alpha multiplied by `opacity`. uv are clamped to `[0, 1]`
/// and texel centers sit at `(i + 0.5) / dim` (edge clamp).
pub fn sample_bilinear(
    rgba: &[u8],
    width: u32,
    height: u32,
    u: f32,
    v: f32,
    opacity: f32,
) -> [f32; 4] {
    if width == 0 || height == 0 {
        return [0.0, 0.0, 0.0, 0.0];
    }

    let u = u.clamp(0.0, 1.0);
    let v = v.clamp(0.0, 1.0);

    let fx = (u * width as f32 - 0.5).clamp(0.0, width.saturating_sub(1) as f32);
    let fy = (v * height as f32 - 0.5).clamp(0.0, height.saturating_sub(1) as f32);

    let x0 = fx.floor() as u32;
    let y0 = fy.floor() as u32;
    let x1 = (x0 + 1).min(width.saturating_sub(1));
    let y1 = (y0 + 1).min(height.saturating_sub(1));

    let tx = fx.fract();
    let ty = fy.fract();

    let idx00 = ((y0 * width + x0) * 4) as usize;
    let idx10 = ((y0 * width + x1) * 4) as usize;
    let idx01 = ((y1 * width + x0) * 4) as usize;
    let idx11 = ((y1 * width + x1) * 4) as usize;

    let sample = |idx: usize, ch: usize| -> f32 {
        if idx + ch < rgba.len() {
            rgba[idx + ch] as f32 / 255.0
        } else {
            0.0
        }
    };

    let bilerp = |ch: usize| -> f32 {
        let c00 = sample(idx00, ch);
        let c10 = sample(idx10, ch);
        let c01 = sample(idx01, ch);
        let c11 = sample(idx11, ch);
        let top = c00 * (1.0 - tx) + c10 * tx;
        let bot = c01 * (1.0 - tx) + c11 * tx;
        top * (1.0 - ty) + bot * ty
    };

    [bilerp(0), bilerp(1), bilerp(2), bilerp(3) * opacity]
}

/// sRGB -> linear decode (per channel).
pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// CPU reference of the WGSL overlay blend: linear-space per channel,
/// `a = layer alpha * global_opacity`.
pub fn blend_linear(
    mode: OverlayBlendMode,
    dst_linear: [f32; 3],
    src_linear: [f32; 3],
    a: f32,
) -> [f32; 3] {
    let mut out = [0.0f32; 3];
    for ch in 0..3 {
        let b = dst_linear[ch];
        let s = src_linear[ch];
        out[ch] = match mode {
            OverlayBlendMode::Normal => b * (1.0 - a) + s * a,
            OverlayBlendMode::Multiply => b * (1.0 - a) + b * s * a,
            OverlayBlendMode::Overlay => {
                let ov = if b < 0.5 {
                    2.0 * b * s
                } else {
                    1.0 - 2.0 * (1.0 - b) * (1.0 - s)
                };
                b * (1.0 - a) + ov * a
            }
        };
    }
    out
}

/// One composited layer in an [`OverlayPlan`]: the layer image resampled
/// to the plan target with `alpha * opacity` applied.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedOverlay {
    pub name: String,
    pub blend_mode: OverlayBlendMode,
    pub z_order: i32,
    /// `width * height * 4` RGBA8 (sRGB color, alpha *= layer opacity).
    pub rgba: Vec<u8>,
}

/// Result of [`plan_overlays`].
#[derive(Debug, Clone, PartialEq)]
pub struct OverlayPlan {
    /// Final composite target dims (after budget downscaling).
    pub width: u32,
    pub height: u32,
    /// Visible layers in application order (z_order, stable input index).
    pub layers: Vec<PlannedOverlay>,
    /// `layers * width * height * 4`.
    pub gpu_bytes: u64,
    /// Requested target dims before budget downscaling.
    pub requested_width: u32,
    pub requested_height: u32,
    pub downscaled: bool,
    pub global_opacity: f32,
}

impl OverlayPlan {
    /// Empty plan for a disabled overlay system (feature off).
    pub fn empty(global_opacity: f32) -> Self {
        Self {
            width: 0,
            height: 0,
            layers: Vec::new(),
            gpu_bytes: 0,
            requested_width: 0,
            requested_height: 0,
            downscaled: false,
            global_opacity,
        }
    }
}

/// Resample one layer to `(tw, th)` using the native composite sampling
/// semantics (pixel-center uv, extent skip, layer-uv mapping, bilinear
/// sample, truncating u8 store).
fn resample_layer(
    layer: &OverlayLayer,
    georef: &TerrainGeoreference,
    tw: u32,
    th: u32,
) -> Result<Vec<u8>> {
    let mut out = vec![0u8; (tw * th * 4) as usize];
    for y in 0..th {
        for x in 0..tw {
            let u = (x as f32 + 0.5) / tw as f32;
            let v = (y as f32 + 0.5) / th as f32;
            let (lu, lv) = match &layer.placement {
                OverlayPlacement::Uv(e) => {
                    if u < e[0] || u > e[2] || v < e[1] || v > e[3] {
                        continue;
                    }
                    ((u - e[0]) / (e[2] - e[0]), (v - e[1]) / (e[3] - e[1]))
                }
                OverlayPlacement::Crs { crs, bounds } => {
                    let Some((tx_, ty_)) = georef.uv_to_crs(u as f64, v as f64) else {
                        return Err(crs::crs_mismatch_error(
                            &layer.name,
                            crs,
                            georef.crs.as_deref().unwrap_or("none"),
                        ));
                    };
                    let Some((lx, ly)) =
                        crs::crs_transform(georef.crs.as_deref().unwrap_or(""), crs, tx_, ty_)
                    else {
                        return Err(crs::crs_mismatch_error(
                            &layer.name,
                            crs,
                            georef.crs.as_deref().unwrap_or("none"),
                        ));
                    };
                    let lu = ((lx - bounds[0]) / (bounds[2] - bounds[0])) as f32;
                    let lv = ((bounds[3] - ly) / (bounds[3] - bounds[1])) as f32;
                    if !(0.0..=1.0).contains(&lu) || !(0.0..=1.0).contains(&lv) {
                        continue;
                    }
                    (lu, lv)
                }
            };
            let src = sample_bilinear(
                &layer.image.rgba,
                layer.image.width,
                layer.image.height,
                lu,
                lv,
                layer.opacity,
            );
            let idx = ((y * tw + x) * 4) as usize;
            out[idx] = (src[0].clamp(0.0, 1.0) * 255.0) as u8;
            out[idx + 1] = (src[1].clamp(0.0, 1.0) * 255.0) as u8;
            out[idx + 2] = (src[2].clamp(0.0, 1.0) * 255.0) as u8;
            out[idx + 3] = (src[3].clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
    Ok(out)
}

/// Build the composite plan: target dims (scaled + clamped), per-layer
/// resampled RGBA8, and budget enforcement (halve dims down to 16 while
/// over budget; `ResourceLimitExceeded` if still over).
pub fn plan_overlays(
    settings: &OverlaySettings,
    georef: &TerrainGeoreference,
    terrain_w: u32,
    terrain_h: u32,
    max_dim: u32,
    budget_bytes: u64,
) -> Result<OverlayPlan> {
    settings.validate()?;
    if !settings.enabled || !settings.has_visible_layers() {
        return Ok(OverlayPlan::empty(settings.global_opacity));
    }

    let max_dim = max_dim.max(1);
    let req_w = ((terrain_w as f32 * settings.resolution_scale).round() as u32).clamp(1, max_dim);
    let req_h = ((terrain_h as f32 * settings.resolution_scale).round() as u32).clamp(1, max_dim);

    let visible = settings.visible_layers();
    let nlayers = visible.len() as u64;

    let (mut tw, mut th) = (req_w, req_h);
    let mut downscaled = false;
    let mut gpu_bytes = nlayers * tw as u64 * th as u64 * 4;
    while gpu_bytes > budget_bytes && (tw > 16 || th > 16) {
        tw = (tw / 2).max(16);
        th = (th / 2).max(16);
        downscaled = true;
        gpu_bytes = nlayers * tw as u64 * th as u64 * 4;
    }
    if gpu_bytes > budget_bytes {
        return Err(Forge3dError::ResourceLimitExceeded {
            resource: "overlay_composite".to_string(),
            message: format!(
                "overlay composite needs {gpu_bytes} bytes ({nlayers} layers at {tw}x{th}), budget {budget_bytes}"
            ),
        });
    }

    let mut layers = Vec::with_capacity(visible.len());
    for layer in visible {
        let rgba = resample_layer(layer, georef, tw, th)?;
        layers.push(PlannedOverlay {
            name: layer.name.clone(),
            blend_mode: layer.blend_mode,
            z_order: layer.z_order,
            rgba,
        });
    }

    Ok(OverlayPlan {
        width: tw,
        height: th,
        layers,
        gpu_bytes,
        requested_width: req_w,
        requested_height: req_h,
        downscaled,
        global_opacity: settings.global_opacity,
    })
}
