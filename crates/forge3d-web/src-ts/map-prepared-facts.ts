import { validateTerrainDatasetInput } from './terrain-dataset.js';
import { Forge3DScene } from './scene.js';
import { VectorLayers } from './vector-layers.js';
import { BuildingLayer } from './buildings.js';
import { checkMesh, meshBytes } from './mesh.js';
import { PointBuffer } from './pointcloud-buffer.js';
import { SdfScene } from './sdf.js';
import { TerrainScatterBatch } from './terrain-scatter.js';
import { normalizeTerrainOverlays } from './terrain-overlay.js';
import { validateLabelSupport, placeholderFallbackDiagnostic } from './diagnostic-paths.js';
import { mapProblem, mapBuildingDiagnostic, resourceBytes } from './map-validation.js';
import { mapBuildingOptions } from './map-support-details.js';
import { encodeMapData, mapRecipeByteLimit } from './map-recipe.js';
import type { SceneRecipeInput, MapSceneLayerInput, MapLayerBase, MapResource } from './map-scene-types.js';
import type { TerrainHeightmapInput } from './index.js';
import type { PointData } from './pointcloud-types.js';
import type { Diagnostic } from './diagnostics.js';
type Layer = MapSceneLayerInput | (MapLayerBase & {kind:'terrain'});
interface Facts { objects:number|null; bytes:number; diagnostics:Diagnostic[]; }
interface Context { input:SceneRecipeInput; kind:string; layerId:string; value:unknown; layer:Layer|undefined; resourceKind:boolean; textured:boolean; bytes:number; }
function inspect({input,kind,layerId,value,layer,resourceKind,textured,bytes}:Context):Facts {
    let objects:number|null=null; const diagnostics:Diagnostic[]=[];
        if (resourceKind) {
            if (value !== undefined)
                try {
                    switch (kind) {
                        case 'terrain': {
                            const t = value as TerrainHeightmapInput;
                            validateTerrainDatasetInput(t);
                            const s = Forge3DScene.create();
                            try {
                                s.addTerrain(t);
                            }
                            finally {
                                s.dispose();
                            }
                            objects = t.width * t.height;
                            break;
                        }
                        case 'raster':
                            normalizeTerrainOverlays({ enabled: true, layers: [{ ...(layer?.kind === 'raster' ? layer.options : {}), image: value as never }] });
                            if (!input.terrain)
                                throw Error('Raster overlays require terrain');
                            break;
                        case 'vector': {
                            const v = new VectorLayers();
                            try {
                                v.add(value as never);
                                objects = (value as {
                                    features: unknown[];
                                }).features.length;
                            }
                            finally {
                                v.dispose();
                            }
                            break;
                        }
                        case 'labels': {
                            if (!Array.isArray(value) || !value.length)
                                throw Error('Label data must contain records');
                            objects = value.length;
                            const l = layer as Extract<MapSceneLayerInput, {
                                kind: 'labels';
                            }>;
                            if (l.coordinateSpace !== undefined && !['screen', 'world'].includes(l.coordinateSpace))
                                throw Error('Unknown label coordinate space');
                            if (l.atlasGlyphs)
                                diagnostics.push(...validateLabelSupport(value, { atlasGlyphs: l.atlasGlyphs, layerId }).diagnostics);
                            break;
                        }
                        case 'buildings':
                            if (Array.isArray(value) || value instanceof BuildingLayer) {
                                const b = value instanceof BuildingLayer ? value : new BuildingLayer(value as never, mapBuildingOptions(layer as Extract<MapSceneLayerInput, { kind: 'buildings' }>));
                                try {
                                    objects = b.buildingCount;
                                    bytes = b.cpuBytes;
                                    if (!textured) diagnostics.push(...b.validate().diagnostics.map(d => mapBuildingDiagnostic(d, layerId)));
                                }
                                finally {
                                    if (b !== value)
                                        b.dispose();
                                }
                            }
                            break;
                        case 'mesh':
                            checkMesh(value as never);
                            objects = (value as {
                                indices: Uint32Array;
                            }).indices.length / 3;
                            bytes = meshBytes(value as never);
                            break;
                        case 'point-cloud':
                            if (!(value as {
                                dataset?: unknown;
                            }).dataset) {
                                const b = new PointBuffer(value as PointData);
                                try {
                                    objects = b.pointCount;
                                }
                                finally {
                                    b.dispose();
                                }
                            }
                            break;
                    }
                }
                catch (error) {
                    diagnostics.push(mapProblem('invalid_layer', String(error), layerId));
                }
        }
        else
            try {
                if (kind === 'nodes') {
                    const scene = Forge3DScene.create();
                    try {
                        for (const n of (layer as Extract<MapSceneLayerInput, {
                            kind: 'nodes';
                        }>).nodes) {
                            if (n.kind === 'terrain')
                                diagnostics.push(mapProblem('unsupported_layer_combination', 'Terrain nodes must use the recipe TerrainSource so their resource identity and CRS are validated.', layerId));
                            if (n.kind === 'custom')
                                diagnostics.push(placeholderFallbackDiagnostic('custom scene node has no executable recipe adapter', { layer_id: layerId }));
                            if (n.kind === 'text-mesh' && !n.vertices)
                                diagnostics.push(placeholderFallbackDiagnostic('text mesh requires real glyph triangles', { layer_id: layerId }));
                            scene.addNode(n);
                        }
                        objects = scene.snapshot().nodes.filter(n => n.node.kind !== 'group' && n.visible).length;
                        bytes = scene.estimatedGpuBytes();
                    }
                    finally {
                        scene.dispose();
                    }
                }
                if (kind === 'scatter') {
                    const batches = (layer as Extract<MapSceneLayerInput, {
                        kind: 'scatter';
                    }>).batches;
                    for (const b of batches)
                        new TerrainScatterBatch(b);
                    objects = batches.length;
                }
                if (kind === 'trace') {
                    const t = layer as Extract<MapSceneLayerInput, {
                        kind: 'trace';
                    }>;
                    if (!t.triangles?.length && !t.sdf)
                        throw Error('Trace layer has no geometry');
                    if (t.sdf) {
                        const sdf = SdfScene.fromSnapshot(t.sdf);
                        sdf.dispose();
                    }
                    objects = (t.triangles?.length ?? 0) + (t.sdf?.primitives.length ?? 0);
                }
            }
            catch (error) {
                diagnostics.push(mapProblem('invalid_layer', String(error), layerId));
            }
    return {objects,bytes,diagnostics};
}
/** Scoped to a private immutable recipe; loading a new value invalidates only its facts. */
export class PreparedMapFacts {
    #facts=new Map<unknown,{value:unknown;result:Facts}>();
    #bytes=new WeakMap<object,number>();
    #signatures=new WeakMap<object,string>();
    inspect(context:Context):Facts {
        const key=context.layer?.kind==='terrain'?context.input.terrain:context.layer;
        const old=this.#facts.get(key);
        if(old && old.value===context.value)return old.result;
        const result=inspect(context); this.#facts.set(key,{value:context.value,result}); return result;
    }
    clear():void { this.#facts.clear(); this.#bytes=new WeakMap(); this.#signatures=new WeakMap(); }
    bytes(value:unknown):number {
        if(!value || typeof value!=='object')return resourceBytes(value);
        let bytes=this.#bytes.get(value); if(bytes===undefined){bytes=resourceBytes(value);this.#bytes.set(value,bytes);} return bytes;
    }
    signature(source:MapResource,layer:Layer|undefined,input:SceneRecipeInput):string {
        const key=layer?.kind==='buildings'?layer:source;
        let signature=this.#signatures.get(key);
        if(signature===undefined){signature=JSON.stringify(encodeMapData(layer?.kind==='buildings'?{source,options:mapBuildingOptions(layer)}:source,mapRecipeByteLimit(input)));this.#signatures.set(key,signature);} return signature;
    }
}
