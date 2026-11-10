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

/// Shader-side reveal of a layer whose alpha channel is a key, not coverage.
///
/// A texel shows where `key >= threshold` and `key > 0` (key 0 never shows).
/// Its age `key - threshold` drives a freshness `exp(-age / fade)` (0 when
/// `fade` is 0): the color is mixed toward `fresh_color` by
/// `fresh_mix * freshness`, and the alpha is 1, or the freshness when
/// `fresh_alpha` is set. The layer's opacity then multiplies the alpha in the
/// shader instead of being baked into the texture, so threshold, freshness
/// and opacity all change without re-uploading the image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OverlayReveal {
    /// Key value (0..1, the alpha byte / 255) at and above which texels show.
    pub threshold: f32,
    /// Key distance over which freshness falls by `1/e`; 0 disables it.
    pub fade: f32,
    /// sRGB color (0..1) fresh texels are mixed toward.
    pub fresh_color: [f32; 3],
    /// Mix toward `fresh_color` at full freshness, 0..1.
    pub fresh_mix: f32,
    /// Alpha follows freshness (a glow) instead of being 1.
    pub fresh_alpha: bool,
}

impl Default for OverlayReveal {
    fn default() -> Self {
        Self {
            threshold: 0.0,
            fade: 0.0,
            fresh_color: [1.0, 1.0, 1.0],
            fresh_mix: 0.0,
            fresh_alpha: false,
        }
    }
}

impl OverlayReveal {
    pub fn validate(&self) -> Result<()> {
        let unit = |v: f32| v.is_finite() && (0.0..=1.0).contains(&v);
        if !unit(self.threshold) {
            return Err(invalid(
                "overlay.reveal.threshold",
                "reveal threshold must be in [0.0, 1.0]".to_string(),
            ));
        }
        if !(self.fade.is_finite() && self.fade >= 0.0) {
            return Err(invalid(
                "overlay.reveal.fade",
                "reveal fade must be a finite number >= 0".to_string(),
            ));
        }
        if !self.fresh_color.iter().all(|c| unit(*c)) {
            return Err(invalid(
                "overlay.reveal.fresh_color",
                "reveal freshColor channels must be in [0.0, 1.0]".to_string(),
            ));
        }
        if !unit(self.fresh_mix) {
            return Err(invalid(
                "overlay.reveal.fresh_mix",
                "reveal freshMix must be in [0.0, 1.0]".to_string(),
            ));
        }
        Ok(())
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
    /// Shader-side reveal; the alpha channel is then a key (see [`OverlayReveal`]).
    pub reveal: Option<OverlayReveal>,
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
            reveal: None,
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

    pub fn with_reveal(mut self, reveal: Option<OverlayReveal>) -> Self {
        self.reveal = reveal;
        self
    }

    /// Opacity baked into the resampled texture: 1 for a reveal layer, whose
    /// alpha is a key and whose opacity is applied in the shader.
    pub fn baked_opacity(&self) -> f32 {
        if self.reveal.is_some() {
            1.0
        } else {
            self.opacity
        }
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
        if let Some(reveal) = &self.reveal {
            reveal.validate()?;
        }
        Ok(())
    }

    /// Native visible-layer predicate: `visible && opacity > 0.001`. A
    /// reveal layer keeps its slot at any opacity, since its opacity is a
    /// live shader value that later updates may raise again.
    pub fn is_effectively_visible(&self) -> bool {
        self.visible && (self.reveal.is_some() || self.opacity > 0.001)
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
    /// Optional composite dimensions independent of the elevation grid.
    /// Device limits and the existing overlay budget still bound allocations.
    pub output_size: Option<[u32; 2]>,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            global_opacity: 1.0,
            layers: Vec::new(),
            resolution_scale: 1.0,
            output_size: None,
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
        if self.output_size.is_some_and(|size| size.contains(&0)) {
            return Err(invalid(
                "overlay.output_size",
                "output_size must contain two positive uint32 dimensions".to_string(),
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

/// CPU reference of the WGSL reveal (`terrain_overlay_reveal`): the texel's
/// linear color and alpha after the reveal, from its sampled sRGB-decoded
/// color, its key (the sampled alpha) and the layer's live opacity.
pub fn reveal_linear(
    reveal: &OverlayReveal,
    color_linear: [f32; 3],
    key: f32,
    opacity: f32,
) -> ([f32; 3], f32) {
    if key < reveal.threshold || key <= 0.5 / 255.0 {
        return (color_linear, 0.0);
    }
    let fresh = if reveal.fade > 0.0 {
        (-(key - reveal.threshold) / reveal.fade).exp()
    } else {
        0.0
    };
    let k = reveal.fresh_mix * fresh;
    let mut color = color_linear;
    for (c, tint) in color.iter_mut().zip(reveal.fresh_color) {
        *c += (srgb_to_linear(tint) - *c) * k;
    }
    let alpha = if reveal.fresh_alpha { fresh } else { 1.0 };
    (color, alpha * opacity.clamp(0.0, 1.0))
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
    /// Terrain UV footprint of this texture slice. CPU-composited layers use
    /// the full domain; local UV layers retain their source footprint.
    pub extent: [f32; 4],
    /// `width * height * 4` RGBA8 (sRGB color, alpha *= layer opacity).
    pub rgba: Vec<u8>,
    /// Layer opacity. Baked into `rgba` alpha unless `reveal` is set, in
    /// which case the shader applies it.
    pub opacity: f32,
    /// Shader-side reveal (see [`OverlayReveal`]).
    pub reveal: Option<OverlayReveal>,
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
    local_uv: bool,
) -> Result<Vec<u8>> {
    match &layer.placement {
        OverlayPlacement::Uv(extent) => Ok(resample_uv_separable(layer, extent, tw, th, local_uv)),
        OverlayPlacement::Crs { .. } => resample_layer_pointwise(layer, georef, tw, th, local_uv),
    }
}

/// One output column (or row) of a UV-placed layer: whether it falls
/// outside the extent, and the bilinear taps and weight `sample_bilinear`
/// derives from its layer coordinate.
#[derive(Clone, Copy)]
struct AxisTap {
    skip: bool,
    lo: u32,
    hi: u32,
    t: f32,
}

/// Taps for `n` output pixels over a layer axis of `size` texels. Every
/// value is computed with the same f32 operations, in the same order, as
/// [`resample_layer_pointwise`] + [`sample_bilinear`] compute it per pixel.
fn axis_taps(n: u32, size: u32, extent_lo: f32, extent_hi: f32, local_uv: bool) -> Vec<AxisTap> {
    (0..n)
        .map(|i| {
            let c = (i as f32 + 0.5) / n as f32;
            let (skip, l) = if local_uv {
                (false, c)
            } else {
                (
                    c < extent_lo || c > extent_hi,
                    (c - extent_lo) / (extent_hi - extent_lo),
                )
            };
            let l = l.clamp(0.0, 1.0);
            let f = (l * size as f32 - 0.5).clamp(0.0, size.saturating_sub(1) as f32);
            let lo = f.floor() as u32;
            AxisTap {
                skip,
                lo,
                hi: (lo + 1).min(size.saturating_sub(1)),
                t: f.fract(),
            }
        })
        .collect()
}

/// [`resample_layer_pointwise`] for UV placement, where the layer `u` depends
/// only on the output column and `v` only on the row, so the bilinear taps
/// are computed once per column and row. Byte-identical to the pointwise
/// path (`separable_uv_resample_matches_pointwise`).
fn resample_uv_separable(
    layer: &OverlayLayer,
    extent: &[f32; 4],
    tw: u32,
    th: u32,
    local_uv: bool,
) -> Vec<u8> {
    let mut out = vec![0u8; (tw * th * 4) as usize];
    let (width, height) = (layer.image.width, layer.image.height);
    if width == 0 || height == 0 {
        return out;
    }
    let columns = axis_taps(tw, width, extent[0], extent[2], local_uv);
    let rows = axis_taps(th, height, extent[1], extent[3], local_uv);
    let rgba = &layer.image.rgba;
    // `byte as f32 / 255.0` for every byte: the same values without a
    // division per tap.
    let unorm: [f32; 256] = std::array::from_fn(|v| v as f32 / 255.0);
    let sample = |idx: usize, ch: usize| -> f32 {
        if idx + ch < rgba.len() {
            unorm[rgba[idx + ch] as usize]
        } else {
            0.0
        }
    };
    // With both weights 0 the bilinear blend is exactly the `lo` texel, so
    // the stored byte is a function of that one source byte.
    let store = |value: f32| (value.clamp(0.0, 1.0) * 255.0) as u8;
    let color: [u8; 256] = std::array::from_fn(|v| store(unorm[v]));
    let opacity = layer.baked_opacity();
    let alpha: [u8; 256] = std::array::from_fn(|v| store(unorm[v] * opacity));
    // Every column a weight-0 tap of the next source texel: a weight-0 row
    // is then one contiguous source span mapped byte by byte (the per-pixel
    // `t == 0` branch below, done a row at a time).
    let first = columns.first().map_or(0, |column| column.lo as usize);
    let contiguous = columns
        .iter()
        .enumerate()
        .all(|(x, column)| !column.skip && column.t == 0.0 && column.lo as usize == first + x);
    let identity = (0..256).all(|v| color[v] as usize == v && alpha[v] as usize == v);
    let row_bytes = tw as usize * 4;
    for (y, row) in rows.iter().enumerate() {
        if row.skip {
            continue;
        }
        let start = (row.lo as usize * width as usize + first) * 4;
        if contiguous && row.t == 0.0 && start + row_bytes <= rgba.len() {
            let source = &rgba[start..start + row_bytes];
            let target = &mut out[y * row_bytes..(y + 1) * row_bytes];
            if identity {
                target.copy_from_slice(source);
            } else {
                for (dst, src) in target.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
                    dst[0] = color[src[0] as usize];
                    dst[1] = color[src[1] as usize];
                    dst[2] = color[src[2] as usize];
                    dst[3] = alpha[src[3] as usize];
                }
            }
            continue;
        }
        for (x, column) in columns.iter().enumerate() {
            if column.skip {
                continue;
            }
            let idx00 = ((row.lo * width + column.lo) * 4) as usize;
            if column.t == 0.0 && row.t == 0.0 && idx00 + 4 <= rgba.len() {
                let idx = (y * tw as usize + x) * 4;
                out[idx] = color[rgba[idx00] as usize];
                out[idx + 1] = color[rgba[idx00 + 1] as usize];
                out[idx + 2] = color[rgba[idx00 + 2] as usize];
                out[idx + 3] = alpha[rgba[idx00 + 3] as usize];
                continue;
            }
            let idx10 = ((row.lo * width + column.hi) * 4) as usize;
            let idx01 = ((row.hi * width + column.lo) * 4) as usize;
            let idx11 = ((row.hi * width + column.hi) * 4) as usize;
            let (tx, ty) = (column.t, row.t);
            let idx = (y * tw as usize + x) * 4;
            for ch in 0..4 {
                let top = sample(idx00, ch) * (1.0 - tx) + sample(idx10, ch) * tx;
                let bot = sample(idx01, ch) * (1.0 - tx) + sample(idx11, ch) * tx;
                let mut value = top * (1.0 - ty) + bot * ty;
                if ch == 3 {
                    value *= opacity;
                }
                out[idx + ch] = store(value);
            }
        }
    }
    out
}

/// Per-pixel resampler; required for CRS placement, where the layer
/// coordinate of a pixel depends on both of its terrain coordinates.
fn resample_layer_pointwise(
    layer: &OverlayLayer,
    georef: &TerrainGeoreference,
    tw: u32,
    th: u32,
    local_uv: bool,
) -> Result<Vec<u8>> {
    let mut out = vec![0u8; (tw * th * 4) as usize];
    for y in 0..th {
        for x in 0..tw {
            let u = (x as f32 + 0.5) / tw as f32;
            let v = (y as f32 + 0.5) / th as f32;
            let (lu, lv) = match &layer.placement {
                OverlayPlacement::Uv(e) => {
                    if local_uv {
                        (u, v)
                    } else {
                        if u < e[0] || u > e[2] || v < e[1] || v > e[3] {
                            continue;
                        }
                        ((u - e[0]) / (e[2] - e[0]), (v - e[1]) / (e[3] - e[1]))
                    }
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
                layer.baked_opacity(),
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
    plan_overlays_impl(
        settings,
        georef,
        terrain_w,
        terrain_h,
        max_dim,
        budget_bytes,
        false,
        None,
    )
    .map(|(plan, _)| plan)
}

/// Plan texture-array slices for GPU UV placement. Local imagery keeps the
/// entire slice resolution inside its footprint instead of being reduced to
/// a few pixels of a terrain-wide composite. CRS placement retains the CPU
/// reprojection path. Dimensions and budget admission match `plan_overlays`.
pub fn plan_overlays_local_uv(
    settings: &OverlaySettings,
    georef: &TerrainGeoreference,
    terrain_w: u32,
    terrain_h: u32,
    max_dim: u32,
    budget_bytes: u64,
) -> Result<OverlayPlan> {
    plan_overlays_impl(
        settings,
        georef,
        terrain_w,
        terrain_h,
        max_dim,
        budget_bytes,
        true,
        None,
    )
    .map(|(plan, _)| plan)
}

/// [`plan_overlays_local_uv`] that copies a layer's resampled bytes from
/// `previous` (an earlier plan and its [`overlay_layer_key`]s) when the key
/// and target dims match, instead of resampling again. Resampling is a pure
/// function of the keyed inputs, so the plan is byte-identical either way.
/// Returns the plan and the key of each of its layers.
pub fn plan_overlays_local_uv_reusing(
    settings: &OverlaySettings,
    georef: &TerrainGeoreference,
    terrain_w: u32,
    terrain_h: u32,
    max_dim: u32,
    budget_bytes: u64,
    previous: Option<(&OverlayPlan, &[u64])>,
) -> Result<(OverlayPlan, Vec<u64>)> {
    plan_overlays_impl(
        settings,
        georef,
        terrain_w,
        terrain_h,
        max_dim,
        budget_bytes,
        true,
        previous,
    )
}

/// Content key of every input that [`resample_layer`] reads: image dims and
/// bytes, placement, opacity, target dims, UV mode and (for CRS placement)
/// the terrain georeference. Name, blend mode, z-order and visibility are
/// not part of the resampled bytes. 64-bit and non-cryptographic: it detects
/// edits, it does not defend against crafted collisions.
pub fn overlay_layer_key(
    layer: &OverlayLayer,
    georef: &TerrainGeoreference,
    tw: u32,
    th: u32,
    local_uv: bool,
) -> u64 {
    const K: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut h = 0xCBF2_9CE4_8422_2325_u64;
    let mut mix = |value: u64| h = (h ^ value).wrapping_mul(K).rotate_left(29);
    mix(u64::from(layer.image.width) << 32 | u64::from(layer.image.height));
    mix(u64::from(tw) << 32 | u64::from(th));
    // Only the baked opacity reaches the bytes; a reveal layer's live
    // opacity and reveal values are shader uniforms.
    mix(u64::from(local_uv) << 33
        | u64::from(layer.reveal.is_some()) << 32
        | u64::from(layer.baked_opacity().to_bits()));
    // Four independent lanes over 32-byte blocks, so the multiply chains
    // overlap; then folded into `h` in order.
    let blocks = layer.image.rgba.chunks_exact(32);
    let rest = blocks.remainder();
    let mut lanes = [1, 2, 3, 4].map(|seed: u64| seed.wrapping_mul(K));
    for block in blocks {
        for (lane, word) in lanes.iter_mut().zip(block.chunks_exact(8)) {
            let value = u64::from_le_bytes(word.try_into().expect("8-byte word"));
            *lane = (*lane ^ value).wrapping_mul(K).rotate_left(29);
        }
    }
    for lane in lanes {
        mix(lane);
    }
    let chunks = rest.chunks_exact(8);
    let tail = chunks.remainder();
    for chunk in chunks {
        mix(u64::from_le_bytes(chunk.try_into().expect("8-byte chunk")));
    }
    let mut last = [0u8; 8];
    last[..tail.len()].copy_from_slice(tail);
    mix(u64::from_le_bytes(last) ^ (tail.len() as u64) << 56);
    mix(layer.image.rgba.len() as u64);
    match &layer.placement {
        OverlayPlacement::Uv(extent) => {
            mix(1);
            for v in extent {
                mix(u64::from(v.to_bits()));
            }
        }
        OverlayPlacement::Crs { crs, bounds } => {
            mix(2);
            for text in [Some(crs.as_str()), georef.crs.as_deref()] {
                mix(text.map_or(u64::MAX, |t| t.len() as u64));
                for byte in text.unwrap_or("").bytes() {
                    mix(u64::from(byte));
                }
            }
            for v in bounds.iter().chain(georef.bounds.iter().flatten()) {
                mix(v.to_bits());
            }
            mix(u64::from(georef.bounds.is_some()));
        }
    }
    h
}

fn plan_overlays_impl(
    settings: &OverlaySettings,
    georef: &TerrainGeoreference,
    terrain_w: u32,
    terrain_h: u32,
    max_dim: u32,
    budget_bytes: u64,
    local_uv: bool,
    previous: Option<(&OverlayPlan, &[u64])>,
) -> Result<(OverlayPlan, Vec<u64>)> {
    settings.validate()?;
    if !settings.enabled || !settings.has_visible_layers() {
        return Ok((OverlayPlan::empty(settings.global_opacity), Vec::new()));
    }

    let max_dim = max_dim.max(1);
    let [requested_w, requested_h] = settings.output_size.unwrap_or_else(|| {
        [
            (terrain_w as f32 * settings.resolution_scale).round() as u32,
            (terrain_h as f32 * settings.resolution_scale).round() as u32,
        ]
    });
    let req_w = requested_w.clamp(1, max_dim);
    let req_h = requested_h.clamp(1, max_dim);

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

    let reusable = previous.filter(|(plan, keys)| {
        plan.width == tw && plan.height == th && keys.len() == plan.layers.len()
    });
    let mut layers = Vec::with_capacity(visible.len());
    let mut keys = Vec::with_capacity(visible.len());
    for layer in visible {
        let key = overlay_layer_key(layer, georef, tw, th, local_uv);
        let reused = reusable.and_then(|(plan, previous_keys)| {
            previous_keys
                .iter()
                .position(|k| *k == key)
                .map(|i| plan.layers[i].rgba.clone())
        });
        let rgba = match reused {
            Some(rgba) => rgba,
            None => resample_layer(layer, georef, tw, th, local_uv)?,
        };
        keys.push(key);
        let extent = match &layer.placement {
            OverlayPlacement::Uv(extent) if local_uv => *extent,
            _ => [0.0, 0.0, 1.0, 1.0],
        };
        layers.push(PlannedOverlay {
            name: layer.name.clone(),
            blend_mode: layer.blend_mode,
            z_order: layer.z_order,
            extent,
            rgba,
            opacity: layer.opacity,
            reveal: layer.reveal,
        });
    }

    Ok((
        OverlayPlan {
            width: tw,
            height: th,
            layers,
            gpu_bytes,
            requested_width: req_w,
            requested_height: req_h,
            downscaled,
            global_opacity: settings.global_opacity,
        },
        keys,
    ))
}
