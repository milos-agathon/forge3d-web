import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MapScene } from '../../src-ts/map-scene.js';
import { SceneRecipe } from '../../src-ts/map-recipe.js';
import * as models from '../../src-ts/map-recipe.js';
import { getMapSceneSupportMatrix } from '../../src-ts/map-support.js';
import { LabelPlan } from '../../src-ts/label-plan.js';
import { ValidationReport } from '../../src-ts/diagnostics.js';
import { generatePrimitive } from '../../src-ts/geometry.js';
import type { SceneRecipeInput, MapSceneLayerInput } from '../../src-ts/map-scene-types.js';

function recipe(): SceneRecipeInput { return { crs: 'LOCAL', terrain: { source: { id: 'dem', format: 'heightmap', crs: 'LOCAL', data: { width: 4, height: 4, heights: new Float32Array(16), spacing: [10, 10] } } }, camera: { kind: 'orbit-camera', target: [0, 0, 0], distance: 50 }, output: { width: 32, height: 24 }, layers: [] }; }
function building(metadata: Record<string, any> = {}): MapSceneLayerInput { return { kind: 'buildings', layerId: 'buildings', source: { id: 'b', format: 'buildings', crs: 'LOCAL', data: [{ id: 'building-1', mesh: generatePrimitive('box') }] }, metadata }; }
function tiles(metadata: Record<string, any> = {}): MapSceneLayerInput { return { kind: 'tiles3d', layerId: 'tiles', source: { id: 't', format: 'tileset.json', crs: 'LOCAL', baseUrl: 'https://example.test/tileset.json', data: { asset: { version: '1.0' }, geometricError: 10, root: { boundingVolume: { sphere: [0, 0, 0, 1] }, geometricError: 1, content: { uri: 'tile.b3dm' } } } }, metadata }; }
afterEach(() => vi.unstubAllGlobals());

describe('W18 review regression contracts', () => {
    it('constructs every public MapScene recipe component without raw IPC', () => {
        const source = { id: 'asset', format: 'json', crs: 'LOCAL', data: [] };
        const layers = [new models.RasterOverlay({ layerId: 'r', source }), new models.VectorOverlay({ layerId: 'v', source }), new models.MapSceneLabelLayer({ layerId: 'l', source }), new models.MapSceneBuildingLayer({ layerId: 'b', source }), new models.MapScenePointCloudLayer({ layerId: 'p', source }), new models.MapSceneTiles3DLayer({ layerId: 't', source })];
        const r = new models.SceneRecipe({ ...recipe(), layers, camera: new models.OrbitCamera({ target: [0, 0, 0], distance: 50 }), lighting: new models.LightingPreset({ name: 'daylight' }), output: new models.OutputSpec({ width: 32, height: 24 }), reproducibility: new models.ReproducibilityProfile({ seed: 42 }) });
        expect(models.SceneRecipe.fromJSON(r.serialize()).serialize()).toBe(r.serialize()); expect(r.value.layers?.map(l => l.kind)).toEqual(['raster', 'vector', 'labels', 'buildings', 'point-cloud', 'tiles3d']);
        const s = new MapScene(r); expect(s.recipe.serialize()).toBe(r.serialize()); expect(typeof s.validate).toBe('function'); expect(typeof s.render).toBe('function'); expect(s.lastValidationReport).toBeNull(); s.dispose();
    });
    it('retains building product support intent and clears output under both policies', async () => {
        for (const supportLevel of ['Pro-gated', 'placeholder/fallback', 'unsupported', 'experimental'] as const) {
            const r = recipe(); r.layers = [{ ...building(), supportLevel }];
            const s = new MapScene(r), report = s.validate();
            expect(report.renderBlocked('continue_on_warning')).toBe(true); expect(report.renderBlocked('fail_on_warning')).toBe(true);
            expect(report.layer_summaries.find(l => l.layer_id === 'buildings')?.support_level).toBe(supportLevel);
            expect(report.diagnostics.some(d => d.code === ({ 'Pro-gated': 'pro_gated_path', 'placeholder/fallback': 'placeholder_fallback', unsupported: 'unsupported_feature', experimental: 'experimental_feature' })[supportLevel])).toBe(true);
            await expect(s.render()).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' }); expect((await s.reviewRecord()).last_render).toBeNull(); s.dispose();
        }
    });
    it('reports CRS identity formats empty data and building source failures on actual MapScenes', async () => {
        for (const target of ['terrain', 'vector'] as const) {
            const r = recipe(); r.crs = 'LOCAL'; r.layers = [{ kind: 'vector', layerId: 'roads', source: { id: 'roads', format: 'vector', crs: 'LOCAL', data: { name: 'roads', features: [{ kind: 'line', positions: [[0, 1, 0], [1, 1, 0]] }] } } }];
            const source = target === 'terrain' ? r.terrain!.source : (r.layers[0] as any).source;
            delete source.crs; const missing = new MapScene(r); expect(missing.validate().diagnostics.find(d => d.code === 'missing_crs')?.layer_id).toBe(target === 'terrain' ? 'terrain' : 'roads'); missing.dispose();
            source.crs = 'EPSG:4326'; const mismatch = new MapScene(r); expect(mismatch.validate().diagnostics.find(d => d.code === 'crs_mismatch')).toMatchObject({ details: { scene_crs: 'LOCAL', layer_crs: 'EPSG:4326' } }); mismatch.dispose();
        }
        const r = recipe(); r.layers = [building()]; const b = r.layers[0] as any; b.source = { id: 'b', format: 'geojson', crs: 'LOCAL', url: 'https://example.test/missing.geojson' };
        vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 })); const missing = new MapScene(r); const report = await missing.prepare(); expect(report.diagnostics.find(d => d.code === 'missing_external_asset')).toMatchObject({ layer_id: 'buildings', details: { path: b.source.url } }); expect(report.layer_summaries.find(l => l.layer_id === 'buildings')?.support_level).toBe('unsupported'); missing.dispose();
        b.source.format = 'txt'; const bad = new MapScene(r); expect(bad.validate().diagnostics.find(d => d.code === 'unsupported_asset_format')?.details.supported_formats).toContain('geojson'); bad.dispose();
        for (const kind of ['vector', 'labels'] as const) {
            r.layers = [{ kind, layerId: kind, source: { id: kind, format: kind === 'vector' ? 'vector' : 'labels', crs: 'LOCAL' } } as any]; const empty = new MapScene(r); expect(empty.validate().diagnostics.find(d => d.code === 'missing_renderable_data')?.layer_id).toBe(kind); empty.dispose();
        }
    });
    it('prepares real GeoJSON buildings and includes geometry in memory estimates', async () => {
        const r = recipe(); r.layers = [building()]; const one = new MapScene(r), count = one.validate().layer_summaries.find(l => l.layer_id === 'buildings')!;
        expect(count.object_count).toBe(1); expect(count.memory_estimate_bytes).toBeGreaterThan(0); expect(one.validate().estimated_gpu_memory_bytes).toBeGreaterThan(count.memory_estimate_bytes!); one.dispose();
        const b = r.layers[0] as any; b.source = { id: 'b', format: 'geojson', crs: 'LOCAL', url: 'https://example.test/buildings.geojson' };
        const bytes = readFileSync(new URL('../fixtures/w15/buildings.geojson', import.meta.url)); vi.stubGlobal('fetch', async () => new Response(bytes));
        const s = new MapScene(r); expect((await s.prepare()).status).toBe('ok'); expect(s.lastValidationReport!.layer_summaries.find(l => l.layer_id === 'buildings')?.object_count).toBeGreaterThan(0); expect(s.resources.find(r => r.id === 'b')?.state).toBe('ready'); s.dispose();
    });
    it('preserves point-cloud fallback before preparation even for nonempty inline data', async () => {
        const r = recipe(); r.layers = [{ kind: 'point-cloud', layerId: 'points', source: { id: 'p', format: 'points', crs: 'LOCAL', data: { positions: new Float32Array(24 * 3) } }, supportLevel: 'supported' }];
        const fetch = vi.fn(), request = vi.fn(), sink = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('navigator', { gpu: { requestAdapter: request } });
        const s = new MapScene(r), report = s.validate();
        expect(report.status).toBe('error'); expect(report.diagnostics.map(d => d.code)).toEqual(['placeholder_fallback']);
        expect(report.diagnostics[0]).toMatchObject({ severity: 'error', layer_id: 'points', details: { feature: 'point cloud MapScene render path' } });
        expect(report.layer_summaries.find(l => l.layer_id === 'points')).toMatchObject({ support_level: 'placeholder/fallback', object_count: 24 });
        expect((await s.prepare()).toJSON()).toEqual(report.toJSON());
        await expect(s.render({ sink: new WritableStream({ write: sink }) })).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
        expect(fetch).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled();
        expect(s.lastValidationReport?.toJSON()).toEqual(report.toJSON());
        expect((await s.reviewRecord()).last_render).toBeNull(); expect((await s.reviewRecord()).renderable).toBe(false); s.dispose();
    });
    it.each(['las', 'laz', 'copc', 'ept'])('blocks ranged %s recipes before network or GPU access', async format => {
        const r = recipe(); r.layers = [{ kind: 'point-cloud', layerId: 'points', source: { id: 'p', format, crs: 'LOCAL', url: `https://example.test/points.${format}` } }];
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const s = new MapScene(r);
        expect(s.validate().diagnostics[0]).toMatchObject({ code: 'placeholder_fallback', details: { feature: 'point cloud MapScene render path' } });
        await expect(s.render()).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' }); expect(fetch).not.toHaveBeenCalled(); s.dispose();
    });
    it('preserves the public tiles validator diagnostic and local tile count', async () => {
        const r = recipe(); r.layers = [tiles()]; const s = new MapScene(r), report = s.validate();
        expect(report.status).toBe('error'); expect(report.diagnostics.map(d => d.code)).toEqual(['python_public_3dtiles_incomplete']);
        expect(report.diagnostics[0]).toMatchObject({ layer_id: 'tiles', support_level: 'underdeveloped' });
        expect(report.layer_summaries.find(l => l.layer_id === 'tiles')).toMatchObject({ support_level: 'underdeveloped', details: { source_kind: 'tileset.json', tile_count: 1 } });
        for (const policy of ['continue_on_warning', 'fail_on_warning'] as const) { const copy = new MapScene({ ...r, renderPolicy: policy }); await expect(copy.render()).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' }); copy.dispose(); }
        expect((await s.reviewRecord()).renderable).toBe(false); s.dispose();
        expect(getMapSceneSupportMatrix().find(e => e.capability === 'tiles3d')?.support_level).toBe('underdeveloped');
        expect(getMapSceneSupportMatrix().find(e => e.capability === 'point-cloud')?.support_level).toBe('placeholder/fallback');
    });
    it('preserves tile format, feature, cache and LOD metadata in public summaries', () => {
        const r = recipe(), layer = tiles({ cache_budget: 4096, cache_stats: { resident_tiles: 2, bytes_used: 1024 }, lod: { maximum_screen_space_error: 8, maximum_depth: 3 }, unsupported_features: ['draco_mesh_compression', 'external_glb_extension'] });
        r.layers = [layer]; const s = new MapScene(r), report = s.validate(), summary = report.layer_summaries.find(l => l.layer_id === 'tiles')!;
        expect(summary.details.cache_budget).toBe(4096); expect(summary.details.cache_stats).toEqual({ bytes_used: 1024, resident_tiles: 2 }); expect(summary.details.lod).toEqual({ maximum_depth: 3, maximum_screen_space_error: 8 });
        expect(report.diagnostics.filter(d => d.code === 'unsupported_tile_feature').map(d => d.details.feature)).toEqual(['draco_mesh_compression', 'external_glb_extension']);
        expect(report.unsupported_features['tiles3d.feature']).toBe('unsupported'); s.dispose();
        (layer as any).source.format = 'glb'; const bad = new MapScene(r), format = bad.validate();
        expect(format.diagnostics.find(d => d.code === 'unsupported_tile_format')?.details.format).toBe('glb'); expect(format.unsupported_features['tiles3d.format']).toBe('unsupported'); bad.dispose();
    });
    it('retains native building cache and instancing diagnostics and per-layer details', () => {
        const r = recipe(); r.layers = [building({ unavailable_cache_lod_stats: ['cache', 'lod'], instancing: { requested: true, path: 'building layer MapScene instancing', support_level: 'unsupported' } })];
        r.diagnosticsPolicy = { largeSceneSummary: true }; const s = new MapScene(r), report = s.validate(), summary = report.layer_summaries.find(l => l.layer_id === 'buildings')!;
        expect(report.diagnostics.find(d => d.code === 'unavailable_cache_lod_stats')).toMatchObject({ support_level: 'underdeveloped', details: { layer_type: 'building_layer', unavailable_stats: ['cache', 'lod'] } });
        expect(report.diagnostics.find(d => d.code === 'unsupported_instancing_path')).toMatchObject({ support_level: 'unsupported', object_id: 'instancing', details: { path: 'building layer MapScene instancing' } });
        expect(summary.details.unavailable_cache_lod_stats).toEqual(['cache', 'lod']); expect(summary.details.instancing_status).toEqual({ requested: true, path: 'building layer MapScene instancing', support_level: 'unsupported' });
        expect(report.layer_summaries.find(l => l.layer_id === 'large_scene.resources')?.details.instancing_status).toEqual({ buildings: summary.details.instancing_status }); s.dispose();
    });
    it('normalizes native cache LOD and instancing availability by layer type', () => {
        const r = recipe(); r.terrain!.requestedStats = ['cache']; r.diagnosticsPolicy = { largeSceneSummary: true };
        r.layers = [tiles({ cache_stats: { entries: 2, bytes: 1024 }, cache_budget: 8, lod: { sse: 16, max_depth: 3 } }), { kind: 'point-cloud', layerId: 'points', source: { id: 'p', format: 'points', crs: 'LOCAL', data: { positions: new Float32Array(30) } }, metadata: { unavailable_cache_lod_stats: ['lod'] } }, building({ instancing: { requested: true, support_level: 'unsupported', path: 'building instances' } })];
        const s = new MapScene(r), report = s.validate(), summary = report.layer_summaries.find(l => l.layer_id === 'large_scene.resources')!, entries = Object.fromEntries((summary.details.cache_lod_status as any[]).map(e => [e.layer_id, e]));
        expect(entries.tiles.cache_stats).toEqual({ bytes: 1024, entries: 2 }); expect(entries.tiles.lod).toEqual({ max_depth: 3, sse: 16 }); expect(entries.points.unavailable_cache_lod_stats).toEqual(['lod']);
        expect(summary.details.unavailable_stats).toContainEqual({ layer_id: 'terrain', stats: ['cache'] }); expect((summary.details.instancing_status as any).buildings.support_level).toBe('unsupported'); s.dispose();
    });
    it('reports native building texture diagnostics and scalar fallback before rendering', async () => {
        const r = recipe(); r.layers = [building({ textured_materials: [{ material_id: 'facade', object_id: 'building-1', albedo_texture: 'missing/facade.ktx2', texture_format: 'ktx2', uv_available: false, scalar_fallback: true }] })];
        const s = new MapScene(r), report = s.validate(), byCode = Object.fromEntries(report.diagnostics.map(d => [d.code, d]));
        expect(report.status).toBe('error'); expect(report.renderBlocked()).toBe(true);
        expect(byCode.missing_texture_path).toMatchObject({ object_id: 'building-1', details: { path: 'missing/facade.ktx2', material_id: 'facade' } });
        expect(byCode.missing_uvs?.object_id).toBe('building-1'); expect(byCode.unsupported_texture_format?.details.format).toBe('ktx2'); expect(byCode.placeholder_fallback?.details.feature).toBe('building textured material scalar fallback');
        expect(report.layer_summaries.find(l => l.layer_id === 'buildings')?.support_level).toBe('placeholder/fallback');
        await expect(s.render()).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' }); expect((await s.reviewRecord()).last_render).toBeNull(); s.dispose();
    });
    it('keeps textured building intent diagnostic-only even when asset and UV metadata are available', async () => {
        const r = recipe(); r.layers = [building({ textured_materials: [{ material_id: 'facade', object_id: 'building-1', albedo_texture: 'facade.png', texture_format: 'png', uv_available: true, asset_available: true }] })];
        const s = new MapScene(r), report = s.validate();
        expect(report.diagnostics.map(d => d.code)).toEqual(['unsupported_feature']); expect(report.diagnostics[0]).toMatchObject({ layer_id: 'buildings', object_id: 'building-1', details: { feature: 'building textured PBR render path' } });
        expect(report.layer_summaries.find(l => l.layer_id === 'buildings')).toMatchObject({ support_level: 'unsupported', details: { textured_material_status: 'unsupported', textured_materials: [{ material_id: 'facade', object_id: 'building-1', albedo_texture: 'facade.png', texture_format: 'png', uv_available: true, scalar_fallback: false }] } });
        await expect(s.render()).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' }); s.dispose();
    });
    it('keeps combined P2 validation deterministic and blocks no-op render success', async () => {
        const r = recipe(); r.diagnosticsPolicy = { largeSceneSummary: true }; r.terrain!.source.data!.material = { virtualTexture: { enabled: true, layers: [{ family: 'normal' }] } };
        r.layers = [building({ instancing: { requested: true, support_level: 'unsupported', path: 'building instances' }, textured_materials: [{ material_id: 'facade', object_id: 'building-1', albedo_texture: 'facade.png', uv_available: true, asset_available: true }] })];
        const s = new MapScene(r); expect(s.validate().toJSON()).toEqual(s.validate().toJSON()); const writes = vi.fn();
        await expect(s.render({ sink: new WritableStream({ write: writes }) })).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
        expect(writes).not.toHaveBeenCalled(); expect(s.lastValidationReport?.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['vt_unsupported_family', 'unsupported_feature'])); s.dispose();
    });
    it('keeps advanced label diagnostics and repeated placement deterministic', () => {
        const input = { labels: [{ id: 'curved', text: 'River', geometry: { type: 'LineString', coordinates: [[0, 0], [20, 5]] }, curved_text: true }, { id: 'repeat', text: 'Road', geometry: { type: 'LineString', coordinates: [[0, 20], [80, 20]] }, repeat_distance: 40 }], viewport: [100, 100] as [number, number], seed: 9 };
        const first = LabelPlan.compile(input).toJSON(), second = LabelPlan.compile(input).toJSON();
        expect(first).toEqual(second); expect(first.accepted.map(l => l.label_id)).toEqual(['repeat']); expect(first.diagnostics.some(d => d.code === 'experimental_feature')).toBe(true);
    });
    it('summarizes known memory with budget diagnostics without inventing unresolved memory', () => {
        const r = recipe(); r.diagnosticsPolicy = { gpuMemoryBudgetBytes: 1, largeSceneSummary: true }; r.layers = [building(), { kind: 'point-cloud', layerId: 'points', source: { id: 'p', format: 'points', crs: 'LOCAL', data: { positions: new Float32Array(15) } } }, tiles({ memory_estimate_bytes: 4096 })];
        const s = new MapScene(r), report = s.validate(), summary = report.layer_summaries.find(l => l.layer_id === 'large_scene.resources')!;
        expect(report.diagnostics.some(d => d.code === 'estimated_gpu_memory')).toBe(true); expect(summary.details.total_estimated_gpu_memory_bytes).toBe(report.estimated_gpu_memory_bytes);
        for (const entry of summary.details.memory_estimates as any[]) expect(entry.memory_estimate_bytes).toBe(report.layer_summaries.find(l => l.layer_id === entry.layer_id)?.memory_estimate_bytes); s.dispose();
        r.layers = [{ kind: 'point-cloud', layerId: 'unresolved', source: { id: 'remote', format: 'las', crs: 'LOCAL', url: 'https://example.test/p.las' } }];
        const unknown = new MapScene(r), large = unknown.validate().layer_summaries.find(l => l.layer_id === 'large_scene.resources')!;
        expect((large.details.memory_estimates as any[]).some(e => e.layer_id === 'unresolved')).toBe(false); expect(large.details.unavailable_stats).toContainEqual({ layer_id: 'unresolved', stats: ['memory'] }); unknown.dispose();
    });
    it('orders bottleneck layers deterministically from known buffers and preserves report roundtrip', () => {
        const r = recipe(); r.diagnosticsPolicy = { largeSceneSummary: true }; r.layers = [building(), { kind: 'point-cloud', layerId: 'points', source: { id: 'p', format: 'points', crs: 'LOCAL', data: { positions: new Float32Array(3000) } } }];
        const s = new MapScene(r), first = s.validate().toJSON(), second = s.validate().toJSON(); expect(first).toEqual(second);
        const summary = ValidationReport.fromJSON(first).layer_summaries.find(l => l.layer_id === 'large_scene.resources')!;
        expect((summary.details.bottleneck_layer_types as string[]).slice(0, 2)).toEqual(['point_cloud_layer', 'building_layer']); expect((summary.details.bottleneck_layers as any[])[0].layer_id).toBe('points'); s.dispose();
    });
    it('validates raster options and the merged list including inherited terrain overlays', async () => {
        const image = { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) }, raster = { kind: 'raster', layerId: 'overlay', source: { id: 'o', format: 'rgba', crs: 'LOCAL', data: image } } as const;
        for (const options of [{ opacity: 7 }, { opacity: .5, typo: true }]) {
            const r = recipe(); r.layers = [{ ...raster, options } as any]; const s = MapScene.fromJSON(new SceneRecipe(r).toJSON()); expect(s.validate().renderBlocked()).toBe(true); expect((await s.prepare()).renderBlocked()).toBe(true); expect((await s.reviewRecord()).renderable).toBe(false); s.dispose();
        }
        const r = recipe(); r.layers = Array.from({ length: 9 }, (_, i) => ({ ...raster, layerId: `overlay-${i}`, source: { ...raster.source, id: `image-${i}` } })); const nine = new MapScene(r); expect(nine.validate().renderBlocked()).toBe(true); nine.dispose();
        r.layers = r.layers.slice(0, 8); r.terrain!.source.data!.overlays = { layers: [{ image }] }; const inherited = new MapScene(r); expect(inherited.validate().renderBlocked()).toBe(true); inherited.dispose();
        r.terrain!.source.data!.overlays.layers![0]!.visible = false; const eight = new MapScene(r); expect(eight.validate().status).toBe('ok'); expect((await eight.prepare()).status).toBe('ok'); eight.dispose();
    });
    it('rejects camera style and traversal typos from JSON before preparing', async () => {
        const variants: SceneRecipeInput[] = [];
        for (const key of ['elevation', 'fov']) { const r = recipe(); (r.camera as any)[key] = 80; variants.push(r); }
        const labels = recipe(); labels.layers = [{ kind: 'labels', layerId: 'labels', source: { id: 'labels', format: 'labels', crs: 'LOCAL', data: [{ id: 'a', text: 'A', position: [10, 10, 0] }] }, style: { font_size: 16 } as any }]; variants.push(labels);
        for (const field of ['style', 'traversal']) { const r = recipe(); r.layers = [{ kind: 'point-cloud', layerId: 'points', source: { id: 'p', format: 'points', crs: 'LOCAL', data: { positions: new Float32Array([0, 0, 0]) } }, [field]: { typo: 7 } }]; variants.push(r); }
        for (const r of variants) { const s = MapScene.fromJSON(new SceneRecipe(r).toJSON()), report = s.validate(); expect(report.diagnostics.some(d => d.code === 'unsupported_recipe_field')).toBe(true); expect((await s.prepare()).renderBlocked()).toBe(true); expect((await s.reviewRecord()).renderable).toBe(false); s.dispose(); }
    });
    it('reports invalid lighting during synchronous validation instead of an internal preparation error', async () => {
        const r = recipe(); r.lighting = { name: 'bogus' as any }; const s = MapScene.fromJSON(new SceneRecipe(r).toJSON());
        expect(s.validate().diagnostics.find(d => d.code === 'invalid_lighting')?.severity).toBe('error'); expect((await s.prepare()).renderBlocked()).toBe(true); await expect(s.render()).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' }); s.dispose();
    });
    it('raises recipe serialization limits consistently for large DEM construction validation and JSON replay', () => {
        const r = recipe(), width = 4200; r.terrain!.source.data = { width, height: width, heights: new Float32Array(width * width), crs: 'LOCAL' }; r.terrain!.source.maxBytes = 256 * 1024 * 1024; r.diagnosticsPolicy = { maxResourceBytes: 256 * 1024 * 1024 };
        const source = new SceneRecipe(r), encoded = source.toJSON(), restored = SceneRecipe.fromJSON(encoded); expect(restored.value.terrain!.source.data!.heights.byteLength).toBe(width * width * 4);
        const scene = new MapScene(restored); expect(scene.validate().diagnostics.some(d => d.code === 'resource_limit_exceeded')).toBe(false); scene.dispose();
        r.diagnosticsPolicy.maxRecipeBytes = 1024; expect(() => new SceneRecipe(r)).toThrow('serialized byte limit');
    }, 60000);
});
