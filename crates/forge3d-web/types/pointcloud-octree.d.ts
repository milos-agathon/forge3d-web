import type { PointBounds, PointView, PointCloudDataset, PointTraversalOptions, VisiblePointNode } from "./pointcloud-types.js";
export declare class OctreeKey {
    readonly depth: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    constructor(depth?: number, x?: number, y?: number, z?: number);
    static parse(key: string): OctreeKey;
    child(octant: number): OctreeKey;
    parent(): OctreeKey | null;
    toString(): string;
    bounds(root: PointBounds): PointBounds;
}
export declare function computePointSse(bounds: PointBounds, view: PointView): number;
export declare class PointCloudTraverser {
    #private;
    pointBudget: number;
    maxDepth: number;
    minSpacing: number;
    sseThreshold: number;
    mode: "replace" | "add";
    constructor(o?: PointTraversalOptions);
    setPointBudget(budget: number): void;
    visibleNodes(dataset: PointCloudDataset, view: PointView, signal?: AbortSignal): Promise<VisiblePointNode[]>;
}
