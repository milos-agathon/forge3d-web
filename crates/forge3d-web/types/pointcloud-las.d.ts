import type { PointData, PointVec3, PointBounds } from "./pointcloud-types.js";
export interface LasHeader {
    version: string;
    headerSize: number;
    pointOffset: number;
    vlrCount: number;
    pointFormat: number;
    recordLength: number;
    pointCount: number;
    compressed: boolean;
    scale: PointVec3;
    offset: PointVec3;
    bounds: PointBounds;
}
export declare const LENGTHS: readonly [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
export declare function parseLasHeader(bytes: Uint8Array): LasHeader;
export declare function parseLasRecords(bytes: Uint8Array, count: number, header: LasHeader, options?: {
    maxBytes?: number;
    signal?: AbortSignal;
}): PointData;
