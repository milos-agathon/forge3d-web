import type { PointData, PointVec3 } from "./pointcloud-types.js";
import type { GltfLoadOptions, GltfAsset } from "./mesh-gltf.js";
export interface TileTables {
    featureTable: Record<string, unknown>;
    featureBinary: Uint8Array;
    batchTable: Record<string, unknown>;
    batchBinary: Uint8Array;
    payload: Uint8Array;
}
export declare function parseTileTables(bytes: Uint8Array, magic: "pnts" | "b3dm", maxBytes?: number): TileTables;
export interface PntsContent {
    kind: "pnts";
    points: PointData;
    pointCount: number;
    rtcCenter: PointVec3;
    featureTable: Record<string, unknown>;
    batchTable: Record<string, unknown>;
    batchBinary: Uint8Array;
}
export declare function decodePnts(bytes: Uint8Array, o?: {
    maxBytes?: number;
    signal?: AbortSignal;
}): PntsContent;
export interface B3dmContent {
    kind: "b3dm";
    gltf: GltfAsset;
    batchLength: number;
    rtcCenter: PointVec3;
    featureTable: Record<string, unknown>;
    batchTable: Record<string, unknown>;
    batchBinary: Uint8Array;
}
/** W16 unwraps b3dm. All glTF parsing belongs to the W15 decoder. */
export declare function decodeB3dm(bytes: Uint8Array, o?: GltfLoadOptions): Promise<B3dmContent>;
