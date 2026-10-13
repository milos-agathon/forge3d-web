import { Forge3DError } from './index.js';
import type { TerrainHeightmapInput } from './index.js';
import { readByteSource } from './browser-io.js';
import { decodeOverlayImage } from './terrain-overlay.js';
import { loadMesh } from './mesh-io.js';
import { loadBuildings, BuildingLayer } from './buildings.js';
import { openPointCloud } from './pointcloud.js';
import { PointBuffer } from './pointcloud-buffer.js';
import type { PointData, PointCloudDataset } from './pointcloud-types.js';
import { Tileset } from './tiles3d.js';
import { CogDataset } from './cog.js';
import { decodeMapData, encodeMapData } from './map-recipe.js';
import type { MapResource, PreparedMapResource, SceneRecipeInput, MapSceneProgress } from './map-scene-types.js';
import { mapResources, resourceBytes, MAP_SCENE_DEFAULT_RESOURCE_LIMIT, mapProblem } from './map-validation.js';
import { Diagnostic } from './diagnostics.js';
import { mapBuildingOptions } from './map-support-details.js';
import { missingExternalAssetDiagnostic } from './diagnostic-paths.js';
export function mapCancelled(signal?: AbortSignal): void { if (signal?.aborted)
    throw new Forge3DError('REQUEST_CANCELLED', 'MapScene operation cancelled'); }
export class InlinePointDataset implements PointCloudDataset {
    readonly totalPoints: number;
    readonly bounds: PointCloudDataset['bounds'];
    readonly crs: string | undefined;
    #buffer: PointBuffer | undefined;
    constructor(data: PointData, crs?: string) { this.#buffer = new PointBuffer(data); this.totalPoints = this.#buffer.pointCount; this.bounds = this.#buffer.bounds(); this.crs = crs; }
    rootNode() { return { key: 'inline', depth: 0, pointCount: this.totalPoints, bounds: this.bounds, spacing: 1, children: [] }; }
    async children(_key: string, signal?: AbortSignal) { mapCancelled(signal); return []; }
    async readPoints(key: string, signal?: AbortSignal): Promise<PointData> { mapCancelled(signal); if (key !== 'inline' || !this.#buffer)
        throw new Forge3DError('RUNTIME_DISPOSED', 'Inline point dataset unavailable'); return this.#buffer.data(); }
    dispose() { this.#buffer?.dispose(); this.#buffer = undefined; }
}
async function sha256(bytes: Uint8Array): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)), x => x.toString(16).padStart(2, '0')).join(''); }
async function load(resource: MapResource, input: SceneRecipeInput, signal: AbortSignal): Promise<PreparedMapResource> {
    const maxBytes = resource.maxBytes ?? input.diagnosticsPolicy?.maxResourceBytes ?? MAP_SCENE_DEFAULT_RESOURCE_LIMIT;
    mapCancelled(signal);
    const crs = resource.crs ?? input.crs;
    if (['copc', 'ept', 'las', 'laz'].includes(resource.format)) {
        if (!resource.url)
            throw Error('Point dataset requires a URL');
        if (resource.sha256)
            throw new Forge3DError('UNSUPPORTED_FEATURE', 'Whole-file hashes cannot be claimed for ranged point datasets; use W16 chunk integrity.');
        const dataset = await openPointCloud(resource.url, { format: resource.format as 'copc' | 'ept' | 'las' | 'laz', signal, maxBytes, cacheBytes: Math.min(maxBytes, 32 * 1024 * 1024) });
        return { resource, value: { dataset }, bytes: Math.min(dataset.totalPoints * 32, maxBytes), dispose: () => dataset.dispose() };
    }
    let value = resource.data, bytes: Uint8Array | undefined;
    if (resource.url)
        bytes = await readByteSource(resource.url, { signal, maxBytes });
    if (resource.sha256) {
        const raw = bytes ?? new TextEncoder().encode(JSON.stringify(encodeMapData(value, maxBytes)));
        if (await sha256(raw) !== resource.sha256.toLowerCase())
            throw new Forge3DError('IO_ERROR', 'Map resource digest mismatch', { reason: 'integrity-mismatch', resourceId: resource.id });
    }
    mapCancelled(signal);
    if (bytes)
        switch (resource.format) {
            case 'heightmap-json':
            case 'json':
            case 'labels':
            case 'vector':
            case 'tileset.json':
            case 'geojson':
            case 'cityjson':
                value = decodeMapData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), maxBytes);
                break;
            case 'f32': {
                const p = resource.parameters ?? {}, width = Number(p.width), height = Number(p.height);
                if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || bytes.byteLength !== width * height * 4)
                    throw Error('F32 heightmap dimensions do not match the resource');
                const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), heights = new Float32Array(width * height);
                for (let i = 0; i < heights.length; i++)
                    heights[i] = dv.getFloat32(i * 4, true);
                value = { ...p, width, height, heights, ...(crs ? { crs } : {}) };
                break;
            }
            case 'geotiff': {
                const cog = await CogDataset.open(new Blob([bytes.slice().buffer]), { signal });
                try {
                    const m = cog.ifdInfo(0);
                    if (m.width * m.height * 4 > maxBytes)
                        throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Decoded terrain exceeds MapScene resource limit');
                    const heights = new Float32Array(m.width * m.height);
                    for (let y = 0; y < m.tilesDown; y++)
                        for (let x = 0; x < m.tilesAcross; x++) {
                            mapCancelled(signal);
                            const tile = await cog.readTile(x, y, 0, { signal });
                            for (let row = 0; row < Math.min(m.tileHeight, m.height - y * m.tileHeight); row++)
                                heights.set(tile.subarray(row * m.tileWidth, row * m.tileWidth + Math.min(m.tileWidth, m.width - x * m.tileWidth)), (y * m.tileHeight + row) * m.width + x * m.tileWidth);
                        }
                    value = { width: m.width, height: m.height, heights, ...(crs ?? cog.crs ? { crs: crs ?? cog.crs } : {}), ...(cog.geoTransform ? { transform: cog.geoTransform } : {}), ...(cog.nodata === null ? {} : { nodata: cog.nodata }) };
                }
                finally {
                    cog.dispose();
                }
                break;
            }
            case 'png':
            case 'jpg':
            case 'jpeg':
            case 'webp':
                value = await decodeOverlayImage(new Blob([bytes.slice().buffer]));
                break;
            case 'obj':
            case 'stl':
            case 'gltf':
            case 'glb':
                value = await loadMesh(bytes.slice().buffer, { format: resource.format, signal, maxBytes, ...(resource.url ? { baseUrl: resource.url } : {}) });
                break;
            default: throw Error(`Unsupported external resource format: ${resource.format}`);
        }
    if (resource.format === 'points') {
        const dataset = new InlinePointDataset(value as PointData, crs);
        return { resource, value: { dataset }, bytes: resourceBytes(value), dispose: () => dataset.dispose() };
    }
    if (resource.format === 'tileset.json' || resource.format === 'json' && input.layers?.some(l => l.kind === 'tiles3d' && l.source.id === resource.id)) {
        const base = resource.baseUrl ?? resource.url;
        if (!base)
            throw Error('Inline tilesets require baseUrl');
        const tileset = Tileset.fromJson(value, base, { signal, maxBytes });
        return { resource, value: tileset, bytes: bytes?.byteLength ?? resourceBytes(value), dispose: () => tileset.dispose() };
    }
    if (resource.format === 'buildings' || resource.format === 'geojson' || resource.format === 'cityjson') {
        const options = input.layers?.find(l => l.kind === 'buildings' && l.source.id === resource.id);
        const building = resource.format === 'buildings' ? new BuildingLayer(value as never, options?.kind === 'buildings' ? mapBuildingOptions(options) : undefined) : await loadBuildings(new TextEncoder().encode(JSON.stringify(value)).buffer, { format: resource.format as 'geojson' | 'cityjson', signal, maxBytes, ...(options?.kind === 'buildings' ? mapBuildingOptions(options) : {}), ...(crs ? { crs } : {}) });
        return { resource, value: building, bytes: building.cpuBytes, dispose: () => building.dispose() };
    }
    return { resource, value, bytes: resourceBytes(value) };
}
export async function loadMapResources(input: SceneRecipeInput, signal: AbortSignal, onProgress?: (p: MapSceneProgress) => void): Promise<{
    prepared: Map<string, PreparedMapResource>;
    diagnostics: Diagnostic[];
    failed: Set<string>;
}> {
    const prepared = new Map<string, PreparedMapResource>(), diagnostics: Diagnostic[] = [], failed = new Set<string>();
    const refs = mapResources(input), unique = [...new Map(refs.map(r => [r.resource.id, r.resource])).values()];
    try {
        for (const [i, resource] of unique.entries()) {
            mapCancelled(signal);
            try {
                const result = await load(resource, input, signal);
                const limit = resource.maxBytes ?? input.diagnosticsPolicy?.maxResourceBytes ?? MAP_SCENE_DEFAULT_RESOURCE_LIMIT;
                if (result.bytes > limit) {
                    result.dispose?.();
                    throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Decoded MapScene resource exceeds its byte limit', { bytes: result.bytes, limit });
                }
                prepared.set(resource.id, result);
                mapCancelled(signal);
            }
            catch (error) {
                mapCancelled(signal);
                failed.add(resource.id);
                for (const ref of refs.filter(r => r.resource.id === resource.id)) {
                    const e = Forge3DError.from(error), details = e.details as {
                        reason?: string;
                        status?: number;
                    } | undefined;
                    diagnostics.push(details?.status !== undefined || details?.reason === 'http-error' ? missingExternalAssetDiagnostic(resource.format, resource.url ?? resource.id, { layer_id: ref.layerId }) : mapProblem(details?.reason === 'integrity-mismatch' ? 'asset_integrity_mismatch' : 'resource_load_failed', e.message, ref.layerId, { resource_id: resource.id, error_code: e.code }));
                }
            }
            onProgress?.({ phase: 'load', completed: i + 1, total: unique.length, resourceId: resource.id });
        }
        return { prepared, diagnostics, failed };
    }
    catch (error) {
        for (const r of prepared.values())
            r.dispose?.();
        throw error;
    }
}
