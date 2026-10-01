import type { TerrainScatterSource } from "./scatter-source.js";
import { type ProbeReflectionMaterial, type ProbeReflectionLighting } from "./probe-bake-options.js";
export { getTerrainProbeMaterialDefaults } from "./probe-bake-options.js";
export type { ProbeReflectionMaterial, ProbeReflectionLighting } from "./probe-bake-options.js";
export interface TerrainProbeGrid {
    origin: readonly [number, number];
    spacing: readonly [number, number];
    dims: readonly [number, number];
    heightOffset?: number;
    edgeBlend?: readonly [number, number];
}
export interface TerrainProbeBakeOptions {
    grid: TerrainProbeGrid;
    skyColor?: readonly [number, number, number];
    skyIntensity?: number;
    rayCount?: number;
    maxTraceDistance?: number;
    reflectionResolution?: number;
    reflectionSamples?: number;
    terrainColor?: readonly [number, number, number];
    signal?: AbortSignal;
    reflectionMaterial?: Partial<ProbeReflectionMaterial>;
    reflectionLighting?: ProbeReflectionLighting;
    /** CPU bake output admission; defaults to 64 MiB. GPU commits use the runtime ledger. */
    memoryBudgetBytes?: number;
}
export interface TerrainProbeSnapshot {
    grid: Required<TerrainProbeGrid>;
    positions: Float32Array;
    /** Probe-major: nine native z-up SH L2 basis coefficients, packed RGB. */
    coefficients: Float32Array;
    reflectionResolution: number;
    reflectionMips: Float32Array[];
    strength: number;
    reflectionStrength: number;
    debug: "none" | "irradiance" | "reflections" | "weight";
}
export interface TerrainProbeMemoryReport {
    probeCount: number;
    coefficientBytes: number;
    reflectionBytes: number;
    positionBytes: number;
    gpuBytes: number;
}
export declare function probeShBasis(direction: readonly [number, number, number]): number[];
export declare function probeCubeDirection(face: number, u: number, v: number): [number, number, number];
export declare class TerrainLightingProbes {
    #private;
    constructor(snapshot: TerrainProbeSnapshot);
    static bake(source: TerrainScatterSource, options: TerrainProbeBakeOptions): Promise<TerrainLightingProbes>;
    get disposed(): boolean;
    snapshot(): TerrainProbeSnapshot;
    setStrength(irradiance: number, reflection?: number): void;
    setDebug(debug: TerrainProbeSnapshot["debug"]): void;
    memoryReport(): TerrainProbeMemoryReport;
    dispose(): void;
}
export declare function normalizeProbeGrid(input: TerrainProbeGrid): Required<TerrainProbeGrid>;
export declare function validateProbeSnapshot(input: TerrainProbeSnapshot): void;
/** Storage buffer is vec4-aligned, with 4 header vectors then 10 vectors per probe. */
export declare function packTerrainProbes(v: TerrainProbeSnapshot): Float32Array;
