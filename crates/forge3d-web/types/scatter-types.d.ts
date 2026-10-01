/** W09 mesh data uses indexed triangles and packed xyz vectors. */
export interface ScatterMesh {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
}
export interface ScatterLevel {
    mesh: ScatterMesh;
    maxDistance?: number;
}
export interface ScatterWindInput {
    enabled?: boolean;
    directionDegrees?: number;
    speed?: number;
    amplitude?: number;
    rigidity?: number;
    bendStart?: number;
    bendExtent?: number;
    gustStrength?: number;
    gustFrequency?: number;
    fadeStart?: number;
    fadeEnd?: number;
}
export type ScatterWindSnapshot = Required<ScatterWindInput>;
export interface ScatterHlodPolicy {
    distance: number;
    clusterRadius: number;
    simplifyRatio?: number;
}
export interface ScatterBlendInput {
    enabled?: boolean;
    buryDepth?: number;
    fadeDistance?: number;
}
export interface ScatterContactInput {
    enabled?: boolean;
    distance?: number;
    strength?: number;
    verticalWeight?: number;
}
export interface ScatterBatchInput {
    levels: readonly ScatterLevel[];
    /** N row-major affine 4x4 transforms. Translation occupies offsets 3, 7, 11. */
    transforms: Float32Array;
    name?: string;
    color?: readonly [number, number, number, number];
    maxDrawDistance?: number;
    wind?: ScatterWindInput;
    hlod?: ScatterHlodPolicy;
    terrainBlend?: ScatterBlendInput;
    terrainContact?: ScatterContactInput;
}
export interface ScatterBounds {
    min: [number, number, number];
    max: [number, number, number];
}
export interface ScatterCluster {
    mesh: ScatterMesh;
    instanceIndices: number[];
    bounds: ScatterBounds;
    center: [number, number, number];
    radius: number;
}
export interface ScatterBatchSnapshot {
    levels: ScatterLevel[];
    transforms: Float32Array;
    name: string;
    color: [number, number, number, number];
    maxDrawDistance: number | null;
    wind: ScatterWindSnapshot;
    hlod: Required<ScatterHlodPolicy> | null;
    terrainBlend: Required<ScatterBlendInput>;
    terrainContact: Required<ScatterContactInput>;
    bounds: ScatterBounds;
    clusters: ScatterCluster[];
}
export interface ScatterFrameStats {
    batchCount: number;
    totalInstances: number;
    visibleInstances: number;
    culledInstances: number;
    lodInstanceCounts: number[];
    hlodClusterDraws: number;
    hlodCoveredInstances: number;
    effectiveDraws: number;
}
export interface ScatterMemoryReport {
    batchCount: number;
    levelCount: number;
    totalInstances: number;
    vertexBufferBytes: number;
    indexBufferBytes: number;
    instanceBufferBytes: number;
    hlodClusterCount: number;
    hlodBufferBytes: number;
    uniformBufferBytes: number;
    totalBufferBytes: number;
    textureBytes: number;
    gpuBytes: number;
}
export interface ScatterFilters {
    minSlopeDegrees?: number;
    maxSlopeDegrees?: number;
    minElevation?: number;
    maxElevation?: number;
}
export interface ScatterGeneratorOptions {
    seed?: number;
    count: number;
    scale?: readonly [number, number];
    yawDegrees?: readonly [number, number];
    filters?: ScatterFilters;
    mask?: Float32Array;
    maxAttempts?: number;
    minDistance?: number;
    edgeMargin?: number;
    densityScale?: number;
}
