import { Diagnostic } from './diagnostics.js';
import { LabelStyle } from './labels.js';
import { normalizePointStyle } from './pointcloud-layer.js';
import { normalizeTerrainOverlays } from './terrain-overlay.js';
import type { Forge3DScene } from './scene.js';
import type { SceneRecipeInput, PreparedMapResource, LightingPresetInput } from './map-scene-types.js';
import type { TerrainHeightmapInput, TerrainOverlayLayerInput, TerrainOverlaysInput } from './index.js';

export function settingFields(value: unknown, allowed: readonly string[], path: string, layerId: string | null, diagnostics: Diagnostic[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        diagnostics.push(settingProblem('invalid_layer', `Settings ${path} must be an object.`, layerId));
        return;
    }
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) diagnostics.push(settingProblem('unsupported_recipe_field', 'A requested recipe field has no adapter.', layerId, { field: path ? `${path}.${key}` : key }));
    }
}
function settingProblem(code: string, message: string, layerId: string | null, details: Record<string, unknown> = {}): Diagnostic {
    return new Diagnostic({ code, severity: 'error', message, remediation: 'Use the documented setting names and values.', layer_id: layerId, support_level: 'unsupported', details });
}
export function applyMapLighting(scene: Forge3DScene, lighting: LightingPresetInput): void {
    const colors = { default: [1, 1, 1], daylight: [1, .95, .85], overcast: [.8, .85, 1], sunset: [1, .55, .25] } as const;
    if (!Object.hasOwn(colors, lighting.name ?? 'default')) throw Error('Unknown MapScene lighting preset');
    scene.clearLights();
    if (lighting.lights) {
        for (const light of lighting.lights) scene.addLight(light);
        if (lighting.sunDirection !== undefined || lighting.intensity !== undefined) throw Error('Explicit lights cannot be combined with preset sunDirection or intensity');
    } else scene.addLight({ type: 'directional', direction: lighting.sunDirection ?? [-.4, -1, -.5], color: [...colors[lighting.name ?? 'default']], intensity: lighting.intensity ?? 1 });
}

/** The same merged overlay settings are checked in preflight and used by preparation. */
export function mapTerrainOverlays(input: SceneRecipeInput, terrain: TerrainHeightmapInput | undefined, resources: ReadonlyMap<string, PreparedMapResource>, preflight = false): TerrainOverlaysInput | undefined {
    const rasters = input.layers?.filter(l => l?.kind === 'raster') ?? [];
    if (!rasters.length) return terrain?.overlays;
    if (!input.terrain) throw Error('Raster overlays require terrain');
    const layers: TerrainOverlayLayerInput[] = [...terrain?.overlays?.layers ?? []];
    for (const layer of rasters) {
        const image = resources.get(layer.source.id)?.value ?? layer.source.data;
        layers.push({ ...layer.options, name: layer.layerId, image: (image ?? (preflight ? { width: 1, height: 1, data: new Uint8Array(4) } : undefined)) as TerrainOverlayLayerInput['image'] });
    }
    const merged = { ...terrain?.overlays, enabled: true, layers };
    normalizeTerrainOverlays(merged);
    return merged;
}

export function validateMapSettings(input: SceneRecipeInput): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const camera = input.camera;
    settingFields(camera, camera && typeof camera === 'object' && 'kind' in camera && camera.kind === 'orbit-camera'
        ? ['kind', 'target', 'distance', 'azimuthDegrees', 'elevationDegrees', 'fovYDegrees', 'near', 'far']
        : ['position', 'target', 'up', 'fovYDegrees', 'near', 'far', 'projection', 'orthographicHeight'], 'camera', null, diagnostics);
    for (const layer of input.layers ?? []) {
        if (!layer || typeof layer !== 'object') continue;
        const id = layer.layerId;
        try {
            if (layer.kind === 'raster' && layer.options) settingFields(layer.options, ['extent', 'crs', 'crsBounds', 'opacity', 'blendMode', 'visible', 'zOrder'], 'options', id, diagnostics);
            if (layer.kind === 'point-cloud') {
                if (layer.style) {
                    settingFields(layer.style, ['pointSize', 'shape', 'colorMode', 'color', 'opacity'], 'style', id, diagnostics);
                    normalizePointStyle(layer.style);
                }
                if (layer.traversal) {
                    settingFields(layer.traversal, ['pointBudget', 'maxDepth', 'minSpacing', 'sseThreshold', 'mode'], 'traversal', id, diagnostics);
                    const t = layer.traversal;
                    for (const k of ['pointBudget', 'maxDepth'] as const) if (t[k] !== undefined && (!Number.isSafeInteger(t[k]) || t[k]! < (k === 'pointBudget' ? 1 : 0))) throw Error(`Invalid traversal.${k}`);
                    for (const k of ['minSpacing', 'sseThreshold'] as const) if (t[k] !== undefined && (typeof t[k] !== 'number' || !Number.isFinite(t[k]) || t[k]! < 0)) throw Error(`Invalid traversal.${k}`);
                    if (t.mode !== undefined && !['add', 'replace'].includes(t.mode)) throw Error('Invalid traversal.mode');
                }
            }
            if (layer.kind === 'tiles3d' && layer.traversal) {
                settingFields(layer.traversal, ['sseThreshold', 'maxDepth', 'maxTiles'], 'traversal', id, diagnostics);
                for (const [key, value] of Object.entries(layer.traversal)) if (['sseThreshold', 'maxDepth', 'maxTiles'].includes(key) && (typeof value !== 'number' || !Number.isFinite(value) || value < (key === 'maxTiles' ? 1 : 0) || key !== 'sseThreshold' && !Number.isSafeInteger(value))) throw Error(`Invalid traversal.${key}`);
            }
            if (layer.kind === 'labels') {
                if (layer.style) {
                    settingFields(layer.style, ['fontSize', 'minDepth', 'maxDepth', 'depthFade', 'horizonFadeAngle', 'color', 'haloColor', 'haloWidth', 'priority', 'offset', 'minZoom', 'maxZoom', 'depthTest', 'horizonCull', 'underline', 'smallCaps', 'leader', 'rotation', 'repeatDistance', 'placement'], 'style', id, diagnostics);
                    new LabelStyle(layer.style);
                    for (const key of ['depthTest', 'horizonCull', 'underline', 'smallCaps', 'leader'] as const) if (layer.style[key] !== undefined && typeof layer.style[key] !== 'boolean') throw Error(`Invalid style.${key}`);
                }
                for (const region of layer.keepouts ?? []) settingFields(region, ['region_id', 'kind', 'bounds', 'priority'], 'keepouts', id, diagnostics);
                if (Array.isArray(layer.priorityRules)) for (const rule of layer.priorityRules) settingFields(rule, ['name', 'rank', 'tie_break_policy'], 'priorityRules', id, diagnostics);
                else if (layer.priorityRules !== undefined && layer.priorityRules !== 'cartographic') throw Error('Invalid priorityRules');
            }
            if (layer.kind === 'buildings' && layer.options) {
                settingFields(layer.options, ['name', 'crs', 'textures', 'proGated'], 'options', id, diagnostics);
                for (const texture of layer.options.textures ?? []) settingFields(texture, ['materialId', 'objectId', 'albedoTexture', 'textureFormat', 'uvAvailable', 'assetAvailable', 'scalarFallback'], 'options.textures', id, diagnostics);
            }
        } catch (error) { diagnostics.push(settingProblem('invalid_layer', String(error), id)); }
    }
    return diagnostics;
}
