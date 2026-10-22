import type { BvhNode, BvhStats, TraceTriangle } from './trace-types.js';
export interface BvhResult {
    triangles: readonly TraceTriangle[];
    nodes: readonly BvhNode[];
    indices: Uint32Array;
    stats: Pick<BvhStats, 'backend' | 'method' | 'buildTimeMs'>;
}
/** Validates a complete candidate before any installed state is touched. */
export declare function ownBvhResult(input: BvhResult): {
    triangles: Required<TraceTriangle>[];
    nodes: BvhNode[];
    indices: Uint32Array<ArrayBuffer>;
    stats: {
        triangleCount: number;
        nodeCount: number;
        leafCount: number;
        maxDepth: number;
        memoryUsageBytes: number;
        method: "sah" | "lbvh";
        backend: "cpu" | "wasm" | "webgpu";
        buildTimeMs: number;
    };
};
