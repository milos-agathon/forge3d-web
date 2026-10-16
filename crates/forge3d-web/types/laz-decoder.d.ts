import type { LasHeader } from "./pointcloud-las.js";
import type { PointData } from "./pointcloud-types.js";
export interface LazDecodeOptions {
    maxBytes?: number;
    signal?: AbortSignal;
    /** Enqueue-to-completion deadline, including worker/module startup; default 30 s. */
    timeoutMs?: number;
}
export declare function decodeLaz(bytes: Uint8Array, options?: LazDecodeOptions): Promise<PointData>;
export declare function decodeLazChunk(bytes: Uint8Array, header: LasHeader, count: number, options?: LazDecodeOptions): Promise<PointData>;
