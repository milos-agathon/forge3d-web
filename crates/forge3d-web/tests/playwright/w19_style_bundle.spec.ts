import licenses from '../fixtures/w21/licenses.json' with { type: 'json' };
import { test, expect } from "../browser/webgpu-fixture";
declare global { interface Window { __w19: any; } }
const nativeLayerIds = ['native-base:raster:0', 'native-base:vector:0', 'native-base:vector:1', 'native-review-0:vector:0'];
for (const dist of [false, true]) {
    const label = dist ? 'dist' : 'source';
    test.describe(label, () => {
        test.beforeEach(async ({ page }) => {
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => {
                if (message.type() === 'error') errors.push(message.text());
                if (message.text().startsWith('[W19-native-timing]')) console.info(`${label}: ${message.text()}`);
            });
            await page.addInitScript(key => sessionStorage.setItem('forge3d-example-license',key), licenses.active);
            await page.goto('/examples/style-bundle.html' + (dist ? '?dist' : '?source'));
            try { await page.waitForFunction(() => window.__w19?.ready); }
            catch (error) { throw new Error(`W19 example startup failed: ${errors.join('\n') || await page.locator('#status').textContent()}`, { cause: error }); }
        });
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
        test(`W19 ${label}: an unused glyph template preserves supported style pixels in strict and default exports`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, features, baseRecipe } = window.__w19;
                const style = api.parseStyle({ glyphs: 'https://cdn.example/{fontstack}/{range}.pbf', sources: { local: { type: 'geojson' } }, layers: [{ id: 'roads', type: 'line', source: 'local', paint: { 'line-color': '#ffaa00', 'line-width': 4 } }] });
                const scene = api.MapScene.fromStyle(baseRecipe(), style, { local: features }), prepared = await scene.prepare(), original = await scene.render();
                const fetcher = window.fetch; let network = 0; window.fetch = async (...args: any[]) => { if (String(args[0]).startsWith('blob:')) return fetcher(...args as [any]); network++; throw Error('offline glyph metadata'); };
                const results = [];
                try {
                    for (const blob of [await scene.saveBundle(), await api.saveBundle({ base: scene.recipe.value, style: style.value })]) {
                        const metadata = await api.loadBundle(blob), restored = await api.MapScene.loadBundle(blob), validation = restored.validate(), ready = await restored.prepare(), output = await restored.render();
                        results.push({ missing: metadata.sceneState.value.missingAssets ?? [], valid: !validation.hasErrors && !ready.hasErrors, same: original.frame.data.every((v: number, i: number) => v === output.frame.data[i]), coverage: output.metrics.coveragePixels });
                        metadata.dispose(); restored.dispose();
                    }
                } finally { window.fetch = fetcher; scene.dispose(); }
                return { prepared: !prepared.hasErrors, network, results };
            });
            expect(r.prepared).toBe(true); expect(r.network).toBe(0); expect(r.results).toHaveLength(2);
            for (const result of r.results) { expect(result.missing).toEqual([]); expect(result.valid).toBe(true); expect(result.same).toBe(true); expect(result.coverage).toBeGreaterThan(1000); }
        });
        test(`W19 ${label}: native-saver raster/vector assets prepare and resave offline`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, baseRecipe } = window.__w19;
                const started = performance.now(), mark = (phase: string) => console.info('[W19-native-timing]', phase, Math.round(performance.now() - started));
                mark('load-start');
                const scene = await api.MapScene.loadBundle(location.origin + '/tests/fixtures/w19/native-renderable.forge3d', { nativeRecipe: baseRecipe() });
                mark('loaded'); const validation = scene.validate(), prepared = await scene.prepare(); mark('prepared');
                const original = await scene.render(); mark('original-rendered');
                const layerIds = scene.recipe.value.layers.filter((l: any) => ['raster', 'vector'].includes(l.kind)).map((l: any) => l.layerId);
                const blob = await scene.saveBundle(); scene.dispose(); mark('saved');
                const fetcher = window.fetch; let network = 0; window.fetch = async (...args: any[]) => { if (String(args[0]).startsWith('blob:')) return fetcher(...args as [any]); network++; throw Error('offline native archive'); };
                let same = false, coverage = 0, restoredValid = false;
                try { const restored = await api.MapScene.loadBundle(blob); mark('restored'); restoredValid = !restored.validate().hasErrors; const output = await restored.render(); mark('restored-rendered'); same = original.frame.data.every((v: number, i: number) => v === output.frame.data[i]); coverage = output.metrics.coveragePixels; restored.dispose(); }
                finally { window.fetch = fetcher; }
                return { valid: !validation.hasErrors && !prepared.hasErrors, restoredValid, same, coverage, layerIds, network };
            });
            expect(r.valid).toBe(true); expect(r.restoredValid).toBe(true); expect(r.same).toBe(true); expect(r.coverage).toBeGreaterThan(500); expect(r.network).toBe(0);
            expect(r.layerIds).toEqual(nativeLayerIds);
        });
        // Keep each independent removal control within the same 30-second budget.
        for (const layerId of nativeLayerIds) test(`W19 ${label}: native-saver ${layerId} changes pixels`, async ({ page }) => {
            const r = await page.evaluate(async (removedId) => {
                const { api, baseRecipe } = window.__w19;
                const started = performance.now(), mark = (phase: string) => console.info('[W19-native-timing]', `${removedId}:${phase}`, Math.round(performance.now() - started));
                mark('load-start');
                const scene = await api.MapScene.loadBundle(location.origin + '/tests/fixtures/w19/native-renderable.forge3d', { nativeRecipe: baseRecipe() });
                mark('loaded'); const original = await scene.render(); mark('original-rendered');
                const recipe = scene.recipe.value, layers = recipe.layers.filter((l: any) => l.layerId !== removedId);
                const candidate = new api.MapScene({ ...recipe, layers });
                try {
                    const output = await candidate.render(); mark('removed-rendered');
                    return { removed: recipe.layers.length - layers.length, valid: !candidate.validate().hasErrors, coverage: original.metrics.coveragePixels,
                        changed: original.frame.data.reduce((n: number, v: number, i: number) => n + Number(v !== output.frame.data[i]), 0) };
                } finally { candidate.dispose(); scene.dispose(); }
            }, layerId);
            expect(r.removed).toBe(1); expect(r.valid).toBe(true); expect(r.coverage).toBeGreaterThan(500); expect(r.changed).toBeGreaterThan(0);
        });
        test(`W19 ${label}: HTTP loads and cold offline-cache renders preserve verified bundle state`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, makeState } = window.__w19;
                const http = await api.loadBundle(location.origin + '/tests/fixtures/w19/native-v2.forge3d');
                const native = { variants: http.listVariants().map((v: any) => v.id), exposure: http.sceneState.value.base.postFx.effects[0].exposure }; http.dispose();
                const scene = api.MapScene.fromSceneState(makeState().applyVariant('review')), original = await scene.render(), blob = await scene.saveBundle(); scene.dispose();
                const key = location.origin + '/cached-w19.forge3d', cache = await caches.open('w19-offline'); await cache.put(key, new Response(blob));
                const fetcher = window.fetch; let network = 0; window.fetch = async (...args: any[]) => { if (String(args[0]).startsWith('blob:')) return fetcher(...args as [any]); network++; throw Error('cold offline'); };
                let same = false, coverage = 0;
                try { const response = await cache.match(key), replacement = await api.MapScene.loadBundle(await response!.blob()), output = await replacement.render(); same = original.frame.data.every((v: number, i: number) => v === output.frame.data[i]); coverage = output.metrics.coveragePixels; replacement.dispose(); }
                finally { window.fetch = fetcher; await caches.delete('w19-offline'); }
                return { native, same, coverage, network };
            });
            expect(r.native).toEqual({ variants: ['review', 'empty', 'other'], exposure: 2.5 }); expect(r.same).toBe(true); expect(r.coverage).toBeGreaterThan(1000); expect(r.network).toBe(0);
        });
        test(`W19 ${label}: progress, quota and staged OPFS cancellation have observable outcomes`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, makeState } = window.__w19, progress: any[] = [], initial = await api.saveBundle(makeState(), { onProgress: (p: any) => progress.push(p) });
                const loaded = await api.loadBundle(initial, { onProgress: (p: any) => progress.push(p) }); loaded.dispose();
                let quota; const handle = { createWritable: async () => { throw new DOMException('full', 'QuotaExceededError'); } };
                try { await api.saveBundle(makeState(), { sink: { kind: 'file-system', handle } }); } catch (e: any) { quota = [e.code, e.details.reason]; }
                const directory = await navigator.storage.getDirectory(), path = 'w19-staged.forge3d', file = await directory.getFileHandle(path, { create: true });
                const original = new Uint8Array([11, 12, 13]); const writer = await file.createWritable(); await writer.write(original); await writer.close();
                const abort = new AbortController(); let staged: FileSystemWritableFileStream | undefined, cancelled;
                const wrapped = { createWritable: async () => { staged = await file.createWritable(); return { write: async (bytes: Uint8Array) => { await staged!.write(bytes); abort.abort(); }, close: () => staged!.close(), abort: (e: any) => staged!.abort(e) }; } };
                try { await api.saveBundle(makeState(), { signal: abort.signal, sink: { kind: 'file-system', handle: wrapped } }); } catch (e: any) { cancelled = e.code; }
                // Await the writer's abort before reading the committed file.
                try { await staged?.abort(); } catch { /* already aborted */ }
                const remaining = Array.from(new Uint8Array(await (await file.getFile()).arrayBuffer())); await directory.removeEntry(path);
                return { quota, cancelled, remaining, phases: [...new Set(progress.map(p => p.phase))], bounded: progress.every(p => p.completed >= 0 && p.completed <= p.total), verify: progress.filter(p => p.phase === 'verify').map(p => p.completed) };
            });
            expect(r.quota).toEqual(['RESOURCE_LIMIT_EXCEEDED', 'quota-exceeded']); expect(r.cancelled).toBe('REQUEST_CANCELLED'); expect(r.remaining).toEqual([11, 12, 13]); expect(r.bounded).toBe(true); expect(r.phases).toEqual(expect.arrayContaining(['verify', 'archive'])); expect(r.verify).toEqual(r.verify.map((_, i) => i + 1));
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
                const state = makeState().value; state.style.sprite = 'sprite'; state.style.glyphs = 'glyphs/{fontstack}/{range}.pbf'; state.styleGlyphRequests = [{fontStack:'Test',text:'AA'}]; const initial = await api.saveBundle(state, { assets: { 'sprite.json': new Blob([JSON.stringify({ red: { x: 0, y: 0, width: 2, height: 2, pixelRatio: 1 } })]), 'sprite.png': png, 'glyphs/Test/0-255.pbf': pbf } }); const scene = await api.MapScene.loadBundle(initial); const blob = await scene.saveBundle(); scene.dispose(); const bundle = await api.loadBundle(blob), options = { resolveUrl: (url: string) => bundle.resolveAsset(url) };
                const atlas = await api.loadSpriteAtlas('sprite', options), ranges = await api.loadGlyphRanges('glyphs/{fontstack}/{range}.pbf', 'Test', 'AA', options), pixel = Array.from(atlas.extractSprite('red').rgba.slice(0, 4)); atlas.dispose(); bundle.dispose(); return { pixel, glyph: ranges[0].glyphs[0].left, memory: bundle.getMemoryReport() };
            });
            expect(r.pixel).toEqual([255, 0, 0, 255]); expect(r.glyph).toBe(-2); expect(r.memory.objectUrlCount).toBe(0); expect(r.memory.cpuBytes).toBe(0);
        });
        for (const renderDelayMs of [0, 6_000]) {
            test(`W19 ${label}: example download and file input replace native CLI paths${renderDelayMs ? ' with a slow render' : ''}`, async ({ page }, info) => {
                // Reproduce a cold render exceeding the default five-second assertion timeout.
                if (renderDelayMs) await page.evaluate(delay => {
                    const originalRender = window.__w19.api.MapScene.prototype.render;
                    window.__w19.api.MapScene.prototype.render = async function (...args: any[]) {
                        await new Promise(resolve => setTimeout(resolve, delay));
                        return originalRender.apply(this, args);
                    };
                }, renderDelayMs);
                const downloadEvent = page.waitForEvent('download'); await page.locator('#save').click(); const download = await downloadEvent;
                expect(download.suggestedFilename()).toBe('local-map.forge3d'); const path = await download.path(); expect(path).not.toBeNull();
                await page.locator('#load').setInputFiles(path!);
                // Upload includes bundle preparation, GPU initialization and readback; keep the existing test budget.
                await expect(page.locator('#status')).toContainText('covered pixels', { timeout: info.timeout });
                expect(await page.evaluate(() => window.__w19.scene.getActiveVariantId())).toBe('plain');
            });
        }
        test(`W19 ${label}: device loss replays the loaded active variant and releases transient owners`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, makeState } = window.__w19, scene = await api.MapScene.loadBundle(await api.saveBundle(makeState().applyVariant('review'))), prior = await scene.render(), priorRecord = await scene.reviewRecord(), gpu = navigator.gpu, request = gpu.requestAdapter.bind(gpu); let killed = false, lost = false;
                gpu.requestAdapter = async options => { const adapter = await request(options); if (adapter) { const create = adapter.requestDevice.bind(adapter); adapter.requestDevice = async options => { const device = await create(options); if (!killed) { killed = true; const submit = device.queue.submit.bind(device.queue); device.queue.submit = commands => { submit(commands); if (!lost) { lost = true; device.destroy(); } }; } return device; }; } return adapter; };
                let code; try { await scene.render(); } catch (e: any) { code = e.code; } finally { gpu.requestAdapter = request; }
                const failed = await scene.reviewRecord(), memory = scene.getMemoryReport(), recovered = await scene.render(), active = scene.getActiveVariantId(); scene.dispose(); return { priorCoverage: prior.metrics.coveragePixels, priorRender: priorRecord.last_render, code, lost, failed, memory, active, coverage: recovered.metrics.coveragePixels, after: scene.getMemoryReport() };
            });
            expect(r.priorCoverage).toBeGreaterThan(1000); expect(r.priorRender).not.toBeNull(); expect(r.lost).toBe(true); expect(r.code).toBeTruthy(); expect(r.failed.last_render).toBeNull(); expect(r.failed.renderable).toBe(false); expect(r.memory.gpuBytes).toBe(0); expect(r.active).toBe('review'); expect(r.coverage).toBeGreaterThan(1000); expect(r.after.cpuBytes).toBe(0); expect(r.after.reviewStateBytes).toBe(0);
        });
    });
}
