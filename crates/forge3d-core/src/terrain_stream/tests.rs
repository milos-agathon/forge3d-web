//! W08/T08 terrain_stream tests — ports of native tiling / async loader /
//! COG streaming assertions that apply GPU-free (B1–B5).

use super::*;

use crate::terrain_clipmap::{ClipmapConfig, ClipmapLayout};

fn fixture_pyramid() -> HeightPyramid {
    // Native fixture convention: 16385x16385, T = 256.
    HeightPyramid::new(16385, 16385, 256).unwrap()
}

// ---------------------------------------------------------------- TileId --

#[test]
fn test_tile_id_hierarchy() {
    // W08 convention: lod 0 finest; parent is coarser at lod+1.
    let parent = TileId::new(1, 0, 0);
    let children = parent.children().unwrap();
    assert_eq!(children[0], TileId::new(0, 0, 0));
    assert_eq!(children[1], TileId::new(0, 1, 0));
    assert_eq!(children[2], TileId::new(0, 0, 1));
    assert_eq!(children[3], TileId::new(0, 1, 1));
    assert_eq!(children[0].parent().unwrap(), parent);
    assert!(TileId::new(0, 3, 5).children().is_none());
    // The id itself always returns parent coords (pyramid decides the top).
    assert_eq!(TileId::new(7, 0, 0).parent().unwrap(), TileId::new(8, 0, 0));
}

#[test]
fn test_tile_id_descendant() {
    let coarse = TileId::new(2, 4, 4);
    let fine = TileId::new(0, 16, 17); // inside (2,4,4): 16>>2=4, 17>>2=4
    let outside = TileId::new(0, 17, 17); // 17>>2=4 x, 17>>2=4 y -> inside!
    assert!(fine.is_descendant_of(&coarse));
    assert!(outside.is_descendant_of(&coarse));
    assert!(!TileId::new(0, 15, 16).is_descendant_of(&coarse));
    assert!(!coarse.is_descendant_of(&fine));
    assert!(!coarse.is_descendant_of(&coarse));
}

#[test]
fn test_tile_id_pack() {
    let id = TileId::new(3, 0xABC, 0x00F);
    assert_eq!(id.pack(), (3 << 24) | (0xABC << 12) | 0x00F);
    assert_eq!(TileId::unpack(id.pack()), id);
    assert_eq!(TileId::new(0, 0, 0).pack(), 0);
    assert_eq!(
        TileId::unpack(TileId::new(9, 400, 17).pack()),
        TileId::new(9, 400, 17)
    );
}

// ------------------------------------------------------------ pyramid ----

#[test]
fn test_pyramid_validation() {
    assert!(HeightPyramid::new(1, 10, 256).is_err());
    assert!(HeightPyramid::new(10, 0, 256).is_err());
    assert!(HeightPyramid::new(100, 100, 8).is_err());
    assert!(HeightPyramid::new(100, 100, 15).is_err());
    assert!(HeightPyramid::new(100, 100, 16).is_ok());
}

#[test]
fn test_pyramid_fixture_dims() {
    let p = fixture_pyramid();
    assert_eq!(p.lod_count(), 8);
    assert_eq!(p.dims(0), (16385, 16385));
    assert_eq!(p.dims(1), (8193, 8193)); // ceil(16385/2)
    assert_eq!(p.dims(6), (257, 257));
    assert_eq!(p.dims(7), (129, 129)); // fits one 256 tile
    assert_eq!(p.tiles_at(0), (65, 65));
    assert_eq!(p.tiles_at(7), (1, 1));
    assert_eq!(p.tiles_at(6), (2, 2)); // 257 -> 2 tiles
}

#[test]
fn test_pyramid_tile_rect_clipped_at_edge() {
    let p = fixture_pyramid();
    assert_eq!(p.tile_rect(TileId::new(0, 0, 0)), (0, 0, 256, 256));
    // Edge tile: 65*256 = 16640 > 16385; last tile is clipped to 129.
    assert_eq!(p.tile_rect(TileId::new(0, 64, 64)), (16384, 16384, 1, 1));
    assert_eq!(p.tile_rect(TileId::new(6, 1, 0)), (256, 0, 1, 256));
}

#[test]
fn test_pyramid_contains_and_parent_of() {
    let p = fixture_pyramid();
    assert!(p.contains(TileId::new(0, 64, 64)));
    assert!(!p.contains(TileId::new(0, 65, 0)));
    assert!(!p.contains(TileId::new(8, 0, 0)));
    assert_eq!(
        p.parent_of(TileId::new(0, 64, 64)),
        Some(TileId::new(1, 32, 32))
    );
    assert_eq!(p.parent_of(TileId::new(7, 0, 0)), None); // top of pyramid
}

#[test]
fn test_pyramid_total_and_finest_sample() {
    let p = HeightPyramid::new(512, 512, 256).unwrap();
    // dims(1) = 256 <= 256 -> lod_count 2.
    assert_eq!(p.lod_count(), 2);
    // tiles: lod0 2x2 + lod1 1x1 = 5.
    assert_eq!(p.total_tiles(), 5);
    assert_eq!(p.finest_sample(1, 10, 20), (20, 40));
    assert_eq!(p.finest_sample(7, 100, 100), (511, 511)); // clamped
}

// ------------------------------------------------------------- mosaic ----

fn mosaic(capacity: u32) -> HeightMosaic {
    let p = HeightPyramid::new(512, 512, 64).unwrap();
    HeightMosaic::new(p, capacity).unwrap()
}

#[test]
fn test_mosaic_capacity_check() {
    let p = HeightPyramid::new(512, 512, 64).unwrap();
    assert_eq!(p.lod_count(), 4); // dims(3)=64<=64
    assert!(HeightMosaic::new(p.clone(), 0).is_err());
    assert!(HeightMosaic::new(p, 1).is_ok()); // coarsest lod = 1 tile
}

#[test]
fn test_mosaic_pin_coarsest_required() {
    let mut m = mosaic(4);
    // Finer insert before pin_coarsest fails.
    assert!(m.insert(TileId::new(0, 0, 0)).is_err());
    m.pin_coarsest().unwrap();
    assert!(m.is_pinned(TileId::new(3, 0, 0)));
    assert!(m.insert(TileId::new(0, 0, 0)).is_ok());
}

#[test]
fn test_mosaic_insert_lookup_evict() {
    let mut m = mosaic(3); // 1 pinned + 2 free
    m.pin_coarsest().unwrap();
    let a = TileId::new(0, 0, 0);
    let b = TileId::new(0, 1, 0);
    let c = TileId::new(0, 0, 1);
    let oa = m.insert(a).unwrap();
    assert_eq!(oa.evicted, None);
    let ob = m.insert(b).unwrap();
    assert_eq!(ob.slot, oa.slot + 1);
    // Existing insert returns same slot.
    let oa2 = m.insert(a).unwrap();
    assert_eq!(oa2.slot, oa.slot);
    // Third new tile evicts the LRU unpinned tile not touched this frame.
    // a and b are both in-use (insert marks them); begin_frame clears.
    // The re-insert of `a` above refreshed its LRU order, so `b` is LRU.
    m.begin_frame();
    let oc = m.insert(c).unwrap();
    assert_eq!(oc.evicted, Some(b));
    assert!(m.lookup(b).is_none());
    assert_eq!(m.lookup(c), Some(ob.slot));
    assert_eq!(m.stats().evictions, 1);
}

#[test]
fn test_mosaic_backpressure() {
    let mut m = mosaic(2); // 1 pinned + 1 free
    m.pin_coarsest().unwrap();
    let a = TileId::new(0, 0, 0);
    m.insert(a).unwrap();
    // a is in-use this frame -> nothing evictable.
    assert!(m.insert(TileId::new(0, 1, 0)).is_err());
    assert_eq!(m.stats().full_rejections, 1);
    // Next frame: a no longer in-use -> eviction succeeds.
    m.begin_frame();
    assert!(m.insert(TileId::new(0, 1, 0)).is_ok());
}

#[test]
fn test_mosaic_pinned_never_evicted() {
    let mut m = mosaic(1); // only the pinned coarsest tile fits
    m.pin_coarsest().unwrap();
    assert!(m.insert(TileId::new(0, 0, 0)).is_err()); // backpressure
    assert!(m.lookup(TileId::new(3, 0, 0)).is_some()); // pinned resident
    assert!(!m.remove(TileId::new(3, 0, 0))); // pinned
}

#[test]
fn test_mosaic_page_table_and_dirty_lods() {
    let mut m = mosaic(9);
    m.pin_coarsest().unwrap();
    let t = TileId::new(0, 1, 2);
    m.begin_frame();
    m.take_dirty_lods();
    let out = m.insert(t).unwrap();
    let pt = m.page_table(0);
    // 512/64 = 8 tiles per side at lod 0.
    assert_eq!(pt.len(), 64);
    assert_eq!(pt[(2 * 8 + 1) as usize], out.slot + 1);
    assert_eq!(m.take_dirty_lods(), vec![0]);
}

#[test]
fn test_mosaic_dirty_lods_scope() {
    let mut m = mosaic(9);
    m.pin_coarsest().unwrap();
    assert_eq!(m.take_dirty_lods(), vec![3]); // coarsest lod marked
    m.insert(TileId::new(0, 0, 0)).unwrap();
    m.insert(TileId::new(1, 0, 0)).unwrap();
    assert_eq!(m.take_dirty_lods(), vec![0, 1]);
    assert!(m.take_dirty_lods().is_empty());
}

#[test]
fn test_mosaic_bytes_and_slot_origin() {
    let m = mosaic(10);
    // tile_size 64 -> 64*64*4 = 16384 bytes per slot.
    assert_eq!(m.capacity_bytes(), 10 * 16384);
    assert_eq!(m.slot_origin(7, 3), (64, 128));
}

#[test]
fn test_mosaic_resolve_fallback_chain() {
    let mut m = mosaic(16);
    m.pin_coarsest().unwrap();
    // Only the coarsest tile resident: resolve finds it from lod 0 texels.
    let found = m.resolve(0, 300, 100);
    assert!(found.is_some());
    let (lod, _slot) = found.unwrap();
    assert_eq!(lod, 3);
    assert_eq!(m.stats().hits, 1);
    // Insert a mid-level tile covering texel range.
    let mid = TileId::new(2, 0, 0);
    m.insert(mid).unwrap();
    let (lod, _slot) = m.resolve(0, 10, 10).unwrap();
    assert_eq!(lod, 2); // finest resident at-or-above lod
}

#[test]
fn test_mosaic_resident_bytes() {
    let mut m = mosaic(4);
    m.pin_coarsest().unwrap();
    assert_eq!(m.resident_count(), 1);
    assert_eq!(m.resident_bytes(), 64 * 64 * 4);
}

// -------------------------------------------------------------- queue ----

#[test]
fn test_queue_prefer_coarse() {
    let mut q = TileRequestQueue::new(8, CoalescePolicy::PreferCoarse);
    let fine = TileId::new(0, 8, 8);
    let coarse = TileId::new(2, 2, 2);
    assert_eq!(q.request(coarse), RequestOutcome::Enqueued);
    // Finer request while a pending coarser ancestor exists -> dropped.
    assert_eq!(q.request(fine), RequestOutcome::DroppedByPolicy);
    // Re-request of pending tile -> deduplicated.
    assert_eq!(q.request(coarse), RequestOutcome::Deduplicated);
    // Request the coarser ancestor of the pending fine tile cancels it.
    assert_eq!(q.request(fine), RequestOutcome::DroppedByPolicy);
    let other_fine = TileId::new(0, 9, 9);
    assert_eq!(q.request(other_fine), RequestOutcome::DroppedByPolicy);
}

#[test]
fn test_queue_prefer_coarse_cancels_descendants() {
    let mut q = TileRequestQueue::new(8, CoalescePolicy::PreferCoarse);
    let fine = TileId::new(0, 8, 8);
    let coarse = TileId::new(2, 2, 2);
    assert_eq!(q.request(fine), RequestOutcome::Enqueued);
    // Coarser ancestor request: enqueued, pending fine tile cancelled.
    assert_eq!(q.request(coarse), RequestOutcome::Enqueued);
    assert!(q.pending().contains(&coarse));
    assert!(!q.pending().contains(&fine));
    assert!(q.cancelled().contains(&fine));
    // Completing the cancelled tile discards the result.
    assert_eq!(q.complete(fine), Completion::Discarded);
    assert_eq!(q.complete(coarse), Completion::Accepted);
    let c = q.counters();
    assert_eq!(c.requests, 2);
    assert_eq!(c.enqueued, 2);
    assert_eq!(c.canceled, 1);
    assert_eq!(c.completed, 1);
}

#[test]
fn test_queue_prefer_fine() {
    let mut q = TileRequestQueue::new(8, CoalescePolicy::PreferFine);
    let fine = TileId::new(0, 8, 8);
    let coarse = TileId::new(2, 2, 2);
    assert_eq!(q.request(coarse), RequestOutcome::Enqueued);
    // Finer request while coarser pending -> enqueued, ancestor cancelled.
    assert_eq!(q.request(fine), RequestOutcome::Enqueued);
    assert!(q.pending().contains(&fine));
    assert!(!q.pending().contains(&coarse));
    assert!(q.cancelled().contains(&coarse));
    assert_eq!(q.complete(coarse), Completion::Discarded);
    // New coarse request while fine pending -> dropped.
    assert_eq!(q.request(coarse), RequestOutcome::DroppedByPolicy);
}

#[test]
fn test_queue_backpressure() {
    let mut q = TileRequestQueue::new(2, CoalescePolicy::PreferCoarse);
    assert_eq!(q.request(TileId::new(0, 0, 0)), RequestOutcome::Enqueued);
    assert_eq!(q.request(TileId::new(0, 1, 0)), RequestOutcome::Enqueued);
    assert_eq!(
        q.request(TileId::new(0, 2, 0)),
        RequestOutcome::Backpressure
    );
    assert_eq!(q.counters().backpressure, 1);
    // Completing frees a slot.
    assert_eq!(q.complete(TileId::new(0, 0, 0)), Completion::Accepted);
    assert_eq!(q.request(TileId::new(0, 2, 0)), RequestOutcome::Enqueued);
}

#[test]
fn test_queue_cancel_and_reacquire() {
    let mut q = TileRequestQueue::new(4, CoalescePolicy::PreferCoarse);
    let a = TileId::new(0, 0, 0);
    let b = TileId::new(0, 1, 0);
    q.request(a);
    q.request(b);
    assert_eq!(q.cancel(&[a]), 1);
    assert!(!q.pending().contains(&a));
    // Re-request clears the cancelled mark.
    assert_eq!(q.request(a), RequestOutcome::Enqueued);
    assert!(!q.cancelled().contains(&a));
    // Cancelling a non-pending id counts nothing.
    assert_eq!(q.cancel(&[TileId::new(5, 0, 0)]), 0);
}

#[test]
fn test_queue_counters() {
    let mut q = TileRequestQueue::new(2, CoalescePolicy::PreferCoarse);
    // Non-related tiles (PreferCoarse would coalesce/cancel related ones).
    q.request(TileId::new(0, 0, 0));
    q.request(TileId::new(0, 0, 0)); // dedupe
    q.request(TileId::new(0, 100, 0));
    q.request(TileId::new(0, 200, 0)); // backpressure (2 pending)
    let c = q.counters();
    assert_eq!(c.requests, 4);
    assert_eq!(c.enqueued, 2);
    assert_eq!(c.deduplicated, 1);
    assert_eq!(c.backpressure, 1);
    assert_eq!(c.dropped_by_policy, 0);
}

// ---------------------------------------------------------- planning ----

#[test]
fn test_data_lod_for_ring() {
    let p = fixture_pyramid();
    let plan = StreamPlanConfig {
        lod_bias: 0,
        prefetch_margin_tiles: 1,
    };
    assert_eq!(data_lod_for_ring(0, &plan, &p), 0);
    assert_eq!(data_lod_for_ring(3, &plan, &p), 3);
    assert_eq!(data_lod_for_ring(30, &plan, &p), 7); // clamped top
    let biased = StreamPlanConfig {
        lod_bias: 2,
        prefetch_margin_tiles: 1,
    };
    assert_eq!(data_lod_for_ring(0, &biased, &p), 2);
    let negative = StreamPlanConfig {
        lod_bias: -5,
        prefetch_margin_tiles: 1,
    };
    assert_eq!(data_lod_for_ring(2, &negative, &p), 0); // clamped low
}

#[test]
fn test_plan_clipmap_requests_deterministic() {
    let config = ClipmapConfig::new(2, 32, 32, 10.0, 0.3).unwrap();
    let s0 = 1.0f32;
    let layout = ClipmapLayout::for_camera(&config, s0, [0.0, 0.0], [0.0, 0.0]);
    let pyramid = HeightPyramid::new(4096, 4096, 256).unwrap();
    let placement = HeightfieldPlacement {
        origin: [-2048.0, -2048.0],
        spacing: [1.0, 1.0],
    };
    let plan = StreamPlanConfig {
        lod_bias: 0,
        prefetch_margin_tiles: 1,
    };
    let a = plan_clipmap_requests(&layout, &config, &pyramid, &placement, &plan);
    let b = plan_clipmap_requests(&layout, &config, &pyramid, &placement, &plan);
    assert_eq!(a, b);
    assert!(!a.is_empty());
    // Sorted by (priority, pack()).
    for w in a.windows(2) {
        assert!(
            w[0].priority < w[1].priority
                || (w[0].priority == w[1].priority && w[0].id.pack() < w[1].id.pack())
        );
    }
    // Ring-0 non-prefetch tiles come before ring-1 and before prefetch.
    let r0: Vec<_> = a.iter().filter(|t| t.ring == 0 && !t.prefetch).collect();
    let prefetches: Vec<_> = a.iter().filter(|t| t.prefetch).collect();
    assert!(!r0.is_empty());
    assert!(!prefetches.is_empty());
    assert!(r0.iter().all(|t| t.priority < 1e6));
    assert!(prefetches.iter().all(|t| t.priority >= 1e9));
    // Deduplicated ids.
    let mut ids: Vec<u32> = a.iter().map(|t| t.id.pack()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), a.len());
}

#[test]
fn test_plan_clipmap_requests_cover_footprint() {
    // One ring, footprint = (Hc+R)*s0 centered on origin: M0=48 -> 48 units.
    let config = ClipmapConfig::new(1, 32, 32, 10.0, 0.3).unwrap();
    let layout = ClipmapLayout::for_camera(&config, 1.0, [0.0, 0.0], [0.0, 0.0]);
    // Heightfield 512x512 at spacing 4 world units/sample; origin chosen so
    // the 96-unit footprint lands entirely inside lod-0 tile (4,4)
    // (world 0 -> sample 288).
    let pyramid = HeightPyramid::new(512, 512, 64).unwrap();
    let placement = HeightfieldPlacement {
        origin: [-1152.0, -1152.0],
        spacing: [4.0, 4.0],
    };
    let plan = StreamPlanConfig {
        lod_bias: 0,
        prefetch_margin_tiles: 1,
    };
    let tiles = plan_clipmap_requests(&layout, &config, &pyramid, &placement, &plan);
    assert!(tiles.iter().all(|t| t.id.lod == 0));
    let base: Vec<_> = tiles.iter().filter(|t| !t.prefetch).collect();
    // Footprint 96 world units -> 24 samples -> exactly 1 tile at lod 0
    // (margin adds the 8 neighbours, all inside the 8x8 grid).
    assert_eq!(base.len(), 1);
    assert_eq!(base[0].id, TileId::new(0, 4, 4));
    assert_eq!(tiles.len(), 9); // 1 + 8 prefetch neighbours
}
