import { Camera } from './camera.js';
import { validateTerrainDatasetInput } from './terrain-dataset.js';
import { VectorLayers } from './vector-layers.js';
import { BuildingLayer } from './buildings.js';
import { checkMesh, meshBytes } from './mesh.js';
import { SdfScene } from './sdf.js';
import { PointBuffer } from './pointcloud-buffer.js';
import { TerrainScatterBatch } from './terrain-scatter.js';
import { Forge3DScene } from './scene.js';
import { normalizeTerrainOverlays } from './terrain-overlay.js';
import { iblFromSnapshot } from './ibl.js';
import { Diagnostic, LayerSummary, ValidationReport, type SupportLevel } from './diagnostics.js';
import { diagnosticFor, supportDiagnostic, validateLabelSupport, crsMismatchDiagnostic, estimatedGpuMemoryDiagnostic, placeholderFallbackDiagnostic, vtUnsupportedFamilyDiagnostic } from './diagnostic-paths.js';
import type { BuildingDiagnostic } from './building-diagnostics.js';
import type { PointData } from './pointcloud-types.js';
import { mapCamera, encodeMapData, mapRecipeByteLimit } from './map-recipe.js';
import { applyMapLighting, mapTerrainOverlays, validateMapSettings } from './map-settings.js';
import { mapAvailability, nativeMapLayerType, mapLargeSceneSummary, mapBuildingOptions } from './map-support-details.js';
import { pythonPublic3dtilesIncompleteDiagnostic, unsupportedTileFormatDiagnostic, unsupportedTileFeatureDiagnostic } from './diagnostic-paths.js';
import { diagnoseBuildingTextures } from './building-diagnostics.js';
import { MAP_SCENE_LAYER_KINDS } from './map-support.js';
import type { MapResource, MapSceneResourceSummary, SceneRecipeInput, PreparedMapResource, MapSceneLayerInput, MapLayerBase } from './map-scene-types.js';
import type { TerrainHeightmapInput } from './index.js';
import type { LabelPlanData } from './label-types.js';
export const MAP_SCENE_DEFAULT_BUDGET = 512 * 1024 * 1024;
export const MAP_SCENE_DEFAULT_RESOURCE_LIMIT = 64 * 1024 * 1024;
export function mapBuildingDiagnostic(d: BuildingDiagnostic, layerId: string): Diagnostic {
    const scope = { layer_id: layerId, object_id: d.objectId };
    if (d.code === 'unsupported_feature')
        return new Diagnostic({ ...mapProblem(d.code, 'Building textured PBR render path is not supported.', layerId, d.details).toJSON(), object_id: d.objectId });
    return diagnosticFor(d.code, d.details, scope);
}
export function mapProblem(code: string, message: string, layerId: string | null = null, details: Record<string, unknown> = {}, severity: 'error' | 'fatal' | 'warning' | 'info' = 'error', level: SupportLevel = 'unsupported'): Diagnostic {
    return new Diagnostic({ code, severity, message, remediation: 'Correct the recipe or supply the documented supported resource before rendering.', layer_id: layerId, support_level: level, details });
}
export function resourceBytes(value: unknown): number {
    if (ArrayBuffer.isView(value))
        return value.byteLength;
    if (value instanceof ArrayBuffer)
        return value.byteLength;
    if (Array.isArray(value))
        return value.reduce((n, v) => n + resourceBytes(v), 0);
    if (value && typeof value === 'object')
        return Object.values(value).reduce<number>((n, v) => n + resourceBytes(v), 0);
    return typeof value === 'string' ? value.length * 2 : typeof value === 'number' ? 8 : 0;
}
export function mapResources(input: SceneRecipeInput): {
    resource: MapResource;
    layerId: string;
}[] {
    const result: {
        resource: MapResource;
        layerId: string;
    }[] = [];
    if (input.terrain)
        result.push({ resource: input.terrain.source, layerId: 'terrain' });
    for (const layer of input.layers ?? [])
        if (layer && 'source' in layer)
            result.push({ resource: layer.source, layerId: layer.layerId });
    return result;
}
const formats: Record<string, readonly string[]> = { terrain: ['heightmap', 'heightmap-json', 'f32', 'geotiff'], raster: ['rgba', 'png', 'jpg', 'jpeg', 'webp'], vector: ['vector', 'json'], labels: ['labels', 'json'], buildings: ['buildings', 'geojson', 'cityjson'], mesh: ['mesh', 'obj', 'stl', 'gltf', 'glb'], 'point-cloud': ['points', 'las', 'laz', 'copc', 'ept'], tiles3d: ['tileset.json', 'json'] };
export function validateMapRecipe(input: SceneRecipeInput, prepared: ReadonlyMap<string, PreparedMapResource> = new Map(), extra: readonly Diagnostic[] = [], failed: ReadonlySet<string> = new Set(), execution?: {
    layerObjects: Record<string, number>;
    plans: Record<string, LabelPlanData>;
}): {
    report: ValidationReport;
    resources: MapSceneResourceSummary[];
} {
    const diagnostics = [...extra, ...validateMapSettings(input)], summaries: LayerSummary[] = [];
    const resources: MapSceneResourceSummary[] = [];
    for (const d of extra)
        if (d.support_level === 'experimental')
            diagnostics.push(mapProblem('experimental_render_path', 'Experimental diagnostics block unverified MapScene output.', d.layer_id, { diagnostic_code: d.code }, 'error', 'experimental'));
    const ids = new Set<string>(), resourceIds = new Map<string, string>(), layers = input.layers ?? [];
    const budget = input.diagnosticsPolicy?.gpuMemoryBudgetBytes ?? MAP_SCENE_DEFAULT_BUDGET;
    const fields = (value: object, allowed: readonly string[], layerId: string | null) => { for (const key of Object.keys(value))
        if (!allowed.includes(key))
            diagnostics.push(mapProblem('unsupported_recipe_field', 'A requested recipe field has no adapter.', layerId, { field: key })); };
    fields(input, ['terrain', 'layers', 'camera', 'crs', 'lighting', 'output', 'renderPolicy', 'diagnosticsPolicy', 'reproducibility', 'environment', 'postFx', 'shadows', 'cascadedShadows', 'lightingProbes', 'materials', 'ibl', 'timeSeconds', 'runtimeOptions', 'mapFurniture'], null);
    if (input.diagnosticsPolicy)
        fields(input.diagnosticsPolicy, ['gpuMemoryBudgetBytes', 'maxResourceBytes', 'maxRecipeBytes', 'maxLayers', 'maxOutputPixels', 'largeSceneSummary'], null);
    if (input.reproducibility)
        fields(input.reproducibility, ['seed', 'rendererBackend', 'pixelTolerance', 'assetHashesOrIds'], null);
    if (input.terrain)
        fields(input.terrain, ['kind', 'source', 'requestedStats'], 'terrain');
    if (input.lighting)
        fields(input.lighting, ['name', 'lights', 'sunDirection', 'intensity'], null);
    if (input.runtimeOptions)
        fields(input.runtimeOptions, ['powerPreference', 'wasmUrl', 'clearColor', 'alphaMode', 'colorSpace', 'diagnostics', 'quality', 'overflowPolicy', 'timestampMode'], null);
    const featureDiagnostics: Record<string, SupportLevel> = {};
    let estimate = 0;
    const preview = Forge3DScene.create();
    if (input.lighting) {
        try { applyMapLighting(preview, input.lighting); }
        catch (error) { diagnostics.push(mapProblem('invalid_lighting', String(error))); }
    }
    try {
        if (input.timeSeconds !== undefined)
            preview.setTimeSeconds(input.timeSeconds);
        if (input.environment)
            preview.setEnvironment(input.environment);
        if (input.postFx)
            preview.setPostFx(input.postFx);
        if (input.lightingProbes)
            preview.setLightingProbes(input.lightingProbes);
        if (input.shadows)
            preview.setShadows(input.shadows, input.cascadedShadows);
        if (input.cascadedShadows && !input.shadows)
            diagnostics.push(mapProblem('unsupported_recipe_field', 'cascadedShadows requires shadows settings.'));
        for (const m of input.materials ?? [])
            preview.setMaterial(m.slot, m.material);
        if (input.ibl)
            preview.setImageBasedLighting(iblFromSnapshot(input.ibl));
    }
    catch (error) {
        diagnostics.push(mapProblem('invalid_scene_settings', String(error)));
    }
    finally {
        preview.dispose();
    }
    for (const [id, format, value] of [['scene:ibl', 'ibl', input.ibl], ['scene:materials', 'materials', input.materials], ['scene:probes', 'probes', input.lightingProbes], ['scene:environment', 'environment', input.environment]] as const) {
        if (value) {
            const bytes = resourceBytes(value);
            estimate += bytes * 2;
            resources.push({ id, format, layerIds: [], state: execution ? 'ready' : 'inline', estimatedBytes: bytes, sha256: null, url: null });
        }
    }
    if (!Number.isSafeInteger(budget) || budget < 1)
        diagnostics.push(mapProblem('invalid_memory_budget', 'GPU budget must be a positive safe integer.'));
    const maxResource = input.diagnosticsPolicy?.maxResourceBytes ?? MAP_SCENE_DEFAULT_RESOURCE_LIMIT;
    if (!Number.isSafeInteger(maxResource) || maxResource < 1)
        diagnostics.push(mapProblem('invalid_resource_limit', 'Resource limit must be a positive safe integer.'));
    for (const key of ['maxRecipeBytes', 'maxLayers', 'maxOutputPixels'] as const) {
        const limit = input.diagnosticsPolicy?.[key];
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) diagnostics.push(mapProblem('invalid_resource_limit', 'Browser guard limits must be positive safe integers.', null, { field: key }));
    }
    const output = input.output;
    if (output)
        fields(output, ['width', 'height', 'format'], null);
    if (!output || !Number.isSafeInteger(output.width) || !Number.isSafeInteger(output.height) || output.width < 1 || output.height < 1)
        diagnostics.push(mapProblem('invalid_output_size', 'Output dimensions must be positive integers.', null, {}, 'fatal'));
    else {
        estimate += output.width * output.height * 64;
        if (!Number.isSafeInteger(output.width * output.height) || output.width * output.height > (input.diagnosticsPolicy?.maxOutputPixels ?? 16777216))
            diagnostics.push(mapProblem('resource_limit_exceeded', 'Map output exceeds its configured pixel limit.', null, {}, 'fatal'));
    }
    if (output?.format !== undefined && output.format !== 'png')
        diagnostics.push(mapProblem('unsupported_output_format', 'MapScene output format is not supported.', null, { format: output.format }, 'fatal'));
    let camera: Camera | undefined;
    try {
        camera = new Camera(mapCamera(input.camera));
    }
    catch (error) {
        diagnostics.push(mapProblem('invalid_camera', String(error)));
    }
    if (input.reproducibility?.seed !== undefined && (!Number.isInteger(input.reproducibility.seed) || input.reproducibility.seed < 0 || input.reproducibility.seed > 0xffffffff))
        diagnostics.push(mapProblem('invalid_seed', 'Seed must be an unsigned 32-bit integer.'));
    if (input.reproducibility?.rendererBackend === 'cpu' && !layers.some(l => l?.kind === 'trace'))
        diagnostics.push(mapProblem('unsupported_backend', 'CPU backend is available only for the explicit W17 tracing reference.'));
    if (input.reproducibility?.rendererBackend !== undefined && !['cpu', 'webgpu'].includes(input.reproducibility.rendererBackend))
        diagnostics.push(mapProblem('unsupported_backend', 'Unknown requested renderer backend.'));
    if (layers.length > (input.diagnosticsPolicy?.maxLayers ?? 128))
        diagnostics.push(mapProblem('resource_limit_exceeded', 'MapScene layer limit exceeded.'));
    if (!input.terrain && !layers.some(l => l?.kind !== 'diagnostic'))
        diagnostics.push(placeholderFallbackDiagnostic('empty MapScene render path'));
    if (input.mapFurniture && Object.keys(input.mapFurniture).length)
        diagnostics.push(mapProblem('unsupported_feature', 'Map furniture rendering is owned by W20.', 'map-furniture'));
    if (layers.some(l => l?.kind === 'trace') && (input.terrain || layers.filter(l => l?.kind !== 'diagnostic').length !== 1 || input.environment || input.postFx || input.lightingProbes || input.shadows || input.lighting || input.materials || input.ibl || input.timeSeconds !== undefined))
        diagnostics.push(mapProblem('unsupported_layer_combination', 'Trace output requires one trace layer and its own materials, lighting and environment.'));
    if (layers.some(l => l?.kind === 'trace') && (camera?.projection === 'orthographic' || input.runtimeOptions))
        diagnostics.push(mapProblem('unsupported_layer_combination', 'Trace output requires a perspective camera and its dedicated tracing settings.'));
    const terrainResource = input.terrain?.source;
    const terrain = (terrainResource ? prepared.get(terrainResource.id)?.value ?? terrainResource.data : undefined) as TerrainHeightmapInput | undefined;
    const sceneCrs = input.crs ?? terrainResource?.crs ?? terrain?.crs;
    const inspect = (layerId: string, kind: string, source: MapResource | undefined, value: unknown, layer?: MapSceneLayerInput | (MapLayerBase & { kind: 'terrain' })) => {
        let level: SupportLevel = layer?.supportLevel ?? 'supported', bytes = source ? prepared.get(source.id)?.bytes ?? resourceBytes(value) : resourceBytes(value), objects: number | null = null;
        if (!layerId || ids.has(layerId))
            diagnostics.push(mapProblem('duplicate_layer_id', 'Layer IDs must be unique and nonempty.', layerId));
        ids.add(layerId);
        const availability = mapAvailability(kind, layerId, layer);
        diagnostics.push(...availability.diagnostics);
        const details: Record<string, unknown> = { resource_id: source?.id ?? null, ...availability.details };
        if (availability.diagnostics.some(d => d.code === 'unavailable_cache_lod_stats')) featureDiagnostics[`${nativeMapLayerType(kind)}.cache_lod_stats`] = 'underdeveloped';
        if (availability.diagnostics.some(d => d.code === 'unsupported_instancing_path')) featureDiagnostics[`${nativeMapLayerType(kind)}.instancing`] = 'unsupported';
        if (kind === 'point-cloud') {
            diagnostics.push(placeholderFallbackDiagnostic('point cloud MapScene render path', { layer_id: layerId }));
            featureDiagnostics['point_cloud.mapscene_render'] = 'placeholder/fallback';
        }
        if (kind === 'tiles3d') {
            details.source_kind = source?.format ?? null;
            for (const key of ['cache_budget', 'cache_stats', 'lod']) if (layer?.metadata?.[key] !== undefined) details[key] = layer.metadata[key];
            if (source && !formats.tiles3d!.includes(source.format)) {
                diagnostics.push(unsupportedTileFormatDiagnostic(source.format, { layer_id: layerId }));
                featureDiagnostics['tiles3d.format'] = 'unsupported';
            } else {
                diagnostics.push(pythonPublic3dtilesIncompleteDiagnostic({ layer_id: layerId }));
                featureDiagnostics['tiles3d.public_python_render'] = 'underdeveloped';
            }
            const features = layer?.metadata?.unsupported_features;
            for (const feature of Array.isArray(features) ? features : []) {
                diagnostics.push(unsupportedTileFeatureDiagnostic(String(feature), { layer_id: layerId }));
                featureDiagnostics['tiles3d.feature'] = 'unsupported';
            }
            if (value && typeof value === 'object' && 'root' in value) {
                const count = (node: any): number => 1 + (node?.children ?? []).reduce((n: number, child: unknown) => n + count(child), 0);
                details.tile_count = count((value as any).root);
            }
        }
        let textureSupport: SupportLevel | undefined;
        if (kind === 'buildings' && layer?.kind === 'buildings') {
            const texture = diagnoseBuildingTextures(mapBuildingOptions(layer).textures ?? [], layer.options?.proGated);
            if (texture.texturedMaterials.length) {
                diagnostics.push(...texture.diagnostics.map(d => mapBuildingDiagnostic(d, layerId)));
                textureSupport = texture.supportLevel;
                details.textured_material_status = texture.texturedMaterialStatus;
                details.textured_materials = texture.texturedMaterials.map(t => ({ material_id: t.materialId, object_id: t.objectId, albedo_texture: t.albedoTexture ?? null, texture_format: t.textureFormat ?? t.albedoTexture?.split('.').at(-1) ?? '', uv_available: t.uvAvailable, scalar_fallback: t.scalarFallback ?? false }));
                Object.assign(featureDiagnostics, texture.unsupportedFeatures);
            }
        }
        if (layer?.supportLevel) {
            const d = supportDiagnostic(kind, level, { layer_id: layerId });
            if (d)
                diagnostics.push(d);
        }
        if (level === 'experimental')
            diagnostics.push(mapProblem('experimental_render_path', 'Experimental intent requires a verified supported adapter before rendering.', layerId, {}, 'error', 'experimental'));
        if (kind === 'diagnostic' && level === 'supported')
            diagnostics.push(placeholderFallbackDiagnostic('diagnostic-only layer', { layer_id: layerId }));
        if (!(['terrain', ...MAP_SCENE_LAYER_KINDS] as readonly string[]).includes(kind)) {
            level = 'unsupported';
            diagnostics.push(mapProblem('unsupported_layer_type', 'Unknown recipe layer cannot be rendered.', layerId, { kind }));
        }
        if (formats[kind]) {
            if (!source || typeof source.id !== 'string' || !source.id)
                diagnostics.push(mapProblem('missing_source_identity', 'A resource identity is required.', layerId));
            else {
                fields(source, ['id', 'format', 'data', 'url', 'sha256', 'crs', 'maxBytes', 'parameters', 'baseUrl'], layerId);
                if (source.id.startsWith('scene:'))
                    diagnostics.push(mapProblem('duplicate_resource_id', 'The scene: resource namespace is reserved.', layerId, { resource_id: source.id }));
                if ((source.data === undefined) === (source.url === undefined))
                    diagnostics.push(mapProblem('missing_renderable_data', 'Provide exactly one inline resource or URL.', layerId));
                if (!formats[kind]!.includes(source.format))
                    diagnostics.push(mapProblem('unsupported_asset_format', 'Resource format has no adapter for this layer.', layerId, { format: source.format, supported_formats: formats[kind] }));
                if (source.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(source.sha256))
                    diagnostics.push(mapProblem('invalid_asset_hash', 'Asset SHA-256 must contain 64 hex characters.', layerId));
                if (source.url !== undefined && (typeof source.url !== 'string' || !source.url.trim()))
                    diagnostics.push(mapProblem('missing_source_identity', 'Resource URL must be nonempty.', layerId));
                const crs = source.crs ?? (value as {
                    crs?: string;
                } | undefined)?.crs;
                if (typeof sceneCrs !== 'string' || !sceneCrs.trim() || typeof crs !== 'string' || !crs.trim())
                    diagnostics.push(mapProblem('missing_crs', 'Explicit scene and layer CRS metadata are required.', layerId, { scene_crs: sceneCrs ?? null, layer_crs: crs ?? null }));
                else if (sceneCrs.trim().toUpperCase() !== crs.trim().toUpperCase())
                    diagnostics.push(crsMismatchDiagnostic(sceneCrs, crs, { layer_id: layerId }));
                const signature = JSON.stringify(encodeMapData(kind === 'buildings' && layer?.kind === 'buildings' ? { source, options: mapBuildingOptions(layer) } : source, mapRecipeByteLimit(input)));
                if (resourceIds.has(source.id) && resourceIds.get(source.id) !== signature)
                    diagnostics.push(mapProblem('duplicate_resource_id', 'Conflicting resources share an identity.', layerId, { resource_id: source.id }));
                if (!resourceIds.has(source.id)) {
                    resourceIds.set(source.id, signature);
                    resources.push({ id: source.id, format: source.format, layerIds: [layerId], state: failed.has(source.id) ? 'failed' : prepared.has(source.id) ? 'ready' : source.data !== undefined ? 'inline' : 'unresolved', estimatedBytes: prepared.get(source.id)?.bytes ?? bytes, sha256: source.sha256 ?? null, url: source.url ?? null });
                }
                else
                    resources.find(r => r.id === source.id)!.layerIds.push(layerId);
                if (source.maxBytes !== undefined && (!Number.isSafeInteger(source.maxBytes) || source.maxBytes < 1))
                    diagnostics.push(mapProblem('invalid_resource_limit', 'Resource limit must be a positive safe integer.', layerId, { field: 'source.maxBytes' }));
                if (bytes > (source.maxBytes ?? maxResource))
                    diagnostics.push(mapProblem('resource_limit_exceeded', 'Resource exceeds its byte limit.', layerId, { bytes, limit: source.maxBytes ?? maxResource }));
            }
            if (value !== undefined && !failed.has(source?.id ?? ''))
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
                                    if (!details.textured_materials) diagnostics.push(...b.validate().diagnostics.map(d => mapBuildingDiagnostic(d, layerId)));
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
        if (execution?.layerObjects[layerId] !== undefined)
            objects = execution.layerObjects[layerId]!;
        if (objects === 0 && kind !== 'diagnostic') {
            diagnostics.push(placeholderFallbackDiagnostic('layer has no renderable objects', { layer_id: layerId }));
            level = 'placeholder/fallback';
        }
        const layerDiagnostics = diagnostics.filter(d => d.layer_id === layerId);
        const support = layerDiagnostics.find(d => d.support_level !== null && d.support_level !== 'supported');
        if (support)
            level = support.support_level!;
        else if (layerDiagnostics.some(d => d.severity === 'error' || d.severity === 'fatal'))
            level = layer?.supportLevel ?? 'unsupported';
        if (textureSupport) level = textureSupport;
        const memoryEstimate = source && value === undefined && !prepared.has(source.id) ? (typeof layer?.metadata?.memory_estimate_bytes === 'number' && Number.isSafeInteger(layer.metadata.memory_estimate_bytes) && layer.metadata.memory_estimate_bytes >= 0 ? layer.metadata.memory_estimate_bytes : null) : bytes * 2;
        estimate += memoryEstimate ?? 0;
        const plan = execution?.plans[layerId];
        summaries.push(new LayerSummary({ layer_id: layerId, layer_type: nativeMapLayerType(kind), support_level: level, diagnostic_codes: layerDiagnostics.map(d => d.code), object_count: objects, memory_estimate_bytes: memoryEstimate, details: { ...details, ...(plan ? { compiled_label_plan: { accepted_count: plan.accepted.length, rejected_count: plan.rejected.length, seed: plan.seed } } : {}) } }));
    };
    // Add merged overlay failures before building summaries so their support
    // status and diagnostic_codes cannot claim success after preflight failed.
    try { mapTerrainOverlays(input, terrain, prepared, true); }
    catch (error) { diagnostics.push(mapProblem('invalid_layer', String(error), (input.layers ?? []).find(l => l?.kind === 'raster')?.layerId ?? 'terrain')); }
    const vt = terrain?.material?.virtualTexture;
    if (vt?.enabled)
        for (const family of vt.layers ?? [])
            if (family.family !== undefined && family.family !== 'albedo')
                diagnostics.push(vtUnsupportedFamilyDiagnostic(family.family, { layer_id: 'terrain' }));
    if (input.terrain)
        inspect('terrain', 'terrain', terrainResource, terrain, { kind: 'terrain', layerId: 'terrain', ...(input.terrain.requestedStats ? { requestedStats: input.terrain.requestedStats } : {}) });
    const layerFields: Record<string, string[]> = { raster: ['source', 'options'], vector: ['source'], labels: ['source', 'style', 'plan', 'priorityRules', 'typography', 'atlasGlyphs', 'keepouts', 'coordinateSpace'], buildings: ['source', 'options', 'transforms'], mesh: ['source', 'transforms'], 'point-cloud': ['source', 'style', 'traversal', 'origin'], tiles3d: ['source', 'traversal', 'origin'], nodes: ['nodes'], scatter: ['batches'], trace: ['triangles', 'sdf', 'materials', 'lights', 'environment', 'medium', 'samples', 'maxBounces'], diagnostic: ['feature'] };
    for (const [i, layer] of layers.entries()) {
        if (layer && typeof layer === 'object' && !Array.isArray(layer) && typeof layer.kind === 'string' && typeof layer.layerId === 'string') {
            fields(layer, ['kind', 'layerId', 'supportLevel', 'metadata', 'instancingPath', 'requestedStats', ...layerFields[layer.kind] ?? []], layer.layerId);
            const source = 'source' in layer ? layer.source : undefined;
            inspect(layer.layerId, layer.kind, source, source ? prepared.get(source.id)?.value ?? source.data : layer, layer);
        }
        else {
            const id = `invalid-layer-${i}`;
            diagnostics.push(mapProblem('unsupported_layer_type', 'Malformed layers cannot be rendered.', id));
            summaries.push(new LayerSummary({ layer_id: id, layer_type: 'unknown', support_level: 'unsupported', diagnostic_codes: ['unsupported_layer_type'] }));
        }
    }
    if (estimate > budget)
        diagnostics.push(estimatedGpuMemoryDiagnostic(estimate, budget));
    if (input.diagnosticsPolicy?.largeSceneSummary) summaries.push(mapLargeSceneSummary(summaries, estimate, diagnostics));
    const supported: Record<string, SupportLevel> = { 'mapscene.recipe': 'supported', 'mapscene.validation': 'supported' }, unsupported: Record<string, SupportLevel> = { ...featureDiagnostics };
    for (const s of summaries)
        (s.support_level === 'supported' ? supported : unsupported)[`layer:${s.layer_id}`] = s.support_level;
    return { report: new ValidationReport({ diagnostics, layer_summaries: summaries, estimated_gpu_memory_bytes: estimate, supported_features: supported, unsupported_features: unsupported }), resources: resources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}
