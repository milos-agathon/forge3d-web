import { describe, it, expect, vi, afterEach } from 'vitest';
import { MapScene } from '../../src-ts/map-scene.js';
import { SceneRecipe, encodeMapData, decodeMapData, TerrainSource, OrbitCamera, LightingPreset, OutputSpec, ReproducibilityProfile, VectorOverlay } from '../../src-ts/map-recipe.js';
import { getMapSceneSupportMatrix, MAP_SCENE_LAYER_KINDS } from '../../src-ts/map-support.js';
import { RenderFailurePolicy } from '../../src-ts/diagnostics.js';
import { compositeMapPoints, mapLinearDepth, mapHardwareDepth } from '../../src-ts/map-render.js';
import type { SceneRecipeInput } from '../../src-ts/map-scene-types.js';
import { generatePrimitive } from '../../src-ts/geometry.js';
export function recipe(): SceneRecipeInput { return { crs: 'LOCAL', terrain: new TerrainSource({ source: { id: 'dem', format: 'heightmap', crs: 'LOCAL', data: { width: 3, height: 3, heights: new Float32Array([0, 1, 0, 1, 3, 1, 0, 1, 0]), spacing: [10, 10], domain: [0, 3], bounds: [-10, -10, 10, 10], crs: 'LOCAL' } } }), camera: new OrbitCamera({ target: [0, 0, 0], distance: 50, azimuthDegrees: 20, elevationDegrees: 55 }), lighting: new LightingPreset({ name: 'daylight' }), output: new OutputSpec({ width: 32, height: 24 }) }; }
afterEach(() => vi.unstubAllGlobals());
describe('W18 typed recipes and pre-render validation', () => {
    it('serializes every required model and typed buffers without changing bits', () => {
        const r = recipe();
        r.reproducibility = new ReproducibilityProfile({ seed: 42, assetHashesOrIds: { dem: 'dem-v1' } });
        r.layers = [new VectorOverlay({ layerId: 'roads', source: { id: 'roads-data', format: 'vector', crs: 'LOCAL', data: { name: 'roads', features: [{ id: 1, kind: 'line', positions: [[-8, 4, 0], [8, 4, 0]] }] } } })];
        const scene = new MapScene(r), payload = scene.toJSON(), restored = MapScene.fromJSON(payload);
        expect(restored.recipe.serialize()).toBe(scene.recipe.serialize());
        expect(restored.validate().status).toBe('ok');
        const original = r.terrain!.source.data!.heights;
        r.terrain!.source.data!.heights[0] = 999;
        expect(scene.recipe.value.terrain!.source.data!.heights[0]).toBe(0);
        const array = new Float64Array([Math.PI, -0, NaN, Infinity]);
        const round = decodeMapData(encodeMapData({ array })) as {
            array: Float64Array;
        };
        expect(new Uint8Array(round.array.buffer)).toEqual(new Uint8Array(array.buffer));
        expect(Object.is(round.array[1], -0)).toBe(true);
        scene.dispose();
        restored.dispose();
        void original;
    });
    it('rejects callbacks, cycles, unknown schemas, forged tags and oversized arrays', () => {
        const r = recipe();
        (r as any).transform = () => 0;
        expect(() => new SceneRecipe(r)).toThrow();
        const cyclic: any = {};
        cyclic.v = cyclic;
        expect(() => encodeMapData(cyclic)).toThrow();
        expect(() => SceneRecipe.fromJSON({ schema: 'forge3d.mapscene.recipe.v2', recipe: {} })).toThrow('schema');
        expect(() => decodeMapData({ $forge3d_array: 'Float32Array', base64: 'YQ==' })).toThrow('length');
        expect(() => decodeMapData({ $forge3d_array: 'Date', base64: '' })).toThrow();
        expect(() => decodeMapData({ $forge3d_array: 'Uint8Array', base64: '!!!' })).toThrow();
        expect(() => encodeMapData(new Uint8Array(8), 7)).toThrow('limit');
    });
    it('enumerates every layer and resource in deterministic order', () => {
        const r = recipe();
        r.layers = [{ kind: 'mesh', layerId: 'mesh', source: { id: 'z', format: 'mesh', crs: 'LOCAL', data: generatePrimitive('box') } }, { kind: 'point-cloud', layerId: 'points', source: { id: 'a', format: 'points', crs: 'LOCAL', data: { positions: new Float32Array([0, 4, 0]), colors: new Uint8Array([255, 0, 0]) } } }];
        const scene = new MapScene(r), report = scene.validate();
        expect(report.status).toBe('error');
        expect(report.diagnostics.map(d => d.code)).toContain('placeholder_fallback');
        expect(report.layer_summaries.map(s => s.layer_id)).toEqual(['mesh', 'points', 'terrain']);
        expect(scene.resources.map(s => s.id)).toEqual(['a', 'dem', 'z']);
        expect(report.estimated_gpu_memory_bytes).toBeGreaterThan(32 * 24 * 4);
        scene.dispose();
    });
    it.each(['Pro-gated', 'placeholder/fallback', 'unsupported', 'underdeveloped', 'missing', 'non-goal'] as const)('blocks %s intent', supportLevel => {
        const r = recipe();
        r.layers = [{ kind: 'diagnostic', layerId: 'intent', feature: 'native product path', supportLevel }];
        const s = new MapScene(r), report = s.validate();
        expect(report.hasErrors).toBe(true);
        expect(report.layer_summaries.find(l => l.layer_id === 'intent')?.support_level).toBe(supportLevel);
        s.dispose();
    });
    it('preserves the native experimental diagnostic while blocking unverified recipe intent', () => {
        const r = recipe();
        r.layers = [{ kind: 'diagnostic', layerId: 'exp', feature: 'curved labels', supportLevel: 'experimental' }];
        const s = new MapScene(r);
        expect(s.validate().diagnostics.find(d => d.code === 'experimental_feature')?.severity).toBe('warning');
        expect(s.validate().renderBlocked()).toBe(true);
        expect(s.validate().renderBlocked(RenderFailurePolicy.FAIL_ON_WARNING)).toBe(true);
        s.dispose();
    });
    it('rejects missing and mismatched CRS, IDs, source data, formats and recipe fields', () => {
        const cases: [
            string,
            (r: any) => void
        ][] = [['missing_crs', r => { delete r.terrain.source.crs; delete r.terrain.source.data.crs; delete r.crs; }], ['crs_mismatch', r => r.terrain.source.crs = 'EPSG:4326'], ['missing_source_identity', r => r.terrain.source.id = ''], ['missing_renderable_data', r => delete r.terrain.source.data], ['unsupported_asset_format', r => r.terrain.source.format = 'txt'], ['unsupported_recipe_field', r => r.rawIpc = { enabled: true }], ['invalid_layer', r => r.terrain.source.data.heights = new Float32Array(1)], ['invalid_output_size', r => r.output.width = 0], ['unsupported_output_format', r => r.output.format = 'jpg'], ['invalid_camera', r => r.camera.distance = 0], ['invalid_seed', r => r.reproducibility = { seed: -1 }]];
        for (const [code, mutate] of cases) {
            const r = recipe();
            mutate(r);
            const s = new MapScene(r);
            expect(s.validate().diagnostics.map(d => d.code), code).toContain(code);
            expect(s.validate().hasErrors, code).toBe(true);
            s.dispose();
        }
    });
    it('detects conflicting resource/layer IDs, unknown layers and empty geometry', () => {
        const r = recipe();
        r.layers = [{ kind: 'vector', layerId: 'terrain', source: { id: 'dem', format: 'vector', crs: 'LOCAL', data: { name: 'empty', features: [] } } }, { kind: 'mystery', layerId: 'unknown' } as never];
        const s = new MapScene(r);
        const codes = s.validate().diagnostics.map(d => d.code);
        for (const code of ['duplicate_layer_id', 'duplicate_resource_id', 'unsupported_layer_type', 'placeholder_fallback'])
            expect(codes).toContain(code);
        s.dispose();
    });
    it('blocks custom nodes and terrain nodes without a declared TerrainSource', () => {
        const r = recipe();
        r.layers = [{ kind: 'nodes', layerId: 'nodes', nodes: [
            { kind: 'custom', name: 'placeholder', layerType: 'unimplemented' },
            { kind: 'terrain', name: 'second-terrain', terrain: r.terrain!.source.data! },
        ] }];
        const s = new MapScene(r), report = s.validate();
        expect(report.renderBlocked()).toBe(true);
        expect(report.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['placeholder_fallback', 'unsupported_layer_combination']));
        s.dispose();
    });
    it('detects unsupported VT, product instancing and unavailable stats without fabricated telemetry', () => {
        const r = recipe();
        r.terrain!.source.data!.material = { virtualTexture: { enabled: true, layers: [{ family: 'normal' }, { family: 'mask' }] } };
        r.layers = [{ kind: 'mesh', layerId: 'mesh', source: { id: 'cube', format: 'mesh', crs: 'LOCAL', data: generatePrimitive('box') }, instancingPath: 'product', requestedStats: ['lod', 'cache_hits'] }];
        const s = new MapScene(r), codes = s.validate().diagnostics.map(d => d.code);
        expect(codes.filter(c => c === 'vt_unsupported_family')).toHaveLength(2);
        expect(codes).toContain('unsupported_instancing_path');
        expect(codes).toContain('unavailable_cache_lod_stats');
        s.dispose();
    });
    it('reports texture intent with object/material IDs before building rendering', () => {
        const r = recipe();
        r.layers = [{ kind: 'buildings', layerId: 'buildings', source: { id: 'b', format: 'buildings', crs: 'LOCAL', data: [{ id: 'b1', mesh: generatePrimitive('box') }] }, options: { textures: [{ materialId: 'm', objectId: 'b1', uvAvailable: false, albedoTexture: 'missing.dds' }] } }];
        const s = new MapScene(r), report = s.validate();
        expect(report.hasErrors).toBe(true);
        expect(report.diagnostics.find(d => d.code === 'missing_uvs')?.object_id).toBe('b1');
        expect(report.diagnostics.find(d => d.code === 'missing_texture_path')?.details.material_id).toBe('m');
        s.dispose();
    });
    it('retains native memory warning semantics and enforces the stricter warning policy', async () => {
        const r = recipe();
        r.diagnosticsPolicy = { gpuMemoryBudgetBytes: 1 };
        const s = new MapScene(r);
        expect(s.validate().status).toBe('warning');
        expect(s.validate().diagnostics[0]?.code).toBe('estimated_gpu_memory');
        s.dispose();
        r.renderPolicy = 'fail_on_warning';
        const blocked = new MapScene(r);
        await expect(blocked.render()).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
        expect(blocked.lastValidationReport?.status).toBe('warning');
        expect(blocked.lastValidationReport?.diagnostics.map(d => d.code)).toEqual(['estimated_gpu_memory']);
        expect(blocked.getMemoryReport().gpuBytes).toBe(0);
        blocked.dispose();
    });
    it('support matrix covers every adapter and returns detached copies', () => { const entries = getMapSceneSupportMatrix(); for (const kind of MAP_SCENE_LAYER_KINDS.filter(k => k !== 'diagnostic'))
        expect(entries.some(e => e.capability === kind)).toBe(true); entries[0]!.limitations.push('mutated'); expect(getMapSceneSupportMatrix()[0]!.limitations).not.toContain('mutated'); });
    it('enumerates terrain and layer cache/LOD/instancing limitations in the large-scene summary', () => {
        const r = recipe();
        r.terrain!.requestedStats = ['cache'];
        r.diagnosticsPolicy = { largeSceneSummary: true };
        r.layers = [{ kind: 'scatter', layerId: 'instances', batches: [], requestedStats: ['lod'], instancingPath: 'product building instances' }];
        const s = new MapScene(r), report = s.validate(), summary = report.layer_summaries.find(l => l.layer_id === 'large_scene.resources')!;
        expect(summary.details.unavailable_stats).toEqual([{ layer_id: 'instances', stats: ['lod'] }, { layer_id: 'terrain', stats: ['cache'] }]);
        expect(summary.details.instancing_status).toEqual({ instances: { requested: true, path: 'product building instances', support_level: 'unsupported' } });
        expect(report.diagnostics.filter(d => d.code === 'unavailable_cache_lod_stats')).toHaveLength(2);
        expect(report.layer_summaries.find(l => l.layer_id === 'terrain')).toMatchObject({ support_level: 'underdeveloped', diagnostic_codes: ['unavailable_cache_lod_stats'] });
        expect(report.unsupported_features['layer:terrain']).toBe('underdeveloped');
        s.dispose();
    });
    it('preserves per-object missing glyphs in preflight and empty-layer summary codes', () => {
        const r = recipe();
        r.layers = [{ kind: 'labels', layerId: 'labels', source: { id: 'labels', format: 'labels', crs: 'LOCAL', data: [{ id: 'cafe', text: 'Café', position: [10, 10, 0] }] }, atlasGlyphs: [...'Caf'] }, { kind: 'scatter', layerId: 'empty', batches: [] }];
        const s = new MapScene(r), report = s.validate();
        expect(report.diagnostics.find(d => d.code === 'missing_glyphs')?.object_id).toBe('cafe');
        expect(report.layer_summaries.find(l => l.layer_id === 'empty')?.diagnostic_codes).toContain('placeholder_fallback');
        s.dispose();
    });
});
describe('W18 resource loading, reports and ownership', () => {
    it('loads a bounded remote F32 resource and verifies its digest before preparing', async () => {
        const r = recipe(), bytes = r.terrain!.source.data!.heights.slice().buffer, sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
        r.terrain!.source = { id: 'dem', format: 'f32', url: 'https://example.test/dem.f32', crs: 'LOCAL', sha256: sha, parameters: { width: 3, height: 3, spacing: [10, 10], domain: [0, 3], bounds: [-10, -10, 10, 10] } };
        const fetch = vi.fn(async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } }));
        vi.stubGlobal('fetch', fetch);
        const scene = new MapScene(r);
        expect((await scene.prepare()).status).toBe('ok');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(scene.resources[0]?.state).toBe('ready');
        const a = await scene.reviewRecord(), b = await scene.reviewRecord();
        expect(a).toEqual(b);
        expect(a.renderable).toBe(true);
        scene.dispose();
        expect(scene.getMemoryReport()).toMatchObject({ cpuBytes: 0, gpuBytes: 0, resourceCount: 0 });
    });
    it('enumerates all failed external assets and never invents missing data', async () => {
        const r = recipe();
        r.terrain!.source = { id: 'dem', format: 'f32', url: 'https://example.test/missing', crs: 'LOCAL', parameters: { width: 3, height: 3 } };
        r.layers = [{ kind: 'raster', layerId: 'ortho', source: { id: 'ortho', format: 'png', crs: 'LOCAL', url: 'https://example.test/missing.png' } }];
        vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
        const s = new MapScene(r);
        expect((await s.prepare()).hasErrors).toBe(true);
        expect(s.resources.map(r => r.state)).toEqual(['failed', 'failed']);
        expect(s.lastValidationReport!.diagnostics).toHaveLength(2);
        expect((await s.reviewRecord()).renderable).toBe(false);
        await expect(s.render()).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
        s.dispose();
    });
    it('rejects corrupt bytes and digest tampering before any GPU request', async () => {
        const r = recipe();
        r.terrain!.source = { id: 'dem', format: 'f32', url: 'https://example.test/dem', crs: 'LOCAL', parameters: { width: 3, height: 3 }, sha256: '0'.repeat(64) };
        vi.stubGlobal('fetch', async () => new Response(new Uint8Array(36)));
        const s = new MapScene(r);
        expect((await s.prepare()).diagnostics[0]?.code).toBe('asset_integrity_mismatch');
        s.dispose();
        delete r.terrain!.source.sha256;
        vi.stubGlobal('fetch', async () => new Response(new Uint8Array(3)));
        const bad = new MapScene(r);
        expect((await bad.prepare()).diagnostics[0]?.code).toBe('resource_load_failed');
        bad.dispose();
    });
    it('cancels an in-flight fetch, bounds concurrent calls and disposes late owners', async () => {
        const r = recipe();
        r.terrain!.source = { id: 'dem', format: 'f32', url: 'https://example.test/dem', crs: 'LOCAL', parameters: { width: 3, height: 3 } };
        let entered!: () => void;
        const start = new Promise<void>(resolve => entered = resolve);
        vi.stubGlobal('fetch', async (_url: unknown, opts: RequestInit) => { entered(); return await new Promise<Response>((_, reject) => opts.signal!.addEventListener('abort', () => reject(new Error('abort')), { once: true })); });
        const s = new MapScene(r), pending = s.prepare();
        await start;
        await expect(s.prepare()).rejects.toMatchObject({ details: { reason: 'operation-in-progress' } });
        s.dispose();
        await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        expect(s.getMemoryReport().cpuBytes).toBe(0);
        expect(() => s.validate()).toThrow('disposed');
        s.dispose();
    });
    it('releases repeated mesh preparation without retaining old buffers', async () => {
        const r = recipe();
        r.layers = [{ kind: 'point-cloud', layerId: 'points', source: { id: 'p', format: 'points', crs: 'LOCAL', data: { positions: new Float32Array([0, 4, 0]), colors: new Uint8Array([255, 0, 0]) } } }, { kind: 'mesh', layerId: 'mesh', source: { id: 'm', format: 'mesh', crs: 'LOCAL', data: generatePrimitive('box') } }];
        r.layers = r.layers!.filter(l => l.kind !== 'point-cloud');
        const s = new MapScene(r);
        let bytes = 0;
        for (let i = 0; i < 12; i++) {
            const report = await s.prepare();
            expect(report.status, JSON.stringify(report.toJSON())).toBe('ok');
            if (!i)
                bytes = s.getMemoryReport().cpuBytes;
            expect(s.getMemoryReport().cpuBytes).toBe(bytes);
        }
        s.dispose();
        expect(s.getMemoryReport().resourceCount).toBe(0);
    });
    it('produces deterministic explicit CPU tracing output and review hashes', async () => {
        const r: SceneRecipeInput = { crs: 'LOCAL', camera: { position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fovYDegrees: 45, near: .1, far: 100 }, output: { width: 8, height: 8 }, reproducibility: { seed: 7, rendererBackend: 'cpu' }, layers: [{ kind: 'trace', layerId: 'trace', samples: 1, triangles: [{ v0: [-2, -2, 0], v1: [2, -2, 0], v2: [0, 2, 0], id: 1 }] }] };
        const s = new MapScene(r), one = await s.render(), two = await s.render();
        expect(one.frame.data).toEqual(two.frame.data);
        expect(one.executedLayerIds).toEqual(['trace']);
        expect(one.blob.type).toBe('image/png');
        expect(new Uint8Array(await one.blob.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
        expect((await s.reviewRecord()).last_render?.recipe_hash).toBe(one.recipeHash);
        s.dispose();
    });
    it('interrupts a stalled output sink and clears success on pre-aborted replay',async()=>{
        const r:SceneRecipeInput={crs:'LOCAL',camera:{position:[0,0,5],target:[0,0,0],up:[0,1,0],fovYDegrees:45,near:.1,far:100},output:{width:8,height:8},reproducibility:{seed:7,rendererBackend:'cpu'},layers:[{kind:'trace',layerId:'trace',samples:1,triangles:[{v0:[-2,-2,0],v1:[2,-2,0],v2:[0,2,0],id:1}]}]};
        const s=new MapScene(r);await s.render();const pre=new AbortController();pre.abort();await expect(s.render({signal:pre.signal})).rejects.toMatchObject({code:'REQUEST_CANCELLED'});expect((await s.reviewRecord()).last_render).toBeNull();
        let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),a=new AbortController(),sink=new WritableStream<Uint8Array>({write(){entered();return new Promise<void>(()=>{});}});
        const pending=s.render({signal:a.signal,sink});await started;a.abort();await expect(pending).rejects.toMatchObject({code:'REQUEST_CANCELLED'});expect(sink.locked).toBe(false);expect((await s.reviewRecord()).last_render).toBeNull();s.dispose();
    });
    it('keeps trace/raster mixing and furniture requests explicitly blocked', () => { const r = recipe(); r.layers = [{ kind: 'trace', layerId: 'trace', triangles: [{ v0: [0, 0, 0], v1: [1, 0, 0], v2: [0, 1, 0] }] }]; r.mapFurniture = { title: 'map' }; const s = new MapScene(r), codes = s.validate().diagnostics.map(d => d.code); expect(codes).toContain('unsupported_layer_combination'); expect(codes).toContain('unsupported_feature'); s.dispose(); });
    it('converts depth correctly and detects a deliberately broken occlusion control', () => {
        const c = { position: [0, 0, 5] as [
                number,
                number,
                number
            ], target: [0, 0, 0] as [
                number,
                number,
                number
            ], up: [0, 1, 0] as [
                number,
                number,
                number
            ], fovYDegrees: 45, near: .1, far: 100 };
        const linear = new Float32Array([0, .01, .1, .8, 1]);
        expect(Array.from(mapLinearDepth(mapHardwareDepth(linear, c), c))).toEqual(expect.arrayContaining([0, 1]));
        for (const [i, v] of mapLinearDepth(mapHardwareDepth(linear, c), c).entries())
            expect(v).toBeCloseTo(linear[i]!, 4);
        const base = new Uint8Array([0, 0, 255, 255]), point = new Uint8Array([128, 0, 0, 128]);
        expect(compositeMapPoints(base, new Float32Array([.2]), point, new Float32Array([.1]))).toEqual(new Uint8Array([128, 0, 127, 255]));
        expect(compositeMapPoints(base, new Float32Array([.05]), point, new Float32Array([.1]))).toEqual(base);
        expect(compositeMapPoints(base, new Float32Array([1]), point, new Float32Array([.1]))).not.toEqual(base);
    });
});
