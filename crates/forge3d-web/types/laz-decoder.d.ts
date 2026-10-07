import type { LasHeader } from "./pointcloud-las.js";
import type { PointData } from "./pointcloud-types.js";
export interface LazDecodeOptions {
    maxBytes?: number;
    signal?: AbortSignal;
}
export declare function decodeLaz(bytes: Uint8Array, o?: LazDecodeOptions): Promise<PointData>;
export declare function decodeLazChunk(bytes: Uint8Array, header: LasHeader, count: number, o?: LazDecodeOptions): Promise<PointData>;
