import { Forge3DScene } from './scene.js';
import { Camera } from './camera.js';
import { applyMapLighting, mapTerrainOverlays } from './map-settings.js';
import { TerrainDataset } from './terrain-dataset.js';
import { VectorLayers } from './vector-layers.js';
import { MeshLayer } from './mesh.js';
import { BuildingLayer } from './buildings.js';
import { PointCloudLayer } from './pointcloud-layer.js';
import { Tiles3dLayer } from './tiles3d-layer.js';
import { Tileset } from './tiles3d.js';
import { FontAtlas } from './typography.js';
import { LabelLayer } from './labels.js';
import { LabelPlan } from './label-plan.js';
import { iblFromSnapshot } from './ibl.js';
import type { LabelRecord, LabelPlanData } from './label-types.js';
import { Diagnostic, type DiagnosticInput } from './diagnostics.js';
import { labelRejectionSummaryDiagnostic, placeholderFallbackDiagnostic } from './diagnostic-paths.js';
import { mapProblem, resourceBytes } from './map-validation.js';
import { mapCamera } from './map-recipe.js';
import { mapCancelled } from './map-resource-loader.js';
import type { SceneRecipeInput, PreparedMapResource, PreparedPointSource, MapSceneLabelLayerInput } from './map-scene-types.js';
import type { TerrainHeightmapInput, ScatterBatchInput } from './index.js';
export interface PreparedMapLayers {
    scene: Forge3DScene;
    points: PointCloudLayer[];
    diagnostics: Diagnostic[];
    plans: Record<string, LabelPlanData>;
    layerObjects: Record<string, number>;
    fontBytes: number;
    cpuBytes: number;
    dispose: () => void;
}
export async function prepareMapLayers(input: SceneRecipeInput, resources: ReadonlyMap<string, PreparedMapResource>, signal: AbortSignal): Promise<PreparedMapLayers> {
    const scene = Forge3DScene.create(), points: PointCloudLayer[] = [], diagnostics: Diagnostic[] = [], plans: Record<string, LabelPlanData> = {}, layerObjects: Record<string, number> = {};
    const releases: (() => void)[] = [() => scene.dispose()];
    let disposed = false, fontBytes = 0;
    const dispose = () => { if (disposed)
        return; disposed = true; for (const release of releases.reverse())
        release(); };
    const camera = new Camera(mapCamera(input.camera)), view = { position: camera.position, viewportHeight: input.output.height, fovY: camera.fovYDegrees * Math.PI / 180, viewProjection: camera.viewProjectionMatrix(input.output.width / input.output.height) };
    const vectors = new VectorLayers();
    releases.push(() => vectors.dispose());
    let terrain = input.terrain ? structuredClone(resources.get(input.terrain.source.id)?.value) as TerrainHeightmapInput : undefined;
    if (terrain) {
        const overlays = mapTerrainOverlays(input, terrain, resources);
        if (overlays) terrain.overlays = overlays;
    }
    let terrainDataset: TerrainDataset | undefined;
    try {
        if (terrain) {
            terrainDataset = TerrainDataset.fromArray(terrain);
            scene.addTerrain(terrain);
            layerObjects.terrain = terrain.width * terrain.height;
        }
        if (input.timeSeconds !== undefined)
            scene.setTimeSeconds(input.timeSeconds);
        for (const m of input.materials ?? [])
            scene.setMaterial(m.slot, m.material);
        if (input.ibl)
            scene.setImageBasedLighting(iblFromSnapshot(input.ibl));
        if (input.environment)
            scene.setEnvironment(input.environment);
        if (input.postFx)
            scene.setPostFx(input.postFx);
        if (input.lightingProbes)
            scene.setLightingProbes(input.lightingProbes);
        if (input.shadows)
            scene.setShadows(input.shadows, input.cascadedShadows);
        if (input.lighting) applyMapLighting(scene, input.lighting);
        const labelLayers = (input.layers ?? []).filter(l => l.kind === 'labels');
        let atlas: FontAtlas | undefined;
        if (labelLayers.length) {
            atlas = await FontAtlas.create({ signal });
            releases.push(() => atlas!.dispose());
            mapCancelled(signal);
            fontBytes = atlas.memoryReport().fontBytes;
        }
        for (const l of input.layers ?? []) {
            mapCancelled(signal);
            const value = 'source' in l ? resources.get(l.source.id)?.value : undefined;
            try {
                switch (l.kind) {
                    case 'raster': layerObjects[l.layerId] = 1; break;
                    case 'vector':
                        vectors.add(value as never);
                        layerObjects[l.layerId] = (value as {
                            features: unknown[];
                        }).features.length;
                        break;
                    case 'mesh': {
                        const mesh = new MeshLayer(value as never, { name: l.layerId, ...(l.transforms ? { transforms: l.transforms } : {}) });
                        releases.push(() => mesh.dispose());
                        scene.setScatterBatches([...scene.getScatterBatches(), mesh.toBatch()]);
                        layerObjects[l.layerId] = mesh.mesh().indices.length / 3;
                        break;
                    }
                    case 'buildings': {
                        const b = value as BuildingLayer;
                        b.addToScene(scene, l.transforms ? { transforms: l.transforms } : {});
                        layerObjects[l.layerId] = b.buildingCount;
                        break;
                    }
                    case 'point-cloud': {
                        const dataset = (value as PreparedPointSource).dataset, point = new PointCloudLayer(dataset, { ...l.traversal, name: l.layerId, ...(l.origin ? { origin: l.origin } : {}), ...(l.style ? { style: l.style } : {}), maxBytes: l.source.maxBytes ?? input.diagnosticsPolicy?.maxResourceBytes ?? 64 * 1024 * 1024 });
                        releases.push(() => point.dispose());
                        await point.update(view, signal);
                        points.push(point);
                        layerObjects[l.layerId] = point.stats().pointsRendered;
                        if (!point.stats().pointsRendered)
                            diagnostics.push(placeholderFallbackDiagnostic('point cloud MapScene render path', { layer_id: l.layerId }));
                        break;
                    }
                    case 'tiles3d': {
                        const tiles = new Tiles3dLayer(value as Tileset, { ...l.traversal, name: l.layerId, ...(l.origin ? { origin: l.origin } : {}), maxBytes: l.source.maxBytes ?? input.diagnosticsPolicy?.maxResourceBytes ?? 64 * 1024 * 1024 });
                        releases.push(() => tiles.dispose());
                        await tiles.update(view, signal);
                        tiles.addMeshesToScene(scene);
                        let count = tiles.meshes().length;
                        const point = tiles.asPointCloudLayer();
                        releases.push(() => point.dispose());
                        await point.update(view, signal);
                        if (point.stats().pointsRendered) {
                            points.push(point);
                            count += point.stats().pointsRendered;
                        }
                        layerObjects[l.layerId] = count;
                        if (!count)
                            diagnostics.push(placeholderFallbackDiagnostic('3D Tiles MapScene render path', { layer_id: l.layerId }));
                        break;
                    }
                    case 'nodes':
                        for (const n of l.nodes)
                            scene.addNode(n);
                        layerObjects[l.layerId] = l.nodes.length;
                        break;
                    case 'scatter':
                        scene.setScatterBatches([...scene.getScatterBatches(), ...l.batches]);
                        layerObjects[l.layerId] = l.batches.length;
                        break;
                    case 'labels': {
                        const label = new LabelLayer(atlas!);
                        releases.push(() => label.dispose());
                        const original = value as readonly LabelRecord[], projected = l.coordinateSpace === 'world' ? projectLabels(original, camera, input) : original;
                        const dataset = terrainDataset;
                        const plan = l.plan ? LabelPlan.fromJSON(l.plan) : LabelPlan.compile({ labels: projected, viewport: input.output, fontAtlas: atlas!, seed: input.reproducibility?.seed ?? 0, ...(l.atlasGlyphs ? { glyph_atlas: l.atlasGlyphs } : {}), ...(l.keepouts ? { keepouts: l.keepouts } : {}), ...(l.priorityRules ? { priority_rules: l.priorityRules } : {}), ...(l.typography ? { typography: l.typography } : {}), ...(dataset ? { terrain: { sample: (x: number, y: number, z: number) => { const world = camera.screenToWorld(x, y, z, input.output), q = dataset.query(world[0], world[2]); return q && Number.isFinite(q.elevation) ? q : undefined; } } } : {}) });
                        plans[l.layerId] = plan.toJSON();
                        const rejectionCounts: Record<string, number> = {};
                        for (const r of plan.rejected)
                            rejectionCounts[r.reason] = (rejectionCounts[r.reason] ?? 0) + 1;
                        if (plan.rejected.length)
                            diagnostics.push(labelRejectionSummaryDiagnostic(rejectionCounts, { layer_id: l.layerId }));
                        const result = label.addPlan(plan, l.style);
                        // MapScene emits the native rejection factory above; addPlan
                        // also returns the W13 plan summary, so do not emit it twice.
                        diagnostics.push(...result.diagnostics.filter(d => d.code !== 'label_rejection_summary').map(d => new Diagnostic({ ...d, layer_id: l.layerId } as DiagnosticInput)));
                        if (l.coordinateSpace === 'world')
                            for (const item of label.snapshot().labels)
                                label.updateLabel(item.id, { position: camera.screenToWorld(item.position[0], item.position[1], item.position[2], input.output) });
                        const placed = label.attach(scene, { viewport: input.output, ...(l.coordinateSpace === 'world' ? { camera } : {}), ...(l.keepouts ? { keepouts: l.keepouts } : {}) });
                        diagnostics.push(...placed.diagnostics.map(d => new Diagnostic({ ...d, layer_id: l.layerId } as DiagnosticInput)));
                        layerObjects[l.layerId] = placed.accepted.length;
                        if (!placed.accepted.length)
                            diagnostics.push(placeholderFallbackDiagnostic('label layer has no renderable accepted glyphs', { layer_id: l.layerId }));
                        break;
                    }
                    case 'trace':
                    case 'diagnostic': break;
                }
            }
            catch (error) {
                mapCancelled(signal);
                diagnostics.push(mapProblem('layer_prepare_failed', String(error), l.layerId));
            }
        }
        if (vectors.snapshot().layers.length)
            scene.setVectorLayers(vectors);
        const cpuBytes = resourceBytes(scene.snapshot()) + resourceBytes(plans) + points.reduce((n, p) => n + p.stats().cpuBytes, 0);
        mapCancelled(signal);
        return { scene, points, diagnostics, plans, layerObjects, fontBytes, cpuBytes, dispose };
    }
    catch (error) {
        dispose();
        throw error;
    }
}
function projectLabels(records: readonly LabelRecord[], camera: Camera, input: SceneRecipeInput): LabelRecord[] {
    const coordinates = (p: unknown): unknown => {
        if (Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number') {
            const s = camera.worldToScreen([p[0], p[1], Number(p[2] ?? 0)], input.output);
            return s ? [s.x, s.y, s.depth] : [-1e6, -1e6, 0];
        }
        return Array.isArray(p) ? p.map(coordinates) : p;
    };
    return records.map(r => ({ ...r, ...(r.geometry ? { geometry: { ...r.geometry, coordinates: coordinates(r.geometry.coordinates) } } : { position: coordinates(r.position ?? r.world_pos) as number[] }) }));
}
