import type { TraceVec3, TraceLight } from "./trace-types.js";
export interface RestirConfig {
    initialCandidates: number;
    temporalNeighbors: number;
    spatialNeighbors: number;
    spatialRadius: number;
    depthThreshold: number;
    normalThreshold: number;
    maxTemporalAge: number;
    biasCorrection: boolean;
}
export declare function normalizeRestirConfig(input?: Partial<RestirConfig>): RestirConfig;
/** Vose alias sampling, preserving the native weighted-light contract. */
export declare class AliasTable {
    readonly probability: Float32Array;
    readonly alias: Uint32Array;
    readonly pdf: Float32Array;
    constructor(weights: readonly number[]);
    sample(u: number, v: number): {
        index: number;
        pdf: number;
    } | undefined;
}
export interface TraceReservoir {
    sample: number;
    weightSum: number;
    selectedTarget: number;
    count: number;
    age: number;
    position?: TraceVec3;
    normal?: TraceVec3;
    depth?: number;
    u?: number;
    v?: number;
}
export declare const emptyReservoir: () => TraceReservoir;
export declare function updateReservoir(r: TraceReservoir, sample: number, target: number, proposalPdf: number, u: number, count?: number): void;
export declare function mergeReservoir(r: TraceReservoir, source: TraceReservoir, target: number, u: number, biasCorrection?: boolean): void;
export declare const reservoirWeight: (r: TraceReservoir) => number;
export declare class RestirDI {
    #private;
    readonly config: RestirConfig;
    constructor(config?: Partial<RestirConfig>);
    get numLights(): number;
    get lights(): readonly TraceLight[];
    addLight(light: TraceLight, weight?: number): number;
    setLights(lights: readonly TraceLight[], weights?: readonly number[]): void;
    clearLights(): void;
    sampleLight(u: number, v: number): {
        index: number;
        pdf: number;
    } | undefined;
    getStatistics(): {
        numLights: number;
        config: RestirConfig;
    };
    calculateVarianceReduction(reference: Float32Array, test: Float32Array): number;
}
/** Native OnlineGuidingGrid: one unit prior per directional bin. */
export declare class OnlineGuidingGrid {
    #private;
    readonly width: number;
    readonly height: number;
    readonly binsPerCell: number;
    constructor(width: number, height: number, binsPerCell?: number, memoryBudgetBytes?: number);
    dims(): readonly [number, number, number];
    update(x: number, y: number, bin: number, weight?: number): void;
    pdf(x: number, y: number): Float32Array;
    snapshot(): Float32Array;
    restore(weights: Float32Array): void;
    reset(): void;
    dispose(): void;
}
export declare function hgPhase(cosTheta: number, g: number): number;
export declare function sampleHg(u1: number, u2: number, g: number): {
    direction: TraceVec3;
    pdf: number;
};
export declare function localToWorld(local: TraceVec3, normal: TraceVec3): TraceVec3;
export declare function cosineDirection(u1: number, u2: number, normal: TraceVec3): TraceVec3;
