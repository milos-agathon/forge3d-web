import { Forge3DError } from './index.js';
import { Frame, encodePng } from './frames.js';
import { Diagnostic, ValidationReport, type ValidationReportData, stableDiagnosticJson, type JsonValue } from './diagnostics.js';
import { SceneRecipe } from './map-recipe.js';
import { validateMapRecipe, mapProblem } from './map-validation.js';
import { loadMapResources, mapCancelled } from './map-resource-loader.js';
import { prepareMapLayers, type PreparedMapLayers } from './map-layer-adapters.js';
import { renderMapFrame } from './map-render.js';
import type { SceneRecipeInput, MapSceneRenderOptions, MapSceneResourceSummary, PreparedMapResource, MapSceneProgress, MapFrameMetrics } from './map-scene-types.js';
import type { LabelPlanData } from './label-types.js';
import { SceneState, type SceneStateInput } from './scene-review.js';
import { saveBundle, loadBundle, type SaveBundleOptions, type BundleOptions, type LoadedBundle } from './bundle.js';
import { StyleSpec, compileStyle } from './map-style.js';
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
async function digest(value: unknown): Promise<string> { const raw = new TextEncoder().encode(stableDiagnosticJson(value)); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), v => v.toString(16).padStart(2, '0')).join(''); }
async function cancellable<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
    const abort=()=>reject(new Forge3DError('REQUEST_CANCELLED','MapScene output cancelled'));
    let reject!:(reason:unknown)=>void;
    const stopped=new Promise<never>((_resolve,r)=>{reject=r;});
    signal.addEventListener('abort',abort,{once:true});
    try{mapCancelled(signal);return await Promise.race([pending,stopped]);}
    finally{signal.removeEventListener('abort',abort);}
}
/** Owns recipe resources, cancellation and output. GPU owners are disposed after each render. */
export class MapScene {
    #recipe: SceneRecipe;
    #review: SceneState;
    #bundle: LoadedBundle | undefined;
    #styleDiagnostics: Diagnostic[] = [];
    #prepared = new Map<string, PreparedMapResource>();
    #layers: PreparedMapLayers | undefined;
    #diagnostics: Diagnostic[] = [];
    #failed = new Set<string>();
    #resources: MapSceneResourceSummary[] = [];
    #lastReport: ValidationReport | null = null;
    #lastRender: MapSceneReviewRecord['last_render'] = null;
    #disposed = false;
    #busy = false;
    #abort: AbortController | undefined;
    #ready = false;
    #gpuBytes = 0;
    #peakGpuBytes = 0;
    constructor(recipe: SceneRecipe | SceneRecipeInput) { this.#recipe = recipe instanceof SceneRecipe ? new SceneRecipe(recipe.value) : new SceneRecipe(recipe); this.#review = new SceneState({ base: this.#recipe.value }); }
    get recipe(): SceneRecipe { this.#live(); return this.#recipe; }
    get sceneState(): SceneState { this.#live(); return new SceneState(this.#review.value); }
    listVariants() { this.#live(); return this.#review.listVariants(); }
    listReviewLayers() { this.#live(); return this.#review.listReviewLayers(); }
    getActiveVariantId(): string | null { this.#live(); return this.#review.activeVariantId; }
    getReviewLayerVisible(id: string): boolean { this.#live(); if (!this.#review.listReviewLayers().some(l => l.id === id)) throw new Forge3DError('INVALID_INPUT', `Unknown review layer: ${id}`); return this.#review.visibleLayerIds().includes(id); }
    get disposed(): boolean { return this.#disposed; }
    get lastValidationReport(): ValidationReport | null { return this.#lastReport; }
    get compiledLabelPlans(): Record<string, LabelPlanData> { return structuredClone(this.#layers?.plans ?? {}); }
    get resources(): MapSceneResourceSummary[] { return structuredClone(this.#resources); }
    getMemoryReport() { return { cpuBytes: this.#disposed ? 0 : Array.from(this.#prepared.values()).reduce((n, r) => n + r.bytes, 0) + (this.#layers?.fontBytes ?? 0) + (this.#layers?.cpuBytes ?? 0) + (this.#bundle?.getMemoryReport().cpuBytes ?? 0), reviewStateBytes: this.#disposed ? 0 : this.#review.getMemoryReport().cpuBytes, gpuBytes: this.#gpuBytes, peakGpuBytes: this.#peakGpuBytes, resourceCount: this.#prepared.size, disposed: this.#disposed }; }
    #live() { if (this.#disposed)
        throw new Forge3DError('RUNTIME_DISPOSED', 'MapScene is disposed'); }
    validate(): ValidationReport {
        this.#live();
        const result = validateMapRecipe(this.recipe.value, this.#prepared, [...this.#styleDiagnostics, ...this.#diagnostics, ...this.#layers?.diagnostics ?? []], this.#failed, this.#layers);
        this.#resources = result.resources;
        this.#lastReport = this.#lastRender ? new ValidationReport({ ...result.report.toJSON(), supported_features: { ...result.report.supported_features, 'mapscene.render_png': 'supported' } }) : result.report;
        return this.#lastReport;
    }
    async #run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        this.#live();
        if (this.#busy)
            throw new Forge3DError('INVALID_INPUT', 'MapScene operation already in progress', { reason: 'operation-in-progress' });
        this.#busy = true;
        this.#lastRender = null;
        const abort = new AbortController();
        this.#abort = abort;
        const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
        let entered = false;
        try {
            mapCancelled(combined);
            entered = true;
            return await operation(combined);
        }
        catch (error) {
            if (!entered) {
                this.#release();
                this.#diagnostics.push(mapProblem('render_cancelled', 'MapScene operation cancelled'));
                this.validate();
            }
            throw error;
        }
        finally {
            this.#busy = false;
            this.#abort = undefined;
        }
    }
    #release() { this.#layers?.dispose(); this.#layers = undefined; for (const r of this.#prepared.values())
        r.dispose?.(); this.#prepared.clear(); this.#ready = false; }
    async #prepare(signal: AbortSignal, onProgress?: (p: MapSceneProgress) => void): Promise<ValidationReport> {
        this.#release();
        this.#diagnostics = [];
        this.#failed.clear();
        this.#lastRender = null;
        const before = this.validate();
        onProgress?.({ phase: 'validate', completed: 1, total: 1 });
        if (before.renderBlocked(this.recipe.value.renderPolicy))
            return before;
        try {
            const loaded = await loadMapResources(this.recipe.value, signal, onProgress);
            this.#prepared = loaded.prepared;
            this.#diagnostics = loaded.diagnostics;
            this.#failed = loaded.failed;
            this.#live();
            mapCancelled(signal);
            let report = this.validate();
            if (report.renderBlocked(this.recipe.value.renderPolicy))
                return report;
            this.#layers = await prepareMapLayers(this.recipe.value, this.#prepared, signal, this.#review.fonts);
            this.#live();
            mapCancelled(signal);
            report = this.validate();
            this.#ready = !report.renderBlocked(this.recipe.value.renderPolicy);
            return report;
        }
        catch (error) {
            this.#release();
            throw error;
        }
    }
    prepare(options: Pick<MapSceneRenderOptions, 'signal' | 'onProgress'> = {}): Promise<ValidationReport> { return this.#run(options.signal, async (s) => { try {
        return await this.#prepare(s, options.onProgress);
    }
    catch (error) {
        const e = Forge3DError.from(error);
        if (!this.#disposed) {
            this.#diagnostics.push(mapProblem(e.code === 'REQUEST_CANCELLED' ? 'render_cancelled' : 'preparation_failed', e.message, null, { error_code: e.code }));
            this.validate();
        }
        throw e;
    } }); }
    render(options: MapSceneRenderOptions = {}): Promise<MapSceneRenderResult> {
        return this.#run(options.signal, async (signal) => {
            this.#lastRender = null;
            let validationBlocked = false;
            try {
                let report = this.#ready ? this.validate() : await this.#prepare(signal, options.onProgress);
                if (report.renderBlocked(this.recipe.value.renderPolicy)) {
                    validationBlocked = true;
                    throw new Forge3DError('UNSUPPORTED_FEATURE', 'MapScene render blocked by diagnostics', { report: report.toJSON() });
                }
                if (!this.#layers)
                    throw new Forge3DError('INTERNAL_ERROR', 'MapScene prepared layers unavailable');
                options.onProgress?.({ phase: 'render', completed: 0, total: 1 });
                const rendered = await renderMapFrame(this.recipe.value, this.#layers, options, signal, bytes => { this.#gpuBytes = bytes; this.#peakGpuBytes = Math.max(this.#peakGpuBytes, bytes); });
                this.#live();
                mapCancelled(signal);
                options.onProgress?.({ phase: 'render', completed: 1, total: 1 });
                options.onProgress?.({ phase: 'encode', completed: 0, total: 1 });
                const blob = await encodePng(rendered.frame.width, rendered.frame.height, rendered.frame.data);
                mapCancelled(signal);
                if (options.sink) {
                    const writer = options.sink.getWriter();
                    try {
                        await cancellable(writer.write(new Uint8Array(await blob.arrayBuffer())),signal);
                        mapCancelled(signal);
                        await cancellable(writer.close(),signal);
                    }
                    catch (error) {
                        // A caller's never-settling write cannot hold cancellation open.
                        void writer.abort(error).catch(() => undefined);
                        throw error;
                    }
                    finally {
                        writer.releaseLock();
                    }
                }
                this.#live();
                mapCancelled(signal);
                const recipeHash = await digest(this.recipe.toJSON());
                mapCancelled(signal);
                const executedLayerIds = Object.keys(this.#layers.layerObjects).sort();
                for (const l of this.recipe.value.layers ?? [])
                    if (l.kind === 'trace')
                        executedLayerIds.push(l.layerId);
                this.#lastRender = { backend: rendered.metrics.backend, executed_layer_ids: executedLayerIds, recipe_hash: recipeHash };
                report = this.validate();
                options.onProgress?.({ phase: 'encode', completed: 1, total: 1 });
                this.#live();mapCancelled(signal);
                return { blob, frame: rendered.frame, report, executedLayerIds, resources: this.resources, metrics: rendered.metrics, recipeHash };
            }
            catch (error) {
                const e = Forge3DError.from(error);
                this.#lastRender = null;
                if (!this.#disposed) {
                    if (validationBlocked) this.#diagnostics.push(...this.#layers?.diagnostics ?? []);
                    else this.#diagnostics.push(mapProblem(e.code === 'REQUEST_CANCELLED' ? 'render_cancelled' : 'render_failed', e.message, null, { error_code: e.code }));
                }
                this.#release();
                if (!this.#disposed) this.validate();
                throw e;
            }
        });
    }
    async reviewRecord(): Promise<MapSceneReviewRecord> {
        this.#live();
        const report = this.validate(), recipe = this.recipe.toJSON(), policy = this.recipe.value.renderPolicy;
        const blocked = report.renderBlocked(policy);
        const recipeHash = await digest(recipe), reportHash = await digest(report.toJSON());
        this.#live();
        return { schema: 'forge3d.mapscene.review.v1', recipe, recipe_hash: recipeHash, validation_report_hash: reportHash, validation_report: report.toJSON(), resources: this.resources, compiled_label_plans: this.compiledLabelPlans, renderable: this.#ready && !blocked, render_status: blocked ? 'blocked_by_diagnostics' : this.#ready ? 'ready_for_render' : 'requires_preparation', last_render: structuredClone(this.#lastRender) };
    }
    toJSON(): JsonValue { return this.recipe.toJSON(); }
    static fromJSON(input: unknown): MapScene { return new MapScene(SceneRecipe.fromJSON(input)); }
    static fromSceneState(input: SceneState | SceneStateInput): MapScene {
        const state = input instanceof SceneState ? new SceneState(input.value) : new SceneState(input), scene = new MapScene(state.effectiveRecipe());
        scene.#review = state;
        if (state.value.style) scene.#styleDiagnostics = [...new StyleSpec(state.value.style).validate().diagnostics];
        if (state.value.validationReport) scene.#styleDiagnostics.push(...ValidationReport.fromJSON(state.value.validationReport).diagnostics.filter(d => d.code === 'unsupported_bundle_field' || state.value.missingAssets?.length && d.code === 'missing_external_asset'));
        return scene;
    }
    static fromStyle(recipe: SceneRecipeInput, style: StyleSpec, sources: Record<string, readonly VectorFeature[]>, options: { zoom?: number } = {}): MapScene {
        const compiled = compileStyle(style, sources, { ...options, ...(recipe.crs ? { crs: recipe.crs } : {}) }), scene = MapScene.fromSceneState({ base: { ...recipe, layers: [...recipe.layers ?? [], ...compiled.layers] }, style: style.value });
        scene.#styleDiagnostics = [...compiled.report.diagnostics]; return scene;
    }
    async #transition(state: SceneState, signal?: AbortSignal): Promise<void> {
        this.#live(); if (this.#busy) throw new Forge3DError('INVALID_INPUT', 'MapScene operation already in progress', { reason: 'operation-in-progress' });
        const candidate = MapScene.fromSceneState(state);
        this.#busy = true; const abort = new AbortController(); this.#abort = abort;
        const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
        try {
            mapCancelled(combined);
            const report = await candidate.prepare({ signal: combined });
            this.#live(); mapCancelled(combined);
            if (report.renderBlocked(candidate.recipe.value.renderPolicy)) throw new Forge3DError('UNSUPPORTED_FEATURE', 'Variant preparation blocked by diagnostics', { report: report.toJSON() });
            this.#release();
            this.#recipe = candidate.#recipe; this.#review = state; this.#prepared = candidate.#prepared; this.#layers = candidate.#layers;
            this.#diagnostics = candidate.#diagnostics; this.#styleDiagnostics = candidate.#styleDiagnostics; this.#failed = candidate.#failed; this.#ready = candidate.#ready;
            this.#lastRender = null; this.#lastReport = null;
            candidate.#prepared = new Map(); candidate.#layers = undefined;
            this.validate();
        } finally { candidate.dispose(); this.#busy = false; this.#abort = undefined; }
    }
    applyVariant(id: string, options: { signal?: AbortSignal } = {}): Promise<void> { this.#live(); return this.#transition(this.#review.applyVariant(id), options.signal); }
    setReviewLayerVisible(id: string, visible: boolean, options: { signal?: AbortSignal } = {}): Promise<void> { this.#live(); return this.#transition(this.#review.setReviewLayerVisible(id, visible), options.signal); }
    /** Resolve a logical sprite/glyph URL from the archive adopted by loadBundle. */
    resolveBundleAsset(url: string): string { this.#live(); if (!this.#bundle) throw new Forge3DError('INVALID_INPUT', 'Scene has no adopted bundle'); return this.#bundle.resolveAsset(url); }
    async saveBundle(options: SaveBundleOptions = {}): Promise<Blob> {
        this.#live(); if (this.#busy) throw new Forge3DError('INVALID_INPUT', 'MapScene operation already in progress');
        this.#busy = true; const abort = new AbortController(); this.#abort = abort;
        const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
        try { mapCancelled(signal); const state = this.#review.value, review = await this.reviewRecord(); state.validationReport = review.validation_report; state.compiledLabelPlans = this.compiledLabelPlans; state.reviewRecord = { renderable: review.renderable, render_status: review.render_status, last_render: review.last_render }; const result = await saveBundle(state, { allowMissingAssets: true, createdAt: '2000-01-01T00:00:00Z', ...options, signal, assets: { ...this.#bundle?.retainedAssets(), ...options.assets } }); this.#live(); return result; }
        finally { this.#busy = false; this.#abort = undefined; }
    }
    static async loadBundle(source: BrowserByteSource | FileSystemFileHandle, options: BundleOptions = {}): Promise<MapScene> {
        const bundle = await loadBundle(source, options);
        try { const state = await bundle.runtimeSceneState(); mapCancelled(options.signal); const scene = MapScene.fromSceneState(state); scene.#bundle = bundle; return scene; }
        catch (e) { bundle.dispose(); throw e; }
    }
    dispose(): void { if (this.#disposed)
        return; this.#disposed = true; this.#abort?.abort(); this.#release(); this.#bundle?.dispose(); this.#bundle = undefined; this.#resources = []; this.#gpuBytes = 0; this.#lastRender = null; this.#review = undefined!; this.#recipe = undefined!; this.#lastReport = null; this.#styleDiagnostics = []; this.#diagnostics = []; }
}
