import { Diagnostic, LayerSummary, canonicalJson } from './diagnostics.js';
import { unavailableCacheLodStatsDiagnostic, unsupportedInstancingPathDiagnostic } from './diagnostic-paths.js';
import type { MapLayerBase, MapSceneBuildingLayerInput } from './map-scene-types.js';
import type { BuildingLayerOptions } from './buildings.js';

const layerTypes: Record<string, string> = { terrain: 'terrain_source', raster: 'raster_overlay', vector: 'vector_overlay', labels: 'label_layer', buildings: 'building_layer', 'point-cloud': 'point_cloud_layer', tiles3d: 'tiles3d_layer' };
export function nativeMapLayerType(kind: string): string { return layerTypes[kind] ?? kind; }
export function mapAvailability(kind: string, layerId: string, layer: MapLayerBase | undefined): { diagnostics: Diagnostic[]; details: Record<string, unknown> } {
    const metadata = layer?.metadata ?? {}, diagnostics: Diagnostic[] = [], details: Record<string, unknown> = {};
    const requested = layer?.requestedStats ?? metadata.unavailable_cache_lod_stats ?? metadata.unavailable_stats;
    const stats = typeof requested === 'string' ? [requested] : Array.isArray(requested) ? requested.map(String) : [];
    if (stats.length) {
        diagnostics.push(unavailableCacheLodStatsDiagnostic(nativeMapLayerType(kind), stats, { layer_id: layerId }));
        details.unavailable_cache_lod_stats = [...stats].sort();
    }
    const raw = layer?.instancingPath ? { requested: true, path: layer.instancingPath, support_level: 'unsupported' } : metadata.instancing ?? metadata.instancing_status;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const intent = raw as Record<string, unknown>;
        details.instancing_status = canonicalJson(intent);
        if ((intent.requested ?? true) && ['unsupported', 'missing', 'unavailable'].includes(String(intent.support_level ?? intent.status ?? ''))) diagnostics.push(unsupportedInstancingPathDiagnostic(String(intent.path ?? `${nativeMapLayerType(kind)} instancing`), { layer_id: layerId, object_id: String(intent.object_id ?? 'instancing') }));
    }
    for (const key of ['cache_stats', 'cache_budget', 'lod']) if (metadata[key] !== undefined) details[key] = canonicalJson(metadata[key]);
    return { diagnostics, details };
}
export function mapBuildingOptions(layer: MapSceneBuildingLayerInput): BuildingLayerOptions {
    const legacy = layer.metadata?.textured_materials;
    return { ...layer.options, ...(Array.isArray(legacy) ? { textures: [...layer.options?.textures ?? [], ...legacy.map(value => {
        const t = value as Record<string, unknown>;
        return { materialId: String(t.material_id ?? ''), objectId: String(t.object_id ?? ''), uvAvailable: t.uv_available === true, ...(t.albedo_texture ? { albedoTexture: String(t.albedo_texture) } : {}), ...(t.texture_format ? { textureFormat: String(t.texture_format) } : {}), assetAvailable: t.asset_available === true, scalarFallback: t.scalar_fallback === true };
    })] } : {}) };
}
export function mapLargeSceneSummary(summaries: readonly LayerSummary[], estimate: number, diagnostics: readonly Diagnostic[]): LayerSummary {
    const memory = summaries.filter(s => s.memory_estimate_bytes !== null).map(s => ({ layer_id: s.layer_id, layer_type: s.layer_type, memory_estimate_bytes: s.memory_estimate_bytes! }));
    const cache: Record<string, unknown>[] = [], unavailable: { layer_id: string; stats: string[] }[] = [], instancing: Record<string, unknown> = {};
    for (const summary of summaries) {
        const row: Record<string, unknown> = { layer_id: summary.layer_id, layer_type: summary.layer_type };
        for (const key of ['cache_stats', 'cache_budget', 'lod', 'unavailable_cache_lod_stats']) if (summary.details[key] !== undefined) row[key] = summary.details[key];
        if (Object.keys(row).length > 2) cache.push(row);
        if (summary.details.unavailable_cache_lod_stats) unavailable.push({ layer_id: summary.layer_id, stats: summary.details.unavailable_cache_lod_stats as string[] });
        if (summary.memory_estimate_bytes === null) unavailable.push({ layer_id: summary.layer_id, stats: ['memory'] });
        if (summary.details.instancing_status) instancing[summary.layer_id] = summary.details.instancing_status;
    }
    const bottlenecks = memory.filter(m => m.memory_estimate_bytes > 0).sort((a, b) => b.memory_estimate_bytes - a.memory_estimate_bytes || a.layer_type.localeCompare(b.layer_type) || a.layer_id.localeCompare(b.layer_id));
    return new LayerSummary({ layer_id: 'large_scene.resources', layer_type: 'large_scene_resource_summary', support_level: diagnostics.some(d => d.code === 'unsupported_instancing_path') ? 'unsupported' : unavailable.length ? 'underdeveloped' : 'supported', diagnostic_codes: [...new Set(diagnostics.map(d => d.code))], memory_estimate_bytes: estimate, details: { memory_estimates: memory.sort((a, b) => a.layer_id.localeCompare(b.layer_id)), total_estimated_gpu_memory_bytes: estimate, cache_lod_status: cache.sort((a, b) => String(a.layer_id).localeCompare(String(b.layer_id))), instancing_status: instancing, unavailable_stats: unavailable.sort((a, b) => a.layer_id.localeCompare(b.layer_id)), bottleneck_layers: bottlenecks, bottleneck_layer_types: [...new Set(bottlenecks.map(b => b.layer_type))] } });
}
