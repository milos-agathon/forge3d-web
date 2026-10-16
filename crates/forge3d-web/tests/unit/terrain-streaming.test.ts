// W08 (F4/F5): TerrainStreamer + HeightTileSource against a fake
// runtime implementing the wasm streaming contract — commit shape,
// fetch/upload flow, upload bound, cancellation, failure handling,
// convergence, and cache-backed replay without refetch.

import { describe, expect, it, vi } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type {
  HeightStreamingStats,
  HeightTilePlan,
  TerrainHeightmapInput,
} from "../../src-ts/index.js";
import type { TerrainStreamerTarget } from "../../src-ts/terrain-streaming.js";
import {
  ArrayHeightSource,
  FunctionHeightSource,
  heightPyramidLodCount,
  TerrainStreamer,
} from "../../src-ts/terrain-streaming.js";

interface ReadCall {
  lod: number;
  x: number;
  y: number;
  signal?: AbortSignal;
  priority?: number;
}

class FakeRuntime implements TerrainStreamerTarget {
  terrain: TerrainHeightmapInput | undefined;
  planned: HeightTilePlan[] = [];
  completions: { lod: number; x: number; y: number; heights: Float32Array }[] =
    [];
  failures: { lod: number; x: number; y: number }[] = [];
  renders = 0;
  converged = false;

  queuePlan(plan: HeightTilePlan): void {
    this.planned.push(plan);
  }

  setTerrain(terrain: TerrainHeightmapInput): void {
    this.terrain = terrain;
  }

  planHeightTiles(_maxRequests: number): HeightTilePlan {
    return this.planned.shift() ?? { requests: [], cancelled: [] };
  }

  completeHeightTile(
    lod: number,
    x: number,
    y: number,
    heights: Float32Array,
  ): { accepted: boolean; evicted: null } {
    this.completions.push({ lod, x, y, heights });
    return { accepted: true, evicted: null };
  }

  failHeightTile(lod: number, x: number, y: number): void {
    this.failures.push({ lod, x, y });
  }

  getHeightStreamingStats(): HeightStreamingStats {
    return {
      enabled: true,
      center: [0, 0],
      lodCount: 4,
      tileSize: 32,
      residentTiles: this.completions.length,
      residentFineTiles: 0,
      residentHeightBytes: this.completions.length * 32 * 32 * 4,
      maxResidentBytes: 64 * 1024 * 1024,
      coarsePrefilled: true,
      tilesRequested: 0,
      tilesUploaded: this.completions.length,
      pending: 0,
      cancelled: 0,
      droppedByPolicy: 0,
      backpressure: 0,
      deduplicated: 0,
      failed: this.failures.length,
      evictions: 0,
      plannedTiles: 0,
      plannedResident: 0,
      converged: this.converged,
      lodSelection: { visibleTiles: 0, totalTriangles: 0, frame: 0 },
    };
  }

  requestRender(): void {
    this.renders += 1;
  }
}

function recordingSource(
  width: number,
  height: number,
  tileSize: number,
  fill: (lod: number, x: number, y: number) => number = () => 0,
) {
  const calls: ReadCall[] = [];
  const source = new FunctionHeightSource({
    width,
    height,
    tileSize,
    sample: fill,
  });
  const wrapped = {
    width,
    height,
    tileSize,
    calls,
    readTile(
      lod: number,
      x: number,
      y: number,
      options: { signal?: AbortSignal; priority?: number } = {},
    ): Promise<Float32Array> {
      calls.push({ lod, x, y, signal: options.signal, priority: options.priority });
      return source.readTile(lod, x, y, options);
    },
  };
  return wrapped;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("heightPyramidLodCount", () => {
  it("returns the smallest n whose coarsest level fits one tile", () => {
    expect(heightPyramidLodCount(64, 64, 32)).toBe(2);
    expect(heightPyramidLodCount(1025, 1025, 256)).toBe(4);
    expect(heightPyramidLodCount(16385, 16385, 256)).toBe(8);
    expect(heightPyramidLodCount(256, 256, 256)).toBe(1);
  });
});

describe("height sources", () => {
  it("ArrayHeightSource subsamples lod levels exactly", async () => {
    // 4x4 heights = row*4 + column.
    const heights = new Float32Array(16).map((_, i) => i);
    const source = new ArrayHeightSource(heights, 4, 4, 16);
    const lod0 = await source.readTile(0, 0, 0);
    expect(Array.from(lod0)).toEqual(Array.from(heights));
    const lod1 = await source.readTile(1, 0, 0);
    // lod 1 dims = 2x2; point subsample of (0,0),(2,0),(0,2),(2,2).
    expect(Array.from(lod1)).toEqual([0, 2, 8, 10]);
  });

  it("FunctionHeightSource clips edge tiles", async () => {
    const source = new FunctionHeightSource({
      width: 5,
      height: 5,
      tileSize: 16,
      sample: (lod, x, y) => lod * 100 + y * 10 + x,
    });
    const tile = await source.readTile(1, 0, 0);
    // lod 1 dims = ceil(5/2) = 3 per axis.
    expect(tile.length).toBe(9);
    expect(tile[0]).toBe(100);
    expect(tile[2 + 2 * 3]).toBe(100 + 20 + 2);
  });

  it("validates source dimensions and tile size", () => {
    expect(
      () => new ArrayHeightSource(new Float32Array(4), 1, 4, 16),
    ).toThrow(Forge3DError);
    expect(
      () => new ArrayHeightSource(new Float32Array(4), 2, 2, 8),
    ).toThrow(Forge3DError);
    expect(
      () => new ArrayHeightSource(new Float32Array(3), 2, 2, 16),
    ).toThrow(Forge3DError);
  });
});

describe("TerrainStreamer", () => {
  it("rejects targets missing the wasm streaming contract", async () => {
    const source = recordingSource(64, 64, 32);
    await expect(
      TerrainStreamer.create({} as never, source),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
    await expect(
      TerrainStreamer.create(
        { setTerrain() {} } as never,
        source,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
  });

  it("commits the coarse base with streaming enabled", async () => {
    const runtime = new FakeRuntime();
    const source = recordingSource(64, 64, 32, (lod, x, y) => lod + x + y);
    const streamer = await TerrainStreamer.create(runtime, source, {
      clipmap: { ringCount: 2, ringResolution: 8, centerResolution: 8 },
    });
    try {
      const terrain = runtime.terrain!;
      expect(terrain.width).toBe(32);
      expect(terrain.height).toBe(32);
      expect(terrain.geometry?.mode).toBe("clipmap");
      expect(terrain.geometry?.clipmap?.ringCount).toBe(2);
      expect(terrain.streaming).toMatchObject({
        width: 64,
        height: 64,
        tileSize: 32,
      });
      // Coarsest level (lod 1) read as the commit heights.
      const coarseReads = source.calls.filter((call) => call.lod === 1);
      expect(coarseReads.length).toBeGreaterThan(0);
      expect(terrain.heights!.length).toBe(32 * 32);
    } finally {
      streamer.dispose();
    }
  });

  it("fetches planned tiles and uploads them through completeHeightTile", async () => {
    const runtime = new FakeRuntime();
    const source = recordingSource(64, 64, 32, () => 5);
    runtime.queuePlan({
      requests: [
        { lod: 0, x: 0, y: 0, priority: -2, prefetch: false },
        { lod: 0, x: 1, y: 0, priority: 3, prefetch: true },
      ],
      cancelled: [],
    });
    const streamer = await TerrainStreamer.create(runtime, source);
    await flush();
    await streamer.update();
    await streamer.update();
    try {
      const tileReads = source.calls.filter(
        (call) => call.lod === 0,
      );
      expect(tileReads.length).toBe(2);
      // Source priority propagation from the plan.
      expect(tileReads[0]!.priority).toBe(-2);
      expect(
        runtime.completions.filter(
          (tile) => tile.lod === 0 && tile.x === 0 && tile.y === 0,
        ).length,
      ).toBe(1);
      expect(runtime.renders).toBeGreaterThan(0);
    } finally {
      streamer.dispose();
    }
  });

  it("bounds uploads per update", async () => {
    const runtime = new FakeRuntime();
    const source = recordingSource(128, 128, 32, () => 1);
    const requests = Array.from({ length: 6 }, (_, i) => ({
      lod: 0,
      x: i % 4,
      y: Math.floor(i / 4),
      priority: i,
      prefetch: false,
    }));
    runtime.queuePlan({ requests, cancelled: [] });
    const streamer = await TerrainStreamer.create(runtime, source, {
      maxUploadsPerFrame: 2,
    });
    await flush();
    // Each update drains at most 2 fetched tiles.
    await streamer.update();
    const first = runtime.completions.length;
    await streamer.update();
    const second = runtime.completions.length;
    expect(first).toBeLessThanOrEqual(2);
    expect(second - first).toBeLessThanOrEqual(2);
    streamer.dispose();
  });

  it("aborts in-flight fetches the runtime cancels", async () => {
    const runtime = new FakeRuntime();
    const aborted: AbortSignal[] = [];
    const source = {
      width: 64,
      height: 64,
      tileSize: 32,
      readTile(
        lod: number,
        _x: number,
        _y: number,
        options: { signal?: AbortSignal } = {},
      ): Promise<Float32Array> {
        if (lod === 1) {
          // Coarse commit read.
          return Promise.resolve(new Float32Array(32 * 32));
        }
        return new Promise<Float32Array>(() => {
          if (options.signal) aborted.push(options.signal);
        });
      },
    };
    const streamer = await TerrainStreamer.create(runtime, source);
    runtime.queuePlan({
      requests: [{ lod: 0, x: 0, y: 0, priority: 0, prefetch: false }],
      cancelled: [],
    });
    await streamer.update();
    expect(aborted.length).toBe(1);
    runtime.queuePlan({
      requests: [],
      cancelled: [{ lod: 0, x: 0, y: 0 }],
    });
    await streamer.update();
    expect(aborted[0]!.aborted).toBe(true);
    streamer.dispose();
  });

  it("reports fetch failures to failHeightTile without auto-retry", async () => {
    const runtime = new FakeRuntime();
    const onError = vi.fn();
    let attempted = 0;
    const source = {
      width: 64,
      height: 64,
      tileSize: 32,
      readTile(lod: number): Promise<Float32Array> {
        if (lod === 1) return Promise.resolve(new Float32Array(32 * 32));
        attempted += 1;
        return Promise.reject(new Error("network"));
      },
    };
    const streamer = await TerrainStreamer.create(runtime, source, {
      onError,
    });
    runtime.queuePlan({
      requests: [{ lod: 0, x: 0, y: 0, priority: 0, prefetch: false }],
      cancelled: [],
    });
    await streamer.update();
    await flush();
    await streamer.update();
    expect(attempted).toBe(1);
    expect(runtime.failures).toEqual([{ lod: 0, x: 0, y: 0 }]);
    expect(onError).toHaveBeenCalledTimes(1);
    // No automatic retry: the failed tile is not re-fetched on the
    // next update with an empty plan.
    await streamer.update();
    await flush();
    expect(attempted).toBe(1);
    streamer.dispose();
  });

  it("converges through whenConverged once stats report converged", async () => {
    const runtime = new FakeRuntime();
    const source = recordingSource(64, 64, 32);
    runtime.queuePlan({
      requests: [{ lod: 0, x: 0, y: 0, priority: 0, prefetch: false }],
      cancelled: [],
    });
    const streamer = await TerrainStreamer.create(runtime, source);
    // Set the runtime converged once the tile upload lands.
    const converged = (async () => {
      for (let i = 0; i < 50 && runtime.completions.length === 0; i += 1) {
        await flush();
        await streamer.update();
      }
      runtime.converged = true;
      await streamer.whenConverged({ timeoutFrames: 10 });
    })();
    await converged;
    expect(streamer.stats().converged).toBe(true);
    streamer.dispose();
  });

  it("times out of whenConverged past the frame budget", async () => {
    const runtime = new FakeRuntime();
    const source = recordingSource(64, 64, 32);
    const streamer = await TerrainStreamer.create(runtime, source);
    runtime.queuePlan({
      requests: [{ lod: 0, x: 0, y: 0, priority: 0, prefetch: false }],
      cancelled: [],
    });
    await expect(
      streamer.whenConverged({ timeoutFrames: 4 }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    streamer.dispose();
  });

  it("replays cached tiles without refetching after recovery", async () => {
    const runtime = new FakeRuntime();
    const source = recordingSource(64, 64, 32, () => 9);
    runtime.queuePlan({
      requests: [{ lod: 0, x: 0, y: 0, priority: 0, prefetch: false }],
      cancelled: [],
    });
    const streamer = await TerrainStreamer.create(runtime, source);
    await flush();
    await streamer.update();
    await streamer.update();
    expect(
      runtime.completions.filter((tile) => tile.lod === 0).length,
    ).toBe(1);
    const readsAfterUpload = source.calls.length;
    // Simulate device-loss replay: the runtime was reset and now plans
    // the same resident tiles again.
    runtime.queuePlan({
      requests: [{ lod: 0, x: 0, y: 0, priority: 0, prefetch: false }],
      cancelled: [],
    });
    await streamer.update();
    await flush();
    await streamer.update();
    // The tile came from the retained cache — no new source read.
    expect(source.calls.length).toBe(readsAfterUpload);
    expect(
      runtime.completions.filter(
        (tile) => tile.lod === 0 && tile.x === 0 && tile.y === 0,
      ).length,
    ).toBe(2);
    expect(runtime.completions.at(-1)!.heights[0]).toBe(9);
    streamer.dispose();
  });

  it("deletes evicted tiles from the replay cache", async () => {
    const runtime = new FakeRuntime();
    runtime.completeHeightTile = (lod, x, y, heights) => {
      runtime.completions.push({ lod, x, y, heights });
      return { accepted: true, evicted: { lod: 0, x: 0, y: 0 } };
    };
    const source = recordingSource(64, 64, 32);
    runtime.queuePlan({
      requests: [
        { lod: 0, x: 0, y: 0, priority: 0, prefetch: false },
        { lod: 0, x: 1, y: 0, priority: 0, prefetch: false },
      ],
      cancelled: [],
    });
    const streamer = await TerrainStreamer.create(runtime, source);
    await flush();
    await streamer.update();
    await streamer.update();
    // First tile evicted by the second upload; a re-plan must refetch.
    runtime.queuePlan({
      requests: [{ lod: 0, x: 0, y: 0, priority: 0, prefetch: false }],
      cancelled: [],
    });
    const reads = source.calls.length;
    await streamer.update();
    await flush();
    expect(source.calls.length).toBe(reads + 1);
    streamer.dispose();
  });

  it("hooks viewer recovery and frame listeners when present", async () => {
    const runtime = new FakeRuntime();
    const listeners: (() => void)[] = [];
    const frameListeners: (() => boolean | void)[] = [];
    const target = runtime as FakeRuntime & {
      addRecoveryListener?: (listener: () => void) => () => void;
      addFrameListener?: (
        listener: () => boolean | void,
      ) => () => void;
    };
    target.addRecoveryListener = (listener) => {
      listeners.push(listener);
      return () => {};
    };
    target.addFrameListener = (listener) => {
      frameListeners.push(listener);
      return () => {};
    };
    const source = recordingSource(64, 64, 32);
    const streamer = await TerrainStreamer.create(target, source, {
      autoUpdate: true,
    });
    expect(listeners.length).toBe(1);
    expect(frameListeners.length).toBe(1);
    // Frame listener pumps update() and keeps the loop alive while
    // not converged.
    const keepAlive = frameListeners[0]!();
    expect(keepAlive).toBe(true);
    streamer.dispose();
  });
});

describe("TerrainStreamer — abort and re-plan", () => {
  /** lod-0 reads settle only when the test says so, ignoring abort (a
   * transport that finishes the in-flight read anyway). */
  function deferredSource() {
    const reads: {
      lod: number;
      x: number;
      y: number;
      signal?: AbortSignal;
      resolve: (heights: Float32Array) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const source = {
      width: 64,
      height: 64,
      tileSize: 32,
      readTile(
        lod: number,
        x: number,
        y: number,
        options: { signal?: AbortSignal } = {},
      ): Promise<Float32Array> {
        if (lod === 1) {
          return Promise.resolve(new Float32Array(32 * 32));
        }
        return new Promise<Float32Array>((resolve, reject) => {
          reads.push({ lod, x, y, signal: options.signal, resolve, reject });
        });
      },
    };
    return { source, reads };
  }

  it("refetches a tile re-planned before its aborted fetch settles", async () => {
    const runtime = new FakeRuntime();
    const { source, reads } = deferredSource();
    const streamer = await TerrainStreamer.create(runtime, source);
    try {
      const tile = { lod: 0, x: 0, y: 0 };
      runtime.queuePlan({
        requests: [{ ...tile, priority: 0, prefetch: false }],
        cancelled: [],
      });
      await streamer.update();
      expect(reads).toHaveLength(1);
      runtime.queuePlan({ requests: [], cancelled: [tile] });
      await streamer.update();
      expect(reads[0]!.signal!.aborted).toBe(true);
      // Re-planned while the aborted fetch is still running.
      runtime.queuePlan({
        requests: [{ ...tile, priority: 0, prefetch: false }],
        cancelled: [],
      });
      await streamer.update();
      expect(reads).toHaveLength(2);
      expect(reads[1]!.signal!.aborted).toBe(false);
      // The stale result lands late and is discarded.
      reads[0]!.resolve(new Float32Array(32 * 32).fill(111));
      await flush();
      await streamer.update();
      expect(runtime.completions).toHaveLength(0);
      reads[1]!.resolve(new Float32Array(32 * 32).fill(222));
      await flush();
      await streamer.update();
      expect(runtime.completions).toHaveLength(1);
      expect(runtime.completions[0]!.heights[0]).toBe(222);
      expect(runtime.failures).toEqual([]);
      runtime.converged = true;
      await streamer.whenConverged({ timeoutFrames: 4 });
      expect(streamer.stats()).toMatchObject({
        pendingFetches: 0,
        queuedFetches: 0,
        converged: true,
      });
    } finally {
      streamer.dispose();
    }
  });

  it("releases the runtime slot when a still-wanted result is dropped", async () => {
    const runtime = new FakeRuntime();
    const { source, reads } = deferredSource();
    const controller = new AbortController();
    const streamer = await TerrainStreamer.create(runtime, source, {
      signal: controller.signal,
    });
    try {
      runtime.queuePlan({
        requests: [{ lod: 0, x: 1, y: 0, priority: 0, prefetch: false }],
        cancelled: [],
      });
      await streamer.update();
      expect(reads).toHaveLength(1);
      controller.abort();
      reads[0]!.resolve(new Float32Array(32 * 32));
      await flush();
      expect(runtime.completions).toHaveLength(0);
      expect(runtime.failures).toEqual([{ lod: 0, x: 1, y: 0 }]);
    } finally {
      streamer.dispose();
    }
  });
});

describe("TerrainStreamer — COG nodata", () => {
  function cogLikeSource(nodata: number | null) {
    const source = new FunctionHeightSource({
      width: 64,
      height: 64,
      tileSize: 32,
      sample: () => 1,
    });
    return Object.assign(source, { nodata });
  }

  it("defaults terrain.nodata to the source's nodata", async () => {
    const runtime = new FakeRuntime();
    const streamer = await TerrainStreamer.create(runtime, cogLikeSource(-9999));
    try {
      expect(runtime.terrain!.nodata).toBe(-9999);
    } finally {
      streamer.dispose();
    }
  });

  it("keeps an explicit terrain.nodata and omits a null source nodata", async () => {
    const runtime = new FakeRuntime();
    const explicit = await TerrainStreamer.create(runtime, cogLikeSource(-9999), {
      terrain: { nodata: -1 },
    });
    expect(runtime.terrain!.nodata).toBe(-1);
    explicit.dispose();
    const none = await TerrainStreamer.create(runtime, cogLikeSource(null));
    expect("nodata" in runtime.terrain!).toBe(false);
    none.dispose();
  });
});

describe("TerrainStreamer — CogHeightSource nodata", () => {
  it("commits the COG nodata when options.terrain.nodata is unset", async () => {
    const { readFile } = await import("node:fs/promises");
    const { CogDataset } = await import("../../src-ts/cog.js");
    const { CogHeightSource } = await import("../../src-ts/terrain-streaming.js");
    const bytes = await readFile(
      new URL("../golden/w08/rainier-cog.tif", import.meta.url),
    );
    const cog = await CogDataset.open(new Blob([bytes]));
    const runtime = new FakeRuntime();
    try {
      expect(cog.nodata).toBe(-9999);
      const streamer = await TerrainStreamer.create(
        runtime,
        new CogHeightSource(cog),
      );
      expect(runtime.terrain!.nodata).toBe(-9999);
      streamer.dispose();
    } finally {
      cog.dispose();
    }
  });
});
