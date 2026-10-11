import { BvhHandle } from "./bvh.js";
import { SdfScene } from "./sdf.js";
import type { TraceSceneInput, TraceMaterial, TraceLight, TraceMedium, TraceVec3, TraceRay, TraceHit, TraceTraversalMode } from "./trace-types.js";
export interface EffectiveTraceMaterial {
    albedo: TraceVec3;
    emission: TraceVec3;
    metallic: number;
    roughness: number;
    ior: number;
}
export declare const normalizeTraceMaterial: (m: TraceMaterial) => EffectiveTraceMaterial;
export declare function color(v: TraceVec3, name: string, max?: number): TraceVec3;
export declare function normalizeTraceCamera(input: import("./trace-types.js").TraceCamera): Required<import("./trace-types.js").TraceCamera>;
export declare class TraceScene {
    readonly bvh: BvhHandle | undefined;
    readonly sdf: SdfScene | undefined;
    readonly materials: EffectiveTraceMaterial[];
    readonly lights: Required<TraceLight>[];
    readonly environment: TraceVec3;
    readonly medium: TraceMedium | undefined;
    constructor(input?: TraceSceneInput, budget?: number, validateMaterials?: boolean);
    intersect(input: TraceRay, mode?: TraceTraversalMode): TraceHit | undefined;
    snapshot(): unknown;
    dispose(): void;
}
