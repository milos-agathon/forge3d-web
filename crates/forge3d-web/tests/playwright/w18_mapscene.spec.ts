import licenses from '../fixtures/w21/licenses.json' with { type: 'json' };
import { test, expect } from "../browser/webgpu-fixture";
declare global {
    interface Window {
        __w18: any;
    }
}
for (const dist of [false, true]) {
    const label = dist ? 'dist' : 'source';
    test.describe(label, () => {
        test(`W18 ${label}: lost scoped devices fail and the next scope recreates them`, async ({ page }, info) => {
            test.setTimeout(60000);
            await page.addInitScript(() => {
                const original = GPUAdapter.prototype.requestDevice;
                GPUAdapter.prototype.requestDevice = async function (options) { const device = await original.call(this, options); (window as any).__scopedDevice = device; return device; };
            });
            await page.reload(); await page.waitForFunction(() => window.__w18?.ready);
            const result = await page.evaluate(async () => {
                const { api, baseRecipe } = window.__w18;
                const first = new api.MapScene(baseRecipe()), afterLoss = new api.MapScene(baseRecipe());
                let code, reference: any, failed: any;
                try {
                    await api.MapScene.withRenderContext(async (renderContext: any) => {
                        reference = await first.render({ renderContext });
                        const device = (window as any).__scopedDevice as GPUDevice;
                        device.destroy(); await device.lost; await Promise.resolve();
                        try { await afterLoss.render({ renderContext }); } catch (error: any) { code = error.code; }
                        failed = await afterLoss.reviewRecord();
                    });
                } finally { first.dispose(); afterLoss.dispose(); }
                const next = new api.MapScene(baseRecipe()); let recovered: any;
                try { recovered = await api.MapScene.withRenderContext((renderContext: any) => next.render({ renderContext })); }
                finally { next.dispose(); delete (window as any).__scopedDevice; }
                return { code, failed, same: recovered.frame.data.every((v: number, i: number) => v === reference.frame.data[i]), coverage: recovered.metrics.coveragePixels, memory: [first, afterLoss, next].map(s => s.getMemoryReport().gpuBytes) };
            });
            await info.attach('map-scoped-device-loss.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
            expect(result.code).toBe('DEVICE_LOST'); expect(result.failed.last_render).toBeNull(); expect(result.failed.renderable).toBe(false);
            expect(result.same).toBe(true); expect(result.coverage).toBeGreaterThan(500); expect(result.memory).toEqual([0, 0, 0]);
        });
        test(`W18 ${label}: scoped devices preserve every frame and close after failure`, async ({ page }, info) => {
            test.setTimeout(60000);
            await page.addInitScript(() => {
                (window as any).__mapDeviceRequests = 0;
                const original = GPUAdapter.prototype.requestDevice;
                GPUAdapter.prototype.requestDevice = function (options) { (window as any).__mapDeviceRequests++; return original.call(this, options); };
            });
            await page.reload(); await page.waitForFunction(() => window.__w18?.ready);
            const result = await page.evaluate(async () => {
                const { api, baseRecipe, fullRecipe } = window.__w18;
                const recipes = [baseRecipe(), fullRecipe(api), baseRecipe()];
                recipes[2].terrain.source.data.material = { ...api.getTerrainMaterialDefaults(), pom: { enabled: true }, layers: { snow: { enabled: true, altitudeMin: .3, altitudeBlend: .2 } } };
                recipes[2].shadows = { enabled: true, filter: 'pcf' };
                const draw = async (recipe: any, renderContext?: any) => {
                    const scene = new api.MapScene(recipe);
                    try { const result = await scene.render({ renderContext }); if (scene.getMemoryReport().gpuBytes !== 0) throw Error('Frame retained GPU owners'); return result; }
                    finally { scene.dispose(); }
                };
                const original = []; for (const recipe of recipes) original.push(await draw(recipe));
                (window as any).__mapDeviceRequests = 0;
                let token: any;
                const shared = await api.MapScene.withRenderContext(async (context: any) => {
                    token = context; return Promise.all(recipes.map((recipe: any) => draw(recipe, context)));
                });
                const sharedDevices = (window as any).__mapDeviceRequests;
                let closed;
                try { await draw(baseRecipe(), token); } catch (error: any) { closed = error.code; }
                const lost: any[] = [];
                const module = GPUDevice.prototype.createShaderModule;
                let inject = true, failure;
                try {
                    GPUDevice.prototype.createShaderModule = function (descriptor) {
                        return module.call(this, inject && descriptor.label === 'forge3d-web-terrain-shader' ? { ...descriptor, code: descriptor.code + '\ninvalid scoped shader;' } : descriptor);
                    };
                    await api.MapScene.withRenderContext(async (context: any) => {
                        try { await draw(baseRecipe(), context); } catch (error: any) { lost.push(error.code); throw error; }
                    });
                } catch (error: any) { failure = error.code; }
                finally { inject = false; GPUDevice.prototype.createShaderModule = module; }
                (window as any).__mapDeviceRequests = 0;
                const recovered = await api.MapScene.withRenderContext((context: any) => draw(baseRecipe(), context));
                return { sharedDevices, closed, failure, lost, recoveryDevices: (window as any).__mapDeviceRequests,
                    frames: shared.map((frame: any, i: number) => ({ coverage: frame.metrics.coveragePixels, originalCoverage: original[i].metrics.coveragePixels, same: frame.frame.data.every((v: number, j: number) => v === original[i].frame.data[j]) })),
                    recoverySame: recovered.frame.data.every((v: number, j: number) => v === original[0].frame.data[j]) };
            });
            await info.attach('map-scoped-device-frames.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
            expect(result.sharedDevices).toBe(1); expect(result.recoveryDevices).toBe(1);
            expect(result.closed).toBe('INVALID_INPUT'); expect(result.failure).toBe('SHADER_COMPILATION_FAILED'); expect(result.lost).toEqual(['SHADER_COMPILATION_FAILED']);
            expect(result.recoverySame).toBe(true);
            for (const frame of result.frames) { expect(frame.coverage).toBeGreaterThan(500); expect(frame.coverage).toBe(frame.originalCoverage); expect(frame.same).toBe(true); }
        });
        for (const kind of ['sentinel', 'rounded-sentinel', 'nan', 'screen']) test(`W18 ${label}: ${kind} terrain preserves original capture coverage`, async ({ page }, info) => {
            test.setTimeout(60000);
            const result = await page.evaluate(async kind => {
                const { api, baseRecipe } = window.__w18, recipe = baseRecipe(), terrain = recipe.terrain.source.data;
                if (kind === 'screen') terrain.renderMode = 'screen';
                else {
                    if (kind !== 'nan') terrain.nodata = kind === 'rounded-sentinel' ? -9999.1 : -9999;
                    for (let y = 0; y < terrain.height; y++) for (let x = 0; x < terrain.width / 2; x++) terrain.heights[y * terrain.width + x] = kind === 'nan' ? NaN : terrain.nodata;
                }
                const run = async (canvas?: HTMLCanvasElement) => {
                    const scene = new api.MapScene(recipe);
                    try { return { result: await scene.render(canvas ? { canvas } : {}), reason: null }; }
                    catch (error: any) { return { result: null, reason: error.details?.reason ?? error.message }; }
                    finally { scene.dispose(); if (scene.getMemoryReport().gpuBytes !== 0) throw Error('Scene retained GPU memory'); }
                };
                const before = await run(document.createElement('canvas')), after = await run();
                return { kind, beforeReason: before.reason, afterReason: after.reason, beforeCoverage: before.result?.metrics.coveragePixels,
                    afterCoverage: after.result?.metrics.coveragePixels, same: before.result && after.result ? before.result.frame.data.every((v: number, i: number) => v === after.result.frame.data[i]) : null };
            }, kind);
            await info.attach('map-special-terrain-coverage.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
            expect(result.afterReason).toBe(result.beforeReason);
            if (result.beforeReason === null) {
                expect(result.beforeCoverage).toBeGreaterThan(500);
                expect(result.afterCoverage).toBe(result.beforeCoverage); expect(result.same).toBe(true);
            } else expect(result.beforeReason).toBe('empty-render-output');
        });
        test(`W18 ${label}: scene pipelines compile only for geometry that exists`, async ({ page }, info) => {
            test.setTimeout(60000);
            await page.addInitScript(() => {
                (window as any).__mapScenePipelines = [];
                const original = GPUDevice.prototype.createRenderPipeline;
                GPUDevice.prototype.createRenderPipeline = function (descriptor) {
                    if (['forge3d-web-scene-world-pipeline', 'forge3d-web-scene-overlay-pipeline', 'forge3d-web-terrain-pipeline'].includes(descriptor.label ?? '')) (window as any).__mapScenePipelines.push(descriptor.label);
                    return original.call(this, descriptor);
                };
            });
            await page.reload(); await page.waitForFunction(() => window.__w18?.ready);
            const rows = await page.evaluate(async () => {
                const { api, baseRecipe } = window.__w18, rows = [];
                for (const kind of ['terrain', 'configured-terrain', 'mesh', 'overlay']) {
                    const recipe = baseRecipe(); recipe.layers = [];
                    if (kind === 'configured-terrain') {
                        recipe.terrain.source.data.material = { ...api.getTerrainMaterialDefaults(), pom: { enabled: true }, layers: { snow: { enabled: true, altitudeMin: .3, altitudeBlend: .2 } } };
                        recipe.shadows = { enabled: true, filter: 'pcf' };
                    }
                    if (kind === 'mesh') recipe.layers = [{ kind: 'nodes', layerId: 'ground', nodes: [{ kind: 'ground-plane', name: 'ground', size: [20, 20], height: 0, color: [.25, .4, .6, 1] }] }];
                    if (kind === 'overlay') { delete recipe.terrain; recipe.layers = [{ kind: 'nodes', layerId: 'panel', nodes: [{ kind: 'overlay', name: 'panel', bounds: [20, 20, 30, 20], color: [1, .2, .1, 1] }] }]; }
                    const scene = new api.MapScene(recipe);
                    try {
                        (window as any).__mapScenePipelines.length = 0;
                        const result = await scene.render();
                        rows.push({ kind, pipelines: [...(window as any).__mapScenePipelines], coverage: result.metrics.coveragePixels, drawCalls: result.metrics.drawCalls });
                    } finally { scene.dispose(); }
                    if (scene.getMemoryReport().gpuBytes !== 0) throw Error('Scene retained GPU memory');
                }
                return rows;
            });
            await info.attach('map-scene-pipeline-demand.json', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
            for (const row of rows) {
                expect(row.coverage).toBeGreaterThan(500); expect(row.drawCalls).toBeGreaterThan(0);
                if (row.kind !== 'mesh') expect(row.pipelines).not.toContain('forge3d-web-scene-world-pipeline');
                else expect(row.pipelines).toContain('forge3d-web-scene-world-pipeline');
                if (row.kind !== 'overlay') expect(row.pipelines).not.toContain('forge3d-web-scene-overlay-pipeline');
                else expect(row.pipelines).toContain('forge3d-web-scene-overlay-pipeline');
                expect(row.pipelines.filter((label: string) => label === 'forge3d-web-terrain-pipeline')).toHaveLength(row.kind === 'overlay' ? 0 : 1);
            }
        });
        test(`W18 ${label}: public and map bootstrap preserve structured shader failures`, async ({ page }) => {
            test.setTimeout(60000);
            await page.addInitScript(() => {
                const original = GPUDevice.prototype.createShaderModule;
                GPUDevice.prototype.createShaderModule = function (descriptor) {
                    return original.call(this, descriptor.label === 'forge3d-web-terrain-shader'
                        ? { ...descriptor, code: descriptor.code + '\ninvalid shader source;' } : descriptor);
                };
            });
            await page.reload(); await page.waitForFunction(() => window.__w18?.ready);
            const result = await page.evaluate(async () => {
                const { api, baseRecipe } = window.__w18;
                let publicCode, mapCode, runtime;
                try { runtime = await api.Forge3DRuntime.create(document.createElement('canvas'), { width: 96, height: 96 }); }
                catch (error: any) { publicCode = error.code; }
                finally { runtime?.dispose(); }
                const scene = new api.MapScene(baseRecipe());
                try { await scene.render(); } catch (error: any) { mapCode = error.code; }
                const review = await scene.reviewRecord(); scene.dispose();
                return { publicCode, mapCode, lastRender: review.last_render, memory: scene.getMemoryReport().gpuBytes };
            });
            expect(result.publicCode).toBe('SHADER_COMPILATION_FAILED');
            expect(result.mapCode).toBe('SHADER_COMPILATION_FAILED');
            expect(result.lastRender).toBeNull(); expect(result.memory).toBe(0);
        });
        test(`W18 ${label}: reference depth omits terrain shading and shadow redraws`, async ({ page }, info) => {
            test.setTimeout(60000);
            await page.addInitScript(() => {
                (window as any).__referenceDepthPipelines = [];
                (window as any).__referenceDepthShadows = [];
                (window as any).__readbackShadows = [];
                const pipeline = GPUDevice.prototype.createRenderPipeline;
                GPUDevice.prototype.createRenderPipeline = function (descriptor) {
                    if (descriptor.fragment?.entryPoint === 'fs_capture_depth') (window as any).__referenceDepthPipelines.push(descriptor.fragment.entryPoint);
                    return pipeline.call(this, descriptor);
                };
                const pass = GPUCommandEncoder.prototype.beginRenderPass;
                GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
                    if (this.label === 'forge3d-web-map-depth-reference' && descriptor.label === 'forge3d-shadow-depth-pass') (window as any).__referenceDepthShadows.push(descriptor.label);
                    if (this.label === 'forge3d-web-readback-encoder' && descriptor.label === 'forge3d-shadow-depth-pass') (window as any).__readbackShadows.push(descriptor.label);
                    return pass.call(this, descriptor);
                };
            });
            await page.reload(); await page.waitForFunction(() => window.__w18?.ready);
            const result = await page.evaluate(async () => {
                const { api, baseRecipe } = window.__w18, recipe = baseRecipe();
                recipe.terrain.source.data.material = { ...api.getTerrainMaterialDefaults(), pom: { enabled: true }, layers: { snow: { enabled: true, altitudeMin: .3, altitudeBlend: .2 } } };
                recipe.shadows = { enabled: true, filter: 'pcf' };
                recipe.postFx = { effects: [{ kind: 'taa' }] };
                recipe.environment = new api.Forge3DEnvironment({ water: [{ bounds: [-12, -12, 12, 12], height: 2, mode: 'animated' }] }).snapshot();
                const baseline = new api.MapScene(recipe), candidate = new api.MapScene(recipe);
                try {
                    const before = await baseline.render({ canvas: document.createElement('canvas') });
                    (window as any).__referenceDepthPipelines.length = 0; (window as any).__referenceDepthShadows.length = 0;
                    (window as any).__readbackShadows.length = 0;
                    const after = await candidate.render();
                    return { same: before.frame.data.every((v: number, i: number) => v === after.frame.data[i]), beforeCoverage: before.metrics.coveragePixels, afterCoverage: after.metrics.coveragePixels,
                        depthPipelines: [...(window as any).__referenceDepthPipelines], shadowRedraws: [...(window as any).__referenceDepthShadows], readbackShadowRedraws: [...(window as any).__readbackShadows], gpuBytes: candidate.getMemoryReport().gpuBytes };
                } finally { baseline.dispose(); candidate.dispose(); }
            });
            await info.attach('map-reference-depth-demand.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
            expect(result.same).toBe(true); expect(result.afterCoverage).toBe(result.beforeCoverage); expect(result.afterCoverage).toBeGreaterThan(500);
            expect(result.depthPipelines).toEqual(['fs_capture_depth']); expect(result.shadowRedraws).toEqual([]); expect(result.gpuBytes).toBe(0);
            expect(result.readbackShadowRedraws).toEqual([]);
        });
        for (const kind of ['layers', 'vector-alpha', 'vector-clipped', 'scatter-alpha', 'effects', 'water', 'environment', 'terrain-environment']) test(`W18 ${label}: ${kind} coverage needs no offline accumulation and preserves exact output`, async ({ page }, info) => {
            test.setTimeout(60000);
            await page.addInitScript(() => {
                (window as any).__mapOfflineCompilations = [];
                (window as any).__mapReferencePasses = [];
                (window as any).__mapColorPasses = [];
                (window as any).__mapEnvironmentCompilations = [];
                (window as any).__mapCaptureCompilations = [];
                const renderPipeline = GPUDevice.prototype.createRenderPipeline;
                GPUDevice.prototype.createRenderPipeline = function (descriptor) {
                    if (descriptor.label === 'environment-water-aov-pipeline') (window as any).__mapEnvironmentCompilations.push(descriptor.fragment?.entryPoint);
                    if (['fs_capture_primary', 'fs_capture_surface', 'fs_aov', 'fs_surface'].includes(descriptor.fragment?.entryPoint ?? '')) (window as any).__mapCaptureCompilations.push(descriptor.fragment?.entryPoint);
                    return renderPipeline.call(this, descriptor);
                };
                const renderPass = GPUCommandEncoder.prototype.beginRenderPass;
                GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
                    if (this.label === 'forge3d-web-map-depth-reference') (window as any).__mapReferencePasses.push(descriptor.label);
                    if (descriptor.label === 'forge3d-web-scene-pass' || descriptor.label === 'forge3d-web-readback-pass') (window as any).__mapColorPasses.push(descriptor.label);
                    return renderPass.call(this, descriptor);
                };
                const original = GPUDevice.prototype.createComputePipeline;
                GPUDevice.prototype.createComputePipeline = function (descriptor) {
                    if (descriptor.label?.startsWith('forge3d-web-offline-')) (window as any).__mapOfflineCompilations.push(descriptor.label);
                    if (descriptor.label === 'environment-froxel-pipeline') (window as any).__mapEnvironmentCompilations.push(descriptor.compute.entryPoint);
                    return original.call(this, descriptor);
                };
            });
            await page.reload(); await page.waitForFunction(() => window.__w18?.ready);
            const result = await page.evaluate(async kind => {
                const { api, fullRecipe, baseRecipe } = window.__w18, recipe = kind === 'terrain-environment' ? baseRecipe() : fullRecipe(api);
                if (kind.startsWith('vector-')) {
                    recipe.layers.find((l: any) => l.kind === 'vector').source.data.features = [
                        { id: 1, kind: 'point', position: [0, 8, 0], style: { shape: 'circle', pointSize: 64, color: [1, 0, 0, .35] } },
                        { id: 2, kind: 'point', position: [0, 7, 0], style: { shape: 'diamond', pointSize: 96, color: [0, 0, 1, .65] } },
                        { id: 3, kind: 'line', positions: [[kind === 'vector-clipped' ? -1000 : -10, 8, 0], [kind === 'vector-clipped' ? 1000 : 10, 8, 0]], style: { lineWidth: 6, color: [0, 1, 0, .4] } },
                    ];
                    if (kind === 'vector-clipped') recipe.camera = { ...recipe.camera, far: 65 };
                }
                if (kind === 'scatter-alpha') recipe.layers.find((l: any) => l.kind === 'scatter').batches[0].color[3] = .35;
                if (kind === 'terrain-environment') recipe.terrain.source.data.material = { ...api.getTerrainMaterialDefaults(), pom: { enabled: true }, layers: { snow: { enabled: true, altitudeMin: .3, altitudeBlend: .2 } } };
                if (kind === 'terrain-environment') recipe.shadows = { enabled: true, filter: 'pcf' };
                if (kind === 'effects') recipe.postFx = { effects: [{ kind: 'taa' }, { kind: 'tonemap', operator: 'exposure', exposure: 2 }] };
                if (kind === 'water') recipe.environment = new api.Forge3DEnvironment({ water: [{ bounds: [-12, -12, 12, 12], height: 2, mode: 'animated' }] }).snapshot();
                if (kind === 'environment' || kind === 'terrain-environment') {
                    const haze = await api.generateDensityVolume({ preset: 'localized_haze', bounds: [-12, 0, -12, 12, 10, 12], dimensions: [8, 8, 8], densityScale: 2, wind: [2, 0, .5], seed: 23 });
                    recipe.environment = new api.Forge3DEnvironment({ sky: { model: 'hosek-wilkie', turbidity: 2 }, fog: { mode: 'height', density: .01 }, clouds: { mode: 'hybrid', preset: 'gentle', height: 40, thickness: 20, wind: [2, .5], animationSpeed: 1, seed: 23 }, volumes: [haze] }).snapshot();
                }
                const baseline = new api.MapScene(recipe), candidate = new api.MapScene(recipe);
                try {
                    const before = await baseline.render({ canvas: document.createElement('canvas') });
                    (window as any).__mapOfflineCompilations.length = 0;
                    (window as any).__mapEnvironmentCompilations.length = 0;
                    (window as any).__mapReferencePasses.length = 0;
                    (window as any).__mapColorPasses.length = 0;
                    (window as any).__mapCaptureCompilations.length = 0;
                    const after = await candidate.render();
                    return { kind, same: before.frame.data.every((v: number, i: number) => v === after.frame.data[i]),
                        beforeCoverage: before.metrics.coveragePixels, afterCoverage: after.metrics.coveragePixels,
                        offlineCompilations: [...(window as any).__mapOfflineCompilations], gpuBytes: candidate.getMemoryReport().gpuBytes,
                        referencePasses: [...(window as any).__mapReferencePasses], environmentCompilations: [...(window as any).__mapEnvironmentCompilations],
                        captureCompilations: [...(window as any).__mapCaptureCompilations],
                        colorPasses: [...(window as any).__mapColorPasses], drawCalls: after.metrics.drawCalls };
                } finally { baseline.dispose(); candidate.dispose(); }
            }, kind);
            await info.attach('map-reference-depth.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
            expect(result.same).toBe(true); expect(result.afterCoverage).toBe(result.beforeCoverage);
            expect(result.afterCoverage).toBeGreaterThan(1000); expect(result.gpuBytes).toBe(0);
            expect(result.offlineCompilations).toEqual([]);
            expect(result.referencePasses).not.toContain('forge3d-environment-pass');
            expect(result.environmentCompilations).toEqual(kind === 'water' ? ['fs_water_primary'] : []);
            if (kind === 'water') expect(result.referencePasses).toContain('environment-water-aov-pass');
            // The fixture has one world scene and one separately composited overlay.
            if (kind !== 'effects') expect(result.colorPasses).toEqual(Array(kind === 'terrain-environment' ? 1 : 2).fill('forge3d-web-readback-pass'));
            if (kind === 'vector-clipped') expect(result.referencePasses).toContain('forge3d-web-capture-primary');
            if (kind !== 'water' && kind !== 'effects' && kind !== 'vector-clipped') {
                expect(result.referencePasses).toEqual([]);
                expect(result.captureCompilations).toEqual([]);
            }
            expect(result.drawCalls).toBeGreaterThan(0);
        });
        test(`W18 ${label}: opaque readback preserves exact pixels and coverage without an offline capture`, async ({ page }, info) => {
            await page.addInitScript(() => {
                (window as any).__mapOfflineCompilations = [];
                const original = GPUDevice.prototype.createComputePipeline;
                GPUDevice.prototype.createComputePipeline = function (descriptor) {
                    if (descriptor.label?.startsWith('forge3d-web-offline-')) (window as any).__mapOfflineCompilations.push(descriptor.label);
                    return original.call(this, descriptor);
                };
            });
            // The hook must be installed before the WASM bridge binds WebGPU.
            await page.reload(); await page.waitForFunction(() => window.__w18?.ready);
            const result = await page.evaluate(async () => {
                const { api, baseRecipe } = window.__w18, rows = [];
                for (const terrain of [false, true]) {
                    const recipe = baseRecipe();
                    recipe.layers = [{ kind: 'nodes', layerId: 'ground', nodes: [{ kind: 'ground-plane', name: 'ground', size: [20, 20], height: 0, color: [.25, .4, .6, 1] }] }];
                    if (!terrain) delete recipe.terrain;
                    const baseline = new api.MapScene(recipe), candidate = new api.MapScene(recipe);
                    try {
                        const before = await baseline.render({ canvas: document.createElement('canvas') });
                        (window as any).__mapOfflineCompilations.length = 0;
                        const after = await candidate.render();
                        rows.push({ terrain, same: before.frame.data.every((v: number, i: number) => v === after.frame.data[i]),
                            beforeCoverage: before.metrics.coveragePixels, afterCoverage: after.metrics.coveragePixels,
                            drawCalls: after.metrics.drawCalls, gpuBytes: candidate.getMemoryReport().gpuBytes,
                            offlineCompilations: [...(window as any).__mapOfflineCompilations] });
                    } finally { baseline.dispose(); candidate.dispose(); }
                }
                const hidden = baseRecipe(); delete hidden.terrain;
                hidden.layers = [{ kind: 'nodes', layerId: 'hidden', nodes: [{ kind: 'ground-plane', name: 'hidden', size: [4, 4], height: 0, color: [1, 0, 0, 1], transform: { translation: [1000, 0, 0] } }] }];
                const empty = new api.MapScene(hidden); let reason: string | undefined;
                try { await empty.render(); } catch (error: any) { reason = error.details?.reason; } finally { empty.dispose(); }
                return { rows, emptyReason: reason, emptyGpuBytes: empty.getMemoryReport().gpuBytes };
            });
            await info.attach('map-frame-readback.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
            expect(result.emptyReason).toBe('empty-render-output'); expect(result.emptyGpuBytes).toBe(0);
            for (const row of result.rows) {
                expect(row.same).toBe(true); expect(row.afterCoverage).toBe(row.beforeCoverage);
                expect(row.afterCoverage).toBeGreaterThan(500); expect(row.drawCalls).toBeGreaterThan(0);
                expect(row.gpuBytes).toBe(0); expect(row.offlineCompilations).toEqual([]);
            }
        });
        test(`W18 ${label}: post-processing cannot conceal empty geometry and overlay-only output is covered`,async({page})=>{
            const r=await page.evaluate(async()=>{const {api,baseRecipe}=window.__w18,r=baseRecipe();delete r.terrain;r.postFx={effects:[{kind:'tonemap',operator:'exposure',exposure:2}]};r.layers=[{kind:'nodes',layerId:'hidden',nodes:[{kind:'ground-plane',name:'hidden-plane',size:[4,4],height:0,color:[1,0,0,1],transform:{translation:[1000,0,0]}}]}];const empty=new api.MapScene(r),preflight=empty.validate().status;let code,reason;try{await empty.render();}catch(e:any){code=e.code;reason=e.details?.reason;}const review=await empty.reviewRecord();empty.dispose();r.layers=[{kind:'nodes',layerId:'overlay',nodes:[{kind:'overlay',name:'panel',bounds:[20,20,30,20],color:[1,.2,.1,1]}]}];const filled=new api.MapScene(r),result=await filled.render().catch((e:any)=>{throw Error(JSON.stringify(e.details));});filled.dispose();return {code,reason,preflight,review,coverage:result.metrics.coveragePixels};});expect(r.preflight).toBe('ok');expect(r.reason).toBe('empty-render-output');expect(r.code).toBe('UNSUPPORTED_FEATURE');expect(r.review.last_render).toBeNull();expect(r.coverage).toBe(600);
        });
        test.beforeEach(async ({ page }) => { await page.addInitScript(key=>sessionStorage.setItem('forge3d-example-license',key),licenses.active); await page.goto('/examples/mapscene.html' + (dist ? '?dist' : '')); await page.waitForFunction(() => window.__w18?.ready); });
        test(`W18 ${label}: multilayer example renders real geometry, glyphs and PNG`, async ({ page }, info) => {
            test.setTimeout(120000);
            const result = await page.evaluate(() => window.__w18.renderExample());
            expect(result.status).toBe('ok');
            expect(result.layers).toEqual(['annotation', 'buildings', 'imagery', 'instances', 'labels', 'mesh', 'roads', 'terrain']);
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
        test(`W18 ${label}: M02b blocks nonempty points and tiles before network or GPU creation`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, baseRecipe } = window.__w18, gpu = navigator.gpu, request = gpu.requestAdapter.bind(gpu), fetcher = window.fetch;
                let requests = 0, fetches = 0; gpu.requestAdapter = async () => { requests++; throw Error('unexpected GPU request'); }; window.fetch = async () => { fetches++; throw Error('unexpected fetch'); };
                const records = [];
                try {
                    for (const layer of [
                        { kind: 'point-cloud', layerId: 'points', source: { id: 'p', format: 'points', crs: 'LOCAL', data: { positions: new Float32Array([0, 10, 0]) } }, supportLevel: 'supported' },
                        { kind: 'point-cloud', layerId: 'las', source: { id: 'las', format: 'las', crs: 'LOCAL', url: new URL('/tests/fixtures/w16/tiny.las', location.href).href } },
                        { kind: 'tiles3d', layerId: 'tiles', source: { id: 't', format: 'tileset.json', crs: 'LOCAL', url: new URL('/tests/fixtures/w16/tileset.json', location.href).href } },
                    ]) {
                        const recipe = baseRecipe(); recipe.layers = [layer]; const s = new api.MapScene(recipe), before = s.validate().toJSON(), prepared = (await s.prepare()).toJSON();
                        let code; try { await s.render(); } catch (e: any) { code = e.code; }
                        records.push({ before, prepared, code, review: await s.reviewRecord(), memory: s.getMemoryReport() }); s.dispose();
                    }
                } finally { gpu.requestAdapter = request; window.fetch = fetcher; }
                return { records, requests, fetches };
            });
            expect(r.requests).toBe(0); expect(r.fetches).toBe(0);
            for (const [i, row] of r.records.entries()) {
                expect(row.before.status).toBe('error'); expect(row.prepared).toEqual(row.before);
                expect(row.before.diagnostics.map((d: any) => d.code)).toContain(i === 2 ? 'python_public_3dtiles_incomplete' : 'placeholder_fallback');
                expect(row.code).toBe('UNSUPPORTED_FEATURE'); expect(row.review.last_render).toBeNull(); expect(row.review.renderable).toBe(false); expect(row.memory.gpuBytes).toBe(0);
            }
        });
        test(`W18 ${label}: JSON settings errors block during preflight without GPU work`, async ({ page }) => {
            const rows = await page.evaluate(async () => {
                const { api, baseRecipe } = window.__w18, gpu = navigator.gpu, request = gpu.requestAdapter.bind(gpu);
                let requests = 0; gpu.requestAdapter = async () => { requests++; throw Error('unexpected GPU request'); };
                const rows = [];
                try {
                    for (const setting of ['camera', 'lighting', 'opacity', 'overlay-key', 'overlay-count', 'label-style']) {
                        const r = baseRecipe();
                        if (setting === 'camera') r.camera = { kind: 'orbit-camera', target: [0, 0, 0], distance: 50, elevation: 80, fov: 10 };
                        if (setting === 'lighting') r.lighting = { name: 'bogus' };
                        if (setting.startsWith('op') || setting.startsWith('overlay')) r.layers = Array.from({ length: setting === 'overlay-count' ? 9 : 1 }, (_, i) => ({ kind: 'raster', layerId: 'overlay-' + i, source: { id: 'image-' + i, format: 'rgba', crs: 'LOCAL', data: { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) } }, options: setting === 'opacity' ? { opacity: 7 } : setting === 'overlay-key' ? { typo: true } : {} }));
                        if (setting === 'label-style') r.layers = [{ kind: 'labels', layerId: 'labels', source: { id: 'l', format: 'labels', crs: 'LOCAL', data: [{ id: 'a', text: 'A', position: [10, 10, 0] }] }, style: { font_size: 80 } }];
                        const s = api.MapScene.fromJSON(new api.SceneRecipe(r).serialize()), preflight = s.validate().toJSON(), prepared = (await s.prepare()).toJSON();
                        let code; try { await s.render(); } catch (e: any) { code = e.code; }
                        rows.push({ setting, preflight, prepared, code, review: await s.reviewRecord() }); s.dispose();
                    }
                } finally { gpu.requestAdapter = request; }
                return { rows, requests };
            });
            expect(rows.requests).toBe(0);
            for (const row of rows.rows) { expect(row.preflight.status).toBe('error'); expect(row.prepared).toEqual(row.preflight); expect(row.code).toBe('UNSUPPORTED_FEATURE'); expect(row.review.last_render).toBeNull(); expect(row.review.renderable).toBe(false); }
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
        test(`W18 ${label}: warning policy retains label rejection reports and blocks strict output`, async ({ page }) => {
            const r = await page.evaluate(async () => {
                const { api, baseRecipe } = window.__w18, r = baseRecipe();
                r.layers = [{ kind: 'labels', layerId: 'labels', source: { id: 'l', format: 'labels', crs: 'LOCAL', data: [{ id: 'city', text: 'Alpha', position: [120, 120, 0] }, { id: 'title', text: 'Beta', position: [24, 24, 0] }] }, keepouts: [{ region_id: 'title', kind: 'title', bounds: [0, 0, 64, 64], priority: 100 }] }];
                const accepted = new api.MapScene(r), rendered = await accepted.render(), record = await accepted.reviewRecord(); accepted.dispose();
                r.renderPolicy = 'fail_on_warning'; const blocked = new api.MapScene(r); let code; try { await blocked.render(); } catch (e: any) { code = e.code; }
                const strict = await blocked.reviewRecord(), report = blocked.lastValidationReport.toJSON(), memory = blocked.getMemoryReport(); blocked.dispose();
                return { status: rendered.report.status, codes: rendered.report.diagnostics.map((d: any) => d.code), png: rendered.blob.type, coverage: rendered.metrics.coveragePixels, record, strict, report, code, memory };
            });
            expect(r.status).toBe('warning'); expect(r.codes).toEqual(['label_rejection_summary']); expect(r.png).toBe('image/png'); expect(r.coverage).toBeGreaterThan(1000); expect(r.record.last_render).not.toBeNull();
            expect(r.report.status).toBe('warning'); expect(r.code).toBe('UNSUPPORTED_FEATURE'); expect(r.strict.last_render).toBeNull(); expect(r.strict.renderable).toBe(false); expect(r.memory.gpuBytes).toBe(0);
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
