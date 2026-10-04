import { LabelPlan } from "./label-plan.js";
import type { LabelDiagnostic, LabelRecord, LabelPlanOptions, LabelTerrainSampler } from "./label-types.js";
export interface LabelFeature {
    id?: string | number;
    feature_id?: string;
    source_id?: string;
    type?: string;
    properties?: Record<string, unknown>;
    geometry?: {
        type?: string;
        coordinates?: unknown;
    };
    [key: string]: unknown;
}
export interface LabelFeatureOptions {
    text?: unknown;
    crs?: string;
    targetCrs?: string;
    terrainSampling?: "auto" | "required" | "flat";
    terrainSampler?: LabelTerrainSampler;
    layerId?: string;
    metadata?: Record<string, unknown>;
    typography?: Record<string, unknown>;
    glyphAtlas?: LabelPlanOptions["glyph_atlas"];
    /** W14 can supply PROJ here. A different CRS always requires a real transform. */
    transformCoords?: (coordinates: readonly (readonly number[])[], fromCrs: string, toCrs: string) => readonly (readonly number[])[];
}
/** Native label feature recipe, separate from the live GPU layer. Native plans
 * use [map x,map y,elevation]. World rendering uses [world x,world y,world z]. */
export declare class LabelFeatureSource {
    readonly labels: LabelRecord[];
    readonly diagnostics: LabelDiagnostic[];
    readonly metadata: Record<string, unknown>;
    readonly layerId: string;
    readonly typography: Record<string, unknown>;
    readonly glyphAtlas: LabelPlanOptions["glyph_atlas"];
    private constructor();
    static fromFeatures(features: Iterable<LabelFeature>, options?: LabelFeatureOptions): LabelFeatureSource;
    static fromRows(rows: Iterable<{
        id: string | number;
        properties: Record<string, unknown>;
        geometry: LabelFeature["geometry"];
    }>, options?: LabelFeatureOptions): LabelFeatureSource;
    static fromStyleLayer(features: Iterable<LabelFeature>, style: {
        layout?: {
            "text-field"?: unknown;
        };
        text?: unknown;
        text_field?: unknown;
    }, options?: LabelFeatureOptions): LabelFeatureSource;
    compileLabels(options: Omit<LabelPlanOptions, "labels">): LabelPlan;
    validate(options: Omit<LabelPlanOptions, "labels">): {
        plan: LabelPlan;
        diagnostics: LabelDiagnostic[];
        summary: {
            layer_id: string;
            support_level: string;
            compiled_label_plan: {
                accepted_count: number;
                rejected_count: number;
                seed: number;
            };
        };
    };
    toJSON(): Record<string, unknown>;
}
