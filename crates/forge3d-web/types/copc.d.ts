import type { PointData, PointBounds, PointVec3, PointNode, PointDatasetOptions, PointCloudDataset } from "./pointcloud-types.js";
import { PointSource } from "./pointcloud-source.js";
import type { LasHeader } from "./pointcloud-las.js";
export interface CopcInfo {
    center: PointVec3;
    halfSize: number;
    spacing: number;
    rootHierarchyOffset: number;
    rootHierarchySize: number;
    gpsTimeMinimum: number;
    gpsTimeMaximum: number;
}
export interface CopcHierarchyEntry {
    key: string;
    offset: number;
    byteSize: number;
    pointCount: number;
}
export declare function parseCopcHierarchy(bytes: Uint8Array): CopcHierarchyEntry[];
export declare class CopcDataset implements PointCloudDataset {
    #private;
    readonly source: string | URL | Blob;
    readonly header: LasHeader;
    readonly info: CopcInfo;
    readonly io: PointSource;
    readonly crs: string | undefined;
    readonly bounds: PointBounds;
    readonly totalPoints: number;
    readonly hierarchy: Map<string, CopcHierarchyEntry>;
    private constructor();
    static open(source: string | URL | Blob, options?: PointDatasetOptions): Promise<CopcDataset>;
    rootNode(): PointNode;
    children(key: string, signal?: AbortSignal): Promise<PointNode[]>;
    readPoints(key: string, signal?: AbortSignal): Promise<PointData>;
    stats(): {
        nodeCount: number;
        totalPoints: number;
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
