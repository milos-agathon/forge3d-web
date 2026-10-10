import type { BrowserByteSource, Forge3DMessageHandler } from "./index.js";
import type { PointCloudDataset, PointDatasetOptions, PointData, PointNode, PointBounds } from "./pointcloud-types.js";
import { PointSource } from "./pointcloud-source.js";
import type { LasHeader } from "./pointcloud-las.js";
import { CopcDataset } from "./copc.js";
import { EptDataset } from "./ept.js";
import type { EptDimension } from "./ept.js";
export declare class LazDataset implements PointCloudDataset {
    readonly header: LasHeader;
    readonly io: PointSource;
    readonly crs: undefined;
    readonly totalPoints: number;
    readonly bounds: PointBounds;
    private constructor();
    static open(source: BrowserByteSource, options?: PointDatasetOptions): Promise<LazDataset>;
    rootNode(): PointNode;
    children(key: string, signal?: AbortSignal): Promise<PointNode[]>;
    readPoints(key: string, signal?: AbortSignal): Promise<PointData>;
    stats(): {
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
export declare const openCopc: typeof CopcDataset.open;
export declare const openEpt: typeof EptDataset.open;
export declare const openLaz: typeof LazDataset.open;
export declare function openPointCloud(source: string | URL | Blob, options?: PointDatasetOptions & {
    format?: "copc" | "ept" | "las" | "laz";
}): Promise<PointCloudDataset>;
export type PointCloudWorkerRequest = {
    kind: "laz-file";
    bytes: Uint8Array;
    maxBytes?: number;
} | {
    kind: "laz-chunk";
    bytes: Uint8Array;
    header: LasHeader;
    count: number;
    maxBytes?: number;
} | {
    kind: "ept-binary";
    bytes: Uint8Array;
    schema: EptDimension[];
    maxBytes?: number;
};
/** Real owned workers call the local decoder; main-thread calls use a dedicated worker. */
export declare function createPointCloudWorkerHandler(): Forge3DMessageHandler;
