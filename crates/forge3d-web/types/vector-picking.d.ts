import { VectorLayers } from "./vector-layers.js";
import type { CameraInput, TerrainHeightmapInput } from "./index.js";
import type { PickOptions, TerrainPickResult, VectorPickMap, VectorPickRegion, VectorPickResult, VectorSnapshot } from "./vector-types.js";
export interface VectorPickTarget {
    readVectorPickMap(region?: VectorPickRegion): Promise<VectorPickMap>;
}
export declare function vectorLassoContains(x: number, y: number, points: readonly (readonly [number, number])[]): boolean;
/** Queries use device pixels, with deterministic numeric-ID ordering for areas. */
export declare class VectorPicker {
    #private;
    private readonly target;
    private readonly layers;
    constructor(target: VectorPickTarget, layers: VectorLayers | (() => VectorSnapshot));
    point(x: number, y: number, options?: PickOptions): Promise<VectorPickResult | null>;
    rect(x: number, y: number, width: number, height: number, options?: PickOptions): Promise<VectorPickResult[]>;
    lasso(points: readonly (readonly [number, number])[], options?: PickOptions): Promise<VectorPickResult[]>;
    /** CSS pointer coordinates are converted to current canvas device pixels. */
    bind(canvas: HTMLCanvasElement, options?: {
        onPick?: (hit: VectorPickResult | null) => void;
        onError?: (error: unknown) => void;
        hover?: boolean;
        select?: boolean;
        invalidate?: () => void;
    }): () => void;
    dispose(): void;
}
/** Terrain ray cast against the bilinear heightfield used by draping. */
export declare function pickVectorTerrain(terrain: TerrainHeightmapInput, camera: CameraInput, x: number, y: number, viewport: {
    width: number;
    height: number;
}): TerrainPickResult | null;
