import { Forge3DError } from "./index.js";
import type { BrowserByteSource } from "./index.js";
import { readByteSource } from "./browser-io.js";
import type {
  PointView,
  PointDatasetOptions,
  PointVec3,
} from "./pointcloud-types.js";
import { PointSource } from "./pointcloud-source.js";
import {
  pointError,
  pointInteger,
  pointFinite,
  pointJson,
  pointUrl,
  pointView,
  pointDistance,
  pointCancelled,
  pointLimit,
} from "./pointcloud-common.js";
import {
  TileBoundingVolume,
  TILE_IDENTITY,
  tileMatrix,
  multiplyTileMatrices,
  tileMatrixScale,
} from "./tiles3d-bounds.js";
import type { TileBoundsInput } from "./tiles3d-bounds.js";
export type TileRefine = "ADD" | "REPLACE";
export interface TileContent {
  uri: string;
  boundingVolume?: TileBoundingVolume;
}
export interface Tile {
  id: string;
  boundingVolume: TileBoundingVolume;
  geometricError: number;
  refine: TileRefine | undefined;
  transform: number[];
  content: TileContent | undefined;
  children: Tile[];
  baseUrl: string;
}
export interface TilesetLoadOptions extends PointDatasetOptions {
  baseUrl?: string | URL;
  maxDepth?: number;
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    pointError("Expected tileset object");
  return v as Record<string, unknown>;
}
function nonnegative(v: unknown, name: string): number {
  if (typeof v !== "number" || v < 0) pointError(`Invalid ${name}`);
  return pointFinite(v, name);
}
export class Tileset {
  readonly version: string;
  readonly geometricError: number;
  readonly root: Tile;
  readonly properties: Record<string, unknown> | undefined;
  readonly #externals = new Set<string>();
  readonly #ancestors = new WeakMap<Tile, Set<string>>();
  private constructor(
    readonly baseUrl: string,
    value: Record<string, unknown>,
    readonly io: PointSource,
    readonly options: TilesetLoadOptions,
  ) {
    const asset = record(value.asset);
    if (asset.version !== "1.0" && asset.version !== "1.1")
      pointError("Unsupported tileset version");
    this.version = asset.version;
    this.geometricError = nonnegative(
      value.geometricError ?? 0,
      "tileset geometricError",
    );
    if (value.extensionsRequired !== undefined) {
      if (!Array.isArray(value.extensionsRequired))
        pointError("Invalid tileset extensionsRequired");
      if (value.extensionsRequired.length)
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Tileset requires an unsupported extension",
          {
            reason: "tiles-required-extension",
            extensions: value.extensionsRequired,
          },
        );
    }
    let count = 0;
    const parse = (input: unknown, id: string, depth: number): Tile => {
      const t = record(input);
      if (depth > (options.maxDepth ?? 32))
        pointError("Tileset exceeds maximum depth");
      pointLimit(++count, io.maxNodes);
      if (t.implicitTiling || t.contents)
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Implicit/multiple-content tiles require a registered adapter",
          { reason: "tiles-content-unavailable" },
        );
      if (
        t.refine !== undefined &&
        t.refine !== "ADD" &&
        t.refine !== "REPLACE"
      )
        pointError("Invalid tile refine");
      let content: TileContent | undefined;
      if (t.content !== undefined) {
        const c = record(t.content),
          uri = c.uri ?? c.url;
        if (typeof uri !== "string" || !uri)
          pointError("Tile content URI missing");
        content = {
          uri: pointUrl(uri, baseUrl),
          ...(c.boundingVolume
            ? {
                boundingVolume: new TileBoundingVolume(
                  c.boundingVolume as TileBoundsInput,
                ),
              }
            : {}),
        };
      }
      if (t.children !== undefined && !Array.isArray(t.children))
        pointError("Invalid tile children");
      return {
        id,
        boundingVolume: new TileBoundingVolume(
          record(t.boundingVolume) as TileBoundsInput,
        ),
        geometricError: nonnegative(
          t.geometricError ?? 0,
          "tile geometricError",
        ),
        refine: t.refine as TileRefine | undefined,
        transform: tileMatrix(t.transform),
        content,
        children: ((t.children as unknown[] | undefined) ?? []).map((c, i) =>
          parse(c, `${id}/${i}`, depth + 1),
        ),
        baseUrl,
      };
    };
    this.root = parse(value.root, "root", 0);
    this.properties =
      value.properties === undefined ? undefined : record(value.properties);
    this.#externals.add(baseUrl);
    const mark = (t: Tile) => {
      this.#ancestors.set(t, new Set([baseUrl]));
      t.children.forEach(mark);
    };
    mark(this.root);
  }
  static fromJson(
    value: unknown,
    baseUrl: string | URL,
    options: TilesetLoadOptions = {},
  ): Tileset {
    const io = new PointSource(options);
    try {
      return new Tileset(String(baseUrl), record(value), io, options);
    } catch (e) {
      io.dispose();
      throw e;
    }
  }
  static async load(
    source: BrowserByteSource,
    options: TilesetLoadOptions = {},
  ): Promise<Tileset> {
    const base =
      options.baseUrl ??
      (typeof source === "string" || source instanceof URL
        ? String(source)
        : undefined);
    if (!base) pointError("Tileset byte sources need a baseUrl");
    const io = new PointSource(options);
    try {
      const bytes =
        typeof source === "string" || source instanceof URL
          ? await io.read(String(source))
          : await readByteSource(source, {
              signal: io.signal(),
              maxBytes: io.maxBytes,
            });
      return new Tileset(String(base), pointJson(bytes), io, options);
    } catch (e) {
      io.dispose();
      throw e;
    }
  }
  get tileCount(): number {
    let count = 0;
    const visit = (t: Tile) => {
      count++;
      t.children.forEach(visit);
    };
    visit(this.root);
    return count;
  }
  get maxDepth(): number {
    const visit = (t: Tile): number =>
      1 + Math.max(0, ...t.children.map(visit));
    return visit(this.root);
  }
  async expandExternal(tile: Tile, signal?: AbortSignal): Promise<boolean> {
    this.io.signal(signal);
    if (!tile.content) return false;
    const uri = tile.content.uri;
    const ancestors = this.#ancestors.get(tile) ?? new Set([tile.baseUrl]);
    if (ancestors.has(uri))
      pointError("Cyclic external tileset", "tileset-cycle");
    const bytes = await this.io.read(uri, signal);
    // Content URIs need no filename extension. Identify JSON from the response,
    // with binary bodies retained in PointSource's bounded cache for decoding.
    let first =
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    while ([0x20, 0x09, 0x0a, 0x0d].includes(bytes[first]!)) first++;
    if (bytes[first] !== 0x7b) return false;
    pointLimit(ancestors.size + 1, this.options.maxDepth ?? 32);
    const external = new Tileset(uri, pointJson(bytes), this.io, this.options);
    pointCancelled(this.io.signal(signal));
    pointLimit(this.tileCount + external.tileCount, this.io.maxNodes);
    const prefix = tile.id + "/external";
    const rename = (t: Tile) => {
      t.id = prefix + "/" + t.id;
      this.#ancestors.set(t, new Set([...ancestors, uri]));
      t.children.forEach(rename);
    };
    rename(external.root);
    tile.children.push(external.root);
    tile.content = undefined;
    this.#externals.add(uri);
    return true;
  }
  resolveUri(uri: string, baseUrl = this.baseUrl): string {
    return pointUrl(uri, baseUrl);
  }
  stats() {
    return {
      ...this.io.stats(),
      tileCount: this.tileCount,
      maxDepth: this.maxDepth,
      externalTilesets: this.#externals.size - 1,
    };
  }
  dispose(): void {
    this.io.dispose();
    this.#externals.clear();
  }
}
export const loadTileset = Tileset.load;
export interface SseParams {
  viewportHeight: number;
  fovY: number;
}
export function computeTileSse(
  geometricError: number,
  bounds: TileBoundingVolume,
  camera: PointVec3,
  params: SseParams = { viewportHeight: 1080, fovY: Math.PI / 4 },
  surface = false,
): number {
  nonnegative(geometricError, "geometricError");
  pointView({ position: camera, ...params });
  const centerDistance = pointDistance(bounds.center(), camera),
    distance = surface
      ? Math.max(0.001, centerDistance - bounds.radius())
      : centerDistance;
  if (distance < 0.001) return 3.4028234663852886e38;
  return (
    ((geometricError / distance) * params.viewportHeight) /
    (2 * Math.tan(params.fovY / 2))
  );
}
export interface VisibleTile {
  tile: Tile;
  worldTransform: number[];
  worldBounds: TileBoundingVolume;
  sse: number;
  depth: number;
}
export interface TilesetTraversalOptions {
  sseThreshold?: number;
  maxDepth?: number;
  frustumCull?: boolean;
  surfaceDistance?: boolean;
}
export class TilesetTraverser {
  sseThreshold: number;
  maxDepth: number;
  frustumCull: boolean;
  surfaceDistance: boolean;
  constructor(o: TilesetTraversalOptions = {}) {
    this.sseThreshold = o.sseThreshold ?? 16;
    this.maxDepth = o.maxDepth ?? 32;
    this.frustumCull = o.frustumCull ?? true;
    this.surfaceDistance = o.surfaceDistance ?? false;
  }
  visibleTiles(tileset: Tileset, view: PointView): VisibleTile[] {
    tileset.io.signal();
    pointView(view);
    nonnegative(this.sseThreshold, "sseThreshold");
    pointInteger(this.maxDepth, "maxDepth", 0, 128);
    const result: VisibleTile[] = [];
    const visit = (
      tile: Tile,
      parent: number[],
      inherited: TileRefine,
      depth: number,
    ): void => {
      if (depth > this.maxDepth) return;
      const world = multiplyTileMatrices(parent, tile.transform),
        bounds = tile.boundingVolume.transform(world);
      if (this.frustumCull && !bounds.intersectsFrustum(view.viewProjection))
        return;
      const sse = computeTileSse(
          tile.geometricError * tileMatrixScale(world),
          bounds,
          view.position,
          view,
          this.surfaceDistance,
        ),
        refine = tile.refine ?? inherited;
      const refining =
        sse > this.sseThreshold &&
        tile.children.length > 0 &&
        depth < this.maxDepth;
      if (tile.content && (!refining || refine === "ADD"))
        result.push({
          tile,
          worldTransform: world,
          worldBounds: bounds,
          sse,
          depth,
        });
      if (refining || !tile.content)
        tile.children.forEach((child) =>
          visit(child, world, refine, depth + 1),
        );
    };
    visit(tileset.root, TILE_IDENTITY, tileset.root.refine ?? "REPLACE", 0);
    return result;
  }
  stats(tileset: Tileset, view: PointView) {
    const tiles = this.visibleTiles(tileset, view),
      sses = tiles.map((t) => t.sse);
    return {
      visibleTileCount: tiles.length,
      maxDepth: Math.max(0, ...tiles.map((t) => t.depth)),
      minSse: sses.length ? Math.min(...sses) : 0,
      maxSse: Math.max(0, ...sses),
      avgSse: sses.reduce((a, b) => a + b, 0) / Math.max(1, sses.length),
      selectedIds: tiles.map((t) => t.tile.id),
    };
  }
}
