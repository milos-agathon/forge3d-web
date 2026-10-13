import type { SceneRecipeInput, MapSceneLayerInput } from './map-scene-types.js';
import type { ValidationReportData, JsonValue } from './diagnostics.js';
import type { LabelPlanData } from './label-types.js';
import type { StyleSpecInput } from './map-style.js';
export interface CameraBookmark {
    name: string;
    eye: [number, number, number];
    target: [number, number, number];
    up?: [number, number, number];
    fovDegrees?: number;
}
export type ScenePreset = Pick<SceneRecipeInput, 'camera' | 'output' | 'lighting' | 'environment' | 'postFx' | 'shadows' | 'cascadedShadows' | 'lightingProbes' | 'materials' | 'ibl' | 'timeSeconds' | 'runtimeOptions'>;
export interface ReviewLayer {
    id: string;
    name?: string;
    description?: string;
    layers: readonly MapSceneLayerInput[];
}
export interface SceneVariant {
    id: string;
    name?: string;
    description?: string;
    activeLayerIds: readonly string[];
    preset?: Partial<ScenePreset>;
}
export interface SceneStateInput {
    base: SceneRecipeInput;
    reviewLayers?: readonly ReviewLayer[];
    variants?: readonly SceneVariant[];
    activeVariantId?: string | null;
    visibilityOverrides?: Record<string, boolean>;
    cameraBookmarks?: readonly CameraBookmark[];
    validationReport?: ValidationReportData | null;
    compiledLabelPlans?: Record<string, LabelPlanData>;
    fonts?: readonly {
        id: string;
        data: Uint8Array;
        sha256?: string;
    }[];
    style?: StyleSpecInput;
    missingAssets?: readonly string[];
    nativeSceneState?: JsonValue;
    reviewRecord?: {
        renderable: boolean;
        render_status: 'ready_for_render' | 'blocked_by_diagnostics' | 'requires_preparation';
        last_render: {
            backend: string;
            recipe_hash: string;
            executed_layer_ids: string[];
        } | null;
    };
}
/** Canonical review registry. Snapshot getters prevent callers mutating pending or active state. */
export declare class SceneState {
    #private;
    constructor(input: SceneStateInput);
    get value(): SceneStateInput;
    get fonts(): SceneStateInput['fonts'];
    getMemoryReport(): {
        cpuBytes: number;
        reviewLayerCount: number;
        variantCount: number;
    };
    get activeVariantId(): string | null;
    listVariants(): SceneVariant[];
    listReviewLayers(): ReviewLayer[];
    visibleLayerIds(): string[];
    applyVariant(id: string): SceneState;
    setReviewLayerVisible(id: string, visible: boolean): SceneState;
    effectiveRecipe(): SceneRecipeInput;
    toJSON(): JsonValue;
    static fromJSON(input: unknown, maxBytes?: number): SceneState;
}
