import type { PersistentByteCache, Forge3DWorkerPool } from "./index.js";
import type { RangeFetchLike } from "./index.js";
export type PointVec3 = readonly [number, number, number];
export interface PointBounds {
    min: PointVec3;
    max: PointVec3;
}
/** Source coordinates retain Float64 precision. GPU coordinates are relative to an origin. */
export interface PointData {
    positions: Float32Array | Float64Array;
    colors?: Uint8Array;
    colorComponents?: 3 | 4;
    intensities?: Uint16Array;
    classifications?: Uint8Array;
    normals?: Float32Array;
    ids?: Uint32Array;
}
export interface PointNode {
    key: string;
    bounds: PointBounds;
    pointCount: number;
    spacing: number;
    depth: number;
    children: string[];
}
export interface PointCloudDataset {
    readonly bounds: PointBounds;
    readonly totalPoints: number;
    readonly crs: string | undefined;
    rootNode(): PointNode;
    children(key: string, signal?: AbortSignal): Promise<PointNode[]>;
    readPoints(key: string, signal?: AbortSignal): Promise<PointData>;
    dispose(): void;
}
export interface PointDatasetOptions {
    signal?: AbortSignal;
    maxBytes?: number;
    cacheBytes?: number;
    maxNodes?: number;
    maxPoints?: number;
    persistentCache?: PersistentByteCache;
    fetch?: RangeFetchLike;
    workerPool?: Forge3DWorkerPool;
}
export interface PointView {
    position: PointVec3;
    viewportHeight: number;
    fovY: number;
    /** Column-major WebGPU view-projection matrix (depth 0..1). */
    viewProjection?: readonly number[] | Float32Array | Float64Array;
}
export interface PointTraversalOptions {
    pointBudget?: number;
    maxDepth?: number;
    minSpacing?: number;
    sseThreshold?: number;
    /** Native leaf selection or additive COPC/EPT samples. */
    mode?: "replace" | "add";
}
export interface VisiblePointNode extends PointNode {
    priority: number;
    sse: number;
}
export interface PointStyle {
    pointSize?: number;
    shape?: "circle" | "square";
    colorMode?: "rgb" | "elevation" | "intensity" | "classification";
    color?: readonly [number, number, number, number];
    opacity?: number;
}
