import { Forge3DError } from './runtime-failure.js';
import { Forge3DScene, sceneShadowsConfigured, clonePayload } from './scene.js';
import type { SceneSnapshot, RendererConfigData, TerrainHeightmapInput, TerrainHeightmapSourceInput, MaterialVtSourceImage } from './index.js';
import type { SessionRuntimeLike } from './session.js';
import type { EnvironmentSnapshot } from './environment.js';
import type { VectorSnapshot } from './vector-types.js';
import type { PostFxSnapshot } from './postfx-types.js';
import type { ScatterBatchSnapshot } from './scatter-types.js';
import type { TerrainProbeSnapshot } from './terrain-probes.js';
export type TerrainReplay = {kind:'direct';value:TerrainHeightmapInput}|{kind:'source';value:TerrainHeightmapSourceInput};
type Target = Partial<SessionRuntimeLike> & {setTerrainFromSource?:(input:TerrainHeightmapSourceInput)=>Promise<void>};
type Sources = {materialIndex:number;family:string;image:MaterialVtSourceImage;fallback?:[number,number,number,number]};
/** Retained values and their application order, shared by session and viewer policies. */
export class CommittedRenderState {
  snapshot:SceneSnapshot|undefined;
  terrain:TerrainReplay|undefined;
  environment:EnvironmentSnapshot|null|undefined;
  vectors:{snapshot:VectorSnapshot|null;terrain?:TerrainHeightmapInput}|undefined;
  postFx:PostFxSnapshot|null|undefined;
  scatter:ScatterBatchSnapshot[]|undefined;
  probes:TerrainProbeSnapshot|null|undefined;
  time=0;
  readonly sources=new Map<string,Sources>();
  static prepare(scene:Forge3DScene,config:RendererConfigData) {
    const copy=scene.copy();applyRendererConfigMaterials(copy,config);applyRendererConfigShadows(copy,config);
    return {copy,snapshot:copy.snapshot(),estimatedBytes:copy.estimatedGpuBytes()};
  }
  replaySources(target:Target):void {
    for(const source of this.sources.values())target.registerMaterialVtSource?.(source.materialIndex,source.family,clonePayload(source.image),source.fallback===undefined?undefined:[...source.fallback]);
  }
  replayScene(target:Target):void { this.replaySources(target);if(this.snapshot)this.applyScene(target,this.snapshot); }
  applyScene(target:Target,snapshot:SceneSnapshot):void {
    for(const node of snapshot.nodes)if(node.node.kind==='terrain')target.setTerrain?.(clonePayload(node.node.terrain));
    if(target.setScene){target.setScene(snapshot);return;}
    target.setLighting?.(clonePayload(snapshot.environmentLighting??snapshot.lighting));
    target.setMaterials?.(clonePayload(snapshot.materials));target.setIbl?.(clonePayload(snapshot.ibl));target.setShadows?.(clonePayload(snapshot.shadows));
    const terrain=snapshot.nodes.find(n=>n.node.kind==='terrain')?.node;
    for(const apply of this.#features(target,snapshot,terrain?.kind==='terrain'?terrain.terrain:undefined))apply();
  }
  *#features(target:Target,features:Pick<SceneSnapshot,'environment'|'vectors'|'postFx'|'scatter'|'probes'|'timeSeconds'>,terrain?:TerrainHeightmapInput):Generator<()=>void|Promise<void>> {
    const required=(method:unknown,name:string)=>{if(!method)throw new Forge3DError('UNSUPPORTED_FEATURE',`Runtime does not support ${name}`);};
    if(features.environment!==undefined)yield()=>{required(target.setEnvironment,'environment');target.setEnvironment!(clonePayload(features.environment!));};
    if(features.vectors!==undefined)yield()=>{required(target.setVectorLayers,'vectors');return target.setVectorLayers!(clonePayload(features.vectors!),terrain);};
    if(features.postFx!==undefined)yield()=>{required(target.setPostFx,'post-FX');target.setPostFx!(clonePayload(features.postFx!));};
    if(features.scatter!==undefined)yield()=>{required(target.setScatterBatches,'terrain scatter');target.setScatterBatches!(clonePayload(features.scatter!));};
    if(features.probes!==undefined)yield()=>{required(target.setLightingProbes,'terrain probes');target.setLightingProbes!(clonePayload(features.probes!));};
    if(features.timeSeconds!==undefined)yield()=>{target.setTimeSeconds?.(features.timeSeconds!);};
  }
  async replayViewer(target:Target,source:(value:TerrainHeightmapSourceInput)=>TerrainHeightmapSourceInput,active:()=>boolean):Promise<void> {
    this.replaySources(target);
    if(this.terrain?.kind==='direct')target.setTerrain?.(this.terrain.value);
    else if(this.terrain?.kind==='source')await target.setTerrainFromSource!(source(this.terrain.value));
    if(!active())return;
    const features={...(this.environment!==undefined?{environment:this.environment}:{}),...(this.vectors!==undefined?{vectors:this.vectors.snapshot}:{}),...(this.postFx!==undefined?{postFx:this.postFx}:{}),...(this.scatter!==undefined?{scatter:this.scatter,timeSeconds:this.time}:{}),...(this.probes!==undefined?{probes:this.probes}:{})};
    for(const apply of this.#features(target,features,this.vectors?.terrain)){await apply();if(!active())return;}
  }
}
function applyRendererConfigMaterials(
  scene: Forge3DScene,
  config: RendererConfigData,
): void {
  const shadingBrdf = config.brdfOverride ?? config.shading.brdf;
  scene.setMaterial("default", {
    id: "default",
    brdf: shadingBrdf,
    baseColor: [1, 1, 1, 1],
    metallic: config.shading.metallic,
    roughness: config.shading.roughness,
    sheen: 0,
    clearcoat: 0,
    subsurface: 0,
    anisotropy: 0,
  });
  for (const [slot, entry] of Object.entries(config.materials)) {
    const parameters = entry.parameters;
    const numeric = (key: string): number | undefined => {
      const value = parameters[key];
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    };
    const brdfParameter = parameters["brdf"];
    const baseColorParameter = parameters["baseColor"];
    const baseColor: [number, number, number, number] =
      Array.isArray(baseColorParameter) &&
      baseColorParameter.length === 4 &&
      baseColorParameter.every(
        (component) =>
          typeof component === "number" && Number.isFinite(component),
      )
        ? baseColorParameter
        : [1, 1, 1, 1];
    scene.setMaterial(slot, {
      id: entry.id,
      brdf:
        typeof brdfParameter === "string" && brdfParameter.length > 0
          ? brdfParameter
          : shadingBrdf,
      baseColor,
      metallic: numeric("metallic") ?? config.shading.metallic,
      roughness: numeric("roughness") ?? config.shading.roughness,
      sheen: numeric("sheen") ?? 0,
      clearcoat: numeric("clearcoat") ?? 0,
      subsurface: numeric("subsurface") ?? 0,
      anisotropy: numeric("anisotropy") ?? 0,
    });
  }
}

function applyRendererConfigShadows(
  scene: Forge3DScene,
  config: RendererConfigData,
): void {
  if (sceneShadowsConfigured(scene)) {
    return;
  }
  const shadows = config.shadows;
  const technique = shadows.technique.trim().toLowerCase();
  const cascades = shadows.cascades;
  scene.setShadows(
    {
      enabled: shadows.enabled,
      filter: technique,
      mapSize: shadows.mapSize,
    },
    {
      enabled: shadows.enabled && technique !== "none" && cascades > 1,
      cascadeCount: cascades > 1 ? (cascades as 2 | 3 | 4) : 3,
    },
  );
}
