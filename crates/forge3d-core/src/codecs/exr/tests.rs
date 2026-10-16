use super::*;

fn names(image: &[ExrChannel]) -> Vec<String> {
    let mut names: Vec<String> = image.iter().map(|c| c.name.clone()).collect();
    names.sort();
    names
}

#[test]
fn channel_naming_matches_native_exr_writer() {
    let cases: [(&str, usize, &[&str]); 10] = [
        (
            "beauty",
            4,
            &["beauty.R", "beauty.G", "beauty.B", "beauty.A"],
        ),
        ("albedo", 3, &["albedo.R", "albedo.G", "albedo.B"]),
        ("normal", 3, &["normal.X", "normal.Y", "normal.Z"]),
        ("depth", 1, &["depth.Z"]),
        ("roughness", 1, &["roughness"]),
        ("metallic", 1, &["metallic"]),
        ("ao", 1, &["ao"]),
        ("sun_vis", 1, &["sun_vis"]),
        ("id", 1, &["id"]),
        ("mask", 1, &["mask"]),
    ];
    for (prefix, count, expected) in cases {
        let got: Vec<String> = channel_names(prefix, count)
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(got, expected, "{prefix}");
    }
    assert_eq!(
        channel_names("motion", 2)
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect::<Vec<_>>(),
        ["motion.X", "motion.Y"]
    );
    // Alpha and vectors quantize linearly; colors do not (native flags).
    assert!(channel_names("beauty", 4).unwrap()[3].1);
    assert!(!channel_names("beauty", 4).unwrap()[0].1);
    assert!(channel_names("normal", 3).unwrap()[0].1);
    assert!(channel_names("", 3).is_err());
    assert!(channel_names("beauty", 5).is_err());
}

#[test]
fn beauty_round_trip_is_exact_and_header_matches_native_parser() {
    let (w, h) = (3u32, 2u32);
    let rgba: Vec<f32> = (0..w * h * 4).map(|i| i as f32 * 0.37 - 1.5).collect();
    let channels = planar_channels("beauty", &rgba, (w * h) as usize, 4).unwrap();
    let metadata = vec![
        ("forge3d:samples".to_string(), "16".to_string()),
        ("forge3d:tonemap".to_string(), "display".to_string()),
    ];
    let bytes = encode_exr(w, h, channels, &metadata, ExrCompression::Zip).unwrap();

    let header = inspect_exr(&bytes).unwrap();
    assert_eq!((header.width, header.height), (3, 2));
    let mut header_names: Vec<String> = header.channels.iter().map(|c| c.0.clone()).collect();
    header_names.sort();
    assert_eq!(
        header_names,
        ["beauty.A", "beauty.B", "beauty.G", "beauty.R"]
    );
    assert!(header.channels.iter().all(|c| c.1 == 2), "float channels");

    let decoded = decode_exr(&bytes, 16, 1024).unwrap();
    assert_eq!((decoded.width, decoded.height), (3, 2));
    assert_eq!(decoded.compression, "zip");
    assert_eq!(decoded.metadata, metadata);
    assert_eq!(decoded.software.as_deref(), Some("forge3d-web"));
    for (lane, suffix) in ["R", "G", "B", "A"].iter().enumerate() {
        let channel = decoded.channel(&format!("beauty.{suffix}")).unwrap();
        let ExrSamples::F32(values) = &channel.samples else {
            panic!("expected f32");
        };
        for pixel in 0..(w * h) as usize {
            assert_eq!(values[pixel].to_bits(), rgba[pixel * 4 + lane].to_bits());
        }
    }
}

#[test]
fn multichannel_aov_file_keeps_every_native_channel_and_exact_ids() {
    let (w, h) = (4u32, 3u32);
    let pixels = (w * h) as usize;
    let mut channels = Vec::new();
    channels.extend(planar_channels("beauty", &vec![0.5; pixels * 4], pixels, 4).unwrap());
    channels.extend(planar_channels("albedo", &vec![0.25; pixels * 3], pixels, 3).unwrap());
    channels.extend(planar_channels("normal", &vec![0.0; pixels * 3], pixels, 3).unwrap());
    channels.extend(planar_channels("depth", &vec![0.75; pixels], pixels, 1).unwrap());
    channels.extend(planar_channels("motion", &vec![0.125; pixels * 2], pixels, 2).unwrap());
    let ids: Vec<u32> = (0..pixels as u32).map(|i| 16_777_217 + i).collect();
    channels.push(ExrChannel {
        name: "id".to_string(),
        samples: ExrSamples::U32(ids.clone()),
        quantize_linearly: true,
    });
    for compression in ["none", "rle", "zip", "zips", "piz"] {
        let bytes = encode_exr(
            w,
            h,
            channels.clone(),
            &[],
            ExrCompression::parse(compression).unwrap(),
        )
        .unwrap();
        let decoded = decode_exr(&bytes, 64, 4096).unwrap();
        assert_eq!(decoded.compression, compression);
        assert_eq!(
            names(&decoded.channels),
            [
                "albedo.B", "albedo.G", "albedo.R", "beauty.A", "beauty.B", "beauty.G", "beauty.R",
                "depth.Z", "id", "motion.X", "motion.Y", "normal.X", "normal.Y", "normal.Z"
            ]
        );
        assert_eq!(
            decoded.channel("id").unwrap().samples,
            ExrSamples::U32(ids.clone())
        );
    }
}

#[test]
fn encoder_rejects_invalid_channel_sets() {
    let one = planar_channels("depth", &[1.0], 1, 1).unwrap();
    assert!(encode_exr(0, 1, one.clone(), &[], ExrCompression::None).is_err());
    assert!(encode_exr(2, 1, one.clone(), &[], ExrCompression::None).is_err());
    let mut dup = one.clone();
    dup.extend(one.clone());
    assert!(encode_exr(1, 1, dup, &[], ExrCompression::None).is_err());
    assert!(encode_exr(1, 1, Vec::new(), &[], ExrCompression::None).is_err());
    assert!(encode_exr(
        1,
        1,
        one.clone(),
        &[("software".to_string(), "x".to_string())],
        ExrCompression::None
    )
    .is_err());
    assert!(ExrCompression::parse("dwaa").is_err());
    assert!(planar_channels("beauty", &[1.0; 7], 2, 4).is_err());
}

fn header_with_window(max_x: i32, max_y: i32) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend(20_000_630u32.to_le_bytes());
    bytes.extend(2u32.to_le_bytes());
    let mut attr = |name: &str, kind: &str, payload: &[u8]| {
        bytes.extend(name.as_bytes());
        bytes.push(0);
        bytes.extend(kind.as_bytes());
        bytes.push(0);
        bytes.extend((payload.len() as u32).to_le_bytes());
        bytes.extend(payload);
    };
    let mut channels = Vec::new();
    channels.extend(b"Y\0");
    channels.extend(2u32.to_le_bytes());
    channels.extend([0u8; 4]);
    channels.extend(1i32.to_le_bytes());
    channels.extend(1i32.to_le_bytes());
    channels.push(0);
    attr("channels", "chlist", &channels);
    attr("compression", "compression", &[0]);
    let mut window = Vec::new();
    for v in [0i32, 0, max_x, max_y] {
        window.extend(v.to_le_bytes());
    }
    attr("dataWindow", "box2i", &window);
    attr("displayWindow", "box2i", &window);
    attr("lineOrder", "lineOrder", &[0]);
    attr("pixelAspectRatio", "float", &1.0f32.to_le_bytes());
    attr("screenWindowCenter", "v2f", &[0; 8]);
    attr("screenWindowWidth", "float", &1.0f32.to_le_bytes());
    bytes.push(0);
    bytes
}

#[test]
fn malformed_and_oversized_files_fail_with_typed_errors_before_allocation() {
    assert!(matches!(
        decode_exr(b"not an exr file", 64, 64),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        decode_exr(&[], 64, 64),
        Err(Forge3dError::InvalidInput { .. })
    ));

    let huge = header_with_window(99_999, 99_999);
    assert_eq!(inspect_exr(&huge).unwrap().width, 100_000);
    assert!(matches!(
        decode_exr(&huge, 16_384, 1 << 26),
        Err(Forge3dError::ResourceLimitExceeded { .. })
    ));
    let many = header_with_window(9_999, 9_999);
    assert!(matches!(
        decode_exr(&many, 16_384, 1_000_000),
        Err(Forge3dError::ResourceLimitExceeded { .. })
    ));
    let inverted = header_with_window(-5, 3);
    assert!(inspect_exr(&inverted).is_err());

    // Header-valid but pixel-truncated: typed failure, no panic.
    let good = encode_exr(
        8,
        8,
        planar_channels("depth", &[0.5; 64], 64, 1).unwrap(),
        &[],
        ExrCompression::Zip,
    )
    .unwrap();
    let truncated = &good[..good.len() - 10];
    assert!(decode_exr(truncated, 64, 4096).is_err());
    // Every single-byte corruption either decodes or errors; none panic.
    for index in (0..good.len()).step_by(7) {
        let mut corrupt = good.clone();
        corrupt[index] ^= 0xa5;
        let _ = decode_exr(&corrupt, 64, 4096);
    }
}
