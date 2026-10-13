import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { StyleSpec, parseStyle, parseStyleColor, styleToVectorStyle, styleToLabelStyle, compileStyle, styleLayerVisible, styleLabelRecords, loadStyle, styleFeaturesFromGeoJson, loadStyleLayers } from '../../src-ts/map-style.js';
import { evaluateStyleExpression as ev, evaluateStyleFilter } from '../../src-ts/style-expressions.js';
import { SceneState } from '../../src-ts/scene-review.js';
import { MapScene } from '../../src-ts/map-scene.js';
import { saveBundle, loadBundle, isBundle } from '../../src-ts/bundle.js';
import { zipSync } from 'fflate';
import { bundleHash, decodeBundleArchive, encodeBundleArchive } from '../../src-ts/bundle-archive.js';
import { SpriteAtlas, decodeGlyphRanges, loadGlyphRanges } from '../../src-ts/style-assets.js';
import { SceneRecipe } from '../../src-ts/map-recipe.js';
import type { SceneRecipeInput } from '../../src-ts/map-scene-types.js';
import type { VectorFeature } from '../../src-ts/vector-types.js';
export const recipe = (): SceneRecipeInput => ({ crs: 'LOCAL', camera: { position: [0, 12, 10], target: [0, 0, 0], up: [0, 1, 0], fovYDegrees: 45, near: .1, far: 100 }, output: { width: 64, height: 48 }, layers: [{ kind: 'nodes', layerId: 'ground', nodes: [{ kind: 'ground-plane', name: 'ground', size: [10, 10], height: 0, color: [.2, .3, .4, 1] }] }] });
const ctx = { properties: { name: 'Road', n: 7, kind: 'a', array: [5, 6] }, zoom: 10, geometryType: 'LineString' };
afterEach(() => vi.unstubAllGlobals());
describe('W19 native style expressions', () => {
    it.each([
        [['get', 'n'], 7], [['has', 'name'], true], [['get', 'missing'], null], [['at', 1, ['literal', [5, 6]]], 6], [['length', 'é🚀'], 2], [['zoom'], 10], [['geometry-type'], 'LineString'],
        [['interpolate', ['linear'], ['zoom'], 5, 1, 15, 10], 5.5], [['interpolate', ['exponential', 2], 1, 0, 0, 2, 12], 4], [['step', ['zoom'], 1, 10, 2, 15, 3], 2], [['match', ['get', 'kind'], ['a', 'b'], 5, 0], 5], [['case', ['>', ['get', 'n'], 5], 'yes', 'no'], 'yes'], [['coalesce', ['get', 'missing'], ['get', 'name']], 'Road'],
        [['+', 1, 2, 3], 6], [['-', 2], -2], [['-', 5, 2], 3], [['*', 2, 3], 6], [['/', 12, 3], 4], [['/', 1, 0], null], [['%', -7, 3], 2], [['^', 2, 3], 8], [['abs', -3], 3], [['ceil', 2.1], 3], [['floor', 2.9], 2], [['round', 2.5], 2], [['round', -1.5], -2], [['min', 3, 'invalid', 1], 1], [['max', 3, 1], 3], [['ln', 1], 0], [['log10', 100], 2], [['log2', 8], 3], [['sin', 0], 0], [['cos', 0], 1], [['tan', 0], 0], [['sqrt', 4], 2], [['sqrt', -1], null],
        [['==', 2, '2'], false], [['!=', 2, 3], true], [['<', 2, 3], true], [['<=', 2, 2], true], [['>', 2, 3], false], [['>=', 2, 2], true], [['all', true, 1], true], [['any', false, true], true], [['!', false], true],
        [['concat', 'a', ['get', 'missing'], 'b'], 'ab'], [['downcase', 'ROAD'], 'road'], [['upcase', 'road'], 'ROAD'], [['to-number', '12'], 12], [['to-number', 'bad'], null], [['to-boolean', 0], false], [['typeof', ['literal', []]], 'array'], [['to-string', 12], '12'], [['rgb', 255, 0, 0], [1, 0, 0, 1]], [['rgba', 0, 255, 0, .5], [0, 1, 0, .5]], [['unknown', 5], null],
    ])('evaluates %j against independent native expectations', (e, expected) => expect(ev(e, ctx)).toEqual(expected));
    it('short circuits unselected branches and bounds pathological inputs', () => {
        let nested: unknown = 1; for (let i = 0; i < 70; i++) nested = ['+', nested];
        expect(() => ev(nested)).toThrow('limit');
        expect(ev(['case', true, 4, nested])).toBe(4);
        expect(ev(['all', false, nested])).toBe(false);
    });
    it.each([
        [['==', 'kind', 'a'], true], [['!=', 'kind', 'b'], true], [['all', ['has', 'name'], ['>', 'n', 6]], true], [['any', ['==', 'n', 2], ['in', 'kind', 'a', 'b']], true], [['none', ['==', 'n', 2]], true], [['!has', 'absent'], true], [['!in', 'kind', 'b'], true], [['==', '$type', 'LineString'], true], [['==', ['get', 'name'], 'Road'], true],
    ])('supports property and expression filter %j', (filter, expected) => expect(evaluateStyleFilter(filter, ctx)).toBe(expected));
});
describe('W19 local feature styles and honest support', () => {
    it.each([['#fff', [1, 1, 1, 1]], ['#00ff0080', [0, 1, 0, 128 / 255]], ['rgba(0, 255, 0, 0.5)', [0, 1, 0, .5]], ['hsl(0, 100%, 50%)', [1, 0, 0, 1]], ['blue', [0, 0, 1, 1]], ['transparent', [0, 0, 0, 0]], ['invalid', null]])('parses native color %s', (input, output) => expect(parseStyleColor(input)).toEqual(output));
    it('loads Blob and preserves layers, filters and metadata with defensive copies', async () => {
        const style = await loadStyle(new Blob([JSON.stringify({ version: 8, name: 'test', layers: [{ id: 'water', type: 'fill', 'source-layer': 'water', paint: { 'fill-color': '#ff0000', 'fill-opacity': .5 } }] })]));
        expect(style.layerById('water')?.type).toBe('fill'); expect(style.layersForSourceLayer('water')).toHaveLength(1); expect(style.layersByType('fill')).toHaveLength(1);
        const copy = style.value; copy.layers![0]!.id = 'changed'; expect(style.layerById('water')).toBeDefined();
        expect(styleToVectorStyle(style.layers[0]!).color).toEqual([1, 0, 0, 1]); expect(styleToVectorStyle(style.layers[0]!).opacity).toBe(.5);
        expect(() => parseStyle({ version: 7 })).toThrow('version'); expect(() => parseStyle({ layers: [{ id: 'x', type: 'line' }, { id: 'x', type: 'fill' }] })).toThrow('unique');
    });
    it('maps fill, outline, line and circle with expressions, IDs, ordering and zoom visibility', () => {
        const features: VectorFeature[] = [{ id: 7, kind: 'polygon', rings: [[[-2, 0, -2], [2, 0, -2], [2, 0, 2]]], properties: { n: 3 } }, { id: 8, kind: 'line', positions: [[-2, 1, 0], [2, 1, 0]], properties: { class: 'road' } }, { id: 9, kind: 'point', position: [0, 2, 0] }];
        const spec = parseStyle({ layers: [{ id: 'area', type: 'fill', source: 'local', paint: { 'fill-color': ['match', ['get', 'n'], 3, '#ff0000', '#000000'], 'fill-outline-color': '#ffffff' } }, { id: 'road', type: 'line', source: 'local', filter: ['==', 'class', 'road'], paint: { 'line-color': '#00ff00', 'line-width': 3 } }, { id: 'point', type: 'circle', source: 'local', paint: { 'circle-radius': 8 } }, { id: 'hidden', type: 'circle', source: 'local', layout: { visibility: 'none' } }] });
        const result = compileStyle(spec, { local: features }, { crs: 'LOCAL' }); expect(result.report.status).toBe('ok'); expect(result.layers.map(l => l.layerId)).toEqual(['area', 'road', 'point']);
        const rendered = result.layers.flatMap(l => l.kind === 'vector' ? l.source.data!.features : []); expect(rendered.map(f => f.id)).toEqual([1, 2, 3, 4]); expect(rendered[0]!.properties?.forge3d_source_id).toBe(7); expect(rendered[2]!.style?.lineWidth).toBe(3); expect(rendered[3]!.style?.pointSize).toBe(16);
        expect(styleLayerVisible({ id: 'x', type: 'line', minzoom: 5, maxzoom: 15 }, 15)).toBe(true); expect(styleLayerVisible({ id: 'x', type: 'line', maxzoom: 15 }, 16)).toBe(false);
    });
    it('diagnoses unknown fields/operators/sources and retains exact native symbol diagnostic', () => {
        const style = parseStyle({ fog: {}, sources: { tiles: { type: 'vector' } }, layers: [{ id: 'bad', type: 'fill', paint: { 'fill-color': ['unimplemented', 1], 'fill-pattern': 'a' }, layout: { visibility: 'visible', unknown: true } }, { id: 'symbols', type: 'symbol' }, { id: 'extruded', type: 'fill-extrusion' }] });
        const report = style.validate(); expect(report.diagnostics.filter(d => d.code === 'unsupported_style_field').length).toBeGreaterThanOrEqual(4); expect(report.diagnostics.map(d => d.code)).toContain('experimental_feature'); expect(report.diagnostics.map(d => d.code)).toContain('unsupported_style_layer_type');
        const r = compileStyle(parseStyle({ layers: [{ id: 'x', type: 'line', source: 'missing' }] }), {}); expect(r.report.hasErrors).toBe(true);
        const scene = MapScene.fromStyle(recipe(), style, {}); expect(scene.validate().diagnostics.map(d => d.code)).toContain('experimental_feature'); scene.dispose();
    });
    it('converts labels without promoting native symbol rendering', () => {
        const layer = { id: 'labels', type: 'symbol', layout: { 'text-field': '{name}', 'text-size': 16 }, paint: { 'text-color': '#333333', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } };
        expect(styleToLabelStyle(layer).fontSize).toBe(16); expect(styleToLabelStyle(layer).haloWidth).toBe(2);
        expect(styleLabelRecords(layer, [{ id: 1, kind: 'point', position: [0, 0, 0], properties: { name: 'Town' } }])[0]?.text).toBe('Town');
    });
    it('loads bounded GeoJSON sources and preserves multi-geometry coordinate/feature identities', async () => {
        const data = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'town', properties: { name: 'Town' }, geometry: { type: 'MultiPoint', coordinates: [[10, 20, 3], [12, 22, 4]] } }] }, features = styleFeaturesFromGeoJson(data);
        expect(features.map(f => f.kind === 'point' ? f.position : null)).toEqual([[10, 3, 20], [12, 4, 22]]); expect(features[0]!.properties?.forge3d_geojson_id).toBe('town');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
        const spec = parseStyle({ sources: { towns: { type: 'geojson', data: 'towns.json' } }, layers: [{ id: 'towns', type: 'circle', source: 'towns' }] }), result = await loadStyleLayers(spec, { baseUrl: 'https://example.test/style.json', crs: 'LOCAL' }); expect(result.report.status).toBe('ok'); expect(result.layers).toHaveLength(1);
        await expect(loadStyleLayers(spec, { baseUrl: 'https://example.test/style.json', maxBytes: 1 })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' }); expect(() => styleFeaturesFromGeoJson({ type: 'Feature', geometry: { type: 'Point', coordinates: [NaN, 2] } })).toThrow('coordinate');
    });
});
describe('W19 bundles, review registry and migration', () => {
    function state() { return new SceneState({ base: recipe(), reviewLayers: [{ id: 'annotation', layers: [{ kind: 'nodes', layerId: 'overlay', nodes: [{ kind: 'overlay', name: 'panel', bounds: [2, 2, 8, 8], color: [1, 0, 0, 1] }] }] }], variants: [{ id: 'plain', activeLayerIds: [] }, { id: 'review', activeLayerIds: ['annotation'], preset: { timeSeconds: 12 } }], activeVariantId: 'plain', cameraBookmarks: [{ name: 'home', eye: [0, 12, 10], target: [0, 0, 0] }] }); }
    it('applies preset replacement and resets overrides with pure validated state', () => {
        const base = state(), manual = base.setReviewLayerVisible('annotation', true); expect(base.visibleLayerIds()).toEqual([]); expect(manual.visibleLayerIds()).toEqual(['annotation']); expect(manual.applyVariant('plain').visibleLayerIds()).toEqual([]);
        expect(base.applyVariant('review').effectiveRecipe().timeSeconds).toBe(12); expect(base.applyVariant('review').applyVariant('plain').effectiveRecipe().timeSeconds).toBeUndefined(); expect(() => base.applyVariant('bad')).toThrow('Unknown'); expect(() => base.setReviewLayerVisible('bad', true)).toThrow('Unknown');
        expect(() => new SceneState({ ...base.value, variants: [{ id: 'bad', activeLayerIds: ['missing'] }] })).toThrow('Unknown');
        expect(() => new SceneState({ ...base.value, reviewLayers: [{ id: 'a', layers: [] }, { id: 'a', layers: [] }] })).toThrow('duplicate');
        const copy = base.listVariants(); copy[0]!.id = 'changed'; expect(base.listVariants()[0]!.id).toBe('plain');
    });
    it('round trips canonical typed arrays, variants, override state, bookmarks and diagnostic reports', async () => {
        const s = state().setReviewLayerVisible('annotation', true), value = s.value;
        value.validationReport = new MapScene(recipe()).validate().toJSON(); value.base.terrain = { source: { id: 'dem', format: 'heightmap', crs: 'LOCAL', data: { width: 2, height: 2, heights: new Float32Array([0, 1, 2, 3]) } } };
        const blob = await saveBundle(value, { createdAt: '2026-01-01T00:00:00Z' }), loaded = await loadBundle(new File([blob], 'test.forge3d'));
        expect(loaded.manifest.version).toBe(2); expect(loaded.getActiveVariantId()).toBe('plain'); expect(loaded.sceneState.visibleLayerIds()).toEqual(['annotation']); expect(loaded.sceneState.value.cameraBookmarks).toEqual(value.cameraBookmarks); expect(loaded.validationReport?.toJSON()).toEqual(value.validationReport); expect(loaded.sceneState.value.base.terrain!.source.data!.heights).toEqual(new Float32Array([0, 1, 2, 3]));
        loaded.applyVariant('review'); expect(loaded.effectiveSceneState().layers).toHaveLength(2); const saved = await loaded.save(), reload = await loadBundle(saved); expect(reload.getActiveVariantId()).toBe('review'); loaded.dispose(); reload.dispose(); expect(loaded.getMemoryReport().cpuBytes).toBe(0); expect(() => loaded.listVariants()).toThrow('disposed');
    });
    it('deduplicates, rewrites and verifies assets offline and revokes every URL lease', async () => {
        const r = recipe(); r.layers = [{ kind: 'vector', layerId: 'a', source: { id: 'a', format: 'vector', crs: 'LOCAL', url: 'https://example.test/a.json' } }];
        const payload = new TextEncoder().encode(JSON.stringify({ name: 'a', features: [{ id: 1, kind: 'point', position: [0, 0, 0] }] })), fetcher = vi.fn(async () => new Response(payload)); vi.stubGlobal('fetch', fetcher);
        const archive = await saveBundle({ base: r }, { assets: { 'sprite.png': payload } }); expect(fetcher).toHaveBeenCalledTimes(1);
        const loaded = await loadBundle(archive); expect(Object.keys(loaded.manifest.checksums).filter(p => p.startsWith('assets/'))).toHaveLength(1);
        vi.stubGlobal('fetch', vi.fn(() => { throw Error('network forbidden'); }));
        const runtime = await loaded.runtimeSceneState(); expect(runtime.value.base.layers?.[0]!.kind).toBe('vector'); expect(loaded.getMemoryReport().objectUrlCount).toBe(1); expect(loaded.resolveAsset('sprite.png')).toMatch(/^blob:/); expect(() => loaded.resolveAsset('missing')).toThrow('absent'); loaded.dispose(); expect(loaded.getMemoryReport().objectUrlCount).toBe(0);
    });
    it('rejects tampering, missing checksums, unchecked extra entries, traversal and future schemas', async () => {
        const archive = new Uint8Array(await (await saveBundle(state())).arrayBuffer());
        for (const mode of ['tamper', 'missing', 'extra', 'version']) {
            const files = decodeBundleArchive(archive), manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
            if (mode === 'tamper') files['scene/state.json']![10] ^= 1;
            if (mode === 'missing') delete manifest.checksums['scene/state.json'];
            if (mode === 'extra') files['unchecked.bin'] = new Uint8Array([1]);
            if (mode === 'version') manifest.version = 99;
            files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
            await expect(loadBundle(encodeBundleArchive(files))).rejects.toMatchObject({ code: 'IO_ERROR' });
        }
        expect(() => encodeBundleArchive({ '../outside': new Uint8Array([1]) })).toThrow('Unsafe');
        await expect(loadBundle(new Uint8Array([1, 2]))).rejects.toThrow('ZIP');
        await expect(loadBundle(archive, { maxExpandedBytes: 16 })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    });
    it('migrates checksum-verified v1 recipes into an empty v2 review registry', async () => {
        const data = new TextEncoder().encode(new SceneRecipe(recipe()).serialize()), files = { 'scene/recipe.json': data, 'manifest.json': new TextEncoder().encode(JSON.stringify({ version: 1, name: 'legacy', checksums: { 'scene/recipe.json': await bundleHash(data) } })) }, loaded = await loadBundle(encodeBundleArchive(files));
        expect(loaded.migratedFrom).toBe(1); expect(loaded.listVariants()).toEqual([]); expect(loaded.listReviewLayers()).toEqual([]); const resaved = await loadBundle(await loaded.save()); expect(resaved.manifest.version).toBe(2); loaded.dispose(); resaved.dispose();
    });
    it.each([1, 2])('migrates actual native v%s directory manifests, mirrors and review registries without losing raw state', async version => {
        vi.stubGlobal('fetch', vi.fn(async url => new Response(readFileSync(new URL('../../assets/fonts/' + new URL(String(url)).pathname.split('/').at(-1), import.meta.url)))));
        const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)), base = { preset: { exposure: 2 }, camera_bookmarks: [{ name: 'legacy', eye: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0], fov_deg: 45 }], vector_overlays: [{ vertices: [[0, 0, 0, 1, 0, 0, 1]], indices: [0], primitive: 'points' }], labels: [{ text: 'Legacy', world_pos: [0, 0, 0] }] }, native = { base, review_layers: [{ id: 'notes', labels: [{ text: 'Review', world_pos: [1, 0, 0] }] }], variants: [{ id: 'review', active_layer_ids: ['notes'] }], active_variant_id: 'review' };
        const files: Record<string, Uint8Array> = version === 1 ? { 'render/preset.json': encode(base.preset), 'camera/bookmarks.json': encode(base.camera_bookmarks), 'overlays/vectors.geojson': encode(base.vector_overlays), 'overlays/labels.json': encode(base.labels) } : { 'scene/state.json': encode(native) };
        const checksums = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([p, v]) => [p, await bundleHash(v)])));
        files['manifest.json'] = encode({ version, name: 'legacy', checksums, camera_bookmarks: base.camera_bookmarks });
        const archive = zipSync({ ...files, 'overlays/': new Uint8Array() }), loaded = await loadBundle(archive, { nativeRecipe: recipe() });
        expect(loaded.migratedFrom).toBe(version); expect(loaded.sceneState.value.cameraBookmarks?.[0]?.name).toBe('legacy'); expect(loaded.sceneState.value.nativeSceneState).toBeDefined(); expect(loaded.sceneState.value.base.postFx?.effects[0]).toMatchObject({ exposure: 2 });
        expect(loaded.listVariants()).toHaveLength(version === 2 ? 1 : 0); const reloaded = await loadBundle(await loaded.save()); expect(reloaded.sceneState.value.nativeSceneState).toEqual(loaded.sceneState.value.nativeSceneState); expect(reloaded.sceneState.fonts).toHaveLength(3); loaded.dispose(); reloaded.dispose();
    });
    it('preserves missing-asset and unsupported-native intent as blocking diagnostic bundles', async () => {
        const r = recipe(); r.layers = [{ kind: 'vector', layerId: 'missing', source: { id: 'missing', crs: 'LOCAL', format: 'vector', url: 'https://missing.test/vector.json' } }]; vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        const scene = new MapScene(r), blob = await scene.saveBundle(), loaded = await loadBundle(blob); expect(loaded.validationReport?.hasErrors).toBe(true); expect(loaded.sceneState.value.reviewRecord).toEqual({ renderable: false, render_status: 'blocked_by_diagnostics', last_render: null });
        const offline = await MapScene.loadBundle(blob); expect(offline.validate().diagnostics.map(d => d.code)).toContain('missing_external_asset'); await expect(offline.prepare()).resolves.toMatchObject({ status: 'error' }); expect(await isBundle(blob)).toBe(true); expect(await isBundle(new Uint8Array(2))).toBe(false);
        scene.dispose(); loaded.dispose(); offline.dispose();
    });
    it('produces deterministic MapScene snapshots and keeps diagnostics without successful output claims', async () => {
        const scene = new MapScene(recipe()), first = await scene.saveBundle(), second = await scene.saveBundle(); expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array(await second.arrayBuffer())); const loaded = await loadBundle(first); expect(loaded.sceneState.value.reviewRecord?.renderable).toBe(false); expect(loaded.sceneState.value.reviewRecord?.last_render).toBeNull(); scene.dispose(); loaded.dispose();
    });
    it('rewrites plain glTF dependencies to embedded data and updates the packaged checksum', async () => {
        const gltf = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'buffer.bin', byteLength: 4 }] })), buffer = new Uint8Array([1, 2, 3, 4]); vi.stubGlobal('fetch', vi.fn(async (source: any) => new Response(String(source).endsWith('buffer.bin') ? buffer : gltf)));
        const r = recipe(); r.layers = [{ kind: 'mesh', layerId: 'mesh', source: { id: 'mesh', format: 'gltf', crs: 'LOCAL', sha256: await bundleHash(gltf), url: 'https://example.test/scene.gltf' } }];
        const loaded = await loadBundle(await saveBundle({ base: r })), layer = loaded.sceneState.value.base.layers![0]!;
        if (layer.kind !== 'mesh') throw Error('Wrong layer'); const path = layer.source.url!.replace('forge3d-asset:', ''), bytes = loaded.asset(path), data = JSON.parse(new TextDecoder().decode(bytes)); expect(data.buffers[0].uri).toBe('data:application/octet-stream;base64,AQIDBA=='); expect(layer.source.sha256).toBe(await bundleHash(bytes)); loaded.dispose();
    });
    it('cancels before reads and aborts a blocked output stream promptly', async () => {
        const cancelled = new AbortController(); cancelled.abort(); await expect(saveBundle(state(), { signal: cancelled.signal })).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' }); await expect(loadBundle(new Uint8Array(1), { signal: cancelled.signal })).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        const abort = new AbortController(), stream = new WritableStream<Uint8Array>({ write() { abort.abort(); return new Promise(() => undefined); } });
        await expect(saveBundle(state(), { signal: abort.signal, sink: { kind: 'stream', stream } })).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    });
    it('rejects duplicate local/central names and admits declared compressed data within explicit limits', () => {
        const duplicate = zipSync({ abc: new Uint8Array([1]), def: new Uint8Array([2]) }, { level: 0 }), view = new DataView(duplicate.buffer); let records = 0;
        for (let i = 0; i < duplicate.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) { if (records++ === 1) { duplicate.set(new TextEncoder().encode('abc'), i + 46); const local = view.getUint32(i + 42, true); duplicate.set(new TextEncoder().encode('abc'), local + 30); break; } }
        expect(() => decodeBundleArchive(duplicate)).toThrow('Duplicate');
        const compressed = zipSync({ data: new Uint8Array(100000) }, { level: 6 }); expect(decodeBundleArchive(compressed).data).toHaveLength(100000); expect(() => decodeBundleArchive(compressed, { maxExpandedBytes: 10 })).toThrow('expanded');
    });
    it('leaves active recipe and variant unchanged after candidate validation or cancellation failure', async () => {
        const initial = state().value; initial.reviewLayers = [{ id: 'bad', layers: [{ kind: 'diagnostic', layerId: 'bad-render', feature: 'unsupported', supportLevel: 'unsupported' }] }]; initial.variants = [{ id: 'plain', activeLayerIds: [] }, { id: 'bad', activeLayerIds: ['bad'] }];
        const scene = MapScene.fromSceneState(initial), before = scene.recipe.serialize(); await expect(scene.applyVariant('bad')).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' }); expect(scene.recipe.serialize()).toBe(before); expect(scene.getActiveVariantId()).toBe('plain');
        const abort = new AbortController(); abort.abort(); await expect(scene.applyVariant('plain', { signal: abort.signal })).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' }); expect(scene.recipe.serialize()).toBe(before); scene.dispose(); expect(scene.getMemoryReport().cpuBytes).toBe(0);
    });
});
describe('W19 sprite and glyph asset contracts', () => {
    it('extracts exact atlas pixels/UVs, DPI and checks malformed rectangles', () => {
        const atlas = new SpriteAtlas({ icon: { x: 1, y: 0, width: 1, height: 2, pixelRatio: 2 } }, 2, 2, new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 128]));
        expect(atlas.extractSprite('icon')?.rgba).toEqual(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128])); expect(atlas.getUvs('icon')).toEqual([.5, 0, 1, 1]); expect(atlas.get('missing')).toBeNull(); atlas.dispose(); expect(atlas.getMemoryReport().cpuBytes).toBe(0);
        expect(() => new SpriteAtlas({ bad: { x: 2, y: 0, width: 1, height: 1 } }, 2, 2, new Uint8Array(16))).toThrow('bounds');
    });
    it('decodes glyph metrics including negative bearings and rejects corrupt PBF', async () => {
        const glyph = new Uint8Array([8, 65, 24, 0, 32, 0, 40, 3, 48, 4, 56, 7]), name = new TextEncoder().encode('Test'), range = new TextEncoder().encode('0-255'), stack = new Uint8Array([10, name.length, ...name, 18, range.length, ...range, 26, glyph.length, ...glyph]), pbf = new Uint8Array([10, stack.length, ...stack]);
        expect(decodeGlyphRanges(pbf)[0]?.glyphs[0]).toMatchObject({ id: 65, left: -2, top: 2, advance: 7 }); expect(() => decodeGlyphRanges(new Uint8Array([10, 200]))).toThrow('PBF');
        const fetcher = vi.fn(async () => new Response(pbf)); vi.stubGlobal('fetch', fetcher); expect((await loadGlyphRanges('https://example.test/{fontstack}/{range}.pbf', 'Test', 'AA')).length).toBe(1); expect(fetcher).toHaveBeenCalledTimes(1);
    });
});
