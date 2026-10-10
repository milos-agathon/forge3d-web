import type { PointCloudDataset, PointData, PointView, PointTraversalOptions, PointStyle, PointVec3, VisiblePointNode } from "./pointcloud-types.js";
import { PointCloudTraverser } from "./pointcloud-octree.js";
import { PointBuffer } from "./pointcloud-buffer.js";
import type { CrsTransformer } from "./crs.js";
export interface AdaptivePointBudgetOptions {
    targetFrameMs?: number;
    minPoints?: number;
    maxPoints?: number;
    sampleFrames?: number;
}
/** Hysteresis adjusts only after a complete sample window; a hard maximum remains authoritative. */
export declare class AdaptivePointBudget {
    #private;
    readonly targetFrameMs: number;
    readonly minPoints: number;
    readonly maxPoints: number;
    readonly sampleFrames: number;
    constructor(options?: AdaptivePointBudgetOptions);
    observe(frameMs: number, current: number): number;
}
export interface PointCloudLayerOptions extends PointTraversalOptions {
    name?: string;
    origin?: PointVec3;
    style?: PointStyle;
    maxBytes?: number;
    ownsDataset?: boolean;
    adaptiveBudget?: AdaptivePointBudgetOptions;
}
export interface PointCloudLayerSnapshot {
    name: string;
    origin: PointVec3;
    style: PointStyle;
    nodes: {
        key: string;
        buffer: PointBuffer;
    }[];
}
/** Commits a camera selection only after every requested node is decoded and admitted. */
export declare class PointCloudLayer {
    #private;
    readonly dataset: PointCloudDataset;
    readonly name: string;
    readonly origin: PointVec3;
    readonly traverser: PointCloudTraverser;
    readonly maxBytes: number;
    readonly ownsDataset: boolean;
    readonly adaptiveBudget: AdaptivePointBudget | undefined;
    constructor(dataset: PointCloudDataset, options?: PointCloudLayerOptions);
    setStyle(style: PointStyle): void;
    recordFrameTime(frameMs: number): void;
    update(view: PointView, signal?: AbortSignal): Promise<VisiblePointNode[]>;
    snapshot(): PointCloudLayerSnapshot;
    stats(): {
        nodesRendered: number;
        pointsRendered: number;
        cpuBytes: number;
        gpuBytes: number;
        pointBudget: number;
        selectedKeys: string[];
        disposed: boolean;
    };
    dispose(): void;
}
export declare function normalizePointStyle(style?: PointStyle): Required<PointStyle>;
export declare function reprojectPointData(data: PointData, transformer: CrsTransformer, source: string, target: string, signal?: AbortSignal): Promise<PointData>;
