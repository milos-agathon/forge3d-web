use super::{decode_rgbe, RgbeImage};
use crate::error::Forge3dError;

fn header(orientation: &str) -> Vec<u8> {
    format!("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n{orientation}\n").into_bytes()
}

fn flat_image(orientation: &str, width: u32, height: u32, pixels: &[[u8; 4]]) -> Vec<u8> {
    let mut bytes = header(orientation);
    for pixel in pixels {
        bytes.extend_from_slice(pixel);
    }
    let _ = (width, height);
    bytes
}

#[test]
fn decodes_flat_pixels_below_rle_width_threshold() {
    // 2x1 image: widths <8 are always flat. E=129 => scale 2^-7.
    let bytes = flat_image("-Y 1 +X 2", 2, 1, &[[128, 64, 32, 129], [0, 0, 0, 0]]);
    let image = decode_rgbe(&bytes, 16384, u64::MAX).expect("flat decode");
    assert_eq!(image.width, 2);
    assert_eq!(image.height, 1);
    assert_eq!(&image.rgba[..8], &[1.0, 0.5, 0.25, 1.0, 0.0, 0.0, 0.0, 1.0]);
}

#[test]
fn zero_exponent_produces_black_with_unit_alpha() {
    let bytes = flat_image("-Y 1 +X 1", 1, 1, &[[200, 100, 50, 0]]);
    let image = decode_rgbe(&bytes, 16384, u64::MAX).expect("decode");
    assert_eq!(image.rgba, vec![0.0, 0.0, 0.0, 1.0]);
}

#[test]
fn hdr_values_are_not_clamped_to_one() {
    // E=137 => scale 2^1 = 2; r=200 => 400.
    let bytes = flat_image("-Y 1 +X 1", 1, 1, &[[200, 4, 2, 137]]);
    let image = decode_rgbe(&bytes, 16384, u64::MAX).expect("decode");
    assert_eq!(image.rgba, vec![400.0, 8.0, 4.0, 1.0]);
}

fn rle_channel_runs(width: usize, channel: u8, value_fn: impl Fn(usize) -> u8) -> Vec<u8> {
    // Encode one channel of a scanline as a mix of literal and run records.
    let values: Vec<u8> = (0..width).map(&value_fn).collect();
    let mut out = Vec::new();
    let mut index = 0;
    while index < width {
        let remaining = width - index;
        if remaining >= 4 && values[index..index + 4].iter().all(|v| *v == values[index]) {
            let mut run = 0;
            while index + run < width && values[index + run] == values[index] && run < 127 {
                run += 1;
            }
            out.push(128 + run as u8);
            out.push(values[index]);
            index += run;
        } else {
            let mut literal = 0;
            while index + literal < width && literal < 128 {
                if literal + 4 <= remaining
                    && values[index + literal..index + literal + 4]
                        .iter()
                        .all(|v| *v == values[index + literal])
                {
                    break;
                }
                literal += 1;
            }
            out.push(literal as u8);
            out.extend_from_slice(&values[index..index + literal]);
            index += literal;
        }
    }
    let _ = channel;
    out
}

fn rle_scanline(width: usize, pixels: &[[u8; 4]]) -> Vec<u8> {
    let mut out = vec![2, 2, (width >> 8) as u8, (width & 0xff) as u8];
    for channel in 0..4 {
        out.extend_from_slice(&rle_channel_runs(width, channel as u8, |x| {
            pixels[x][channel]
        }));
    }
    out
}

#[test]
fn decodes_rle_scanline_with_mixed_runs_and_literals() {
    let width = 8;
    let pixels: [[u8; 4]; 8] = [
        [10, 20, 30, 129],
        [10, 20, 30, 129],
        [10, 20, 30, 129],
        [10, 20, 30, 129],
        [200, 100, 50, 130],
        [201, 101, 51, 130],
        [202, 102, 52, 130],
        [203, 103, 53, 130],
    ];
    let mut bytes = header("-Y 1 +X 8");
    bytes.extend_from_slice(&rle_scanline(width, &pixels));
    let image = decode_rgbe(&bytes, 16384, u64::MAX).expect("rle decode");
    assert_eq!(image.width, 8);
    assert_eq!(image.height, 1);
    for (column, pixel) in pixels.iter().enumerate() {
        let scale = f32::powi(2.0, i32::from(pixel[3]) - 136);
        let offset = column * 4;
        for channel in 0..3 {
            assert_eq!(
                image.rgba[offset + channel],
                f32::from(pixel[channel]) * scale
            );
        }
        assert_eq!(image.rgba[offset + 3], 1.0);
    }
}

#[test]
fn reorients_all_axis_sign_combinations() {
    // 2x2 flat image with distinct colors per pixel.
    let pixels: [[u8; 4]; 4] = [
        [255, 0, 0, 129],
        [0, 255, 0, 129],
        [0, 0, 255, 129],
        [255, 255, 255, 129],
    ];
    // Stored order rows [a,b] then [c,d].
    for (orientation, expected) in [
        ("-Y 2 +X 2", [0usize, 1, 2, 3]),
        ("-Y 2 -X 2", [1, 0, 3, 2]),
        ("+Y 2 +X 2", [2, 3, 0, 1]),
        ("+Y 2 -X 2", [3, 2, 1, 0]),
    ] {
        let bytes = flat_image(orientation, 2, 2, &pixels);
        let image = decode_rgbe(&bytes, 16384, u64::MAX).expect("decode");
        for (output_index, stored_index) in expected.iter().enumerate() {
            let stored = pixels[*stored_index];
            let offset = output_index * 4;
            assert_eq!(
                image.rgba[offset],
                f32::from(stored[0]) * f32::powi(2.0, 129 - 136),
                "{orientation} pixel {output_index} red"
            );
            assert_eq!(
                image.rgba[offset + 1],
                f32::from(stored[1]) * f32::powi(2.0, 129 - 136),
                "{orientation} pixel {output_index} green"
            );
            assert_eq!(
                image.rgba[offset + 2],
                f32::from(stored[2]) * f32::powi(2.0, 129 - 136),
                "{orientation} pixel {output_index} blue"
            );
        }
    }
}

#[test]
fn accepts_crlf_headers_and_rgbe_magic() {
    let mut bytes = b"#?RGBE\r\n# comment\r\nFORMAT=32-bit_rle_rgbe\r\n\r\n-Y 1 +X 1\r\n".to_vec();
    bytes.extend_from_slice(&[10, 20, 30, 129]);
    let image = decode_rgbe(&bytes, 16384, u64::MAX).expect("crlf decode");
    assert_eq!(image.width, 1);
    assert_eq!(image.rgba[0], 10.0 * f32::powi(2.0, -7));
}

#[test]
fn rejects_bad_magic_and_missing_format() {
    for bytes in [
        b"#?NOTRGBE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n".to_vec(),
        b"#?RADIANCE\n\n-Y 1 +X 1\n".to_vec(),
        b"#?RADIANCE\nFORMAT=32-bit_rle_float\n\n-Y 1 +X 1\n".to_vec(),
    ] {
        assert!(decode_rgbe(&bytes, 16384, u64::MAX).is_err());
    }
}

#[test]
fn rejects_bad_resolution_lines() {
    for resolution in [
        "Y 1 X 1",
        "-Y 0 +X 1",
        "-Y 1 +X 0",
        "-Y -1 +X 1",
        "-Y 1 +X 1 extra",
        "-Y 1",
        "-Y 1 -Y 1",
    ] {
        let mut bytes = header(resolution);
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        assert!(
            decode_rgbe(&bytes, 16384, u64::MAX).is_err(),
            "resolution {resolution:?} must reject"
        );
    }
}

#[test]
fn enforces_dimension_and_pixel_limits() {
    let bytes = flat_image("-Y 1 +X 2", 2, 1, &[[0, 0, 0, 0], [0, 0, 0, 0]]);
    let error = decode_rgbe(&bytes, 1, u64::MAX).unwrap_err();
    assert!(matches!(error, Forge3dError::ResourceLimitExceeded { .. }));
    let error = decode_rgbe(&bytes, 16384, 1).unwrap_err();
    assert!(matches!(error, Forge3dError::ResourceLimitExceeded { .. }));
    // A zero-pixel limit still allows the decode contract to reject early.
    assert!(decode_rgbe(&bytes, 16384, 0).is_err());
}

#[test]
fn rejects_truncated_flat_and_rle_data() {
    let truncated = flat_image("-Y 1 +X 2", 2, 1, &[[1, 2, 3, 129]]);
    assert!(decode_rgbe(&truncated, 16384, u64::MAX).is_err());

    // RLE header promises a second scanline that never arrives.
    let mut bytes = header("-Y 2 +X 8");
    let pixels = [[5u8; 4]; 8];
    bytes.extend_from_slice(&rle_scanline(8, &pixels));
    assert!(decode_rgbe(&bytes, 16384, u64::MAX).is_err());
}

#[test]
fn rejects_rle_zero_counts_overflow_and_bad_markers() {
    let mut zero_run = header("-Y 1 +X 8");
    zero_run.extend_from_slice(&[2, 2, 0, 8, 0]);
    assert!(decode_rgbe(&zero_run, 16384, u64::MAX).is_err());

    let mut overflow = header("-Y 1 +X 8");
    overflow.extend_from_slice(&[2, 2, 0, 8, 128 + 9, 7]);
    assert!(decode_rgbe(&overflow, 16384, u64::MAX).is_err());

    let mut literal_overflow = header("-Y 1 +X 8");
    literal_overflow.extend_from_slice(&[2, 2, 0, 8, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert!(decode_rgbe(&literal_overflow, 16384, u64::MAX).is_err());

    let mut wrong_width = header("-Y 1 +X 8");
    wrong_width.extend_from_slice(&[2, 2, 0, 9]);
    wrong_width.extend_from_slice(&[0u8; 36]);
    assert!(decode_rgbe(&wrong_width, 16384, u64::MAX).is_err());
}

#[test]
fn decodes_old_flat_scanlines_at_rle_eligible_width() {
    // 8x1 flat data with no RLE marker: standard decoders read it as flat.
    let pixels: [[u8; 4]; 8] = [
        [0, 0, 128, 128],
        [36, 0, 128, 128],
        [72, 0, 128, 128],
        [109, 0, 128, 128],
        [145, 0, 128, 128],
        [182, 0, 128, 128],
        [218, 0, 128, 128],
        [255, 0, 128, 128],
    ];
    let bytes = flat_image("-Y 1 +X 8", 8, 1, &pixels);
    let image = decode_rgbe(&bytes, 16384, u64::MAX).expect("old flat decode");
    assert_eq!(image.width, 8);
    let scale = f32::powi(2.0, 128 - 136);
    for (column, pixel) in pixels.iter().enumerate() {
        assert_eq!(
            image.rgba[column * 4],
            f32::from(pixel[0]) * scale,
            "column {column} red"
        );
        assert_eq!(image.rgba[column * 4 + 2], 128.0 * scale);
    }
}

#[test]
fn rejects_two_two_marker_with_wrong_declared_width() {
    let mut bytes = header("-Y 1 +X 8");
    bytes.extend_from_slice(&[2, 2, 0, 9]);
    bytes.extend_from_slice(&[0u8; 36]);
    assert!(decode_rgbe(&bytes, 16384, u64::MAX).is_err());
}

#[test]
fn accepts_only_whitespace_trailing_bytes() {
    let mut bytes = flat_image("-Y 1 +X 1", 1, 1, &[[1, 2, 3, 129]]);
    bytes.extend_from_slice(b" \t\n\r");
    assert!(decode_rgbe(&bytes, 16384, u64::MAX).is_ok());
    let mut junk = flat_image("-Y 1 +X 1", 1, 1, &[[1, 2, 3, 129]]);
    junk.extend_from_slice(b"x");
    assert!(decode_rgbe(&junk, 16384, u64::MAX).is_err());
}

#[test]
fn rejects_empty_and_headerless_input() {
    assert!(decode_rgbe(&[], 16384, u64::MAX).is_err());
    assert!(decode_rgbe(b"#?RADIANCE\n", 16384, u64::MAX).is_err());
}

#[test]
fn result_shape_matches_dimensions() {
    let bytes = flat_image(
        "-Y 2 +X 3",
        3,
        2,
        &[
            [7, 8, 9, 129],
            [1, 1, 1, 129],
            [0, 0, 0, 129],
            [2, 2, 2, 129],
            [3, 3, 3, 129],
            [4, 4, 4, 129],
        ],
    );
    let image: RgbeImage = decode_rgbe(&bytes, 16384, u64::MAX).expect("decode");
    assert_eq!(image.rgba.len(), (3 * 2 * 4) as usize);
}
