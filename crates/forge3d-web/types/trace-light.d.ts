import type { TraceLight, TraceVec3 } from "./trace-types.js";
export declare function sampleTraceLight(light: Required<TraceLight>, point: TraceVec3, u?: number, v?: number): {
    direction: TraceVec3;
    distance: number;
    radiance: TraceVec3;
};
