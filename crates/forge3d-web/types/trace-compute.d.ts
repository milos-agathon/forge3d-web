import type { TraceRay, TraceHit, TraceSceneInput, TraceVec3, TraceTraversalMode } from "./trace-types.js";
export declare function traceRaysGpu(scene: TraceSceneInput, rays: readonly TraceRay[], options?: {
    device?: GPUDevice;
    memoryBudgetBytes?: number;
    signal?: AbortSignal;
    mode?: TraceTraversalMode;
}): Promise<(TraceHit | undefined)[]>;
export declare function evaluateSdfGpu(scene: import("./sdf.js").SdfScene, points: readonly TraceVec3[], options?: {
    device?: GPUDevice;
    memoryBudgetBytes?: number;
    signal?: AbortSignal;
}): Promise<{
    distance: number;
    materialId: number;
}[]>;
