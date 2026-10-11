import type { TraceCamera, TraceVec3, TraceResult, TraceTraversalMode } from "./trace-types.js";
import { TraceScene } from "./trace-scene.js";
import { TraceRng } from "./trace-math.js";
import type { RestirConfig, TraceReservoir, OnlineGuidingGrid } from "./trace-sampling.js";
export interface CpuTraceSettings {
    width: number;
    height: number;
    seed: number;
    maxBounces: number;
    camera: Required<TraceCamera>;
    mode: TraceTraversalMode;
    clamp: number;
    restir: RestirConfig | undefined;
    guiding: OnlineGuidingGrid | undefined;
}
export declare function emptyTraceResult(width: number, height: number, samples?: number): TraceResult;
export declare function cameraRay(s: CpuTraceSettings, pixel: number, rng: TraceRng): {
    origin: TraceVec3;
    direction: TraceVec3;
};
/** Analytic Beer transmittance on a finite or directional-light shadow segment. */
export declare function mediumTransmittance(scene: TraceScene, origin: TraceVec3, direction: TraceVec3, distance: number): TraceVec3;
export declare function traceCpuSample(scene: TraceScene, s: CpuTraceSettings, pixel: number, sample: number, reservoirs: TraceReservoir[]): {
    record: Float32Array;
    reservoir: TraceReservoir;
    guidingBin: number | undefined;
    guidingWeight: number | undefined;
};
/** Average linear AOVs; nearest first-sample ID/depth remains stable for integer picking. */
export declare function decodeTraceRecords(data: Float32Array, width: number, height: number, samples: number): TraceResult;
export declare function accumulateRecord(sum: Float32Array, record: Float32Array, pixel: number, sample: number): void;
