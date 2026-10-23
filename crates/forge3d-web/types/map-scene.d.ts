import { Frame } from './index.js';
import { ValidationReport, type ValidationReportData, type JsonValue } from './diagnostics.js';
import { SceneRecipe } from './map-recipe.js';
import { type MapSceneRenderContext } from './map-render-context.js';
import type { SceneRecipeInput, MapSceneRenderOptions, MapSceneResourceSummary, MapFrameMetrics } from './map-scene-types.js';
import type { LabelPlanData } from './label-types.js';
import { SceneState, type SceneStateInput } from './scene-review.js';
import { type SaveBundleOptions, type BundleOptions } from './bundle.js';
import { StyleSpec } from './map-style.js';
import type { VectorFeature } from './vector-types.js';
import type { BrowserByteSource } from './index.js';
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
    /** Own a shared device for related real draws, releasing it on success or failure. */
    static withRenderContext<T>(work: (context: MapSceneRenderContext) => Promise<T>): Promise<T>;
    constructor(recipe: SceneRecipe | SceneRecipeInput);
    get recipe(): SceneRecipe;
    get sceneState(): SceneState;
    listVariants(): import("./scene-review.js").SceneVariant[];
    listReviewLayers(): import("./scene-review.js").ReviewLayer[];
    getActiveVariantId(): string | null;
    getReviewLayerVisible(id: string): boolean;
    get disposed(): boolean;
    get lastValidationReport(): ValidationReport | null;
    get compiledLabelPlans(): Record<string, LabelPlanData>;
    get resources(): MapSceneResourceSummary[];
    getMemoryReport(): {
        cpuBytes: number;
        reviewStateBytes: number;
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
    static fromSceneState(input: SceneState | SceneStateInput): MapScene;
    static fromStyle(recipe: SceneRecipeInput, style: StyleSpec, sources: Record<string, readonly VectorFeature[]>, options?: {
        zoom?: number;
    }): MapScene;
    applyVariant(id: string, options?: {
        signal?: AbortSignal;
    }): Promise<void>;
    setReviewLayerVisible(id: string, visible: boolean, options?: {
        signal?: AbortSignal;
    }): Promise<void>;
    /** Resolve a logical sprite/glyph URL from the archive adopted by loadBundle. */
    resolveBundleAsset(url: string): string;
    saveBundle(options?: SaveBundleOptions): Promise<Blob>;
    static loadBundle(source: BrowserByteSource | FileSystemFileHandle, options?: BundleOptions): Promise<MapScene>;
    dispose(): void;
}
