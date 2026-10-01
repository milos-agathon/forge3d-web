import type { TerrainScatterSource } from "./scatter-source.js";
import { type ProbeReflectionMaterial, type ProbeReflectionLighting } from "./probe-bake-options.js";
export { getTerrainProbeMaterialDefaults } from "./probe-bake-options.js";
export type { ProbeReflectionMaterial, ProbeReflectionLighting, } from "./probe-bake-options.js";
export interface TerrainProbeGrid {
    origin: readonly [number, number];
    spacing: readonly [number, number];
    dims: readonly [number, number];
    heightOffset?: number;
    edgeBlend?: readonly [number, number];
}
export interface TerrainProbeBakeOptions {
    /** Irradiance grid. This retains the original combined-grid API name. */
    grid: TerrainProbeGrid;
    /** Optional native-shape reflection grid. Omission reuses `grid`. */
    reflectionGrid?: TerrainProbeGrid;
    skyColor?: readonly [number, number, number];
    skyIntensity?: number;
    rayCount?: number;
    maxTraceDistance?: number;
    /** Power of two in [1, 64]; native baking raises values below four to four. */
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
    /** World-space terrain bounds used by native reflection box projection. */
    sceneBounds?: {
        min: readonly [number, number, number];
        max: readonly [number, number, number];
    };
    /** Irradiance grid and positions; legacy combined snapshots retain this shape. */
    grid: Required<TerrainProbeGrid>;
    positions: Float32Array;
    /** Probe-major: nine native z-up SH L2 basis coefficients, packed RGB. */
    coefficients: Float32Array;
    /** Paired additive fields for an independent reflection grid. */
    reflectionGrid?: Required<TerrainProbeGrid>;
    reflectionPositions?: Float32Array;
    reflectionResolution: number;
    reflectionMips: Float32Array[];
    strength: number;
    reflectionStrength: number;
    debug: "none" | "irradiance" | "reflections" | "weight";
}
export interface TerrainProbeMemoryReport {
    /** Legacy field: number of irradiance probes. */
    probeCount: number;
    irradianceProbeCount: number;
    reflectionProbeCount: number;
    coefficientBytes: number;
    reflectionBytes: number;
    /** Bytes owned by snapshot position fields; legacy snapshots own one shared field. */
    positionBytes: number;
    irradiancePositionBytes: number;
    reflectionPositionBytes: number;
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
/**
 * W09 probe storage ABI v2: eight header vectors, ten vectors per irradiance
 * probe, one position vector per reflection probe, then mip-major cubemaps.
 */
export declare function packTerrainProbes(value: TerrainProbeSnapshot): Float32Array;
