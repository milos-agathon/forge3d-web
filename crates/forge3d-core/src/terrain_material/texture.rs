//! Deterministic CPU assembly of the terrain material texture arrays.
//!
//! Follows `1f4084a:src/render/material_set/gpu.rs`: every layer is resized to
//! the first texture's size, layers without a texture are filled with their
//! base color, the size drops by halves (not below 256) until the RGBA8 mip
//! chain fits the byte budget, and every deviation from the request is
//! reported as a diagnostic instead of a log line.

use super::TerrainMaterialLayer;

/// RGBA8 image (sRGB-encoded for albedo, linear for normal maps).
#[derive(Debug, Clone, PartialEq)]
pub struct TerrainLayerImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Single-channel coverage mask in terrain UV space.
#[derive(Debug, Clone, PartialEq)]
pub struct TerrainMaskImage {
    pub width: u32,
    pub height: u32,
    pub values: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TerrainMaterialDiagnostic {
    pub code: &'static str,
    pub message: String,
    pub layer: Option<u32>,
}

/// `texture_2d_array` contents: `levels[mip]` holds every layer back to back.
#[derive(Debug, Clone, PartialEq)]
pub struct TerrainMaterialArray {
    pub width: u32,
    pub height: u32,
    pub layers: u32,
    pub levels: Vec<Vec<u8>>,
    pub textured_layers: Vec<bool>,
    pub diagnostics: Vec<TerrainMaterialDiagnostic>,
}

impl TerrainMaterialArray {
    pub fn mip_levels(&self) -> u32 {
        self.levels.len() as u32
    }

    pub fn byte_len(&self) -> u64 {
        self.levels.iter().map(|level| level.len() as u64).sum()
    }
}

/// Two-layer auxiliary array: layer 0 is the tangent-space detail normal map,
/// layer 1 packs the snow (R), rock (G) and wetness (B) coverage masks.
#[derive(Debug, Clone, PartialEq)]
pub struct TerrainAuxArray {
    pub width: u32,
    pub height: u32,
    pub normal: Vec<u8>,
    pub masks: Vec<u8>,
    pub mask_bits: u32,
    pub has_detail_map: bool,
    pub diagnostics: Vec<TerrainMaterialDiagnostic>,
}

impl TerrainAuxArray {
    pub fn byte_len(&self) -> u64 {
        (self.normal.len() + self.masks.len()) as u64
    }
}

/// Native `estimate_rgba8_mip_chain`.
pub fn rgba8_mip_chain_bytes(width: u32, height: u32, layers: u32) -> u64 {
    let mut total = 0u64;
    let mut w = width.max(1);
    let mut h = height.max(1);
    loop {
        total += u64::from(w) * u64::from(h) * u64::from(layers) * 4;
        if w == 1 && h == 1 {
            break;
        }
        w = (w / 2).max(1);
        h = (h / 2).max(1);
    }
    total
}

fn flat_color(color: [f32; 3]) -> [u8; 4] {
    let byte = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    [byte(color[0]), byte(color[1]), byte(color[2]), 255]
}

/// Bilinear resample with texel-center alignment and clamp-to-edge.
fn resample<const C: usize>(
    source: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Vec<u8> {
    if src_w == dst_w && src_h == dst_h {
        return source.to_vec();
    }
    let mut out = vec![0u8; (dst_w * dst_h) as usize * C];
    let scale_x = src_w as f32 / dst_w as f32;
    let scale_y = src_h as f32 / dst_h as f32;
    for y in 0..dst_h {
        let fy = ((y as f32 + 0.5) * scale_y - 0.5).clamp(0.0, (src_h - 1) as f32);
        let y0 = fy.floor() as u32;
        let y1 = (y0 + 1).min(src_h - 1);
        let ty = fy - y0 as f32;
        for x in 0..dst_w {
            let fx = ((x as f32 + 0.5) * scale_x - 0.5).clamp(0.0, (src_w - 1) as f32);
            let x0 = fx.floor() as u32;
            let x1 = (x0 + 1).min(src_w - 1);
            let tx = fx - x0 as f32;
            for c in 0..C {
                let at = |xx: u32, yy: u32| f32::from(source[((yy * src_w + xx) as usize) * C + c]);
                let top = at(x0, y0) * (1.0 - tx) + at(x1, y0) * tx;
                let bottom = at(x0, y1) * (1.0 - tx) + at(x1, y1) * tx;
                out[((y * dst_w + x) as usize) * C + c] =
                    (top * (1.0 - ty) + bottom * ty).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

/// 2x2 box-filtered RGBA8 mip chain, including the base level.
fn mip_chain(base: Vec<u8>, width: u32, height: u32) -> Vec<Vec<u8>> {
    let mut levels = vec![base];
    let (mut w, mut h) = (width, height);
    while w > 1 || h > 1 {
        let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
        let previous = levels.last().expect("mip chain has a base level");
        let mut next = vec![0u8; (nw * nh * 4) as usize];
        for y in 0..nh {
            for x in 0..nw {
                for c in 0..4 {
                    let mut sum = 0u32;
                    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                        let sx = (x * 2 + dx).min(w - 1);
                        let sy = (y * 2 + dy).min(h - 1);
                        sum += u32::from(previous[((sy * w + sx) * 4 + c) as usize]);
                    }
                    next[((y * nw + x) * 4 + c) as usize] = ((sum + 2) / 4) as u8;
                }
            }
        }
        levels.push(next);
        w = nw;
        h = nh;
    }
    levels
}

fn image_is_consistent(image: &TerrainLayerImage) -> bool {
    image.width > 0
        && image.height > 0
        && image.rgba.len() == image.width as usize * image.height as usize * 4
}

/// Builds the `texture_2d_array` for a material set.
///
/// `max_dimension` is the device `maxTextureDimension2D`; `byte_budget` is the
/// memory the ledger can admit for the full mip chain.
pub fn assemble_material_array(
    layers: &[TerrainMaterialLayer],
    images: &[Option<TerrainLayerImage>],
    max_dimension: u32,
    byte_budget: u64,
) -> TerrainMaterialArray {
    let layer_count = layers
        .len()
        .clamp(1, super::TERRAIN_MATERIAL_LAYER_CAPACITY);
    let mut diagnostics = Vec::new();
    let mut usable: Vec<Option<&TerrainLayerImage>> = Vec::with_capacity(layer_count);
    for index in 0..layer_count {
        let image = images.get(index).and_then(Option::as_ref);
        match image {
            Some(image) if !image_is_consistent(image) => {
                diagnostics.push(TerrainMaterialDiagnostic {
                    code: "terrain-material-texture-invalid",
                    message: format!(
                        "layer {index} texture has inconsistent size or data; using its base color"
                    ),
                    layer: Some(index as u32),
                });
                usable.push(None);
            }
            other => usable.push(other),
        }
    }
    let textured_layers: Vec<bool> = usable.iter().map(Option::is_some).collect();
    let canonical = usable
        .iter()
        .flatten()
        .next()
        .map(|image| (image.width, image.height));
    let Some((requested_w, requested_h)) = canonical else {
        // Flat layers only: a 1x1 texel per layer samples identically.
        let base: Vec<u8> = layers
            .iter()
            .take(layer_count)
            .flat_map(|layer| flat_color(layer.base_color))
            .collect();
        return TerrainMaterialArray {
            width: 1,
            height: 1,
            layers: layer_count as u32,
            levels: vec![base],
            textured_layers,
            diagnostics,
        };
    };
    let mut width = requested_w.min(max_dimension.max(1));
    let mut height = requested_h.min(max_dimension.max(1));
    loop {
        let bytes = rgba8_mip_chain_bytes(width, height, layer_count as u32);
        if bytes <= byte_budget || (width <= 256 && height <= 256) {
            break;
        }
        let next = (
            (width / 2).max(256).min(width),
            (height / 2).max(256).min(height),
        );
        if next == (width, height) {
            break;
        }
        width = next.0;
        height = next.1;
    }
    if (width, height) != (requested_w, requested_h) {
        diagnostics.push(TerrainMaterialDiagnostic {
            code: "terrain-material-texture-downscaled",
            message: format!(
                "material textures resolved to {width}x{height} from {requested_w}x{requested_h} for the device limit and memory budget"
            ),
            layer: None,
        });
    }
    let texel_count = (width * height) as usize;
    let mut per_layer: Vec<Vec<Vec<u8>>> = Vec::with_capacity(layer_count);
    for (index, layer) in layers.iter().take(layer_count).enumerate() {
        let base = match usable[index] {
            Some(image) => {
                if (image.width, image.height) != (requested_w, requested_h) {
                    diagnostics.push(TerrainMaterialDiagnostic {
                        code: "terrain-material-texture-resampled",
                        message: format!(
                            "layer {index} texture {}x{} was resampled to the material set size",
                            image.width, image.height
                        ),
                        layer: Some(index as u32),
                    });
                }
                resample::<4>(&image.rgba, image.width, image.height, width, height)
            }
            None => flat_color(layer.base_color).repeat(texel_count),
        };
        per_layer.push(mip_chain(base, width, height));
    }
    let mip_levels = per_layer[0].len();
    let levels = (0..mip_levels)
        .map(|mip| {
            per_layer
                .iter()
                .flat_map(|chain| chain[mip].iter().copied())
                .collect()
        })
        .collect();
    TerrainMaterialArray {
        width,
        height,
        layers: layer_count as u32,
        levels,
        textured_layers,
        diagnostics,
    }
}

/// Builds the detail-normal/mask array at the largest provided size.
pub fn assemble_aux_array(
    detail_normal: Option<&TerrainLayerImage>,
    masks: [Option<&TerrainMaskImage>; 3],
    max_dimension: u32,
) -> TerrainAuxArray {
    let mut diagnostics = Vec::new();
    let detail_normal = detail_normal.filter(|image| {
        let ok = image_is_consistent(image);
        if !ok {
            diagnostics.push(TerrainMaterialDiagnostic {
                code: "terrain-material-detail-normal-invalid",
                message: "detail normal map has inconsistent size or data; detail map disabled"
                    .to_string(),
                layer: None,
            });
        }
        ok
    });
    let mut valid_masks: [Option<&TerrainMaskImage>; 3] = [None; 3];
    for (index, mask) in masks.iter().enumerate() {
        if let Some(mask) = mask {
            if mask.width > 0
                && mask.height > 0
                && mask.values.len() == mask.width as usize * mask.height as usize
            {
                valid_masks[index] = Some(mask);
            } else {
                diagnostics.push(TerrainMaterialDiagnostic {
                    code: "terrain-material-mask-invalid",
                    message: format!(
                        "{} mask has inconsistent size or data; mask ignored",
                        ["snow", "rock", "wetness"][index]
                    ),
                    layer: Some(index as u32),
                });
            }
        }
    }
    let mut width = 1u32;
    let mut height = 1u32;
    if let Some(image) = detail_normal {
        width = width.max(image.width);
        height = height.max(image.height);
    }
    for mask in valid_masks.iter().flatten() {
        width = width.max(mask.width);
        height = height.max(mask.height);
    }
    let limit = max_dimension.max(1);
    if width > limit || height > limit {
        diagnostics.push(TerrainMaterialDiagnostic {
            code: "terrain-material-aux-downscaled",
            message: format!(
                "detail/mask textures clamped from {width}x{height} to the device limit {limit}"
            ),
            layer: None,
        });
        width = width.min(limit);
        height = height.min(limit);
    }
    let texels = (width * height) as usize;
    let normal = match detail_normal {
        Some(image) => resample::<4>(&image.rgba, image.width, image.height, width, height),
        None => [128u8, 128, 255, 255].repeat(texels),
    };
    let mut packed = [255u8, 255, 255, 255].repeat(texels);
    let mut mask_bits = 0u32;
    for (channel, mask) in valid_masks.iter().enumerate() {
        if let Some(mask) = mask {
            mask_bits |= 1 << channel;
            let values = resample::<1>(&mask.values, mask.width, mask.height, width, height);
            for (texel, value) in values.iter().enumerate() {
                packed[texel * 4 + channel] = *value;
            }
        }
    }
    TerrainAuxArray {
        width,
        height,
        normal,
        masks: packed,
        mask_bits,
        has_detail_map: detail_normal.is_some(),
        diagnostics,
    }
}
