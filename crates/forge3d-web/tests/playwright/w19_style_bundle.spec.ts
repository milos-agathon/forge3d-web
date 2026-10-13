import { test, expect } from "../browser/webgpu-fixture";
declare global { interface Window { __w19: any; } }
for (const dist of [false, true]) {
    const label = dist ? 'dist' : 'source';
    test.describe(label, () => {
        test.beforeEach(async ({ page }) => { await page.goto('/examples/style-bundle.html' + (dist ? '?dist' : '?source')); await page.waitForFunction(() => window.__w19?.ready); });
        test(`W19 ${label}: supported styles draw covered geometry and every style layer changes pixels`, async ({ page }, info) => {
            const r = await page.evaluate(async () => {
                const { api, makeState, renderScene } = window.__w19, state = makeState().value, scene = api.MapScene.fromSceneState(state), whole = await renderScene(scene), changes: Record<string, number> = {};
                for (const id of ['water', 'roads', 'towns']) { const reduced = structuredClone(state); reduced.base.layers = reduced.base.layers.filter((l: any) => l.layerId !== id); const candidate = api.MapScene.fromSceneState(reduced); const image = await candidate.render(); changes[id] = whole.frame.data.reduce((n: number, v: number, i: number) => n + (v !== image.frame.data[i] ? 1 : 0), 0); candidate.dispose(); }
                scene.dispose(); return { coverage: whole.metrics.coveragePixels, status: whole.report.status, changes };
            });
            expect(r.status).toBe('ok'); expect(r.coverage).toBeGreaterThan(1000); for (const n of Object.values(r.changes)) expect(n).toBeGreaterThan(0);
            await info.attach('styles.png', { body: await page.locator('canvas').screenshot(), contentType: 'image/png' });
        });
        test(`W19 ${label}: variant and visibility commits are atomic and bundles reproduce exact offline pixels`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, makeState } = window.__w19, scene = api.MapScene.fromSceneState(makeState()); const base = await scene.render();
                await scene.applyVariant('review'); const review = await scene.render(); await scene.setReviewLayerVisible('annotation', false); const hidden = await scene.render();
                const snapshot = scene.recipe.serialize(); let unknown; try { await scene.applyVariant('missing'); } catch (e: any) { unknown = e.code; }
                const unchanged = snapshot === scene.recipe.serialize(); await scene.applyVariant('review'); const blob = await scene.saveBundle({ name: 'offline' });
                const metadata = await api.loadBundle(blob), plans = Object.keys(metadata.sceneState.value.compiledLabelPlans ?? {}); metadata.dispose();
                const loaded = await api.MapScene.loadBundle(new File([blob], 'offline.forge3d')); const originalFetch = fetch; let network = 0; window.fetch = async (...args: any[]) => { if (String(args[0]).startsWith('blob:')) return originalFetch(...args as [any]); network++; throw Error('offline'); };
                let output; try { output = await loaded.render(); } finally { window.fetch = originalFetch; }
                const same = review.frame.data.every((v: number, i: number) => v === output.frame.data[i]); const changed = review.frame.data.some((v: number, i: number) => v !== base.frame.data[i]), hiddenSame = hidden.frame.data.every((v: number, i: number) => v === base.frame.data[i]);
                const variants = loaded.listVariants().map((v: any) => v.id), active = loaded.getActiveVariantId(); loaded.dispose(); scene.dispose(); return { same, changed, hiddenSame, network, unknown, unchanged, variants, active, plans, memory: loaded.getMemoryReport() };
            });
            expect(r.same).toBe(true); expect(r.changed).toBe(true); expect(r.hiddenSame).toBe(true); expect(r.network).toBe(0); expect(r.unknown).toBe('INVALID_INPUT'); expect(r.unchanged).toBe(true); expect(r.variants).toEqual(['plain', 'review']); expect(r.active).toBe('review'); expect(r.plans).toContain('review-labels'); expect(r.memory.cpuBytes).toBe(0);
        });
        test(`W19 ${label}: URL, Blob, stream and OPFS bundles verify assets and survive repeated disposal`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, makeState } = window.__w19, blob = await api.saveBundle(makeState()), url = URL.createObjectURL(blob), variants = [];
                try { for (const source of [blob, url, blob.stream()]) { const loaded = await api.loadBundle(source); variants.push(loaded.listVariants().length); loaded.dispose(); } } finally { URL.revokeObjectURL(url); }
                const path = `w19-${Date.now()}.forge3d`; await api.saveBundle(makeState(), { sink: { kind: 'opfs', path } }); const directory = await navigator.storage.getDirectory(), handle = await directory.getFileHandle(path), file = await handle.getFile();
                const loaded = await api.loadBundle(handle), checksums = Object.keys(loaded.manifest.checksums).length; loaded.dispose(); await directory.removeEntry(path);
                for (let i = 0; i < 12; i++) { const s = await api.MapScene.loadBundle(blob); await s.prepare(); s.dispose(); if (s.getMemoryReport().cpuBytes !== 0) throw Error('Leaked scene resources'); }
                return { variants, checksums, bytes: file.size };
            });
            expect(r.variants).toEqual([2, 2, 2]); expect(r.checksums).toBeGreaterThan(0); expect(r.bytes).toBeGreaterThan(100);
        });
        test(`W19 ${label}: prepared external assets become verified offline blob leases`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, makeState } = window.__w19, state = makeState().value, layer = state.base.layers.find((l: any) => l.kind === 'vector');
                const payload = new Blob([JSON.stringify(layer.source.data)]), url = URL.createObjectURL(payload); delete layer.source.data; layer.source.url = url;
                const scene = api.MapScene.fromSceneState(state); await scene.prepare(); const blob = await scene.saveBundle(); URL.revokeObjectURL(url); scene.dispose();
                const loaded = await api.MapScene.loadBundle(blob); const result = await loaded.render(); const before = loaded.getMemoryReport(); loaded.dispose(); return { coverage: result.metrics.coveragePixels, before, after: loaded.getMemoryReport() };
            });
            expect(r.coverage).toBeGreaterThan(1000); expect(r.before.cpuBytes).toBeGreaterThan(0); expect(r.after.cpuBytes).toBe(0);
        });
        test(`W19 ${label}: cancellation, resource failure and unsupported style intent cannot change an active variant`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, makeState } = window.__w19, state = makeState().value; state.reviewLayers.push({ id: 'missing', layers: [{ kind: 'vector', layerId: 'missing-data', source: { id: 'missing-resource', format: 'vector', crs: 'LOCAL', url: location.origin + '/missing-w19.json' } }] }); state.variants.push({ id: 'broken', activeLayerIds: ['missing'] });
                const scene = api.MapScene.fromSceneState(state); const original = await scene.render(), before = scene.recipe.serialize(), record = await scene.reviewRecord(); let failure; try { await scene.applyVariant('broken'); } catch (e: any) { failure = e.code; }
                const afterRecord = await scene.reviewRecord(), after = await scene.render(), same = original.frame.data.every((v: number, i: number) => v === after.frame.data[i]); const abort = new AbortController(); abort.abort(); let cancelled; try { await scene.applyVariant('review', { signal: abort.signal }); } catch (e: any) { cancelled = e.code; }
                const unchanged = before === scene.recipe.serialize(), active = scene.getActiveVariantId(); scene.dispose();
                const styled = api.MapScene.fromStyle(window.__w19.baseRecipe(), api.parseStyle({ layers: [{ id: 'symbols', type: 'symbol' }, { id: 'unsupported', type: 'fill-extrusion' }] }), {}); const diagnostics = styled.validate().diagnostics.map((d: any) => d.code); styled.dispose();
                return { same, unchanged, active, failure, cancelled, renderRetained: JSON.stringify(record.last_render) === JSON.stringify(afterRecord.last_render), diagnostics };
            });
            expect(r.same).toBe(true); expect(r.unchanged).toBe(true); expect(r.active).toBe('plain'); expect(r.cancelled).toBe('REQUEST_CANCELLED'); expect(r.failure).toBeDefined(); expect(r.renderRetained).toBe(true); expect(r.diagnostics).toContain('experimental_feature'); expect(r.diagnostics).toContain('unsupported_style_layer_type');
        });
        test(`W19 ${label}: sprites and glyph ranges load from checksum-verified bundle assets`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, makeState } = window.__w19, c = new OffscreenCanvas(2, 2), context = c.getContext('2d')!; context.fillStyle = '#ff0000'; context.fillRect(0, 0, 2, 2); const png = await c.convertToBlob({ type: 'image/png' });
                const glyph = [8, 65, 24, 0, 32, 0, 40, 3, 48, 4, 56, 7], name = [...new TextEncoder().encode('Test')], range = [...new TextEncoder().encode('0-255')], stack = [10, name.length, ...name, 18, range.length, ...range, 26, glyph.length, ...glyph], pbf = new Uint8Array([10, stack.length, ...stack]);
                const blob = await api.saveBundle(makeState(), { assets: { 'sprite.json': new Blob([JSON.stringify({ red: { x: 0, y: 0, width: 2, height: 2, pixelRatio: 1 } })]), 'sprite.png': png, 'glyphs/Test/0-255.pbf': pbf } }); const bundle = await api.loadBundle(blob), options = { resolveUrl: (url: string) => bundle.resolveAsset(url) };
                const atlas = await api.loadSpriteAtlas('sprite', options), ranges = await api.loadGlyphRanges('glyphs/{fontstack}/{range}.pbf', 'Test', 'AA', options), pixel = Array.from(atlas.extractSprite('red').rgba.slice(0, 4)); atlas.dispose(); bundle.dispose(); return { pixel, glyph: ranges[0].glyphs[0].left, memory: bundle.getMemoryReport() };
            });
            expect(r.pixel).toEqual([255, 0, 0, 255]); expect(r.glyph).toBe(-2); expect(r.memory.objectUrlCount).toBe(0); expect(r.memory.cpuBytes).toBe(0);
        });
        test(`W19 ${label}: device loss replays the loaded active variant and releases transient owners`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, makeState } = window.__w19, scene = await api.MapScene.loadBundle(await api.saveBundle(makeState().applyVariant('review'))), gpu = navigator.gpu, request = gpu.requestAdapter.bind(gpu); let killed = false, lost = false;
                gpu.requestAdapter = async options => { const adapter = await request(options); if (adapter) { const create = adapter.requestDevice.bind(adapter); adapter.requestDevice = async options => { const device = await create(options); if (!killed) { killed = true; const submit = device.queue.submit.bind(device.queue); device.queue.submit = commands => { submit(commands); if (!lost) { lost = true; device.destroy(); } }; } return device; }; } return adapter; };
                let code; try { await scene.render(); } catch (e: any) { code = e.code; } finally { gpu.requestAdapter = request; }
                const failed = await scene.reviewRecord(), memory = scene.getMemoryReport(), recovered = await scene.render(), active = scene.getActiveVariantId(); scene.dispose(); return { code, lost, failed, memory, active, coverage: recovered.metrics.coveragePixels, after: scene.getMemoryReport() };
            });
            expect(r.lost).toBe(true); expect(r.code).toBeTruthy(); expect(r.failed.last_render).toBeNull(); expect(r.failed.renderable).toBe(false); expect(r.memory.gpuBytes).toBe(0); expect(r.active).toBe('review'); expect(r.coverage).toBeGreaterThan(1000); expect(r.after.cpuBytes).toBe(0); expect(r.after.reviewStateBytes).toBe(0);
        });
    });
}
