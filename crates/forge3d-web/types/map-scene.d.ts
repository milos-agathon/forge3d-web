import { Frame } from "./index.js";
import { ValidationReport, type ValidationReportData, type JsonValue } from './diagnostics.js';
import { SceneRecipe } from './map-recipe.js';
import type { SceneRecipeInput, MapSceneRenderOptions, MapSceneResourceSummary, MapFrameMetrics } from './map-scene-types.js';
import type { LabelPlanData } from './label-types.js';
export interface MapSceneRenderResult {
    blob: Blob;
    frame: Frame;
    report: ValidationReport;
    executedLayerIds: string[];
    resources: MapSceneResourceSummary[];
    metrics: MapFrameMetrics;
    recipeHash: string;
}
export interface MapSceneReviewRecord {
    schema: 'forge3d.mapscene.review.v1';
    recipe: JsonValue;
    recipe_hash: string;
    validation_report_hash: string;
    validation_report: ValidationReportData;
    resources: MapSceneResourceSummary[];
    compiled_label_plans: Record<string, LabelPlanData>;
    renderable: boolean;
    render_status: 'ready_for_render' | 'blocked_by_diagnostics' | 'requires_preparation';
    last_render: {
        backend: string;
        executed_layer_ids: string[];
        recipe_hash: string;
    } | null;
}
/** Owns recipe resources, cancellation and output. GPU owners are disposed after each render. */
export declare class MapScene {
    #private;
    readonly recipe: SceneRecipe;
    constructor(recipe: SceneRecipe | SceneRecipeInput);
    get disposed(): boolean;
    get lastValidationReport(): ValidationReport | null;
    get compiledLabelPlans(): Record<string, LabelPlanData>;
    get resources(): MapSceneResourceSummary[];
    getMemoryReport(): {
        cpuBytes: number;
        gpuBytes: number;
        peakGpuBytes: number;
        resourceCount: number;
        disposed: boolean;
    };
    validate(): ValidationReport;
    prepare(options?: Pick<MapSceneRenderOptions, 'signal' | 'onProgress'>): Promise<ValidationReport>;
    render(options?: MapSceneRenderOptions): Promise<MapSceneRenderResult>;
    reviewRecord(): Promise<MapSceneReviewRecord>;
    toJSON(): JsonValue;
    static fromJSON(input: unknown): MapScene;
    dispose(): void;
}
