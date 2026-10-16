import type { LabelRect } from "./label-types.js";
export interface LabelDeclutterCandidate {
    labelId: number;
    position: [number, number];
    bounds: LabelRect;
    priority: number;
    cost?: number;
    selected?: boolean;
}
export interface LabelDeclutterConfig {
    algorithm?: "greedy" | "annealing";
    maxIterations?: number;
    initialTemperature?: number;
    coolingRate?: number;
    overlapWeight?: number;
    priorityWeight?: number;
    distanceWeight?: number;
    seed?: number;
    margin?: number;
}
export interface LabelDeclutterResult {
    visibleLabels: number[];
    positions: [number, [number, number]][];
    totalEnergy: number;
    iterations: number;
}
/** Browser spatial equivalent of native collision/RTree queries. Huge boxes
 * occupy the broad list instead of creating an unbounded number of grid cells. */
export declare class LabelCollisionIndex {
    #private;
    readonly cellSize: number;
    constructor(cellSize?: number);
    insert(id: number, bounds: LabelRect): void;
    query(bounds: LabelRect, margin?: number): number[];
    clear(): void;
    memoryReport(): {
        entries: number;
        cells: number;
        estimatedBytes: number;
    };
}
/** Native energy, LCG and cooling schedule, evaluated as f32. Seeded choices
 * use native 64-bit indices, preserving the monolithic reference's behavior. */
export declare function declutterLabels(input: readonly LabelDeclutterCandidate[], options?: LabelDeclutterConfig): LabelDeclutterResult;
