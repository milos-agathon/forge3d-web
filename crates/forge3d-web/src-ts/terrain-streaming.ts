import { assembleRasterLevel, SharedRasterLevel } from './raster-level.js';
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
import { Forge3DError } from "./runtime-failure.js";
import { TerrainStreamingSession } from './terrain-streaming-session.js';
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
  readonly #coarse = new SharedRasterLevel(signal=>{
    const level=this.#cog.overviewCount-1,info=this.#cog.ifdInfo(level);
    return assembleRasterLevel({...info,padded:true,readTile:(x,y,s)=>this.#cog.readTile(x,y,level,s?{signal:s}:{})},signal);
  });

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
    return this.#coarse.get(options.signal);
  }
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
  readonly #session: TerrainStreamingSession;
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
    this.#session = new TerrainStreamingSession(
      options.maxResidentBytes ?? terrain.streaming?.maxResidentBytes ?? 64 * 1024 * 1024, this.#signal,
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
    const heights=await assembleRasterLevel({width:coarseWidth,height:coarseHeight,tileWidth:source.tileSize,tileHeight:source.tileSize,padded:false,readTile:(x,y,signal)=>source.readTile(coarsestLod,x,y,signal?{signal}:{})},options.signal);

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
      streamer.#session.listen(
        hooks.addRecoveryListener(() => {
          void streamer.update().catch(streamer.#reportError);
        }),
      );
    }
    if (
      options.autoUpdate === true &&
      typeof hooks.addFrameListener === "function"
    ) {
      streamer.#session.listen(
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
      const pending = this.#session.next();
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
          this.#session.retain(pending);
        }
        if (completion && completion.evicted) {
          this.#session.evict(completion.evicted);
        }
      } catch (error) {
        this.#failTile(pending.lod, pending.x, pending.y);
        this.#reportError(error);
      }
    }
    if (uploads > 0) this.#requestRender();

    if (this.#disposed || this.#signal?.aborted) return;
    const plan = target.planHeightTiles!(this.#maxInFlight);
    for (const cancelled of plan.cancelled) this.#session.cancel(cancelled);
    for (const request of plan.requests) {
      if(!this.#session.request(request,this.source,this.#maxInFlight,()=>this.#failTile(request.lod,request.x,request.y),this.#reportError))break;
    }
    // Serve any cache-hit completions immediately within this cycle's
    // upload budget rather than waiting a frame.
    if (this.#session.readyCount > 0 && uploads === 0) {
      await this.update();
    }
  }

  get converged(): boolean {
    return (
      this.#session.pendingCount === 0 &&
      this.#session.readyCount === 0 &&
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
      await this.#session.wait(options.signal);
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
      pendingFetches: this.#session.pendingCount,
      queuedFetches: this.#session.readyCount,
      converged: this.converged,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#session.dispose();
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
