import type { PointData, PointBounds, PointNode, PointDatasetOptions, PointCloudDataset } from "./pointcloud-types.js";
import { PointSource } from "./pointcloud-source.js";
export interface EptDimension {
    name: string;
    type: "signed" | "unsigned" | "floating";
    size: number;
    scale?: number;
    offset?: number;
}
export interface EptInfo {
    bounds: number[];
    boundsConforming?: number[];
    points: number;
    span: number;
    schema: EptDimension[];
    dataType: "binary" | "laszip" | "zstandard";
    hierarchyType: "json";
    srs?: {
        wkt?: string;
        authority?: string;
        horizontal?: string | number;
    };
}
export declare function parseEptBinary(bytes: Uint8Array, schema: readonly EptDimension[], o?: {
    maxBytes?: number;
    signal?: AbortSignal;
}): PointData;
export declare class EptDataset implements PointCloudDataset {
    #private;
    readonly url: string;
    readonly info: EptInfo;
    readonly io: PointSource;
    readonly bounds: PointBounds;
    readonly totalPoints: number;
    readonly crs: string | undefined;
    readonly hierarchy: Map<string, number>;
    private constructor();
    static open(url: string | URL, options?: PointDatasetOptions): Promise<EptDataset>;
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
