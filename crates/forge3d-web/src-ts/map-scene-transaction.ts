import { PreparedMapFacts } from './map-prepared-facts.js';
import { Forge3DError } from './runtime-failure.js';
import { mapCancelled } from './map-resource-loader.js';
import { SceneRecipe } from './map-recipe.js';
import { SceneState } from './scene-review.js';
import type { Diagnostic, ValidationReport } from './diagnostics.js';
import type { PreparedMapResource, MapSceneResourceSummary } from './map-scene-types.js';
import type { PreparedMapLayers } from './map-layer-adapters.js';
import type { MapSceneReviewRecord } from './map-scene.js';

/** All publishable map state moves together; release never leaves resource aliases. */
export class MapSceneState {
    recipe: SceneRecipe;
    readonly input;
    readonly facts = new PreparedMapFacts();
    review: SceneState;
    styleDiagnostics: Diagnostic[] = [];
    prepared = new Map<string, PreparedMapResource>();
    layers: PreparedMapLayers | undefined;
    diagnostics: Diagnostic[] = [];
    failed = new Set<string>();
    resources: MapSceneResourceSummary[] = [];
    lastReport: ValidationReport | null = null;
    lastRender: MapSceneReviewRecord['last_render'] = null;
    ready = false;
    constructor(recipe: SceneRecipe) { this.recipe = recipe; this.input=recipe.value; this.review = new SceneState({base:recipe.value}); }
    release():void { this.facts.clear(); this.layers?.dispose(); this.layers=undefined; for(const r of this.prepared.values()) r.dispose?.(); this.prepared.clear(); this.ready=false; }
}

/** One admission/cancellation scope, including atomic candidate adoption. */
export class MapSceneTransactions {
    #abort: AbortController | undefined;
    #disposed = false;
    constructor(public state: MapSceneState) {}
    async run<T>(signal:AbortSignal|undefined, work:(signal:AbortSignal)=>Promise<T>, hooks:{begin?:()=>void; preCancelled?:()=>void}={}):Promise<T> {
        if(this.#disposed) throw new Forge3DError('RUNTIME_DISPOSED','MapScene is disposed');
        if(this.#abort) throw new Forge3DError('INVALID_INPUT','MapScene operation already in progress',{reason:'operation-in-progress'});
        const abort = new AbortController(); this.#abort=abort;
        const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
        let entered=false;
        try { hooks.begin?.(); mapCancelled(combined); entered=true; const result=await work(combined); mapCancelled(combined); return result; }
        catch(error) { if(!entered) hooks.preCancelled?.(); throw error; }
        finally { this.#abort=undefined; }
    }
    adopt(candidate:MapSceneTransactions, signal:AbortSignal):void {
        mapCancelled(signal);
        if(this.#disposed) throw new Forge3DError('RUNTIME_DISPOSED','MapScene is disposed');
        const previous=this.state; this.state=candidate.state; candidate.state=previous;
        previous.release(); this.state.lastRender=null; this.state.lastReport=null;
    }
    dispose():void { if(this.#disposed)return; this.#disposed=true; this.#abort?.abort(); this.state.release(); }
}
