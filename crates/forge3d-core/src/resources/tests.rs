use super::{
    mip_level_count, select_transcode_fallback, texture_byte_size, texture_format_info,
    ChunkedBuffer, DoubleBuffer, RenderBundleCache, StagingRing,
};
use crate::error::Forge3dError;

#[test]
fn staging_ring_wraps_and_stalls_until_fence_completes() {
    let mut ring = StagingRing::new(2, 64).unwrap();

    let first = ring.allocate(64, 1, 0).unwrap();
    assert_eq!((first.ring_index, first.offset, first.size), (0, 0, 64));
    ring.submit_current(1).unwrap();

    let second = ring.allocate(64, 1, 0).unwrap();
    assert_eq!(second.ring_index, 1);
    ring.submit_current(2).unwrap();

    assert!(matches!(
        ring.allocate(8, 1, 0),
        Err(Forge3dError::ResourceLimitExceeded { .. })
    ));
    assert_eq!(ring.stats().stalls, 1);
    assert_eq!(ring.stats().bytes_in_flight, 128);

    let third = ring.allocate(16, 1, 1).unwrap();
    assert_eq!(third.ring_index, 0);
    assert_eq!(ring.stats().bytes_in_flight, 64);

    ring.submit_current(3).unwrap();
    assert_eq!(ring.stats().bytes_in_flight, 80);
}

#[test]
fn staging_ring_validates_arguments() {
    assert!(matches!(
        StagingRing::new(0, 64),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        StagingRing::new(2, 0),
        Err(Forge3dError::InvalidInput { .. })
    ));

    let mut ring = StagingRing::new(1, 64).unwrap();
    assert!(matches!(
        ring.allocate(0, 1, 0),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        ring.allocate(8, 0, 0),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        ring.allocate(8, 3, 0),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        ring.allocate(128, 1, 0),
        Err(Forge3dError::ResourceLimitExceeded { .. })
    ));
}

#[test]
fn staging_ring_respects_alignment() {
    let mut ring = StagingRing::new(1, 128).unwrap();
    let first = ring.allocate(10, 1, 0).unwrap();
    assert_eq!(first.offset, 0);
    let second = ring.allocate(8, 16, 0).unwrap();
    assert_eq!(second.offset, 16);
}

#[test]
fn chunked_buffer_fills_chunks_and_applies_backpressure() {
    let mut buffer = ChunkedBuffer::new(64, 2).unwrap();
    let a = buffer.allocate(40, 1).unwrap();
    assert_eq!((a.chunk, a.offset, a.size), (0, 0, 40));
    let b = buffer.allocate(16, 8).unwrap();
    assert_eq!((b.chunk, b.offset), (0, 40));
    let c = buffer.allocate(8, 1).unwrap();
    assert_eq!((c.chunk, c.offset), (0, 56));
    let d = buffer.allocate(64, 1).unwrap();
    assert_eq!((d.chunk, d.offset), (1, 0));

    assert!(matches!(
        buffer.allocate(1, 1),
        Err(Forge3dError::ResourceLimitExceeded { .. })
    ));
    assert!(matches!(
        buffer.allocate(128, 1),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert_eq!(buffer.allocated_bytes(), 128);

    buffer.reset();
    assert_eq!(buffer.allocated_bytes(), 0);
    let e = buffer.allocate(64, 1).unwrap();
    assert_eq!((e.chunk, e.offset), (0, 0));
}

#[test]
fn chunked_buffer_validates_arguments() {
    assert!(matches!(
        ChunkedBuffer::new(0, 2),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        ChunkedBuffer::new(64, 0),
        Err(Forge3dError::InvalidInput { .. })
    ));
    let mut buffer = ChunkedBuffer::new(64, 1).unwrap();
    assert!(matches!(
        buffer.allocate(0, 1),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        buffer.allocate(8, 6),
        Err(Forge3dError::InvalidInput { .. })
    ));
}

#[test]
fn double_buffer_swaps_front_and_back() {
    let mut buffer = DoubleBuffer::new(String::from("a"), String::from("b"));
    assert_eq!(buffer.front(), "a");
    buffer.back_mut().push('!');
    buffer.swap();
    assert_eq!(buffer.front(), "b!");
    buffer.back_mut().push('?');
    buffer.swap();
    assert_eq!(buffer.front(), "a?");
}

#[test]
fn bundle_cache_insert_replace_remove() {
    let mut cache = RenderBundleCache::new();
    assert!(cache.insert("main", 1u32).is_none());
    assert_eq!(cache.insert("main", 2), Some(1));
    assert_eq!(cache.get("main"), Some(&2));
    assert_eq!(cache.len(), 1);
    assert_eq!(cache.remove("main"), Some(2));
    assert!(cache.get("main").is_none());
    cache.insert("a", 1);
    cache.clear();
    assert_eq!(cache.len(), 0);
}

#[test]
fn texture_format_info_covers_block_formats() {
    let rgba = texture_format_info(wgpu::TextureFormat::Rgba8Unorm).unwrap();
    assert_eq!(
        (
            rgba.bytes_per_block,
            rgba.block_width,
            rgba.block_height,
            rgba.compressed
        ),
        (4, 1, 1, false)
    );

    let bc1 = texture_format_info(wgpu::TextureFormat::Bc1RgbaUnormSrgb).unwrap();
    assert_eq!(
        (
            bc1.bytes_per_block,
            bc1.block_width,
            bc1.block_height,
            bc1.compressed
        ),
        (8, 4, 4, true)
    );

    let bc7 = texture_format_info(wgpu::TextureFormat::Bc7RgbaUnorm).unwrap();
    assert_eq!((bc7.bytes_per_block, bc7.compressed), (16, true));

    let etc2 = texture_format_info(wgpu::TextureFormat::Etc2Rgba8Unorm).unwrap();
    assert_eq!(
        (etc2.bytes_per_block, etc2.block_width, etc2.block_height),
        (16, 4, 4)
    );

    assert!(texture_format_info(wgpu::TextureFormat::Depth32Float).is_none());
}

#[test]
fn compressed_texture_size_rounds_up_odd_dimensions() {
    let size = texture_byte_size(wgpu::TextureFormat::Bc1RgbaUnorm, 5, 3, 1).unwrap();
    assert_eq!(size, 16);

    let etc = texture_byte_size(wgpu::TextureFormat::Etc2Rgb8Unorm, 4, 4, 1).unwrap();
    assert_eq!(etc, 8);
}

#[test]
fn texture_byte_size_sums_all_mips() {
    let size = texture_byte_size(wgpu::TextureFormat::Rgba8Unorm, 4, 4, 3).unwrap();
    assert_eq!(size, 64 + 16 + 4);

    let single = texture_byte_size(wgpu::TextureFormat::Rgba32Float, 2, 2, 1).unwrap();
    assert_eq!(single, 64);

    assert!(matches!(
        texture_byte_size(wgpu::TextureFormat::Rgba8Unorm, 0, 4, 1),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        texture_byte_size(wgpu::TextureFormat::Rgba8Unorm, 4, 4, 0),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        texture_byte_size(wgpu::TextureFormat::Depth32Float, 4, 4, 1),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        texture_byte_size(wgpu::TextureFormat::Rgba32Float, u32::MAX, u32::MAX, 1),
        Err(Forge3dError::InvalidInput { .. })
    ));
}

#[test]
fn texture_byte_size_rejects_mip_levels_beyond_chain() {
    assert!(matches!(
        texture_byte_size(wgpu::TextureFormat::Rgba8Unorm, 4, 4, 4),
        Err(Forge3dError::InvalidInput { .. })
    ));
    assert!(matches!(
        texture_byte_size(wgpu::TextureFormat::Rgba8Unorm, 4, 4, u32::MAX),
        Err(Forge3dError::InvalidInput { .. })
    ));
}

#[test]
fn mip_level_count_uses_max_dimension() {
    assert_eq!(mip_level_count(1, 1).unwrap(), 1);
    assert_eq!(mip_level_count(4, 4).unwrap(), 3);
    assert_eq!(mip_level_count(256, 128).unwrap(), 9);
    assert!(matches!(
        mip_level_count(0, 4),
        Err(Forge3dError::InvalidInput { .. })
    ));
}

#[test]
fn transcode_fallback_prefers_bc7_then_etc2_then_rgba8() {
    let all = [
        wgpu::TextureFormat::Rgba8UnormSrgb,
        wgpu::TextureFormat::Etc2Rgba8UnormSrgb,
        wgpu::TextureFormat::Bc7RgbaUnormSrgb,
    ];
    assert_eq!(
        select_transcode_fallback(&all, true),
        Some(wgpu::TextureFormat::Bc7RgbaUnormSrgb)
    );

    let no_bc7 = [
        wgpu::TextureFormat::Rgba8UnormSrgb,
        wgpu::TextureFormat::Etc2Rgba8UnormSrgb,
    ];
    assert_eq!(
        select_transcode_fallback(&no_bc7, true),
        Some(wgpu::TextureFormat::Etc2Rgba8UnormSrgb)
    );

    let only_rgba = [wgpu::TextureFormat::Rgba8UnormSrgb];
    assert_eq!(
        select_transcode_fallback(&only_rgba, true),
        Some(wgpu::TextureFormat::Rgba8UnormSrgb)
    );

    let linear = [
        wgpu::TextureFormat::Bc7RgbaUnorm,
        wgpu::TextureFormat::Etc2Rgba8Unorm,
    ];
    assert_eq!(
        select_transcode_fallback(&linear, false),
        Some(wgpu::TextureFormat::Bc7RgbaUnorm)
    );

    let srgb_only = [wgpu::TextureFormat::Bc7RgbaUnormSrgb];
    assert_eq!(select_transcode_fallback(&srgb_only, false), None);
    assert_eq!(select_transcode_fallback(&[], true), None);
}
