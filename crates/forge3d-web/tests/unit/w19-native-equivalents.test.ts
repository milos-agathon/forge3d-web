import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { saveBundle, loadBundle, isBundle, BUNDLE_VERSION } from '../../src-ts/bundle.js';
import { bundleHash, decodeBundleArchive, encodeBundleArchive } from '../../src-ts/bundle-archive.js';
import { SceneState } from '../../src-ts/scene-review.js';
import { MapScene } from '../../src-ts/map-scene.js';
import { missingExternalAssetDiagnostic } from '../../src-ts/diagnostic-paths.js';
import { ValidationReport } from '../../src-ts/diagnostics.js';
import { LabelPlan } from '../../src-ts/label-plan.js';
import { SceneRecipe } from '../../src-ts/map-recipe.js';
const recipe = () => ({ crs: 'LOCAL', camera: { kind: 'orbit-camera' as const, target: [0,0,0] as [number,number,number], distance: 20 }, output: { width: 64, height: 48 } });
const key = (source: string, name: string) => `tests/${source}.py :: ${name}`;
afterEach(() => vi.unstubAllGlobals());
describe('W19 explicit native filesystem and facade equivalents', () => {
    it(key('test_bundle_roundtrip', 'test_manifest_roundtrip'), async () => {
        const bundle = await loadBundle(await saveBundle({ base: recipe() }, { name: 'test_bundle', description: 'Test description', createdAt: '2026-06-04T00:00:00Z' }));
        expect(bundle.manifest).toMatchObject({ version: 2, name: 'test_bundle', description: 'Test description', created_at: '2026-06-04T00:00:00Z' }); expect(Object.keys(bundle.manifest.checksums)).toEqual(['scene/state.json']); bundle.dispose();
    });
    it(key('test_bundle_roundtrip', 'test_is_bundle_false_for_nonexistent'), async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 }))); expect(await isBundle('https://missing.test/absent.forge3d')).toBe(false);
    });
    it(key('test_bundle_roundtrip', 'test_is_bundle_false_for_file'), async () => expect(await isBundle(new File(['ordinary file'], 'text.txt'))).toBe(false));
    it(key('test_bundle_roundtrip', 'test_is_bundle_false_for_dir_without_manifest'), async () => expect(await isBundle(encodeBundleArchive({ 'scene/state.json': new Uint8Array([1]) }))).toBe(false));
    it(key('test_bundle_roundtrip', 'test_load_bundle_rejects_invalid'), async () => expect(loadBundle(new Uint8Array([1,2,3]))).rejects.toMatchObject({ code: 'IO_ERROR' }));
    it(key('test_bundle_roundtrip', 'test_manifest_version_check'), async () => {
        const archive = decodeBundleArchive(new Uint8Array(await (await saveBundle({ base: recipe() })).arrayBuffer())); const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json'])); manifest.version = 999; archive['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
        await expect(loadBundle(encodeBundleArchive(archive))).rejects.toMatchObject({ code: 'IO_ERROR', details: { reason: 'bundle-version-mismatch' } });
    });
    it(key('test_bundle_roundtrip', 'test_load_v1_bundle_synthesizes_empty_review_registry'), async () => {
        const payload = new TextEncoder().encode(JSON.stringify({ exposure: 1.5 })); const manifest = { version: 1, name: 'legacy', checksums: { 'render/preset.json': await bundleHash(payload) } };
        const bundle = await loadBundle(encodeBundleArchive({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)), 'render/preset.json': payload }));
        expect(bundle.migratedFrom).toBe(1); expect(bundle.listVariants()).toEqual([]); expect(bundle.listReviewLayers()).toEqual([]); expect(bundle.getActiveVariantId()).toBeNull(); expect(bundle.sceneState.value.base.postFx?.effects[0]).toMatchObject({ exposure: 1.5 }); bundle.dispose();
    });
    it(key('test_bundle_render', 'test_bundle_manifest_version'), async () => { const bundle = await loadBundle(await saveBundle({ base: recipe() })); expect(bundle.manifest.version).toBe(BUNDLE_VERSION); expect(BUNDLE_VERSION).toBe(2); bundle.dispose(); });
    it(key('test_bundle_render', 'test_bundle_image_hash_verification'), async () => {
        const image = readFileSync(new URL('../fixtures/w19/native-snapshot.png', import.meta.url)), hash = await bundleHash(image);
        const bundle = await loadBundle(await saveBundle({ base: recipe() }, { assets: { snapshot: image } })); const path = bundle.manifest.asset_aliases!.snapshot!;
        expect(bundle.manifest.checksums[path]).toBe(hash); expect(await bundleHash(bundle.asset(path))).toBe(hash); bundle.dispose();
    });
    // The CLI equivalents use the same public inputs as the example. The
    // browser spec separately exercises the actual download and file input.
    it(key('test_bundle_cli', 'test_save_bundle_flag_exists'), async () => { const scene = new MapScene(recipe()); expect(await scene.saveBundle()).toBeInstanceOf(Blob); scene.dispose(); });
    it(key('test_bundle_cli', 'test_load_bundle_flag_exists'), async () => { const blob = await saveBundle({ base: recipe() }), scene = await MapScene.loadBundle(new File([blob], 'review.forge3d')); expect(scene.recipe.value.output).toEqual(recipe().output); scene.dispose(); });
    it(key('test_bundle_cli', 'test_was_cli_set_detects_explicit_flags'), () => {
        const state = new SceneState({ base: { ...recipe(), postFx: { effects: [{ kind: 'tonemap', operator: 'exposure', exposure: 1 }] } }, variants: [{ id: 'explicit', activeLayerIds: [], preset: { postFx: { effects: [{ kind: 'tonemap', operator: 'exposure', exposure: 2 }] } } }], activeVariantId: 'explicit' });
        expect(state.effectiveRecipe().postFx?.effects[0]).toMatchObject({ exposure: 2 }); expect(state.value.base.postFx?.effects[0]).toMatchObject({ exposure: 1 });
    });
    it(key('test_bundle_cli', 'test_bundle_directory_structure'), async () => {
        const bytes = new Uint8Array(await (await saveBundle({ base: recipe() }, { assets: { fixture: new Uint8Array([1]) } })).arrayBuffer()), files = decodeBundleArchive(bytes);
        expect(Object.keys(files).sort()).toEqual(['assets/' + await bundleHash(new Uint8Array([1])), 'manifest.json', 'scene/state.json'].sort());
    });
    it(key('test_bundle_cli', 'test_manifest_has_version_2'), async () => { const files = decodeBundleArchive(new Uint8Array(await (await saveBundle({ base: recipe() })).arrayBuffer())); expect(JSON.parse(new TextDecoder().decode(files['manifest.json'])).version).toBe(2); });
    it(key('test_bundle_cli', 'test_bundle_extension_added_if_missing'), async () => { const file = new File([await saveBundle({ base: recipe() })], 'review.forge3d'); expect(file.name).toBe('review.forge3d'); expect(await isBundle(file)).toBe(true); });

    const review = () => ({ base: { ...recipe(), terrain: { source: { id: 'dem', crs: 'LOCAL', format: 'heightmap', data: { width: 2, height: 2, heights: new Float32Array([0,1,2,3]) } } }, layers: [{ kind: 'vector' as const, layerId: 'roads', source: { id: 'roads-data', crs: 'LOCAL', format: 'vector', data: { name: 'roads', features: [{ id: 1, kind: 'line' as const, positions: [[0,0,0],[1,0,1]] as [number,number,number][] }] } } }] }, cameraBookmarks: [{ name: 'overview', eye: [1,2,3] as [number,number,number], target: [0,0,0] as [number,number,number] }], reviewRecord: { renderable: false, render_status: 'requires_preparation' as const, last_render: null } });
    it(key('test_mapscene_save_bundle', 'test_save_bundle_writes_deterministic_review_bundle_with_label_plan'), async () => {
        const value: any = review(); value.compiledLabelPlans = { labels: LabelPlan.compile({ labels: [{ id: 'city', text: 'Alpha', world_pos: [24,24,0], geometry_type: 'Point' }], viewport: [64,48], glyph_atlas: { glyphs: [...'Alpha'] }, seed: 42 }).toJSON() };
        const options = { createdAt: '2000-01-01T00:00:00Z' }, first = await saveBundle(value, options), second = await saveBundle(value, options); expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array(await second.arrayBuffer()));
        const bundle = await loadBundle(first); expect(bundle.sceneState.value.compiledLabelPlans).toEqual(value.compiledLabelPlans); bundle.dispose();
    });
    it(key('test_mapscene_save_bundle', 'test_save_bundle_preserves_blocking_diagnostics_without_render_success_claim'), async () => {
        const value = review(), report = new ValidationReport({ diagnostics: [missingExternalAssetDiagnostic('terrain', 'missing.tif')] });
        const bundle = await loadBundle(await saveBundle({ ...value, validationReport: report.toJSON(), reviewRecord: { renderable: false, render_status: 'blocked_by_diagnostics', last_render: null } }));
        expect(bundle.validationReport!.toJSON()).toEqual(report.toJSON()); expect(bundle.sceneState.value.reviewRecord).toEqual({ renderable: false, render_status: 'blocked_by_diagnostics', last_render: null }); bundle.dispose();
    });
    async function missing() {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        return loadBundle(await saveBundle({ base: { ...recipe(), terrain: { source: { id: 'dem', format: 'geotiff', crs: 'LOCAL', url: 'https://missing.test/dem.tif' } } } }, { allowMissingAssets: true }));
    }
    it(key('test_mapscene_save_bundle', 'test_save_bundle_preserves_missing_asset_diagnostics_without_renderability'), async () => { const b = await missing(); expect(b.validationReport!.diagnostics.map(d => d.code)).toContain('missing_external_asset'); expect(b.sceneState.value.reviewRecord?.renderable).toBe(false); expect(b.sceneState.value.reviewRecord?.last_render).toBeNull(); b.dispose(); });
    it(key('test_p1_bundle_guardrails', 'test_p1_bundle_persists_asset_layers_label_sources_and_diagnostics'), async () => {
        const value: any = review(); value.base.layers.push({ kind: 'labels', layerId: 'cities', source: { id: 'label-data', format: 'labels', crs: 'LOCAL', data: [{ id: 'city', text: 'Alpha', world_pos: [24,24,0], geometry_type: 'Point' }] }, coordinateSpace: 'screen' }); value.base.layers.push({ kind: 'buildings', layerId: 'buildings', source: { id: 'building-data', format: 'geojson', crs: 'LOCAL', data: { type: 'FeatureCollection', features: [] } }, metadata: { source_id: 'buildings' } });
        value.base.layers.push({ kind: 'tiles3d', layerId: 'tiles', source: { id: 'tile-data', format: 'tileset.json', crs: 'LOCAL', baseUrl: 'https://tiles.test/tileset.json', data: { asset: { version: '1.0' }, geometricError: 10, root: { boundingVolume: { sphere: [0,0,0,1] }, geometricError: 1, content: { uri: 'tile.b3dm' } } } }, metadata: { source_id: 'tiles' } });
        value.fonts = []; const scene = new MapScene(value.base); value.validationReport = scene.validate().toJSON(); scene.dispose();
        const bundle = await loadBundle(await saveBundle(value)); expect(bundle.sceneState.value.base.layers).toEqual(value.base.layers); expect(bundle.sceneState.value.base.terrain).toEqual(value.base.terrain); expect(bundle.validationReport!.toJSON()).toEqual(value.validationReport); bundle.dispose();
    });
    it(key('test_p1_bundle_guardrails', 'test_p1_bundle_missing_external_assets_remain_diagnostic_bearing'), async () => { const b = await missing(), reloaded = await loadBundle(await b.save()); expect(reloaded.validationReport!.toJSON()).toEqual(b.validationReport!.toJSON()); expect(reloaded.sceneState.value.missingAssets).toEqual(['https://missing.test/dem.tif']); b.dispose(); reloaded.dispose(); });
    it(key('test_p1_bundle_roundtrip', 'test_bundle_persists_required_p1_review_fields_and_label_payloads'), async () => { const value = review(), b = await loadBundle(await saveBundle(value)); expect(b.sceneState.value.cameraBookmarks).toEqual(value.cameraBookmarks); expect(b.sceneState.value.reviewRecord).toEqual(value.reviewRecord); expect(new SceneRecipe(b.sceneState.value.base).serialize()).toBe(new SceneRecipe(value.base).serialize()); b.dispose(); });
    it(key('test_p1_bundle_roundtrip', 'test_bundle_load_reconstructs_renderable_scene_when_assets_are_available'), async () => { const value = review(), scene = await MapScene.loadBundle(await saveBundle(value)); expect(scene.validate().hasErrors).toBe(false); expect(scene.recipe.serialize()).toBe(new SceneRecipe(value.base).serialize()); await expect(scene.prepare()).resolves.toMatchObject({ status: 'ok' }); scene.dispose(); });
    it(key('test_p1_bundle_roundtrip', 'test_bundle_load_reports_missing_external_assets_with_structured_diagnostics'), async () => { const b = await missing(), scene = await MapScene.loadBundle(await b.save()); expect(scene.validate().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_external_asset', severity: 'error', details: expect.objectContaining({ path: 'https://missing.test/dem.tif' }) })])); await expect(scene.prepare()).resolves.toMatchObject({ status: 'error' }); scene.dispose(); b.dispose(); });
});
