import type { BvhNode, TraceTriangle, TraceBounds, BvhBuildOptions } from "./trace-types.js";
export declare function normalizeTriangles(input: readonly TraceTriangle[]): Required<TraceTriangle>[];
export declare function triangleBounds(t: TraceTriangle): TraceBounds;
export declare function mortonCode(c: readonly number[], b: TraceBounds): number;
export declare function buildNodes(triangles: readonly TraceTriangle[], options: BvhBuildOptions): {
    nodes: BvhNode[];
    indices: Uint32Array;
    maxDepth: number;
};
