import type { Forge3DMessageHandler } from "./index.js";
import type { TraceTriangle, BvhBuildOptions, TraceVec3, TraceRay } from "./trace-types.js";
import { BvhHandle } from "./bvh.js";
import { SdfScene } from "./sdf.js";
import type { SdfSnapshot } from "./sdf.js";
export declare function buildBvhWasm(triangles: readonly TraceTriangle[], options?: BvhBuildOptions): Promise<BvhHandle>;
export declare function evaluateSdfWasm(scene: SdfScene, points: readonly TraceVec3[]): Promise<{
    distance: number;
    materialId: number;
}[]>;
export type TraceWorkerRequest = {
    kind: "build-bvh";
    triangles: readonly TraceTriangle[];
    options?: BvhBuildOptions;
} | {
    kind: "trace-rays";
    triangles: readonly TraceTriangle[];
    rays: readonly TraceRay[];
} | {
    kind: "evaluate-sdf";
    scene: SdfSnapshot;
    points: readonly TraceVec3[];
};
/** Register with W02 WorkerPool/registerMessageHandlers; payloads use transferable typed buffers. */
export declare function createTraceWorkerHandler(): Forge3DMessageHandler;
