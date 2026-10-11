import type { PointData, PointBounds, PointVec3 } from "./pointcloud-types.js";
export declare function pointDataBytes(data: PointData): number;
export declare function validatePointData(data: PointData, maxBytes?: number): number;
export declare function clonePointData(data: PointData): PointData;
export declare class PointBuffer {
    #private;
    constructor(data: PointData, maxBytes?: number);
    get pointCount(): number;
    get cpuBytes(): number;
    get gpuBytes(): number;
    data(): PointData;
    /** Independent lifetime over immutable owned arrays; public reads still copy. */
    retain(): PointBuffer;
    point(index: number): {
        position: PointVec3;
        color: readonly number[];
        intensity: number;
        classification: number;
        id: number | undefined;
    };
    bounds(): PointBounds;
    /** Native [x,y,z,r,g,b] contract. Relative origin avoids large-coordinate f32 drift. */
    createGpuBuffer(origin?: PointVec3): Float32Array;
    /** Historical viewer contract: xyz, elevation(Y), rgb, intensity, size, padding. */
    createViewerGpuBuffer(bounds?: PointBounds): Float32Array;
    dispose(): void;
}
export declare function transferPointData(data: PointData): {
    data: PointData;
    transfer: ArrayBuffer[];
};
