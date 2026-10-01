import type { ScatterGeneratorOptions } from "./scatter-types.js";
export declare function makeScatterTransform(translation: readonly [number, number, number], yawDegrees?: number, scale?: number): Float32Array;
export declare function bilinearScatterSample(field: Float32Array, width: number, height: number, row: number, col: number): number;
/** Native terrain contract coordinates: x/z span [0, terrainWidth], y=(h-min)*zScale. */
export declare class TerrainScatterSource {
    readonly heights: Float32Array;
    readonly slopes: Float32Array;
    readonly width: number;
    readonly height: number;
    readonly terrainWidth: number;
    readonly zScale: number;
    readonly minHeight: number;
    readonly maxHeight: number;
    readonly origin: readonly [number, number];
    constructor(heights: Float32Array, width: number, height: number, options?: {
        terrainWidth?: number;
        zScale?: number;
        domainMin?: number;
        origin?: readonly [number, number];
    });
    contractToPixel(x: number, z: number): [number, number];
    sampleHeight(row: number, col: number): number;
    sampleScaledHeight(row: number, col: number): number;
    sampleSlopeDegrees(row: number, col: number): number;
    pixelToContract(row: number, col: number): [number, number, number];
}
export declare function seededScatterTransforms(source: TerrainScatterSource, options: ScatterGeneratorOptions): Float32Array;
export declare function gridScatterTransforms(source: TerrainScatterSource, options: Omit<ScatterGeneratorOptions, "count"> & {
    spacing: number;
    jitter?: number;
}): Float32Array;
