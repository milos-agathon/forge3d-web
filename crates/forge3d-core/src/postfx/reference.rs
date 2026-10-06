//! Independent CPU references for GPU conformance fixtures.
use super::ColorLut;

pub fn hzb_dimensions(mut width: u32, mut height: u32) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    while width > 0 && height > 0 {
        out.push((width, height));
        if width == 1 && height == 1 {
            break;
        }
        width = (width / 2).max(1);
        height = (height / 2).max(1);
    }
    out
}
/// Conservative min depth pyramid. Odd edge texels participate in the last cell.
pub fn hzb_reduce(depth: &[f32], width: usize, height: usize) -> Vec<f32> {
    assert_eq!(depth.len(), width * height);
    let (w, h) = ((width / 2).max(1), (height / 2).max(1));
    let mut out = vec![1.; w * h];
    for y in 0..h {
        for x in 0..w {
            let (x0, x1) = (x * width / w, (x + 1) * width / w);
            let (y0, y1) = (y * height / h, (y + 1) * height / h);
            let mut v = f32::INFINITY;
            for yy in y0..y1 {
                for xx in x0..x1 {
                    v = v.min(depth[yy * width + xx]);
                }
            }
            out[y * w + x] = v;
        }
    }
    out
}
pub fn bloom_brightpass(rgb: [f32; 3], threshold: f32, softness: f32) -> [f32; 3] {
    // Native bloom_brightpass.wgsl: luminance threshold with quadratic soft knee.
    let brightness = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    let knee = threshold * softness;
    let factor = if brightness < threshold - knee {
        0.
    } else if brightness < threshold + knee {
        ((brightness - threshold + knee) / (2. * knee)).powi(2)
    } else {
        1.
    };
    rgb.map(|x| x * factor)
}
pub fn lens_distort(uv: [f32; 2], strength: f32) -> [f32; 2] {
    let x = uv[0] - 0.5;
    let y = uv[1] - 0.5;
    let r2 = x * x + y * y;
    let factor = 1. + strength * r2 + strength * 0.5 * r2 * r2;
    [x * factor + 0.5, y * factor + 0.5]
}
pub fn circle_of_confusion(
    depth: f32,
    focus: f32,
    aperture: f32,
    focal: f32,
    sensor: f32,
    scale: f32,
) -> f32 {
    let denominator = depth * (focus + focal);
    if denominator < 0.001 {
        0.
    } else {
        aperture * focal * (depth - focus).abs() / denominator * sensor * scale
    }
}
pub fn sample_color_lut(lut: &ColorLut, rgb: [f32; 3]) -> [f32; 3] {
    let size = lut.size as usize;
    let v = rgb.map(|x| x.clamp(0., 1.) * (size - 1) as f32);
    let lo = v.map(|x| x.floor() as usize);
    let hi = lo.map(|x| (x + 1).min(size - 1));
    let t = std::array::from_fn::<_, 3, _>(|i| v[i] - lo[i] as f32);
    let mut out = [0.; 3];
    for b in 0..2 {
        for g in 0..2 {
            for r in 0..2 {
                let xyz = [r, g, b];
                let mut w = 1.;
                let mut p = [0; 3];
                for i in 0..3 {
                    w *= if xyz[i] == 0 { 1. - t[i] } else { t[i] };
                    p[i] = if xyz[i] == 0 { lo[i] } else { hi[i] };
                }
                let index = ((p[2] * size + p[1]) * size + p[0]) * 3;
                for (c, value) in out.iter_mut().enumerate() {
                    *value += lut.data[index + c] * w;
                }
            }
        }
    }
    out
}
pub fn history_accepted(
    current_id: u32,
    old_id: u32,
    depth: f32,
    old_depth: f32,
    threshold: f32,
) -> bool {
    current_id == old_id && (depth - old_depth).abs() <= threshold.max(depth.abs() * threshold)
}
