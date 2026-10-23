import type { TraceScene } from './trace-scene.js';
import type { CpuTraceSettings } from './trace-cpu.js';
import type { TraceResult, TraceHit } from './trace-types.js';
export { TRACE_RECORD, TRACE_UNIFORM_BYTES, TRACE_PARAMS_WGSL } from './trace-packet-layout.js';
export declare function packTraceScene(scene: TraceScene, guiding?: Float32Array, guidingBins?: number): {
    bytes: ArrayBuffer;
    offsets0: number[];
    offsets1: number[];
    counts: number[];
};
export declare function traceUniform(scene: TraceScene, s: CpuTraceSettings, packed: ReturnType<typeof packTraceScene>, sample: number): ArrayBuffer;
export declare function emptyTraceResult(width: number, height: number, samples?: number): TraceResult;
/** Average linear AOVs; nearest first-sample ID/depth remains stable for integer picking. */
export declare function decodeTraceRecords(data: Float32Array, width: number, height: number, samples: number): TraceResult;
export declare function accumulateRecord(sum: Float32Array, record: Float32Array, pixel: number, sample: number): void;
export declare const TRACE_HIT_BYTES = 64;
export declare const TRACE_QUERY_WGSL_LAYOUT = "struct Query {o:vec4f,d:vec4f};\nstruct Result {p:vec4f,n:vec4f,bary:vec4f,tags:vec4u};";
export declare function writeTraceHit(records: ArrayBuffer, index: number, hit: TraceHit | undefined): void;
export declare function readTraceHits(data: ArrayBuffer): (TraceHit | undefined)[];
