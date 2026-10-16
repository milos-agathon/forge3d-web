// W08 / DESIGN F4 — `TerrainStreamer` drives the wasm height-streaming
// contract (E3): `planHeightTiles` → `readTile` fetches →
// `completeHeightTile` (bounded uploads per update) → render request.
//
// Pyramid math mirrors `HeightPyramid` B2 in forge3d-core: lod 0 is the
// full virtual resolution, `dims(l) = ceil(dims(0)/2^l)` per axis, and
// `lod_count` is the smallest n whose coarsest dims fit in one tile.
// `heights` in the committed terrain input is the whole coarsest level.

import type {
  Forge3DRuntime,
  Forge3DViewer,
  HeightStreamingStats,
  HeightTileId,
  HeightTilePlan,
  HeightTileSource,
  TerrainClipmapInput,
  TerrainHeightmapInput,
  TerrainStreamerOptions,
  TerrainStreamerStats,
} from "./index.js";
import { Forge3DError } from "./index.js";
import { MemoryByteCache } from "./byte-cache.js";
import type { CogDataset } from "./cog.js";

const DEFAULT_TILE_SIZE = 256;
const DEFAULT_MAX_IN_FLIGHT = 16;
const DEFAULT_MAX_UPLOADS = 8;
const DEFAULT_TIMEOUT_FRAMES = 600;

/** The subset of the runtime/viewer contract the streamer drives. */
export interface TerrainStreamerTarget {
  setTerrain?(terrain: TerrainHeightmapInput): void;
  planHeightTiles?(maxRequests: number): HeightTilePlan;
  completeHeightTile?(
    lod: number,
    x: number,
    y: number,
    heights: Float32Array,
  ): { accepted: boolean; evicted: HeightTileId | null } | void;
  failHeightTile?(lod: number, x: number, y: number): void;
  getHeightStreamingStats?(): HeightStreamingStats;
  /** Viewer-render-loop hook used by `autoUpdate` (registered per
   * scheduled frame; returning true keeps the loop alive). */
  addFrameListener?(listener: () => boolean | void): () => void;
  /** Called after a successful device-loss recovery. */
  addRecoveryListener?(listener: () => void): () => void;
  /** Requests a render; falls back to `render()` when absent. */
  requestRender?(): void;
  render?(): void;
}

function tileKey(lod: number, x: number, y: number): string {
  return `${lod}/${x}/${y}`;
}

/** B2: smallest n such that `dims(n-1)` fits a single tile. */
export function heightPyramidLodCount(
  width: number,
  height: number,
  tileSize: number,
): number {
  let lodCount = 1;
  while (true) {
    const div = 2 ** (lodCount - 1);
    if (Math.ceil(width / div) <= tileSize && Math.ceil(height / div) <= tileSize) {
      return lodCount;
    }
    lodCount += 1;
  }
}

function levelDims(
  width: number,
  height: number,
  lod: number,
): [number, number] {
  const div = 2 ** lod;
  return [Math.ceil(width / div), Math.ceil(height / div)];
}

/** Edge-clipped tile rect `[x0, y0, w, h]` in level sample space. */
function tileRect(
  width: number,
  height: number,
  tileSize: number,
  lod: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const [levelWidth, levelHeight] = levelDims(width, height, lod);
  const x0 = x * tileSize;
  const y0 = y * tileSize;
  if (x0 >= levelWidth || y0 >= levelHeight || x0 < 0 || y0 < 0) {
    throw new Forge3DError(
      "INVALID_INPUT",
      `height tile (${lod}, ${x}, ${y}) is outside the pyramid`,
      { reason: "tile-out-of-range" },
    );
  }
  return [
    x0,
    y0,
    Math.min(tileSize, levelWidth - x0),
    Math.min(tileSize, levelHeight - y0),
  ];
}

function assertPyramidSource(source: HeightTileSource): void {
  const { width, height, tileSize } = source;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2
  ) {
    throw new Forge3DError(
      "INVALID_INPUT",
      `height tile source dimensions must be >= 2, got ${width}x${height}`,
      { reason: "invalid-source" },
    );
  }
  if (!Number.isInteger(tileSize) || tileSize < 16) {
    throw new Forge3DError(
      "INVALID_INPUT",
      `height tile source tileSize must be >= 16, got ${tileSize}`,
      { reason: "invalid-source" },
    );
  }
}

/** W08 (F4): a `HeightTileSource` over a full-resolution dense height
 * array (point subsample at each lod). */
export class ArrayHeightSource implements HeightTileSource {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly #heights: ArrayLike<number>;

  constructor(
    heights: ArrayLike<number>,
    width: number,
    height: number,
    tileSize = DEFAULT_TILE_SIZE,
  ) {
    if (heights.length !== width * height) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `heights length ${heights.length} does not match ${width}x${height}`,
        { reason: "invalid-source" },
      );
    }
    this.#heights = heights;
    this.width = width;
    this.height = height;
    this.tileSize = tileSize;
    assertPyramidSource(this);
  }

  readTile(
    lod: number,
    x: number,
    y: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<Float32Array> {
    options.signal?.throwIfAborted();
    const [x0, y0, w, h] = tileRect(
      this.width,
      this.height,
      this.tileSize,
      lod,
      x,
      y,
    );
    const out = new Float32Array(w * h);
    const shift = 2 ** lod;
    for (let row = 0; row < h; row += 1) {
      const sourceRow = Math.min((y0 + row) * shift, this.height - 1);
      const dstBase = row * w;
      const srcBase = sourceRow * this.width;
      for (let column = 0; column < w; column += 1) {
        const sourceColumn = Math.min(
          (x0 + column) * shift,
          this.width - 1,
        );
        out[dstBase + column] = this.#heights[srcBase + sourceColumn]!;
      }
    }
    return Promise.resolve(out);
  }
}

/** W08 (F4): `HeightTileSource` evaluating `sample(lod, x, y)` per
 * destination sample in the tile's level-space rect. */
export class FunctionHeightSource implements HeightTileSource {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly #sample: (lod: number, x: number, y: number) => number;

  constructor(options: {
    width: number;
    height: number;
    tileSize?: number;
    sample: (lod: number, x: number, y: number) => number;
  }) {
    this.width = options.width;
    this.height = options.height;
    this.tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
    this.#sample = options.sample;
    assertPyramidSource(this);
  }

  readTile(
    lod: number,
    x: number,
    y: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<Float32Array> {
    options.signal?.throwIfAborted();
    const [x0, y0, w, h] = tileRect(
      this.width,
      this.height,
      this.tileSize,
      lod,
      x,
      y,
    );
    const out = new Float32Array(w * h);
    for (let row = 0; row < h; row += 1) {
      for (let column = 0; column < w; column += 1) {
        out[row * w + column] = this.#sample(lod, x0 + column, y0 + row);
      }
    }
    return Promise.resolve(out);
  }
}

/** W08 (F4): `HeightTileSource` over a {@link CogDataset}. IFD `l`
 * backs pyramid lod `l` when its dims equal `ceil(dims(0)/2^l)`;
 * lods beyond the available overviews are point-subsampled from the
 * coarsest IFD; a dims mismatch on an existing IFD is INVALID_INPUT. */
export class CogHeightSource implements HeightTileSource {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly #cog: CogDataset;
  #coarsest: Float32Array | undefined;
  #coarsestPromise: Promise<Float32Array> | undefined;

  constructor(cog: CogDataset) {
    const info = cog.ifdInfo(0);
    if (info.tileWidth !== info.tileHeight) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `COG tiles must be square for streaming (${info.tileWidth}x${info.tileHeight})`,
        { reason: "cog-tile-not-square" },
      );
    }
    this.#cog = cog;
    this.width = cog.width;
    this.height = cog.height;
    this.tileSize = info.tileWidth;
    assertPyramidSource(this);
  }

  get cog(): CogDataset {
    return this.#cog;
  }

  /** The COG's GDAL nodata value; the streamer commits it as
   * `terrain.nodata` unless the caller sets one. */
  get nodata(): number | null {
    return this.#cog.nodata;
  }

  async readTile(
    lod: number,
    x: number,
    y: number,
    options: { signal?: AbortSignal; priority?: number } = {},
  ): Promise<Float32Array> {
    options.signal?.throwIfAborted();
    const [x0, y0, w, h] = tileRect(
      this.width,
      this.height,
      this.tileSize,
      lod,
      x,
      y,
    );
    if (lod < this.#cog.overviewCount) {
      const info = this.#cog.ifdInfo(lod);
      const [expectedWidth, expectedHeight] = levelDims(
        this.width,
        this.height,
        lod,
      );
      if (info.width !== expectedWidth || info.height !== expectedHeight) {
        throw new Forge3DError(
          "INVALID_INPUT",
          `COG IFD ${lod} dims ${info.width}x${info.height} do not match pyramid level ${expectedWidth}x${expectedHeight}`,
          { reason: "cog-ifd-dims-mismatch" },
        );
      }
      const tile = await this.#cog.readTile(x, y, lod, options);
      // The COG tile is a full tileWidth x tileHeight block; slice the
      // clipped rect out of it.
      const out = new Float32Array(w * h);
      for (let row = 0; row < h; row += 1) {
        for (let column = 0; column < w; column += 1) {
          out[row * w + column] = tile[row * info.tileWidth + column]!;
        }
      }
      return out;
    }
    // Beyond the stored overviews: point-subsample the coarsest IFD.
    const coarsestLod = this.#cog.overviewCount - 1;
    const coarsest = await this.#coarsestLevel(options);
    const [coarsestWidth, coarsestHeight] = levelDims(
      this.width,
      this.height,
      coarsestLod,
    );
    const scale = 2 ** (lod - coarsestLod);
    const out = new Float32Array(w * h);
    for (let row = 0; row < h; row += 1) {
      const srcRow = Math.min((y0 + row) * scale, coarsestHeight - 1);
      for (let column = 0; column < w; column += 1) {
        const srcColumn = Math.min((x0 + column) * scale, coarsestWidth - 1);
        out[row * w + column] = coarsest[srcRow * coarsestWidth + srcColumn]!;
      }
    }
    return out;
  }

  /** Assemble the full coarsest IFD level into one Float32Array
   * (once, via the COG's decoded-tile cache). */
  #coarsestLevel(options: { signal?: AbortSignal }): Promise<Float32Array> {
    if (this.#coarsest !== undefined) return Promise.resolve(this.#coarsest);
    this.#coarsestPromise ??= (async () => {
      const level = this.#cog.overviewCount - 1;
      const info = this.#cog.ifdInfo(level);
      const out = new Float32Array(info.width * info.height);
      const reads: Promise<void>[] = [];
      for (let ty = 0; ty < info.tilesDown; ty += 1) {
        for (let tx = 0; tx < info.tilesAcross; tx += 1) {
          reads.push(
            this.#cog
              .readTile(tx, ty, level, options)
              .then((tile) => {
                const copyWidth = Math.min(
                  info.tileWidth,
                  info.width - tx * info.tileWidth,
                );
                const copyHeight = Math.min(
                  info.tileHeight,
                  info.height - ty * info.tileHeight,
                );
                for (let row = 0; row < copyHeight; row += 1) {
                  const src = row * info.tileWidth;
                  const dst =
                    (ty * info.tileHeight + row) * info.width +
                    tx * info.tileWidth;
                  for (let column = 0; column < copyWidth; column += 1) {
                    out[dst + column] = tile[src + column]!;
                  }
                }
              }),
          );
        }
      }
      await Promise.all(reads);
      this.#coarsest = out;
      return out;
    })();
    return this.#coarsestPromise;
  }
}

interface PendingTile extends HeightTileId {
  heights: Float32Array;
  priority: number;
}

interface InflightFetch extends HeightTileId {
  controller: AbortController;
  settled: Promise<void>;
  /** Detaches the streamer-signal forwarding for this fetch. */
  detach: () => void;
}

/**
 * W08 (F4): streams a `HeightTileSource` into a committed terrain's
 * mosaic through the wasm streaming methods. Call `update()` per frame
 * (or set `autoUpdate` against a viewer target); uploads are bounded
 * by `maxUploadsPerFrame` and fetches by `maxInFlight`.
 *
 * Device-loss recovery: when attached to a `Forge3DViewer`, the viewer
 * replays the committed terrain (coarse base + streaming block); the
 * streamer's retained resident-tile cache then re-serves every planned
 * tile without touching the source again.
 */
export class TerrainStreamer {
  readonly source: HeightTileSource;
  readonly terrain: TerrainHeightmapInput;

  readonly #target: TerrainStreamerTarget;
  readonly #maxInFlight: number;
  readonly #maxUploadsPerFrame: number;
  readonly #signal: AbortSignal | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #inflight = new Map<string, InflightFetch>();
  readonly #ready: PendingTile[] = [];
  readonly #tileCache: MemoryByteCache;
  readonly #detachListeners: (() => void)[] = [];
  #uploadedTiles = 0;
  #disposed = false;

  private constructor(
    target: TerrainStreamerTarget,
    source: HeightTileSource,
    terrain: TerrainHeightmapInput,
    options: TerrainStreamerOptions,
  ) {
    this.#target = target;
    this.source = source;
    this.terrain = terrain;
    this.#maxInFlight =
      options.maxInFlight ?? terrain.streaming?.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.#maxUploadsPerFrame = options.maxUploadsPerFrame ?? DEFAULT_MAX_UPLOADS;
    this.#signal = options.signal;
    this.#onError = options.onError;
    // Resident-tile replay cache: sized to the mosaic budget so every
    // tile the runtime could be asked to re-upload is present.
    this.#tileCache = new MemoryByteCache(
      options.maxResidentBytes ?? terrain.streaming?.maxResidentBytes ?? 64 * 1024 * 1024,
    );
  }

  static async create(
    target: Forge3DRuntime | Forge3DViewer | TerrainStreamerTarget,
    source: HeightTileSource,
    options: TerrainStreamerOptions = {},
  ): Promise<TerrainStreamer> {
    assertPyramidSource(source);
    for (const method of [
      "setTerrain",
      "planHeightTiles",
      "completeHeightTile",
      "failHeightTile",
      "getHeightStreamingStats",
    ] as const) {
      if (typeof target[method] !== "function") {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          `TerrainStreamer target does not implement ${method}`,
          { reason: "streaming-unsupported" },
        );
      }
    }
    options.signal?.throwIfAborted();

    const lodCount = heightPyramidLodCount(
      source.width,
      source.height,
      source.tileSize,
    );
    const coarsestLod = lodCount - 1;
    const [coarseWidth, coarseHeight] = levelDims(
      source.width,
      source.height,
      coarsestLod,
    );
    // B2: the coarsest level always fits one tile per axis; read all
    // coarsest tiles generically in case a source reports otherwise.
    const tilesAcross = Math.ceil(coarseWidth / source.tileSize);
    const tilesDown = Math.ceil(coarseHeight / source.tileSize);
    const heights = new Float32Array(coarseWidth * coarseHeight);
    const reads: Promise<void>[] = [];
    for (let ty = 0; ty < tilesDown; ty += 1) {
      for (let tx = 0; tx < tilesAcross; tx += 1) {
        reads.push(
          source
            .readTile(coarsestLod, tx, ty, {
              ...(options.signal !== undefined
                ? { signal: options.signal }
                : {}),
            })
            .then((tile) => {
              const copyWidth = Math.min(
                source.tileSize,
                coarseWidth - tx * source.tileSize,
              );
              const copyHeight = Math.min(
                source.tileSize,
                coarseHeight - ty * source.tileSize,
              );
              for (let row = 0; row < copyHeight; row += 1) {
                for (let column = 0; column < copyWidth; column += 1) {
                  heights[
                    (ty * source.tileSize + row) * coarseWidth +
                      tx * source.tileSize +
                      column
                  ] = tile[row * copyWidth + column]!;
                }
              }
            }),
        );
      }
    }
    await Promise.all(reads);

    const clipmap: TerrainClipmapInput = {
      ...options.terrain?.geometry?.clipmap,
      ...options.clipmap,
    };
    const nodata = options.terrain?.nodata ?? source.nodata ?? undefined;
    const terrain: TerrainHeightmapInput = {
      ...options.terrain,
      ...(nodata !== undefined ? { nodata } : {}),
      width: coarseWidth,
      height: coarseHeight,
      heights,
      geometry: {
        ...options.terrain?.geometry,
        mode: "clipmap",
        clipmap,
      },
      streaming: {
        width: source.width,
        height: source.height,
        tileSize: source.tileSize,
        ...(options.maxResidentBytes !== undefined
          ? { maxResidentBytes: options.maxResidentBytes }
          : {}),
        ...(options.lodBias !== undefined ? { lodBias: options.lodBias } : {}),
        ...(options.prefetchMarginTiles !== undefined
          ? { prefetchMarginTiles: options.prefetchMarginTiles }
          : {}),
        ...(options.maxInFlight !== undefined
          ? { maxInFlight: options.maxInFlight }
          : {}),
        ...(options.coalescePolicy !== undefined
          ? { coalescePolicy: options.coalescePolicy }
          : {}),
      },
    };
    target.setTerrain!(terrain);
    const streamer = new TerrainStreamer(target, source, terrain, options);
    const hooks = target as TerrainStreamerTarget;
    if (typeof hooks.addRecoveryListener === "function") {
      streamer.#detachListeners.push(
        hooks.addRecoveryListener(() => {
          void streamer.update().catch(streamer.#reportError);
        }),
      );
    }
    if (
      options.autoUpdate === true &&
      typeof hooks.addFrameListener === "function"
    ) {
      streamer.#detachListeners.push(
        hooks.addFrameListener(() => {
          void streamer.update().catch(streamer.#reportError);
          return !streamer.converged;
        }),
      );
    }
    // Prime the pipeline: the first plan/fetch cycle does not wait for
    // an external frame.
    void streamer.update().catch(streamer.#reportError);
    return streamer;
  }

  /** One update cycle: drain completed fetches into uploads (bounded
   * by `maxUploadsPerFrame`), plan the next requests, abort cancelled
   * in-flight fetches, and request a render after uploads. */
  async update(): Promise<void> {
    if (this.#disposed || this.#signal?.aborted) return;
    const target = this.#target;
    let uploads = 0;
    while (uploads < this.#maxUploadsPerFrame) {
      const pending = this.#ready.shift();
      if (pending === undefined) break;
      try {
        const completion = target.completeHeightTile!(
          pending.lod,
          pending.x,
          pending.y,
          pending.heights,
        );
        uploads += 1;
        this.#uploadedTiles += 1;
        if (completion && completion.accepted !== false) {
          this.#tileCache.put(
            tileKey(pending.lod, pending.x, pending.y),
            new Uint8Array(
              pending.heights.buffer,
              pending.heights.byteOffset,
              pending.heights.byteLength,
            ),
          );
        }
        if (completion && completion.evicted) {
          this.#tileCache.delete(
            tileKey(
              completion.evicted.lod,
              completion.evicted.x,
              completion.evicted.y,
            ),
          );
        }
      } catch (error) {
        this.#failTile(pending.lod, pending.x, pending.y);
        this.#reportError(error);
      }
    }
    if (uploads > 0) this.#requestRender();

    if (this.#disposed || this.#signal?.aborted) return;
    const plan = target.planHeightTiles!(this.#maxInFlight);
    for (const cancelled of plan.cancelled) {
      const key = tileKey(cancelled.lod, cancelled.x, cancelled.y);
      // Forget the fetch now, not when the abort settles: a re-plan of the
      // same tile must start a fresh fetch, and the late result of this
      // one is discarded by its entry token.
      const inflight = this.#inflight.get(key);
      if (inflight !== undefined) {
        this.#inflight.delete(key);
        inflight.detach();
        inflight.controller.abort();
      }
      const readyIndex = this.#ready.findIndex(
        (tile) =>
          tile.lod === cancelled.lod &&
          tile.x === cancelled.x &&
          tile.y === cancelled.y,
      );
      if (readyIndex >= 0) this.#ready.splice(readyIndex, 1);
    }
    for (const request of plan.requests) {
      const key = tileKey(request.lod, request.x, request.y);
      if (this.#inflight.has(key)) continue;
      const cached = this.#tileCache.get(key);
      if (cached !== undefined) {
        this.#ready.push({
          lod: request.lod,
          x: request.x,
          y: request.y,
          heights: new Float32Array(
            cached.buffer.slice(
              cached.byteOffset,
              cached.byteOffset + cached.byteLength,
            ) as ArrayBuffer,
          ),
          priority: request.priority,
        });
        continue;
      }
      if (this.#inflight.size >= this.#maxInFlight) break;
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      this.#signal?.addEventListener("abort", forwardAbort, { once: true });
      const entry: InflightFetch = {
        lod: request.lod,
        x: request.x,
        y: request.y,
        controller,
        settled: undefined as unknown as Promise<void>,
        detach: () => this.#signal?.removeEventListener("abort", forwardAbort),
      };
      // `entry` is the per-request token: a result is only used while its
      // entry is still the current fetch for the key.
      const settle = (): boolean => {
        if (this.#inflight.get(key) !== entry) return false;
        this.#inflight.delete(key);
        entry.detach();
        return !this.#disposed;
      };
      entry.settled = this.source
        .readTile(request.lod, request.x, request.y, {
          signal: controller.signal,
          priority: request.priority,
        })
        .then((heights) => {
          if (!settle()) return;
          if (controller.signal.aborted) {
            // Still wanted by the runtime, but dropped: release its slot.
            this.#failTile(request.lod, request.x, request.y);
            return;
          }
          this.#ready.push({ ...request, heights });
        })
        .catch((error) => {
          if (!settle()) return;
          this.#failTile(request.lod, request.x, request.y);
          if (!controller.signal.aborted) this.#reportError(error);
        });
      this.#inflight.set(key, entry);
    }
    // Serve any cache-hit completions immediately within this cycle's
    // upload budget rather than waiting a frame.
    if (this.#ready.length > 0 && uploads === 0) {
      await this.update();
    }
  }

  get converged(): boolean {
    return (
      this.#inflight.size === 0 &&
      this.#ready.length === 0 &&
      this.#target.getHeightStreamingStats?.().converged === true
    );
  }

  /** Waits until the runtime reports `converged` (or the signal/frame
   * budget fires), pumping `update()` itself — so a bare runtime
   * target converges without an external render loop. */
  async whenConverged(
    options: { signal?: AbortSignal; timeoutFrames?: number } = {},
  ): Promise<void> {
    const timeoutFrames = options.timeoutFrames ?? DEFAULT_TIMEOUT_FRAMES;
    for (let frame = 0; frame < timeoutFrames; frame += 1) {
      options.signal?.throwIfAborted();
      this.#signal?.throwIfAborted();
      if (this.#disposed) {
        throw new Forge3DError(
          "RUNTIME_DISPOSED",
          "TerrainStreamer is disposed",
        );
      }
      await this.update();
      if (this.converged) return;
      const pending = [...this.#inflight.values()].map((fetch) => fetch.settled);
      if (pending.length === 0) {
        // Nothing in flight and not converged: yield so the caller can
        // interleave work, then keep polling within the frame budget.
        await Promise.resolve();
        continue;
      }
      await Promise.race(pending);
    }
    throw new Forge3DError(
      "INTERNAL_ERROR",
      `TerrainStreamer did not converge within ${timeoutFrames} frames`,
      { reason: "converge-timeout", timeoutFrames },
    );
  }

  stats(): TerrainStreamerStats {
    const runtime = this.#target.getHeightStreamingStats?.();
    if (runtime === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "TerrainStreamer target does not report streaming stats",
        { reason: "streaming-unsupported" },
      );
    }
    return {
      runtime,
      uploadedTiles: this.#uploadedTiles,
      pendingFetches: this.#inflight.size,
      queuedFetches: this.#ready.length,
      converged: this.converged,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const detach of this.#detachListeners.splice(0)) {
      detach();
    }
    for (const fetch of this.#inflight.values()) {
      fetch.controller.abort();
    }
    this.#inflight.clear();
    this.#ready.length = 0;
  }

  #requestRender(): void {
    try {
      if (typeof this.#target.requestRender === "function") {
        this.#target.requestRender();
      } else {
        this.#target.render?.();
      }
    } catch {
      // A render request is best-effort (the viewer may be recovering).
    }
  }

  #failTile(lod: number, x: number, y: number): void {
    try {
      this.#target.failHeightTile?.(lod, x, y);
    } catch {
      // The runtime may already be gone (device loss); the tile drops.
    }
  }

  #reportError = (error: unknown): void => {
    if (this.#onError !== undefined) {
      this.#onError(error);
    } else {
      // eslint-disable-next-line no-console
      console.warn?.("forge3d: terrain streamer error", error);
    }
  };
}
