import { TerrainScatterBatch } from "./index.js";
import type { ScatterBatchInput, ScatterLevel } from "./scatter-types.js";
/** Owned, packed triangle buffers. Empty optional attributes mean absent. */
export interface MeshBuffers {
    positions: Float32Array;
    indices: Uint32Array;
    normals: Float32Array;
    uvs: Float32Array;
    tangents: Float32Array;
}
export interface MeshInput {
    positions: Float32Array;
    indices: Uint32Array;
    normals?: Float32Array;
    uvs?: Float32Array;
    tangents?: Float32Array;
}
export interface MeshBounds {
    min: [number, number, number];
    max: [number, number, number];
}
export declare const MAX_MESH_BYTES: number;
export declare function meshError(message: string): never;
export declare function meshLimit(bytes: number, maximum?: number): void;
export declare function meshNumber(n: number, name: string, min?: number, max?: number): number;
export declare function meshInteger(n: number, name: string, min?: number, max?: number): number;
export declare function meshBytes(m: MeshInput): number;
export declare function checkMesh(m: MeshInput, checkIndices?: boolean): void;
export declare function cloneMesh(m: MeshInput): MeshBuffers;
export declare function meshBounds(m: MeshInput): MeshBounds | null;
export type Vec3 = readonly [number, number, number];
export declare function sub(a: Vec3, b: Vec3): [number, number, number];
export declare function cross(a: Vec3, b: Vec3): [number, number, number];
export declare function dot(a: Vec3, b: Vec3): number;
export declare function unit(a: Vec3): [number, number, number];
export declare function vertex(m: MeshInput, i: number): [number, number, number];
/** Area weighting for subdivision/displacement; equal weighting matches native weld. */
export declare function recomputeMeshNormals(input: MeshInput, weighting?: "area" | "equal"): MeshBuffers;
export declare function attachMeshTangents(input: MeshInput): MeshBuffers;
/** Transfer a dedicated copy; borrowing and SharedArrayBuffers never detach caller data. */
export declare function transferMesh(input: MeshInput): {
    mesh: MeshBuffers;
    transfer: ArrayBuffer[];
};
export declare function mergeMeshes(inputs: readonly MeshInput[]): MeshBuffers;
export declare const MESH_IDENTITY: Float32Array<ArrayBuffer>;
/** General meshes use the shared W09 bounded instancing, LOD, AOV and recovery path. */
export declare class MeshLayer {
    #private;
    constructor(mesh: MeshInput, options?: Partial<Omit<ScatterBatchInput, "levels">>);
    get disposed(): boolean;
    get cpuBytes(): number;
    mesh(): MeshBuffers;
    toBatch(levels?: readonly ScatterLevel[]): TerrainScatterBatch;
    dispose(): void;
}
