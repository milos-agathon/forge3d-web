import { MapSceneState, MapSceneTransactions } from './map-scene-transaction.js';
import { Forge3DError } from "./runtime-failure.js";
import { Frame, encodePng } from './frames.js';
import { Diagnostic, ValidationReport, type ValidationReportData, stableDiagnosticJson, type JsonValue } from './diagnostics.js';
import { SceneRecipe } from './map-recipe.js';
import { validateMapRecipe, mapProblem } from './map-validation.js';
import { loadMapResources, mapCancelled } from './map-resource-loader.js';
import { prepareMapLayers, type PreparedMapLayers } from './map-layer-adapters.js';
import { renderMapFrame } from './map-render.js';
import { withMapRenderContext, scheduleMapFrame, type MapSceneRenderContext } from './map-render-context.js';
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
    /** Own a shared device for related real draws, releasing it on success or failure. */
    static withRenderContext<T>(work: (context: MapSceneRenderContext) => Promise<T>): Promise<T> { return withMapRenderContext(work); }
    #transaction: MapSceneTransactions;
    get #state() { return this.#transaction.state; }
    #bundle: LoadedBundle | undefined;
    #disposed = false;
    #gpuBytes = 0;
    #peakGpuBytes = 0;
    constructor(recipe: SceneRecipe | SceneRecipeInput) { this.#transaction = new MapSceneTransactions(new MapSceneState(recipe instanceof SceneRecipe ? new SceneRecipe(recipe.value) : new SceneRecipe(recipe))); }
    get recipe(): SceneRecipe { this.#live(); return this.#state.recipe; }
    get sceneState(): SceneState { this.#live(); return new SceneState(this.#state.review.value); }
    listVariants() { this.#live(); return this.#state.review.listVariants(); }
    listReviewLayers() { this.#live(); return this.#state.review.listReviewLayers(); }
    getActiveVariantId(): string | null { this.#live(); return this.#state.review.activeVariantId; }
    getReviewLayerVisible(id: string): boolean { this.#live(); if (!this.#state.review.listReviewLayers().some(l => l.id === id)) throw new Forge3DError('INVALID_INPUT', `Unknown review layer: ${id}`); return this.#state.review.visibleLayerIds().includes(id); }
    get disposed(): boolean { return this.#disposed; }
    get lastValidationReport(): ValidationReport | null { return this.#state.lastReport; }
    get compiledLabelPlans(): Record<string, LabelPlanData> { return structuredClone(this.#state.layers?.plans ?? {}); }
    get resources(): MapSceneResourceSummary[] { return structuredClone(this.#state.resources); }
    getMemoryReport() { return { cpuBytes: this.#disposed ? 0 : Array.from(this.#state.prepared.values()).reduce((n, r) => n + r.bytes, 0) + (this.#state.layers?.fontBytes ?? 0) + (this.#state.layers?.cpuBytes ?? 0) + (this.#bundle?.getMemoryReport().cpuBytes ?? 0), reviewStateBytes: this.#disposed ? 0 : this.#state.review.getMemoryReport().cpuBytes, gpuBytes: this.#gpuBytes, peakGpuBytes: this.#peakGpuBytes, resourceCount: this.#state.prepared.size, disposed: this.#disposed }; }
    #live() { if (this.#disposed)
        throw new Forge3DError('RUNTIME_DISPOSED', 'MapScene is disposed'); }
    validate(): ValidationReport {
        this.#live();
        const result = validateMapRecipe(this.#state.input, this.#state.prepared, [...this.#state.styleDiagnostics, ...this.#state.diagnostics, ...this.#state.layers?.diagnostics ?? []], this.#state.failed, this.#state.layers, this.#state.facts);
        this.#state.resources = result.resources;
        this.#state.lastReport = this.#state.lastRender ? new ValidationReport({ ...result.report.toJSON(), supported_features: { ...result.report.supported_features, 'mapscene.render_png': 'supported' } }) : result.report;
        return this.#state.lastReport;
    }
    async #run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return this.#transaction.run(signal,operation,{
            begin:()=>{this.#state.lastRender=null;},
            preCancelled:()=>{this.#release(); this.#state.diagnostics.push(mapProblem('render_cancelled','MapScene operation cancelled')); this.validate();}
        });
    }
    #release() { this.#state.release(); }
    async #prepare(signal: AbortSignal, onProgress?: (p: MapSceneProgress) => void): Promise<ValidationReport> {
        this.#release();
        this.#state.diagnostics = [];
        this.#state.failed.clear();
        this.#state.lastRender = null;
        const before = this.validate();
        onProgress?.({ phase: 'validate', completed: 1, total: 1 });
        if (before.renderBlocked(this.#state.input.renderPolicy))
            return before;
        try {
            const loaded = await loadMapResources(this.#state.input, signal, onProgress);
            this.#state.prepared = loaded.prepared;
            this.#state.diagnostics = loaded.diagnostics;
            this.#state.failed = loaded.failed;
            this.#live();
            mapCancelled(signal);
            let report = this.validate();
            if (report.renderBlocked(this.#state.input.renderPolicy))
                return report;
            this.#state.layers = await prepareMapLayers(this.#state.input, this.#state.prepared, signal, this.#state.review.fonts);
            this.#live();
            mapCancelled(signal);
            report = this.validate();
            this.#state.ready = !report.renderBlocked(this.#state.input.renderPolicy);
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
            this.#state.diagnostics.push(mapProblem(e.code === 'REQUEST_CANCELLED' ? 'render_cancelled' : 'preparation_failed', e.message, null, { error_code: e.code }));
            this.validate();
        }
        throw e;
    } }); }
    render(options: MapSceneRenderOptions = {}): Promise<MapSceneRenderResult> {
        return this.#run(options.signal, async (signal) => {
            this.#state.lastRender = null;
            let validationBlocked = false;
            try {
                let report = this.#state.ready ? this.validate() : await this.#prepare(signal, options.onProgress);
                if (report.renderBlocked(this.#state.input.renderPolicy)) {
                    validationBlocked = true;
                    throw new Forge3DError('UNSUPPORTED_FEATURE', 'MapScene render blocked by diagnostics', { report: report.toJSON() });
                }
                if (!this.#state.layers)
                    throw new Forge3DError('INTERNAL_ERROR', 'MapScene prepared layers unavailable');
                options.onProgress?.({ phase: 'render', completed: 0, total: 1 });
                const draw = () => renderMapFrame(this.#state.input, this.#state.layers!, options, signal, bytes => { this.#gpuBytes = bytes; this.#peakGpuBytes = Math.max(this.#peakGpuBytes, bytes); });
                const rendered = options.renderContext ? await scheduleMapFrame(options.renderContext, draw) : await draw();
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
                const executedLayerIds = Object.keys(this.#state.layers.layerObjects).sort();
                for (const l of this.#state.input.layers ?? [])
                    if (l.kind === 'trace')
                        executedLayerIds.push(l.layerId);
                this.#state.lastRender = { backend: rendered.metrics.backend, executed_layer_ids: executedLayerIds, recipe_hash: recipeHash };
                report = this.validate();
                options.onProgress?.({ phase: 'encode', completed: 1, total: 1 });
                this.#live();mapCancelled(signal);
                return { blob, frame: rendered.frame, report, executedLayerIds, resources: this.resources, metrics: rendered.metrics, recipeHash };
            }
            catch (error) {
                const e = Forge3DError.from(error);
                this.#state.lastRender = null;
                if (!this.#disposed) {
                    if (validationBlocked) this.#state.diagnostics.push(...this.#state.layers?.diagnostics ?? []);
                    else this.#state.diagnostics.push(mapProblem(e.code === 'REQUEST_CANCELLED' ? 'render_cancelled' : 'render_failed', e.message, null, { error_code: e.code }));
                }
                this.#release();
                if (!this.#disposed) this.validate();
                throw e;
            }
        });
    }
    async reviewRecord(): Promise<MapSceneReviewRecord> {
        this.#live();
        const report = this.validate(), recipe = this.recipe.toJSON(), policy = this.#state.input.renderPolicy;
        const blocked = report.renderBlocked(policy);
        const recipeHash = await digest(recipe), reportHash = await digest(report.toJSON());
        this.#live();
        return { schema: 'forge3d.mapscene.review.v1', recipe, recipe_hash: recipeHash, validation_report_hash: reportHash, validation_report: report.toJSON(), resources: this.resources, compiled_label_plans: this.compiledLabelPlans, renderable: this.#state.ready && !blocked, render_status: blocked ? 'blocked_by_diagnostics' : this.#state.ready ? 'ready_for_render' : 'requires_preparation', last_render: structuredClone(this.#state.lastRender) };
    }
    toJSON(): JsonValue { return this.recipe.toJSON(); }
    static fromJSON(input: unknown): MapScene { return new MapScene(SceneRecipe.fromJSON(input)); }
    static fromSceneState(input: SceneState | SceneStateInput): MapScene {
        const state = input instanceof SceneState ? new SceneState(input.value) : new SceneState(input), scene = new MapScene(state.effectiveRecipe());
        scene.#state.review = state;
        if (state.value.style) scene.#state.styleDiagnostics = [...new StyleSpec(state.value.style).validate().diagnostics];
        if (state.value.validationReport) scene.#state.styleDiagnostics.push(...ValidationReport.fromJSON(state.value.validationReport).diagnostics.filter(d => d.code === 'unsupported_bundle_field' || state.value.missingAssets?.length && d.code === 'missing_external_asset'));
        return scene;
    }
    static fromStyle(recipe: SceneRecipeInput, style: StyleSpec, sources: Record<string, readonly VectorFeature[]>, options: { zoom?: number } = {}): MapScene {
        const compiled = compileStyle(style, sources, { ...options, ...(recipe.crs ? { crs: recipe.crs } : {}) }), scene = MapScene.fromSceneState({ base: { ...recipe, layers: [...recipe.layers ?? [], ...compiled.layers] }, style: style.value });
        scene.#state.styleDiagnostics = [...compiled.report.diagnostics]; return scene;
    }
    async #transition(state: SceneState, signal?: AbortSignal): Promise<void> {
        return this.#transaction.run(signal, async combined => {
            const candidate = MapScene.fromSceneState(state);
            try {
                const report = await candidate.prepare({ signal: combined });
                this.#live(); mapCancelled(combined);
                if (report.renderBlocked(candidate.recipe.value.renderPolicy)) throw new Forge3DError('UNSUPPORTED_FEATURE', 'Variant preparation blocked by diagnostics', { report: report.toJSON() });
                this.#transaction.adopt(candidate.#transaction,combined);
                this.validate();
            } finally { candidate.dispose(); }
        });
    }
    applyVariant(id: string, options: { signal?: AbortSignal } = {}): Promise<void> { this.#live(); return this.#transition(this.#state.review.applyVariant(id), options.signal); }
    setReviewLayerVisible(id: string, visible: boolean, options: { signal?: AbortSignal } = {}): Promise<void> { this.#live(); return this.#transition(this.#state.review.setReviewLayerVisible(id, visible), options.signal); }
    /** Resolve a logical sprite/glyph URL from the archive adopted by loadBundle. */
    resolveBundleAsset(url: string): string { this.#live(); if (!this.#bundle) throw new Forge3DError('INVALID_INPUT', 'Scene has no adopted bundle'); return this.#bundle.resolveAsset(url); }
    async saveBundle(options: SaveBundleOptions = {}): Promise<Blob> {
        return this.#transaction.run(options.signal,async signal => { const state = this.#state.review.value, review = await this.reviewRecord(); state.validationReport = review.validation_report; state.compiledLabelPlans = this.compiledLabelPlans; state.reviewRecord = { renderable: review.renderable, render_status: review.render_status, last_render: review.last_render }; const result = await saveBundle(state, { allowMissingAssets: true, createdAt: '2000-01-01T00:00:00Z', ...options, signal, assets: { ...this.#bundle?.retainedAssets(), ...options.assets } }); this.#live(); return result;  });
    }
    static async loadBundle(source: BrowserByteSource | FileSystemFileHandle, options: BundleOptions = {}): Promise<MapScene> {
        const bundle = await loadBundle(source, options);
        try { const state = await bundle.runtimeSceneState(); mapCancelled(options.signal); const scene = MapScene.fromSceneState(state); scene.#bundle = bundle; return scene; }
        catch (e) { bundle.dispose(); throw e; }
    }
    dispose(): void { if (this.#disposed)
        return; this.#disposed = true; this.#transaction.dispose(); this.#bundle?.dispose(); this.#bundle = undefined; this.#state.resources = []; this.#gpuBytes = 0; this.#state.lastRender = null; this.#state.review = undefined!; this.#state.recipe = undefined!; this.#state.lastReport = null; this.#state.styleDiagnostics = []; this.#state.diagnostics = []; }
}
