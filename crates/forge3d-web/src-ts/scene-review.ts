import { Forge3DError } from "./runtime-failure.js";
import { SceneRecipe, encodeMapData, decodeMapData, mapRecipeByteLimit } from './map-recipe.js';
import type { SceneRecipeInput, MapSceneLayerInput } from './map-scene-types.js';
import type { ValidationReportData, JsonValue } from './diagnostics.js';
import type { LabelPlanData } from './label-types.js';
import type { StyleSpecInput } from './map-style.js';
export interface CameraBookmark { name: string; eye: [number, number, number]; target: [number, number, number]; up?: [number, number, number]; fovDegrees?: number; }
export type ScenePreset = Pick<SceneRecipeInput, 'camera' | 'output' | 'lighting' | 'environment' | 'postFx' | 'shadows' | 'cascadedShadows' | 'lightingProbes' | 'materials' | 'ibl' | 'timeSeconds' | 'runtimeOptions'>;
export interface ReviewLayer { id: string; name?: string; description?: string; layers: readonly MapSceneLayerInput[]; }
export interface SceneVariant { id: string; name?: string; description?: string; activeLayerIds: readonly string[]; preset?: Partial<ScenePreset>; }
export interface SceneStateInput { base: SceneRecipeInput; reviewLayers?: readonly ReviewLayer[]; variants?: readonly SceneVariant[]; activeVariantId?: string | null; visibilityOverrides?: Record<string, boolean>; cameraBookmarks?: readonly CameraBookmark[]; validationReport?: ValidationReportData | null; compiledLabelPlans?: Record<string, LabelPlanData>; fonts?: readonly { id: string; data: Uint8Array; sha256?: string }[]; style?: StyleSpecInput; /** Additional finite glyph requests for offline loaders. */ styleGlyphRequests?: readonly { fontStack: string; text: string }[]; missingAssets?: readonly string[]; nativeSceneState?: JsonValue; reviewRecord?: { renderable: boolean; render_status: 'ready_for_render' | 'blocked_by_diagnostics' | 'requires_preparation'; last_render: { backend: string; recipe_hash: string; executed_layer_ids: string[] } | null }; }
const presetFields = new Set('camera output lighting environment postFx shadows cascadedShadows lightingProbes materials ibl timeSeconds runtimeOptions'.split(' '));
function invalid(message: string): never { throw new Forge3DError('INVALID_INPUT', message, { reason: 'invalid-scene-state' }); }
function bytes(value: unknown): number { if (ArrayBuffer.isView(value)) return value.byteLength; if (Array.isArray(value)) return value.reduce((n, v) => n + bytes(v), 0); if (value && typeof value === 'object') return Object.values(value).reduce<number>((n, v) => n + bytes(v), 0); return typeof value === 'string' ? value.length * 2 : typeof value === 'number' ? 8 : 0; }
/** Canonical review registry. Snapshot getters prevent callers mutating pending or active state. */
export class SceneState {
    #state: SceneStateInput;
    #bytes: number;
    constructor(input: SceneStateInput) {
        this.#state = structuredClone(input);
        this.#state.base = new SceneRecipe(input.base).value;
        this.#state.reviewLayers = [...input.reviewLayers ?? []];
        this.#state.variants = [...input.variants ?? []];
        this.#state.activeVariantId = input.activeVariantId ?? null;
        this.#state.visibilityOverrides = { ...input.visibilityOverrides ?? {} };
        const layers = new Set<string>(), variants = new Set<string>();
        const id = (value: string, set: Set<string>, kind: string) => { if (typeof value !== 'string' || !value.trim() || set.has(value)) invalid(`Invalid or duplicate ${kind} ID: ${value}`); set.add(value); };
        const rendered = new Set<string>();
        for (const layer of this.#state.base.layers ?? []) id(layer.layerId, rendered, 'render layer');
        for (const layer of this.#state.reviewLayers) {
            id(layer.id, layers, 'review layer');
            if (!Array.isArray(layer.layers)) invalid('Review layers require layer payloads');
            for (const payload of layer.layers) id(payload.layerId, rendered, 'render layer');
        }
        for (const variant of this.#state.variants) {
            id(variant.id, variants, 'variant');
            if (!Array.isArray(variant.activeLayerIds) || new Set(variant.activeLayerIds).size !== variant.activeLayerIds.length) invalid('Variant layer IDs must be a unique list');
            for (const layerId of variant.activeLayerIds) if (!layers.has(layerId)) invalid(`Unknown review layer: ${layerId}`);
            if (variant.preset) for (const key of Object.keys(variant.preset)) if (!presetFields.has(key)) invalid(`Unsupported preset field: ${key}`);
        }
        if (this.#state.activeVariantId !== null && !variants.has(this.#state.activeVariantId)) invalid('Unknown active variant');
        for (const [layerId, visible] of Object.entries(this.#state.visibilityOverrides)) if (!layers.has(layerId) || typeof visible !== 'boolean') invalid('Invalid review visibility override');
        const names = new Set<string>();
        for (const b of input.cameraBookmarks ?? []) {
            id(b.name, names, 'bookmark');
            for (const p of [b.eye, b.target, b.up ?? [0, 1, 0]]) if (!Array.isArray(p) || p.length !== 3 || p.some(n => !Number.isFinite(n))) invalid('Invalid camera bookmark');
            if (b.fovDegrees !== undefined && (!Number.isFinite(b.fovDegrees) || b.fovDegrees <= 0 || b.fovDegrees >= 180)) invalid('Invalid bookmark field of view');
        }
        encodeMapData(this.#state, mapRecipeByteLimit(this.#state.base));
        this.#bytes = bytes(this.#state);
    }
    get value(): SceneStateInput { return structuredClone(this.#state); }
    get fonts(): SceneStateInput['fonts'] { return this.#state.fonts ? structuredClone(this.#state.fonts) : undefined; }
    getMemoryReport() { return { cpuBytes: this.#bytes, reviewLayerCount: this.#state.reviewLayers!.length, variantCount: this.#state.variants!.length }; }
    get activeVariantId(): string | null { return this.#state.activeVariantId ?? null; }
    listVariants(): SceneVariant[] { return structuredClone([...this.#state.variants ?? []]); }
    listReviewLayers(): ReviewLayer[] { return structuredClone([...this.#state.reviewLayers ?? []]); }
    visibleLayerIds(): string[] {
        const active = this.#state.variants?.find(v => v.id === this.activeVariantId);
        const visible = new Set(active?.activeLayerIds ?? []);
        for (const [id, enabled] of Object.entries(this.#state.visibilityOverrides ?? {})) enabled ? visible.add(id) : visible.delete(id);
        return this.#state.reviewLayers!.filter(l => visible.has(l.id)).map(l => l.id);
    }
    applyVariant(id: string): SceneState {
        if (!this.#state.variants!.some(v => v.id === id)) invalid(`Unknown scene variant: ${id}`);
        return new SceneState({ ...this.value, activeVariantId: id, visibilityOverrides: {} });
    }
    setReviewLayerVisible(id: string, visible: boolean): SceneState {
        if (!this.#state.reviewLayers!.some(l => l.id === id) || typeof visible !== 'boolean') invalid(`Unknown review layer or invalid visibility: ${id}`);
        const state = this.value, defaults = state.variants!.find(v => v.id === state.activeVariantId)?.activeLayerIds ?? [];
        if (defaults.includes(id) === visible) delete state.visibilityOverrides![id]; else Object.defineProperty(state.visibilityOverrides!, id, { value: visible, enumerable: true, writable: true, configurable: true });
        return new SceneState(state);
    }
    effectiveRecipe(): SceneRecipeInput {
        const recipe = this.value.base, visible = new Set(this.visibleLayerIds()), variant = this.#state.variants!.find(v => v.id === this.activeVariantId);
        recipe.layers = [...recipe.layers ?? [], ...this.#state.reviewLayers!.filter(l => visible.has(l.id)).flatMap(l => structuredClone([...l.layers]))];
        // A variant replaces the preset; it never merges with the previously selected variant.
        if (variant?.preset !== undefined) {
            for (const key of presetFields) if (key !== 'camera' && key !== 'output') delete (recipe as unknown as Record<string, unknown>)[key];
            Object.assign(recipe, structuredClone(variant.preset));
        }
        return new SceneRecipe(recipe).value;
    }
    toJSON(): JsonValue { return encodeMapData({ schema: 'forge3d.scene-state.v2', state: this.value }, mapRecipeByteLimit(this.#state.base)); }
    static fromJSON(input: unknown, maxBytes = 64 * 1024 * 1024): SceneState {
        const raw = decodeMapData(typeof input === 'string' ? JSON.parse(input) : input, maxBytes) as { schema: string; state: SceneStateInput };
        if (raw.schema !== 'forge3d.scene-state.v2') invalid('Unknown scene-state schema');
        return new SceneState(raw.state);
    }
}
