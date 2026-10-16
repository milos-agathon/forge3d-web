//! W08/T14a terrain_vt tests — ports of the GPU-free assertions from
//! `tests/test_tv20_virtual_texturing.py` and
//! `tests/test_p2_vt_family_validation.py`, plus the spec-mandated
//! budget/eviction/feedback/determinism/mip-chain/border tests.

use super::*;

fn field_msg(r: Result<()>) -> String {
    match r.unwrap_err() {
        Forge3dError::InvalidInput { message, .. } => message,
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

// ------------------------------------------- family config (test_tv20) --

#[test]
fn test_vt_layer_family_defaults() {
    let family = VtLayerFamily::new("albedo").unwrap();
    assert_eq!(family.tile_size, 248);
    assert_eq!(family.tile_border, 4);
    assert_eq!(family.slot_size(), 256);
    assert_eq!(family.pages_x0(), 17);
    assert_eq!(family.pages_y0(), 17);
    assert_eq!(family.fallback, [0.5, 0.5, 0.5, 1.0]);
    assert_eq!(family.virtual_size_px, (4096, 4096));
}

#[test]
fn test_vt_layer_family_rejects_unknown() {
    let msg = field_msg(VtLayerFamily::new("diffuse").map(|_| ()));
    assert_eq!(msg, "family must be one of ['albedo', 'mask', 'normal']");
}

#[test]
fn test_vt_layer_family_accepts_forward_compatible_families() {
    assert!(VtLayerFamily::new("normal").is_ok());
    assert!(VtLayerFamily::new("mask").is_ok());
}

#[test]
fn test_native_terrain_vt_runtime_is_currently_albedo_only() {
    assert_eq!(TERRAIN_VT_SUPPORTED_FAMILY, "albedo");
}

#[test]
fn test_vt_layer_family_validation() {
    let l = VtLayerFamily::new("albedo").unwrap().with_tile_size(8);
    assert_eq!(field_msg(l.validate()), "tile_size must be >= 16");
    let l = VtLayerFamily::new("albedo")
        .unwrap()
        .with_virtual_size(16, 8);
    assert_eq!(
        field_msg(l.validate()),
        "virtual_size_px must be >= tile_size in both dimensions"
    );
}

// ------------------------------------------ settings config (test_tv20) --

#[test]
fn test_vt_settings_defaults() {
    let s = TerrainVtSettings::new();
    assert!(!s.enabled);
    assert_eq!(s.layers.len(), 1);
    assert_eq!(s.layers[0].family, "albedo");
    assert_eq!(s.atlas_size, 4096);
    assert_eq!(s.residency_budget_mb, 256.0);
    assert_eq!(s.max_mip_levels, 8);
    assert!(s.use_feedback);
}

#[test]
fn test_vt_settings_reject_duplicate_families() {
    let mut s = TerrainVtSettings::new();
    s.layers.push(VtLayerFamily::new("albedo").unwrap());
    let msg = field_msg(s.validate());
    assert!(msg.contains("duplicate"), "got: {msg}");
    assert_eq!(msg, "duplicate family in layers");
}

#[test]
fn test_vt_settings_reject_indivisible_atlas() {
    let mut s = TerrainVtSettings::new();
    s.atlas_size = 1000;
    let msg = field_msg(s.validate());
    assert!(msg.contains("divisible"), "got: {msg}");
    assert_eq!(
        msg,
        "atlas_size (1000) must be divisible by slot_size (256) for family 'albedo'"
    );
}

#[test]
fn test_vt_settings_validation_ranges() {
    let mut s = TerrainVtSettings::new();
    s.atlas_size = 128;
    assert_eq!(field_msg(s.validate()), "atlas_size must be >= 256");

    let mut s = TerrainVtSettings::new();
    s.residency_budget_mb = 0.0;
    assert_eq!(field_msg(s.validate()), "residency_budget_mb must be > 0");

    let mut s = TerrainVtSettings::new();
    s.max_mip_levels = 0;
    assert_eq!(field_msg(s.validate()), "max_mip_levels must be >= 1");
}

#[test]
fn test_vt_settings_actual_mip_count() {
    let mut s = TerrainVtSettings::new();
    s.max_mip_levels = 8;
    assert!(s.actual_mip_count("albedo").unwrap() >= 1);
    // Default 17x17 -> full levels floor(log2(17))+1 = 5 -> min(8, 5) = 5.
    assert_eq!(s.actual_mip_count("albedo"), Some(5));
    assert_eq!(s.actual_mip_count("normal"), None);
    // Divisible-by-atlas normal family: request 2 mips on 17x17 -> min(2,5).
    s.layers.push(VtLayerFamily::new("normal").unwrap());
    s.max_mip_levels = 2;
    assert_eq!(s.actual_mip_count("normal"), Some(2));
    // 1.38 wheel: virtual (2048,2048)/tile 248 -> 9 pages ->
    // actual_mip_count == 4 (floor-based public value, min(8, 4)).
    let mut s2048 = TerrainVtSettings::new();
    s2048.max_mip_levels = 8;
    s2048.layers = vec![VtLayerFamily::new("albedo")
        .unwrap()
        .with_virtual_size(2048, 2048)
        .with_tile_size(248)];
    assert_eq!(s2048.actual_mip_count("albedo"), Some(4));
}

#[test]
fn test_vt_layer_pages_at_mip_non_power_of_two() {
    let family = VtLayerFamily::new("albedo")
        .unwrap()
        .with_virtual_size(3000, 2000);
    assert_eq!(family.pages_at_mip(0), (13, 9));
    assert_eq!(family.pages_at_mip(1), (7, 5));
    assert_eq!(family.pages_at_mip(4), (1, 1));
}

#[test]
fn test_vt_full_pyramid_levels() {
    let family = VtLayerFamily::new("albedo").unwrap();
    assert_eq!(family.full_pyramid_levels(), 5); // 17 -> floor(log2 17)+1

    // Native 1.38 wheel: virtual (2048, 2048) with tile 248 -> 9 pages,
    // public full_pyramid_levels == 4 (floor formula); the runtime page
    // pyramid still completes to 1x1 (ceil formula, 5 levels: 9,5,3,2,1).
    let golden = VtLayerFamily::new("albedo")
        .unwrap()
        .with_virtual_size(2048, 2048)
        .with_tile_size(248);
    assert_eq!(golden.full_pyramid_levels(), 4);
    let small = VtLayerFamily::new("albedo")
        .unwrap()
        .with_virtual_size(256, 256)
        .with_tile_size(64);
    assert_eq!(small.full_pyramid_levels(), 3); // 4 pages -> 3 levels
    assert_eq!(page_table_mip_levels(1, 1), 1);
    assert_eq!(page_table_mip_levels(8, 8), 4);
    assert_eq!(page_table_mip_levels(9, 9), 5); // runtime pyramid -> 1x1
}

// ----------------------------------------------------- support report --

#[test]
fn test_support_report_albedo_only() {
    let mut s = TerrainVtSettings::new();
    s.enabled = true;
    let report = validate_terrain_vt_support(&s, None);
    assert_eq!(report.status, "ok");
    assert!(report.diagnostics.is_empty());
    assert_eq!(report.supported_features["vt.albedo"], "supported");
    assert!(!report.unsupported_features.contains_key("vt.normal"));
    let summary = &report.layer_summaries[0];
    assert_eq!(summary.support_level, "supported");
    assert_eq!(summary.families, ["albedo"]);
    assert_eq!(summary.native_supported_family, "albedo");
    assert_eq!(summary.layer_type, "terrain.virtual_texture");
    assert_eq!(summary.layer_id, "terrain.vt");
    assert!(summary.enabled);
    assert!(summary.diagnostic_codes.is_empty());
}

#[test]
fn test_support_report_non_albedo_deterministic() {
    let mut first = TerrainVtSettings::new();
    first.enabled = true;
    first.layers.push(VtLayerFamily::new("normal").unwrap());
    first.layers.push(VtLayerFamily::new("mask").unwrap());
    let mut second = TerrainVtSettings::new();
    second.enabled = true;
    second.layers = vec![
        VtLayerFamily::new("mask").unwrap(),
        VtLayerFamily::new("albedo").unwrap(),
        VtLayerFamily::new("normal").unwrap(),
    ];
    let r1 = validate_terrain_vt_support(&first, None);
    let r2 = validate_terrain_vt_support(&second, None);
    assert_eq!(r1.status, "error");
    assert_eq!(r2.status, "error");
    assert_eq!(r1, r2); // deterministic across layer order

    let diags: Vec<&VtDiagnostic> = r1
        .diagnostics
        .iter()
        .filter(|d| d.code == "vt_unsupported_family")
        .collect();
    assert_eq!(diags.len(), 2);
    let families: Vec<&str> = diags
        .iter()
        .map(|d| {
            d.details
                .iter()
                .find(|(k, _)| k == "family")
                .map(|(_, v)| v.as_str())
                .unwrap()
        })
        .collect();
    assert_eq!(families, ["mask", "normal"]); // sorted by object_id
    let object_ids: Vec<&str> = diags.iter().map(|d| d.object_id.as_str()).collect();
    assert_eq!(object_ids, ["vt.mask", "vt.normal"]);
    assert!(diags.iter().all(|d| d.layer_id == "terrain.vt"));
    assert!(diags.iter().all(|d| d.support_level == "unsupported"));
    assert!(diags.iter().all(|d| d.severity == "error"));
    assert!(diags.iter().all(|d| d.message
        == "Requested terrain virtual-texturing family is not paged by the native runtime."));
    assert!(diags.iter().all(|d| d.remediation
        == "Use the albedo VT family or wait for native normal/mask runtime support."));
    assert!(diags.iter().all(|d| {
        d.details
            .iter()
            .any(|(k, v)| k == "supported_family" && v == "albedo")
    }));

    let summary = &r1.layer_summaries[0];
    assert_eq!(summary.support_level, "unsupported");
    assert_eq!(
        summary.diagnostic_codes,
        ["vt_unsupported_family", "vt_unsupported_family"]
    );
    assert_eq!(summary.families, ["albedo", "mask", "normal"]);
    assert_eq!(r1.supported_features["vt.albedo"], "supported");
    assert_eq!(r1.unsupported_features["vt.mask"], "unsupported");
    assert_eq!(r1.unsupported_features["vt.normal"], "unsupported");
}

#[test]
fn test_support_report_custom_layer_id() {
    let mut s = TerrainVtSettings::new();
    s.layers.push(VtLayerFamily::new("mask").unwrap());
    let r = validate_terrain_vt_support(&s, Some("custom.layer"));
    assert_eq!(r.diagnostics[0].layer_id, "custom.layer");
    assert_eq!(r.layer_summaries[0].layer_id, "custom.layer");
    // Diagnostic details carry the native shape.
    assert_eq!(
        r.diagnostics[0].details,
        vec![
            ("family".to_string(), "mask".to_string()),
            ("supported_family".to_string(), "albedo".to_string()),
        ]
    );
}

// ------------------------------------------------------- source registry --

#[test]
fn test_registry_virtual_size_validation() {
    let mut reg = VtSourceRegistry::new();
    assert_eq!(
        field_msg(reg.register(0, "albedo", (0, 256), vec![0; 4], [0.0; 4])),
        "virtual_size_px must be > 0 in both dimensions"
    );
    assert_eq!(
        field_msg(reg.register(0, "albedo", (256, 0), vec![0; 4], [0.0; 4])),
        "virtual_size_px must be > 0 in both dimensions"
    );
}

#[test]
fn test_registry_albedo_size_mismatch() {
    let mut reg = VtSourceRegistry::new();
    let msg = field_msg(reg.register(0, "albedo", (64, 64), vec![0; 100], [0.0; 4]));
    assert_eq!(
        msg,
        "VT source data size mismatch for albedo: expected 16384 RGBA8 bytes, got 100"
    );
}

#[test]
fn test_registry_non_albedo_nonempty() {
    let mut reg = VtSourceRegistry::new();
    assert_eq!(
        field_msg(reg.register(0, "normal", (64, 64), vec![], [0.0; 4])),
        "VT source data must not be empty"
    );
    // Stored but never paged by the runtime.
    reg.register(0, "normal", (64, 64), vec![1, 2, 3], [0.0; 4])
        .unwrap();
    assert!(reg.get(0, "normal").is_some());
}

#[test]
fn test_registry_virtual_size_mismatch_reregister() {
    let mut reg = VtSourceRegistry::new();
    reg.register(0, "albedo", (64, 64), vec![0; 64 * 64 * 4], [0.0; 4])
        .unwrap();
    // Native checks data size before the existing-source size compare, so
    // the re-register must carry correctly-sized data to reach that check.
    let msg = field_msg(reg.register(0, "albedo", (32, 64), vec![0; 32 * 64 * 4], [0.0; 4]));
    assert_eq!(
        msg,
        "Virtual size mismatch: existing (64, 64), new (32, 64)"
    );
    // Same size re-register succeeds and bumps the generation.
    let gen = reg.source_generation();
    reg.register(0, "albedo", (64, 64), vec![1; 64 * 64 * 4], [0.0; 4])
        .unwrap();
    assert_eq!(reg.source_generation(), gen + 1);
}

#[test]
fn test_registry_clear_and_generation() {
    let mut reg = VtSourceRegistry::new();
    reg.register(0, "albedo", (16, 16), vec![0; 16 * 16 * 4], [0.0; 4])
        .unwrap();
    assert_eq!(reg.source_generation(), 1);
    assert_eq!(reg.len(), 1);
    reg.clear();
    assert_eq!(reg.source_generation(), 2);
    assert!(reg.is_empty());
}

// ------------------------------------------------------------- runtime --

/// Small fixture: virtual 256x256, tile 64, border 0 -> slot 64, pages 4x4,
/// full levels 3; atlas 128 -> 2x2 = 4 slots.
fn fixture() -> (VtSourceRegistry, VtLayerFamily, TerrainVtSettings) {
    let mut reg = VtSourceRegistry::new();
    // Source: texel (x,y) -> [x, y, 0, 255].
    let mut data = vec![0u8; 256 * 256 * 4];
    for y in 0..256usize {
        for x in 0..256usize {
            let i = (y * 256 + x) * 4;
            data[i] = x as u8;
            data[i + 1] = y as u8;
            data[i + 2] = 0;
            data[i + 3] = 255;
        }
    }
    reg.register(0, "albedo", (256, 256), data, [0.25, 0.5, 0.75, 1.0])
        .unwrap();
    let layer = VtLayerFamily::new("albedo")
        .unwrap()
        .with_virtual_size(256, 256)
        .with_tile_size(64)
        .with_tile_border(0);
    let mut settings = TerrainVtSettings::new();
    settings.enabled = true;
    settings.layers = vec![layer.clone()];
    settings.atlas_size = 256; // divisible by slot 64 -> 4x4 slots
    settings.residency_budget_mb = 4.0 * 16384.0 / (1024.0 * 1024.0); // 4 slots
    settings.validate().unwrap();
    (reg, layer, settings)
}

#[test]
fn test_runtime_geometry_and_budget() {
    let (reg, layer, settings) = fixture();
    let rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    assert_eq!(rt.slot_size(), 64);
    assert_eq!(rt.pages_x0(), 4);
    assert_eq!(rt.pages_y0(), 4);
    assert_eq!(rt.max_mip_levels(), 3); // min(8, full=3)
    assert_eq!(rt.budget_pages(), 4); // atlas slots cap
    let stats = rt.stats();
    assert_eq!(stats.total_pages, 21); // 16+4+1 pages over 1 source
    assert_eq!(stats.cache_budget_pages, 4);
    assert_eq!(stats.source_count, 1);
    assert_eq!(stats.resident_pages, 0);
}

#[test]
fn test_runtime_source_size_must_match_layer() {
    let (reg, _layer, settings) = fixture();
    let layer = VtLayerFamily::new("albedo")
        .unwrap()
        .with_virtual_size(512, 512)
        .with_tile_size(64)
        .with_tile_border(0);
    let mut s2 = settings.clone();
    s2.layers = vec![layer.clone()];
    let err = VtRuntimeState::new(&reg, &layer, &s2, 4).unwrap_err();
    match err {
        Forge3dError::InvalidInput { message, .. } => assert_eq!(
            message,
            "VT source (0, \"albedo\") virtual size (256, 256) does not match layer contract (512, 512)"
        ),
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

#[test]
fn test_runtime_skips_non_albedo_and_out_of_range_sources() {
    let (mut reg, layer, settings) = fixture();
    reg.register(0, "normal", (256, 256), vec![9; 16], [0.0; 4])
        .unwrap();
    reg.register(7, "albedo", (256, 256), vec![0; 256 * 256 * 4], [0.0; 4])
        .unwrap();
    let rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    // material 7 >= material_count(4) -> skipped; normal -> skipped.
    assert_eq!(rt.prepared_source_count(), 1);
    assert!(rt.prepared_source(0).is_some());
    assert!(rt.prepared_source(7).is_none());
    assert_eq!(rt.stats().source_count, 1);
}

#[test]
fn test_mip_chain_values() {
    // 4x2 image; check truncating 2x2 average.
    let data: Vec<u8> = vec![
        0, 0, 0, 255, 10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, // row 0
        4, 0, 0, 255, 14, 0, 0, 255, 24, 0, 0, 255, 34, 0, 0, 255, // row 1
    ];
    let chain = build_rgba_mip_chain(&data, (4, 2), 3);
    assert_eq!(chain.len(), 3);
    assert_eq!((chain[0].width, chain[0].height), (4, 2));
    assert_eq!((chain[1].width, chain[1].height), (2, 1));
    // mip1 texel 0 = avg(0,10,4,14) = 28/4 = 7; texel 1 = avg(20,30,24,34)=27.
    assert_eq!(chain[1].data[0], 7);
    assert_eq!(chain[1].data[4], 27);
    // mip2 1x1 = avg(7,27) = 34/2 = 17.
    assert_eq!((chain[2].width, chain[2].height), (1, 1));
    assert_eq!(chain[2].data[0], 17);
    // Extra levels clone the 1x1.
    let chain5 = build_rgba_mip_chain(&data, (4, 2), 5);
    assert_eq!(chain5.len(), 5);
    assert_eq!(chain5[4], chain5[3]);
}

#[test]
fn test_build_tile_data_border_clamping() {
    // tile_size 16, border 2 -> slot 20; virtual 32x32 -> 2x2 pages.
    let mut reg = VtSourceRegistry::new();
    let mut data = vec![0u8; 32 * 32 * 4];
    for y in 0..32usize {
        for x in 0..32usize {
            let i = (y * 32 + x) * 4;
            data[i] = x as u8;
            data[i + 1] = y as u8;
            data[i + 2] = 0;
            data[i + 3] = 255;
        }
    }
    reg.register(0, "albedo", (32, 32), data, [0.0; 4]).unwrap();
    let layer = VtLayerFamily::new("albedo")
        .unwrap()
        .with_virtual_size(32, 32)
        .with_tile_size(16)
        .with_tile_border(2);
    let mut settings = TerrainVtSettings::new();
    settings.layers = vec![layer.clone()];
    settings.atlas_size = 260; // divisible by slot 20
    settings.validate().unwrap();
    let rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    let source = rt.prepared_source(0).unwrap();
    let key = TileKey {
        material_index: 0,
        x: 0,
        y: 0,
        mip_level: 0,
    };
    let tile = rt.build_tile_data(source, key);
    assert_eq!(tile.len(), 20 * 20 * 4);
    let px = |sx: usize, sy: usize| -> &[u8] { &tile[(sy * 20 + sx) * 4..(sy * 20 + sx) * 4 + 4] };
    // Slot (0,0) -> src (-2,-2) clamped to (0,0).
    assert_eq!(px(0, 0), &[0, 0, 0, 255]);
    // Slot (2,2) -> src (0,0) (first content texel).
    assert_eq!(px(2, 2), &[0, 0, 0, 255]);
    // Slot (17,17) -> src (15,15) (last content texel of tile (0,0)).
    assert_eq!(px(17, 17), &[15, 15, 0, 255]);
    // Slot (19,19) -> src (17,17): gutter samples neighbour content, only
    // mip bounds are clamped (not tile bounds).
    assert_eq!(px(19, 19), &[17, 17, 0, 255]);
    // Edge tile (1,1): slot (0,0) -> src (16-2, 16-2) = (14,14).
    let edge = rt.build_tile_data(
        source,
        TileKey {
            material_index: 0,
            x: 1,
            y: 1,
            mip_level: 0,
        },
    );
    assert_eq!(&edge[0..4], &[14, 14, 0, 255]);
    // Corner tile (1,1): slot (19,19) -> src (33,33) clamped to (31,31).
    let i = (19 * 20 + 19) * 4;
    assert_eq!(&edge[i..i + 4], &[31, 31, 0, 255]);
}

#[test]
fn test_ensure_resident_hit_miss_evict() {
    let (reg, layer, settings) = fixture();
    let mut rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    let key = |x, y, mip| TileKey {
        material_index: 0,
        x,
        y,
        mip_level: mip,
    };
    // First ensure -> miss, uploads slot 0.
    let up = rt.ensure_resident(key(0, 0, 0)).unwrap();
    assert_eq!(up.size, 64);
    assert_eq!(up.rgba.len(), 64 * 64 * 4);
    assert_eq!((up.atlas_x, up.atlas_y), (0, 0));
    assert_eq!(rt.stats().cache_misses, 1);
    // Hit -> None, hits counter.
    assert!(rt.ensure_resident(key(0, 0, 0)).is_none());
    assert_eq!(rt.stats().cache_hits, 1);
    assert_eq!(rt.stats().miss_rate, 0.5);
    // Missing source material -> None, no counters.
    assert!(rt
        .ensure_resident(TileKey {
            material_index: 3,
            x: 0,
            y: 0,
            mip_level: 0,
        })
        .is_none());

    // Fill remaining 3 free slots, then force an eviction.
    rt.ensure_resident(key(1, 0, 0));
    rt.ensure_resident(key(2, 0, 0));
    rt.ensure_resident(key(3, 0, 0));
    assert_eq!(rt.stats().resident_pages, 4);
    let up = rt.ensure_resident(key(0, 1, 0)).unwrap();
    assert_eq!(rt.stats().evictions, 1);
    // LRU victim was the oldest tile (0,0,0) -> page entry cleared.
    let pt = rt.page_table_texels(0, 0);
    // pages_at_mip(0) = 4x4; entry (0,0) cleared, (0,1) resident.
    assert_eq!(pt[0], [0.0, 0.0, 0.0, 0.0]);
    assert_eq!(pt[4][2], 1.0);
    // The evicted slot was reused: new upload at slot 0 origin.
    assert_eq!((up.atlas_x, up.atlas_y), (0, 0));
}

#[test]
fn test_page_table_texels_and_dirty_layers() {
    let (reg, layer, settings) = fixture();
    let mut rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    let key = TileKey {
        material_index: 0,
        x: 1,
        y: 2,
        mip_level: 0,
    };
    rt.ensure_resident(key);
    let pt = rt.page_table_texels(0, 0);
    // page index = y*4 + x = 9; atlas slot 0 origin (0,0)/256.
    assert_eq!(pt[9], [0.0, 0.0, 1.0, 0.0]);
    assert_eq!(rt.take_dirty_layers(), vec![(0, 0)]);
    assert!(rt.take_dirty_layers().is_empty());
    // Slot 1 -> atlas origin (64,0) -> u = 64/256 = 0.25.
    let key2 = TileKey { x: 2, ..key };
    rt.ensure_resident(key2);
    let pt = rt.page_table_texels(0, 0);
    assert_eq!(pt[10], [0.25, 0.0, 1.0, 0.0]);
    // Out-of-range texels -> empty.
    assert!(rt.page_table_texels(9, 0).is_empty());
    assert!(rt.page_table_texels(0, 9).is_empty());
}

#[test]
fn test_collect_requests_deterministic_and_ancestors() {
    let (reg, layer, settings) = fixture();
    let mut rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    let params = VtViewParams::default(); // screen -> full rect
    let (w, h) = (256u32, 256u32);
    // Full rect, virtual 256 == render 256 -> texels_per_pixel ~1 -> mip 0.
    let a = rt.collect_requests(&params, w, h, false);
    let b = rt.collect_requests(&params, w, h, false);
    assert_eq!(a, b); // deterministic
    assert!(!a.is_empty());
    // Sorted by (mip, material, y, x).
    let mut sorted = a.clone();
    sorted.sort_by_key(|k| (k.mip_level, k.material_index, k.y, k.x));
    assert_eq!(a, sorted);
    // Full rect at mip 0 -> all 16 mip-0 pages + ancestors (4 + 1) = 21.
    assert_eq!(a.len(), 21);
    let set: std::collections::HashSet<TileKey> = a.iter().copied().collect();
    assert!(set.contains(&TileKey {
        material_index: 0,
        x: 3,
        y: 3,
        mip_level: 0
    }));
    assert!(set.contains(&TileKey {
        material_index: 0,
        x: 1,
        y: 1,
        mip_level: 1
    }));
    assert!(set.contains(&TileKey {
        material_index: 0,
        x: 0,
        y: 0,
        mip_level: 2
    }));
    // Corner mesh view: requests only cover the far tile + ancestors.
    let mesh = VtViewParams {
        camera_mode: "mesh".to_string(),
        cam_target: [4.0, 4.0, 0.0],
        cam_radius: 1.0,
        ..VtViewParams::default()
    };
    // Feedback tile (0,0) at mip 0 is outside the visible rect.
    rt.apply_feedback(&[FeedbackEntry {
        tile_x: 0,
        tile_y: 0,
        mip_level: 0,
        frame_number: 1, // material 0
    }]);
    let fb_tile = TileKey {
        material_index: 0,
        x: 0,
        y: 0,
        mip_level: 0,
    };
    let without_fb = rt.collect_requests(&mesh, w, h, false);
    assert!(!without_fb.contains(&fb_tile));
    let with_fb = rt.collect_requests(&mesh, w, h, true);
    assert!(with_fb.contains(&fb_tile));
    assert_eq!(rt.stats().feedback_requests, 1);
}

#[test]
fn test_apply_feedback_bounds_filtering() {
    let (reg, layer, settings) = fixture();
    let mut rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    rt.apply_feedback(&[
        FeedbackEntry {
            tile_x: 1,
            tile_y: 1,
            mip_level: 0,
            frame_number: 1,
        }, // material 0 ok
        FeedbackEntry {
            tile_x: 0,
            tile_y: 0,
            mip_level: 0,
            frame_number: 0,
        }, // material = -1 -> 0? saturating_sub -> 0 -> but frame 0 -> material 0? saturating_sub(1) of 0 = 0 -> material 0!
        FeedbackEntry {
            tile_x: 9,
            tile_y: 0,
            mip_level: 0,
            frame_number: 1,
        }, // x out of bounds (4 pages)
        FeedbackEntry {
            tile_x: 0,
            tile_y: 0,
            mip_level: 9,
            frame_number: 1,
        }, // mip out of range
        FeedbackEntry {
            tile_x: 0,
            tile_y: 0,
            mip_level: 0,
            frame_number: 3,
        }, // material 2 -> no source
    ]);
    // entry1 ok; entry2 material 0 (0-1 saturates to 0) ok; entry3/4/5 filtered.
    assert_eq!(rt.pending_feedback().len(), 2);
    assert_eq!(rt.stats().feedback_requests, 2);
    assert!(rt.pending_feedback().contains(&TileKey {
        material_index: 0,
        x: 1,
        y: 1,
        mip_level: 0
    }));
    assert!(rt.pending_feedback().contains(&TileKey {
        material_index: 0,
        x: 0,
        y: 0,
        mip_level: 0
    }));
}

#[test]
fn test_record_upload_ms_running_average() {
    let (reg, layer, settings) = fixture();
    let mut rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    rt.ensure_resident(TileKey {
        material_index: 0,
        x: 0,
        y: 0,
        mip_level: 0,
    });
    rt.record_upload_ms(2.0);
    assert_eq!(rt.stats().last_upload_ms, 2.0);
    assert_eq!(rt.stats().avg_upload_ms, 2.0);
    rt.ensure_resident(TileKey {
        material_index: 0,
        x: 1,
        y: 0,
        mip_level: 0,
    });
    rt.record_upload_ms(4.0);
    assert_eq!(rt.stats().last_upload_ms, 4.0);
    assert_eq!(rt.stats().avg_upload_ms, 3.0);
    // reset_frame_stats clears them.
    rt.reset_frame_stats(1.0);
    assert_eq!(rt.stats().last_upload_ms, 0.0);
    assert_eq!(rt.stats().avg_upload_ms, 0.0);
    assert_eq!(rt.stats().cache_budget_mb, 1.0);
}

#[test]
fn test_budget_never_exceeded_under_camera_sweep() {
    let (reg, layer, settings) = fixture();
    let mut rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    // total_pages 21 > budget 4.
    assert!(rt.stats().total_pages > rt.stats().cache_budget_pages);
    let mut saw_eviction = false;
    for tx in [-4.0, -2.0, 0.0, 2.0, 4.0] {
        for ty in [-4.0, 0.0, 4.0] {
            let params = VtViewParams {
                camera_mode: "mesh".to_string(),
                cam_target: [tx, ty, 0.0],
                ..VtViewParams::default()
            };
            let requests = rt.collect_requests(&params, 224, 160, true);
            for key in requests {
                if rt.ensure_resident(key).is_some() {
                    rt.record_upload_ms(0.01);
                }
            }
            let s = rt.stats();
            assert!(
                s.resident_pages <= s.cache_budget_pages,
                "budget exceeded: {} > {}",
                s.resident_pages,
                s.cache_budget_pages
            );
            saw_eviction |= s.evictions > 0;
        }
    }
    assert!(saw_eviction, "expected evictions under camera sweep");
}

#[test]
fn test_visible_uv_rect_mesh_vs_screen() {
    let (reg, layer, settings) = fixture();
    let rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    // Screen mode -> full rect.
    let (mn, mx) = rt.native_visible_uv_rect(&VtViewParams::default());
    assert_eq!(mn, [0.0, 0.0]);
    assert_eq!(mx, [1.0, 1.0]);
    // Mesh mode centered -> clamped rect around 0.5.
    let params = VtViewParams {
        camera_mode: "mesh".to_string(),
        size_px: (224, 160),
        cam_target: [0.0, 0.0, 0.0],
        terrain_span: 8.0,
        cam_radius: 4.0,
        fov_y_deg: 50.0,
    };
    let (mn, mx) = rt.native_visible_uv_rect(&params);
    assert!(mn[0] >= 0.0 && mx[0] <= 1.0);
    assert!(mn[0] < 0.5 && mx[0] > 0.5);
    // aspect > 1 -> wider uv span in u than v.
    assert!(mx[0] - mn[0] >= mx[1] - mn[1]);
    // Far-off camera clamps to edges.
    let params = VtViewParams {
        cam_target: [100.0, 100.0, 0.0],
        ..params
    };
    let (_mn, mx) = rt.native_visible_uv_rect(&params);
    assert_eq!(mx, [1.0, 1.0]);
}

#[test]
fn test_target_mip_level() {
    let (reg, layer, settings) = fixture();
    let rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    // Full 256x256 virtual over 256x256 render -> 1 texel/px -> mip 0.
    let mip = rt.target_mip_level(&VtViewParams::default(), 256, 256);
    assert_eq!(mip, 0);
    // Full extent over 64x64 render -> 4 texel/px -> log2=2 -> clamp to max-1=2.
    let mip = rt.target_mip_level(&VtViewParams::default(), 64, 64);
    assert_eq!(mip, 2);
    // 32x32 -> 8 texel/px -> log2 3 -> clamp to 2.
    let mip = rt.target_mip_level(&VtViewParams::default(), 32, 32);
    assert_eq!(mip, 2);
}

#[test]
fn test_fallback_colors() {
    let (reg, layer, settings) = fixture();
    let rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    let colors = rt.fallback_colors(layer.fallback);
    assert_eq!(colors[0], [0.25, 0.5, 0.75, 1.0]); // source fallback
    assert_eq!(colors[1], layer.fallback);
    assert_eq!(colors[2], layer.fallback);
    assert_eq!(colors[3], layer.fallback);
}

#[test]
fn test_vtstats_default_disabled() {
    let s = VtStats::default();
    assert_eq!(s.resident_pages, 0);
    assert_eq!(s.total_pages, 0);
    assert_eq!(s.miss_rate, 0.0);
}

#[test]
fn test_runtime_resident_megabytes() {
    let (reg, layer, settings) = fixture();
    let mut rt = VtRuntimeState::new(&reg, &layer, &settings, 4).unwrap();
    rt.ensure_resident(TileKey {
        material_index: 0,
        x: 0,
        y: 0,
        mip_level: 0,
    });
    let s = rt.stats();
    assert_eq!(s.resident_pages, 1);
    // 64*64*4 = 16384 bytes = 0.015625 MiB.
    assert!((s.resident_megabytes - 16384.0 / (1024.0 * 1024.0)).abs() < 1e-6);
}

#[test]
fn test_vt_atlas_larger_than_the_device_dimension_is_resource_limit_exceeded() {
    let settings = TerrainVtSettings {
        enabled: true,
        atlas_size: 16384,
        ..TerrainVtSettings::default()
    };
    settings.validate().unwrap();
    match settings.validate_atlas_dimension(8192).unwrap_err() {
        Forge3dError::ResourceLimitExceeded { resource, message } => {
            assert_eq!(resource, "terrain.vt");
            assert!(message.contains("maxTextureDimension2D 8192"), "{message}");
        }
        other => panic!("expected ResourceLimitExceeded, got {other:?}"),
    }
    settings.validate_atlas_dimension(16384).unwrap();
}
