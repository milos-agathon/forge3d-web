import type { PointDatasetOptions, PointData } from "./pointcloud-types.js";
import { RangeScheduler } from "./index.js";
import { MemoryByteCache } from "./index.js";
import { PointCache } from "./pointcloud-common.js";
/** Dataset lifecycle, split compressed/decoded budgets and cancellable W02 worker dispatch. */
export declare class PointSource {
    readonly options: PointDatasetOptions;
    readonly scheduler: RangeScheduler;
    readonly decoded: PointCache<PointData>;
    readonly compressed: MemoryByteCache;
    readonly maxBytes: number;
    readonly maxNodes: number;
    readonly maxPoints: number;
    readonly abort: AbortController;
    disposed: boolean;
    constructor(options?: PointDatasetOptions);
    signal(signal?: AbortSignal): AbortSignal;
    range(source: string | URL | Blob, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
    read(url: string, signal?: AbortSignal): Promise<Uint8Array>;
    decode(request: unknown, main: (signal: AbortSignal) => Promise<PointData>, signal?: AbortSignal): Promise<PointData>;
    cached(key: string): PointData | undefined;
    admit(key: string, data: PointData): PointData;
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
