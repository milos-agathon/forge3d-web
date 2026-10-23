import { type BvhResult } from "./bvh-result.js";
import type { TraceTriangle, TraceRay, TraceHit, BvhNode, BvhBuildOptions, BvhStats, TraceBounds } from "./trace-types.js";
export declare function intersectTriangle(t: Required<TraceTriangle>, r: Required<TraceRay>, max?: number): TraceHit | undefined;
/** Owned CPU query tree; packed layout is shared by WASM and WebGPU. */
export declare class BvhHandle {
    #private;
    readonly triangles: Required<TraceTriangle>[];
    readonly nodes: BvhNode[];
    indices: Uint32Array;
    readonly stats: BvhStats;
    constructor(input: readonly TraceTriangle[], options?: BvhBuildOptions, build?: boolean);
    /** Validated primitive storage for an external builder; no CPU tree build. */
    static prepare(input: readonly TraceTriangle[], options?: BvhBuildOptions): BvhHandle;
    clone(memoryBudgetBytes?: number): BvhHandle;
    /** Internal builder seam. Existing mutable inspection fields remain compatible. */
    install(result: BvhResult): void;
    /** Build privately; failures cannot expose partially refitted query state. */
    refitOwned(input: readonly TraceTriangle[], work: (candidate: BvhHandle) => Promise<void>): Promise<void>;
    get worldBounds(): TraceBounds;
    isGpu(): boolean;
    isCpu(): boolean;
    validatePrimitives(): void;
    getProperties(): BvhStats & {
        worldBounds: TraceBounds;
    };
    intersect(input: TraceRay): TraceHit | undefined;
    refit(input: readonly TraceTriangle[]): void;
    /** 48-byte nodes: two padded vec3 bounds, four u32 topology words. */
    packNodes(): ArrayBuffer;
    packTriangles(): ArrayBuffer;
    dispose(): void;
}
export declare const buildBvh: (triangles: readonly TraceTriangle[], options?: BvhBuildOptions) => BvhHandle;
export declare const refitBvh: (handle: BvhHandle, triangles: readonly TraceTriangle[]) => void;
