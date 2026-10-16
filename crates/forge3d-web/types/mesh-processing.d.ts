import type { MeshInput, MeshBuffers, MeshBounds, Vec3 } from "./mesh.js";
export interface MeshValidationIssue {
    kind: "index-out-of-bounds" | "degenerate-triangle" | "duplicate-vertex" | "non-manifold-edge";
    index?: number;
    triangle?: number;
    first?: number;
    duplicate?: number;
    edge?: [number, number];
    count?: number;
}
export interface MeshValidationReport {
    clean: boolean;
    vertexCount: number;
    triangleCount: number;
    bounds: MeshBounds | null;
    issues: MeshValidationIssue[];
    boundaryEdges: number;
}
export declare function validateMesh(m: MeshInput): MeshValidationReport;
export interface WeldOptions {
    positionEpsilon?: number;
    uvEpsilon?: number;
}
export declare function weldMesh(input: MeshInput, o?: WeldOptions): {
    mesh: MeshBuffers;
    remap: Uint32Array;
    collapsed: number;
};
/** Row-major affine transforms, normals inverse-transpose, reflected winding/TBN. */
export declare function transformMesh(input: MeshInput, m: ArrayLike<number>): MeshBuffers;
export declare function centerMesh(m: MeshInput, target?: Vec3): MeshBuffers;
export declare function scaleMesh(m: MeshInput, scale: Vec3, pivot?: Vec3): MeshBuffers;
export declare function flipMeshAxis(m: MeshInput, axis: 0 | 1 | 2): MeshBuffers;
export declare function swapMeshAxes(m: MeshInput, a: 0 | 1 | 2, b: 0 | 1 | 2): MeshBuffers;
export interface SubdivisionOptions {
    levels?: number;
    creases?: readonly (readonly [number, number])[];
    preserveBoundary?: boolean;
    maxBytes?: number;
}
export declare function subdivideMesh(input: MeshInput, o?: SubdivisionOptions): MeshBuffers;
export interface AdaptiveSubdivisionOptions extends SubdivisionOptions {
    maxEdgeLength?: number;
    curvatureThreshold?: number;
    maxLevels?: number;
}
/** Native global level selection from longest edge and maximum dihedral angle. */
export declare function subdivideMeshAdaptive(input: MeshInput, o?: AdaptiveSubdivisionOptions): MeshBuffers;
export interface HeightmapDisplacement {
    heights: Float32Array;
    width: number;
    height: number;
    scale?: number;
    uvSpace?: boolean;
}
export declare function displaceHeightmap(input: MeshInput, o: HeightmapDisplacement): MeshBuffers;
export declare function displaceProcedural(input: MeshInput, amplitude: number, frequency: number): MeshBuffers;
export declare function simplifyMesh(input: MeshInput, ratio: number): MeshBuffers;
export declare function generateMeshLods(input: MeshInput, ratios?: readonly number[]): MeshBuffers[];
export declare function planarMeshUv(input: MeshInput, axes?: readonly [0 | 1 | 2, 0 | 1 | 2]): MeshBuffers;
export declare function sphericalMeshUv(input: MeshInput): MeshBuffers;
