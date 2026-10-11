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
export declare function parseLasHeader(bytes: Uint8Array): LasHeader;
export declare function parseLasRecords(bytes: Uint8Array, count: number, header: LasHeader, options?: {
    maxBytes?: number;
    signal?: AbortSignal;
}): PointData;
