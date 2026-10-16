import type { ScatterMesh, ScatterBounds, ScatterLevel } from "./scatter-types.js";
export declare function scatterInvalid(message: string): never;
export declare function finite(value: number, name: string, min?: number, max?: number): number;
export declare function validateScatterMesh(mesh: ScatterMesh): ScatterMesh;
export declare function scatterMeshBounds(mesh: ScatterMesh): ScatterBounds;
export declare function scatterTransformPoint(m: ArrayLike<number>, p: ArrayLike<number>): [number, number, number];
export declare function scatterTransformBounds(bounds: ScatterBounds, m: ArrayLike<number>): ScatterBounds;
export declare function mergeScatterBounds(bounds: readonly ScatterBounds[]): ScatterBounds;
/** Deterministic QEM edge collapse, preserving normals through area-weighted recomputation. */
export declare function simplifyScatterMesh(input: ScatterMesh, ratio: number): ScatterMesh;
export declare function recomputeScatterNormals(mesh: ScatterMesh): void;
export declare function autoScatterLodLevels(mesh: ScatterMesh, options?: {
    ratios?: readonly number[];
    distances?: readonly number[];
    minTriangles?: number;
}): ScatterLevel[];
