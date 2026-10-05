import type { LabelCandidate, LabelPoint, LabelRecord, LabelRect } from "./label-types.js";
export declare function labelCoordinates(value: unknown): LabelPoint | undefined;
export declare function labelBounds(points: readonly LabelPoint[]): LabelRect;
export declare function labelRect(value: readonly number[]): LabelRect;
export declare function labelRectsIntersect(a: readonly number[], b: readonly number[]): boolean;
export declare function labelSeedUnit(key: string): number;
export declare function makeLabelCandidate(id: string, type: string, anchor: LabelPoint, score: number, key: string, sample: Record<string, unknown>, details?: Record<string, unknown>): LabelCandidate;
export declare function pointLabelCandidates(id: string, p: LabelPoint, score: number, key: string, r: LabelRecord, seed: number, sample: Record<string, unknown>): LabelCandidate[];
export declare function labelLinePoints(value: unknown): LabelPoint[] | undefined;
export declare function labelLineLength(points: readonly LabelPoint[]): number;
export declare function interpolateLabelLine(points: readonly LabelPoint[], distance: number): {
    point: LabelPoint;
    angle: number;
};
export declare function lineLabelCandidates(id: string, points: LabelPoint[], score: number, key: string, r: LabelRecord, sample: Record<string, unknown>): LabelCandidate[];
export declare function polygonLabelCandidates(id: string, value: unknown, score: number, key: string, sample: Record<string, unknown>): {
    selected: LabelCandidate;
    candidates: LabelCandidate[];
} | undefined;
