import { BvhHandle } from "./bvh.js";
import type { TraceTriangle, BvhBuildOptions } from "./trace-types.js";
export declare function buildBvhGpu(triangles: readonly TraceTriangle[], options?: BvhBuildOptions & {
    device?: GPUDevice;
    signal?: AbortSignal;
}): Promise<BvhHandle>;
export declare function refitBvhGpu(handle: BvhHandle, triangles: readonly TraceTriangle[], options?: {
    device?: GPUDevice;
    memoryBudgetBytes?: number;
    signal?: AbortSignal;
}): Promise<void>;
