import type { ScatterBatchInput, ScatterBatchSnapshot, ScatterWindInput, ScatterWindSnapshot, ScatterBounds, ScatterFrameStats, ScatterMemoryReport } from "./scatter-types.js";
export type * from "./scatter-types.js";
export { makeScatterTransform, TerrainScatterSource, seededScatterTransforms, gridScatterTransforms, bilinearScatterSample } from "./scatter-source.js";
export { simplifyScatterMesh, autoScatterLodLevels, scatterMeshBounds, scatterTransformBounds } from "./scatter-mesh.js";
export declare class ScatterWindSettings {
    #private;
    constructor(input?: ScatterWindInput);
    snapshot(): ScatterWindSnapshot;
}
export declare class TerrainScatterBatch {
    #private;
    constructor(input: ScatterBatchInput);
    get instanceCount(): number;
    snapshot(): ScatterBatchSnapshot;
    instanceBounds(id: number): ScatterBounds;
    memoryReport(): ScatterMemoryReport;
}
export declare function scatterMemoryReport(batches: readonly ScatterBatchSnapshot[]): ScatterMemoryReport;
/** Revalidate and take ownership before a scene, viewer or runtime retains data. */
export declare function normalizeScatterBatches(inputs: readonly (TerrainScatterBatch | ScatterBatchInput | ScatterBatchSnapshot)[]): ScatterBatchSnapshot[];
export declare function selectScatterLods(batches: readonly ScatterBatchSnapshot[], eye: readonly [number, number, number]): ScatterFrameStats;
