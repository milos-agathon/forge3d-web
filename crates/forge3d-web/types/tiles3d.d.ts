import type { BrowserByteSource } from "./index.js";
import type { PointView, PointDatasetOptions, PointVec3 } from "./pointcloud-types.js";
import { PointSource } from "./pointcloud-source.js";
import { TileBoundingVolume } from "./tiles3d-bounds.js";
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
export declare class Tileset {
    #private;
    readonly baseUrl: string;
    readonly io: PointSource;
    readonly options: TilesetLoadOptions;
    readonly version: string;
    readonly geometricError: number;
    readonly root: Tile;
    readonly properties: Record<string, unknown> | undefined;
    private constructor();
    static fromJson(value: unknown, baseUrl: string | URL, options?: TilesetLoadOptions): Tileset;
    static load(source: BrowserByteSource, options?: TilesetLoadOptions): Promise<Tileset>;
    get tileCount(): number;
    get maxDepth(): number;
    expandExternal(tile: Tile, signal?: AbortSignal): Promise<boolean>;
    resolveUri(uri: string, baseUrl?: string): string;
    stats(): {
        tileCount: number;
        maxDepth: number;
        externalTilesets: number;
        ranges: import("./index.js").RangeSchedulerStats;
        compressed: import("./index.js").MemoryByteCacheStats;
        decoded: {
            cacheUsed: number;
            cacheBudget: number;
            entryCount: number;
            hits: number;
            misses: number;
            evictions: number;
            peakBytes: number;
        };
        disposed: boolean;
    };
    dispose(): void;
}
export declare const loadTileset: typeof Tileset.load;
export interface SseParams {
    viewportHeight: number;
    fovY: number;
}
export declare function computeTileSse(geometricError: number, bounds: TileBoundingVolume, camera: PointVec3, params?: SseParams, surface?: boolean): number;
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
export declare class TilesetTraverser {
    sseThreshold: number;
    maxDepth: number;
    frustumCull: boolean;
    surfaceDistance: boolean;
    constructor(o?: TilesetTraversalOptions);
    visibleTiles(tileset: Tileset, view: PointView): VisibleTile[];
    stats(tileset: Tileset, view: PointView): {
        visibleTileCount: number;
        maxDepth: number;
        minSse: number;
        maxSse: number;
        avgSse: number;
        selectedIds: string[];
    };
}
