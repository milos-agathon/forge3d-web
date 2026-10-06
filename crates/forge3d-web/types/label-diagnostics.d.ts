import type { LabelDiagnostic } from "./label-types.js";
export declare function labelDiagnostic(code: string, details: Record<string, unknown>, objectId?: string | null, layerId?: string | null): LabelDiagnostic;
export declare function stableLabelJson(value: unknown): string;
export declare const labelCompare: (a: string, b: string) => number;
