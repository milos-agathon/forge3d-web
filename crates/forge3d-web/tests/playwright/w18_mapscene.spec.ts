import { test, expect } from "../browser/webgpu-fixture";
declare global {
    interface Window {
        __w18: any;
    }
}
for (const dist of [false, true]) {
    const label = dist ? 'dist' : 'source';
    test.describe(label, () => {
        test(`W18 ${label}: post-processing cannot conceal empty geometry and overlay-only output is covered`,async({page})=>{
            const r=await page.evaluate(async()=>{const {api,baseRecipe}=window.__w18,r=baseRecipe();delete r.terrain;r.postFx={effects:[{kind:'tonemap',operator:'exposure',exposure:2}]};r.layers=[{kind:'nodes',layerId:'hidden',nodes:[{kind:'ground-plane',name:'hidden-plane',size:[4,4],height:0,color:[1,0,0,1],transform:{translation:[1000,0,0]}}]}];const empty=new api.MapScene(r),preflight=empty.validate().status;let code,reason;try{await empty.render();}catch(e:any){code=e.code;reason=e.details?.reason;}const review=await empty.reviewRecord();empty.dispose();r.layers=[{kind:'nodes',layerId:'overlay',nodes:[{kind:'overlay',name:'panel',bounds:[20,20,30,20],color:[1,.2,.1,1]}]}];const filled=new api.MapScene(r),result=await filled.render().catch((e:any)=>{throw Error(JSON.stringify(e.details));});filled.dispose();return {code,reason,preflight,review,coverage:result.metrics.coveragePixels};});expect(r.preflight).toBe('ok');expect(r.reason).toBe('empty-render-output');expect(r.code).toBe('UNSUPPORTED_FEATURE');expect(r.review.last_render).toBeNull();expect(r.coverage).toBe(600);
        });
        test.beforeEach(async ({ page }) => { await page.goto('/examples/mapscene.html' + (dist ? '?dist' : '')); await page.waitForFunction(() => window.__w18?.ready); });
        test(`W18 ${label}: multilayer example renders real geometry, glyphs and PNG`, async ({ page }, info) => {
            test.setTimeout(120000);
            const result = await page.evaluate(() => window.__w18.renderExample());
            expect(result.status).toBe('ok');
            expect(result.layers).toEqual(['annotation', 'buildings', 'imagery', 'instances', 'labels', 'mesh', 'points', 'roads', 'terrain']);
            expect(result.coverage).toBeGreaterThan(1000);
            await expect(page.locator('#download')).toBeEnabled();
            await info.attach('mapscene.png', { body: await page.locator('canvas').screenshot(), contentType: 'image/png' });
        });
        test(`W18 ${label}: each completed raster layer changes covered pixels`, async ({ page }) => {
            test.setTimeout(180000);
            const differences = await page.evaluate(async () => { const { api, fullRecipe, renderRecipe } = window.__w18, r = fullRecipe(api), whole = await renderRecipe(api, r), result: Record<string, number> = {}; for (const layer of r.layers) {
                const changed = structuredClone(r);
                changed.layers = changed.layers.filter((l: any) => l.layerId !== layer.layerId);
                const image = await renderRecipe(api, changed);
                result[layer.layerId] = whole.data.reduce((n: number, v: number, i: number) => n + (v !== image.data[i] ? 1 : 0), 0);
            } return result; });
            for (const [layer, pixels] of Object.entries(differences))
                expect(pixels, layer).toBeGreaterThan(0);
        });
        test(`W18 ${label}: point depth occludes hidden translucent points with a negative control`, async ({ page }) => {
            const r = await page.evaluate(async () => { const { api, baseRecipe, renderRecipe } = window.__w18, r = baseRecipe(); r.camera = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fovYDegrees: 45, near: .1, far: 100 }; delete r.terrain; delete r.lighting; r.layers = [{ kind: 'nodes', layerId: 'wall', nodes: [{ kind: 'text-mesh', name: 'wall', text: 'wall', size: 1, vertices: new Float32Array([-5, -5, 0, 5, -5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5, 5, 0]), color: [0, .2, 1, 1] }] }]; const base = await renderRecipe(api, r), point = { kind: 'point-cloud', layerId: 'points', source: { id: 'p', format: 'points', crs: 'LOCAL', data: { positions: new Float32Array([0, 0, -1]), colors: new Uint8Array([255, 0, 0]) } }, style: { pointSize: 32, opacity: .5 } }; r.layers.push(point); const hidden = await renderRecipe(api, r); point.source.data.positions[2] = 1; const front = await renderRecipe(api, r); return { hiddenDiff: hidden.data.reduce((n: number, v: number, i: number) => n + (v !== base.data[i] ? 1 : 0), 0), frontDiff: front.data.reduce((n: number, v: number, i: number) => n + (v !== base.data[i] ? 1 : 0), 0), points: front.metrics.pointCount }; });
            expect(r.hiddenDiff).toBe(0);
            expect(r.frontDiff).toBeGreaterThan(200);
            expect(r.points).toBe(1);
        });
        test(`W18 ${label}: W16 tiles select, decode and render through MapScene`, async ({ page }) => {
            const r = await page.evaluate(async () => { const { api, baseRecipe, renderRecipe } = window.__w18, r = baseRecipe(); r.layers = [{ kind: 'tiles3d', layerId: 'tiles', source: { id: 'tileset', format: 'tileset.json', crs: 'LOCAL', url: new URL('/tests/fixtures/w16/tileset.json', location.href).href }, traversal: { sseThreshold: .1 } }]; return await renderRecipe(api, r); });
            expect(r.report.status).toBe('ok');
            expect(r.layers).toContain('tiles');
            expect(r.metrics.coveragePixels).toBeGreaterThan(1000);
            expect(r.metrics.pointCount).toBeGreaterThan(0);
        });
        test(`W18 ${label}: validation and policies block before GPU creation`, async ({ page }) => {
            const r = await page.evaluate(async () => { const { api, baseRecipe } = window.__w18, recipe = baseRecipe(); recipe.layers = [{ kind: 'diagnostic', layerId: 'pro', feature: 'product', supportLevel: 'Pro-gated' }, { kind: 'unknown', layerId: 'unknown' }]; const s = new api.MapScene(recipe); let code; try {
                await s.render();
            }
            catch (e: any) {
                code = e.code;
            } const review = await s.reviewRecord(), memory = s.getMemoryReport(); s.dispose(); return { code, review, memory }; });
            expect(r.code).toBe('UNSUPPORTED_FEATURE');
            expect(r.review.renderable).toBe(false);
            expect(r.review.last_render).toBeNull();
            expect(r.review.validation_report.diagnostics.map((d: any) => d.code)).toEqual(expect.arrayContaining(['pro_gated_path', 'unsupported_layer_type']));
            expect(r.memory.gpuBytes).toBe(0);
        });
        test(`W18 ${label}: recipe replay, repeated render, resize and disposal are deterministic`, async ({ page }) => {
            test.setTimeout(120000);
            const r = await page.evaluate(async () => { const { api, baseRecipe } = window.__w18, recipe = baseRecipe(), s = new api.MapScene(recipe), restored = api.MapScene.fromJSON(JSON.stringify(s.toJSON())), one = await s.render(), two = await restored.render(), bytes = one.frame.data; for (let i = 0; i < 4; i++)
                await s.render(); const repeat = s.getMemoryReport(); const resize = baseRecipe(); resize.output = { width: 128, height: 96 }; const small = new api.MapScene(resize), size = (await small.render()).frame.size(); small.dispose(); s.dispose(); restored.dispose(); return { equal: bytes.every((v: number, i: number) => v === two.frame.data[i]), size, repeat, disposed: s.getMemoryReport() }; });
            expect(r.equal).toBe(true);
            expect(r.size).toEqual([128, 96]);
            expect(r.repeat.gpuBytes).toBe(0);
            expect(r.disposed.cpuBytes).toBe(0);
            expect(r.disposed.resourceCount).toBe(0);
        });
        test(`W18 ${label}: cancellation and output sink failures never produce a success record`, async ({ page }) => {
            const r = await page.evaluate(async () => { const { api, baseRecipe } = window.__w18, s = new api.MapScene(baseRecipe()), a = new AbortController(); a.abort(); let cancel, sink; try {
                await s.render({ signal: a.signal });
            }
            catch (e: any) {
                cancel = e.code;
            } try {
                await s.render({ sink: new WritableStream({ write() { throw Error('sink failed'); } }) });
            }
            catch (e: any) {
                sink = e.message;
            } const record = await s.reviewRecord(), memory = s.getMemoryReport(); s.dispose(); return { cancel, sink, record, memory }; });
            expect(r.cancel).toBe('REQUEST_CANCELLED');
            expect(r.sink).toContain('sink failed');
            expect(r.record.last_render).toBeNull();
            expect(r.record.renderable).toBe(false);
            expect(r.memory.gpuBytes).toBe(0);
        });
        test(`W18 ${label}: compiled plans preserve priority, keepouts, rejection diagnostics and replay`, async ({ page }) => {
            const r = await page.evaluate(async () => { const { api, baseRecipe } = window.__w18, r = baseRecipe(); r.reproducibility.seed = 1234; r.layers = [{ kind: 'labels', layerId: 'labels', source: { id: 'labels', format: 'labels', crs: 'LOCAL', data: [{ id: 'city', text: 'Alpha', position: [120, 120, 0], priority_class: 'cities' }, { id: 'park', text: 'Park', geometry: { type: 'Polygon', coordinates: [[[150, 150], [190, 150], [190, 180], [150, 180], [150, 150]]] }, priority_class: 'parks' }, { id: 'blocked-title', text: 'Beta', position: [24, 24, 0] }] }, keepouts: [{ region_id: 'title', kind: 'title', bounds: [0, 0, 64, 64], priority: 100 }], priorityRules: [{ name: 'cities', rank: 10 }, { name: 'parks', rank: 5 }] }]; const s = new api.MapScene(r), one = await s.prepare(), plan = s.compiledLabelPlans.labels, two = await s.prepare(), review = await s.reviewRecord(); const result = await s.render(); const restored = api.MapScene.fromJSON(s.toJSON()); await restored.prepare(); const replay = restored.compiledLabelPlans.labels; s.dispose(); restored.dispose(); return { one: one.toJSON(), two: two.toJSON(), plan, replay, review, png: result.blob.type }; });
            expect(r.one).toEqual(r.two);
            expect(r.plan).toEqual(r.replay);
            expect(r.plan.seed).toBe(1234);
            expect(r.plan.accepted.map((x: any) => x.label_id)).toEqual(['city', 'park']);
            expect(r.plan.rejected.find((x: any) => x.label_id === 'blocked-title').reason).toBe('keepout_region');
            expect(r.one.diagnostics.find((d: any) => d.code === 'label_rejection_summary').details.rejection_counts).toEqual({ keepout_region: 1 });
            expect(r.review.compiled_label_plans.labels).toEqual(r.plan);
            expect(r.png).toBe('image/png');
        });
        test(`W18 ${label}: GPU loss clears success and a later render recreates owners`, async ({ page }) => {
            test.setTimeout(90000);
            const result = await page.evaluate(async () => {
                const { api, baseRecipe } = window.__w18, s = new api.MapScene(baseRecipe()), gpu = navigator.gpu, request = gpu.requestAdapter.bind(gpu);
                let kill = true, lost = false;
                gpu.requestAdapter = async (options) => { const adapter = await request(options); if (adapter) {
                    const create = adapter.requestDevice.bind(adapter);
                    adapter.requestDevice = async (options) => { const device = await create(options); if (kill) {
                        kill = false;
                        const submit = device.queue.submit.bind(device.queue);
                        device.queue.submit = commands => { submit(commands); if (!lost) {
                            lost = true;
                            device.destroy();
                        } };
                    } return device; };
                } return adapter; };
                let code;
                try {
                    await s.render();
                }
                catch (e: any) {
                    code = e.code;
                }
                const failed = await s.reviewRecord(), memory = s.getMemoryReport();
                gpu.requestAdapter = request;
                const recovered = await s.render(), after = s.getMemoryReport();
                s.dispose();
                return { code, lost, failed, memory, after, coverage: recovered.metrics.coveragePixels };
            });
            expect(result.lost).toBe(true);
            expect(result.code).toBeTruthy();
            expect(result.failed.last_render).toBeNull();
            expect(result.failed.renderable).toBe(false);
            expect(result.memory.gpuBytes).toBe(0);
            expect(result.after.gpuBytes).toBe(0);
            expect(result.coverage).toBeGreaterThan(1000);
        });
        test(`W18 ${label}: cancellation after GPU work clears an earlier success record`, async ({ page }) => {
            const r = await page.evaluate(async () => { const { api, baseRecipe } = window.__w18, s = new api.MapScene(baseRecipe()); await s.render(); const a = new AbortController(); let code; try {
                await s.render({ signal: a.signal, onProgress: (p: any) => { if (p.phase === 'render' && p.completed === 1)
                        a.abort(); } });
            }
            catch (e: any) {
                code = e.code;
            } const record = await s.reviewRecord(), memory = s.getMemoryReport(); s.dispose(); return { code, record, memory }; });
            expect(r.code).toBe('REQUEST_CANCELLED');
            expect(r.record.last_render).toBeNull();
            expect(r.record.renderable).toBe(false);
            expect(r.memory.gpuBytes).toBe(0);
            expect(r.memory.cpuBytes).toBe(0);
        });
        test(`W18 ${label}: URL heightmap, image, vector, glyph records and OBJ render after preparation`, async ({ page }) => {
            const r = await page.evaluate(async () => { const { api, baseRecipe } = window.__w18, r = baseRecipe(), url = (name: string) => new URL('/tests/fixtures/w18/' + name, location.href).href; r.terrain.source = { id: 'dem', format: 'f32', crs: 'LOCAL', url: url('dem.f32'), parameters: { width: 16, height: 16, spacing: [1.6, 1.6], bounds: [-12, -12, 12, 12], domain: [0, 5] } }; r.layers = [{ kind: 'raster', layerId: 'ortho', source: { id: 'ortho', format: 'png', crs: 'LOCAL', url: url('ortho.png') } }, { kind: 'mesh', layerId: 'mesh', source: { id: 'mesh', format: 'obj', crs: 'LOCAL', url: url('triangle.obj') } }, { kind: 'vector', layerId: 'roads', source: { id: 'roads', format: 'json', crs: 'LOCAL', url: url('roads.json') } }, { kind: 'labels', layerId: 'labels', source: { id: 'labels', format: 'json', crs: 'LOCAL', url: url('labels.json') } }]; const s = new api.MapScene(r), before = s.validate().toJSON(), states = s.resources.map((x: any) => x.state), loaded = await s.prepare(), render = await s.render(), after = s.resources, memory = s.getMemoryReport(); s.dispose(); return { before, states, loaded: loaded.toJSON(), after, memory, coverage: render.metrics.coveragePixels }; });
            expect(r.before.status).toBe('ok');
            expect(r.states).toEqual(Array(5).fill('unresolved'));
            expect(r.loaded.status).toBe('ok');
            expect(r.after.map((x: any) => x.state)).toEqual(Array(5).fill('ready'));
            expect(r.coverage).toBeGreaterThan(1000);
            expect(r.memory.gpuBytes).toBe(0);
        });
        test(`W18 ${label}: lighting and post-processing affect actual terrain output`, async ({ page }) => {
            const r = await page.evaluate(async () => { const { api, baseRecipe, renderRecipe } = window.__w18, r = baseRecipe(), one = await renderRecipe(api, r); r.lighting = { name: 'sunset', intensity: 3 }; const light = await renderRecipe(api, r); r.postFx = { effects: [{ kind: 'tonemap', operator: 'exposure', exposure: 2 }] }; const fx = await renderRecipe(api, r), diff = (x: number[], y: number[]) => x.reduce((n, v, i) => n + (v !== y[i] ? 1 : 0), 0); return { light: diff(one.data, light.data), fx: diff(light.data, fx.data), status: fx.report.status }; });
            expect(r.light).toBeGreaterThan(500);
            expect(r.fx).toBeGreaterThan(500);
            expect(r.status).toBe('ok');
        });
        test(`W18 ${label}: dedicated GPU trace output has real hits and visible material color`, async ({ page }) => {
            const r = await page.evaluate(async () => { const { api, renderRecipe } = window.__w18; return await renderRecipe(api, { crs: 'LOCAL', camera: { position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fovYDegrees: 45, near: .1, far: 100 }, output: { width: 32, height: 24 }, reproducibility: { seed: 7 }, layers: [{ kind: 'trace', layerId: 'trace', samples: 1, triangles: [{ v0: [-2, -2, 0], v1: [2, -2, 0], v2: [0, 2, 0], id: 1 }], materials: [{ emission: [1, .1, .05] }] }] }); });
            expect(r.report.status).toBe('ok');
            expect(r.layers).toEqual(['trace']);
            expect(r.metrics.backend).toBe('webgpu');
            expect(r.metrics.coveragePixels).toBeGreaterThan(100);
            expect(r.data.filter((_: number, i: number) => i % 4 === 0).some((x: number) => x > 100)).toBe(true);
        });
    });
}
