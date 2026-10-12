import type { TraceVec3, TraceRay, TraceBounds } from "./trace-types.js";
export declare const f: (x: number) => number;
export declare const add: (a: TraceVec3, b: TraceVec3) => TraceVec3;
export declare const sub: (a: TraceVec3, b: TraceVec3) => TraceVec3;
export declare const mul: (a: TraceVec3, s: number) => TraceVec3;
export declare const had: (a: TraceVec3, b: TraceVec3) => TraceVec3;
export declare const dot: (a: TraceVec3, b: TraceVec3) => number;
export declare const cross: (a: TraceVec3, b: TraceVec3) => TraceVec3;
export declare const length: (a: TraceVec3) => number;
export declare const unit: (a: TraceVec3) => TraceVec3;
export declare const clamp: (v: number, lo?: number, hi?: number) => number;
export declare const luminance: (v: TraceVec3) => number;
export declare function traceInvalid(message: string): never;
export declare function traceLimit(resource: string, requested: number, limit: number): never;
export declare function integer(v: number, name: string, min?: number, max?: number): number;
export declare function scalar(v: number, name: string, min?: number, max?: number): number;
export declare function vec(v: TraceVec3, name?: string): TraceVec3;
export declare function ray(r: TraceRay): Required<TraceRay>;
export declare function live(disposed: boolean): void;
export declare function cancelled(signal?: AbortSignal): void;
export declare const emptyBounds: () => TraceBounds;
export declare function unionBounds(a: TraceBounds, b: TraceBounds): TraceBounds;
export declare function boundsInterval(b: TraceBounds, r: Required<TraceRay>, max?: number): readonly [number, number] | undefined;
/** Native xorshift32 stream; independent streams use pixel and absolute sample index. */
export declare class TraceRng {
    state: number;
    constructor(state: number);
    nextU32(): number;
    next(): number;
}
export declare function sampleSeed(seed: number, pixel: number, sample: number): number;
