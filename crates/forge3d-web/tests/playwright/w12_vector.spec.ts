import { expect, test, skipRenderAssertionsWhenProbing } from "../browser/webgpu-fixture";
test.beforeEach(async ({ page, webgpuAvailability }) => { skipRenderAssertionsWhenProbing(webgpuAvailability); await page.goto("/examples/test-w12-vector.html"); await page.waitForFunction(() => (window as any).__w12Ready); });
test("W12 visible point/AA line/polygon pixels have exact stable pick IDs and CPU/GPU parity", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    const r = await page.evaluate(() => (window as any).__w12Render());
    expect(r.covered).toBeGreaterThan(300);
    expect(r.ids).toEqual([7, 12, 4294967295]);
    expect(r.alignment).toBe(0);
    expect(r.delta).toBeLessThanOrEqual(1);
    expect(r.idDelta).toBe(0);
    expect(r.report.effectiveCulling).toBe("gpu");
    expect(r.cpuReport.effectiveCulling).toBe("cpu");
    expect(r.point).toBe(4294967295);
    expect(r.lasso).toEqual(r.ids);
    expect(r.highlightDelta).toBeGreaterThan(20);
    expect(r.editedIds).toContain(4294967295);
    expect(r.cancel).toBe("REQUEST_CANCELLED");
    expect(r.after.gpuBytes).toBe(0);
    expect(errors).toEqual([]);
});
test("W12 WBOIT is order independent and dual-source fallback is observable", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12Oit());
    expect(r.center[0] + r.center[2]).toBeGreaterThan(30);
    expect(r.weightedDelta).toBeLessThanOrEqual(1);
    expect(r.standardDelta).toBeGreaterThan(20);
    expect(r.dualDelta).toBeLessThanOrEqual(1);
    expect(["wboit", "dual-source"]).toContain(r.dualReport.effectiveOit);
    if (r.dualReport.effectiveOit === "wboit")
        expect(r.dualReport.fallbackReason).toBe("dual-source-blending-unavailable");
});
test("W12 all point shapes, atlas alpha/LOD and cap/join styles use identical GPU/CPU coverage", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12Styles());
    expect(r.ids).toEqual([100, 101, 102, 103, 104, 105, 300, 301, 302, 303, 304, 305, 306, 307, 308]);
    expect(r.aa).toBeGreaterThan(30);
    expect(r.delta).toBeLessThanOrEqual(1);
    expect(r.idDelta).toBe(0);
});
test("W12 an adapter without dual-source blending renders through the reported WBOIT fallback", async ({ page }) => {
    await page.addInitScript(() => { const gpu = navigator.gpu; const request = gpu.requestAdapter.bind(gpu); gpu.requestAdapter = async (options) => { const adapter = await request(options); if (adapter)
        Object.defineProperty(adapter, "features", { value: new Set([...adapter.features].filter(f => f !== "dual-source-blending")) }); return adapter; }; });
    await page.reload();
    await page.waitForFunction(() => (window as any).__w12Ready);
    const r = await page.evaluate(() => (window as any).__w12Oit());
    expect(r.dualReport.effectiveOit).toBe("wboit");
    expect(r.dualReport.fallbackReason).toBe("dual-source-blending-unavailable");
    expect(r.dualDelta).toBeLessThanOrEqual(1);
});
test("W12 draped IDs survive terrain occlusion and the HDR post-FX capture path", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12Drape());
    expect(r.count).toBeGreaterThan(100);
    expect(r.minY).toBeGreaterThan(.25);
    expect(r.maxY).toBeGreaterThan(.45);
    expect(r.postDelta).toBeGreaterThan(10);
    expect(r.restoreDelta).toBe(0);
    expect(r.aovCovered).toBeGreaterThan(100);
    expect(r.hdrFinite).toBe(true);
});
test("W12 resize/recovery replay, replacement accounting and rejected allocations", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12Lifecycle());
    expect(r.recoveryDelta).toBe(0);
    expect(r.resized).toEqual([64, 48]);
    expect(r.stable).toBe(true);
    expect(r.budget).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(r.rollback).toBe(0);
});
test("W12 vectors and full IDs reach worker and offscreen renderers", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12Wrappers());
    expect(r.ids).toEqual([7, 12, 4294967295]);
    expect(r.report.featureCount).toBe(3);
    expect(r.offscreenReport.featureCount).toBe(3);
});
test("W12 Luxembourg and picking examples render covered features and selection", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto("/examples/luxembourg-vector.html");
    await page.waitForFunction(() => (window as any).__luxembourg);
    const lux = await page.evaluate(async () => { const { runtime, layers } = (window as any).__luxembourg; const map = await runtime.readVectorPickMap(); return { features: layers.snapshot().layers[0].features.length, covered: map.ids.reduce((n: number, id: number) => n + Number(id !== 0), 0) }; });
    expect(lux.features).toBe(2035);
    expect(lux.covered).toBeGreaterThan(1000);
    await page.goto("/examples/vector-picking.html");
    await page.waitForFunction(() => (window as any).__picking);
    await page.locator("#lasso").click();
    await page.waitForFunction(() => (window as any).__picking.layers.getSelection("active")?.ids.length === 3);
    const ids = await page.evaluate(() => (window as any).__picking.layers.getSelection("active").ids);
    expect(ids).toEqual([1, 2, 3]);
});


test("H1 opaque nearest surface owns color and pick ID in auto/standard and both orders", async ({ page }) => {
    const cases = await page.evaluate(() => (window as any).__w12Opaque());
    expect(cases).toHaveLength(4);
    for (const r of cases) {
        expect(r.center, JSON.stringify({mode:r.mode,reverse:r.reverse})).toEqual([255,0,0,255]);
        expect(r.pick).toBe(1);
        expect(r.covered).toBeGreaterThan(100);
        expect(r.mismatch).toBe(0);
    }
});
test("H2 24px miter contains bevel, bevel contains segment quads, limit falls back and cap pixels differ", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12JoinGeometry());
    expect(r.covered).toBeGreaterThan(500);
    expect(r.miterMissing).toBe(0);
    expect(r.bevelMissing).toBe(0);
    expect(r.miterExtra).toBeGreaterThan(0);
    expect(r.limitDelta).toBe(0);
    expect(r.capCounts.round).toBeGreaterThan(r.capCounts.butt);
    expect(r.capCounts.square).toBeGreaterThan(r.capCounts.round);
    expect(r.roundMissing,JSON.stringify(r)).toBe(0);
    expect(r.squareMissing).toBe(0);
});
test("H3 dual-source matches independent native medium CPU equation within one code value in both orders", async ({ page }) => {
    const cases = await page.evaluate(() => (window as any).__w12DualEquation());
    expect(cases).toHaveLength(2);
    for (const r of cases) {
        expect(r.report.effectiveOit).toBe("dual-source");
        expect(r.actual[0]+r.actual[2]).toBeGreaterThan(30);
        expect(r.delta, JSON.stringify(r)).toBeLessThanOrEqual(1);
    }
});
test("M1 auto chooses available dual-source and reports unavailable-feature fallback", async ({ page }) => {
    let r = await page.evaluate(() => (window as any).__w12Auto());
    expect(r.available).toBe(true);
    expect(r.report.effectiveOit).toBe("dual-source");
    expect(r.report.fallbackReason).toBeNull();
    await page.addInitScript(() => { const gpu=navigator.gpu, request=gpu.requestAdapter.bind(gpu); gpu.requestAdapter=async options=>{const adapter=await request(options);if(adapter)Object.defineProperty(adapter,"features",{value:new Set([...adapter.features].filter(f=>f!=="dual-source-blending"))});return adapter;}; });
    await page.reload(); await page.waitForFunction(() => (window as any).__w12Ready);
    r = await page.evaluate(() => (window as any).__w12Auto());
    expect(r.available).toBe(false);
    expect(r.report.effectiveOit).toBe("wboit");
    expect(r.report.fallbackReason).toBe("dual-source-blending-unavailable");
});
test("M2 vector feature 1 uses reserved ID AOV distinct from terrain and retains full pick ID", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12Aovs());
    expect(r.terrainId,JSON.stringify(r)).toBe(1);
    expect(r.vectorId).toBe(0xffffffef);
    expect(r.vectorId).not.toBe(r.terrainId);
    expect(r.pickId).toBe(1);
});
test("M3 draped flat polygon normal faces camera and matches terrain within 1e-3", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12Aovs());
    for (let i=0;i<3;i++) {
        expect(Math.abs(r.vectorNormal[i]-[0,1,0][i]!)).toBeLessThanOrEqual(1e-3);
        expect(Math.abs(r.vectorNormal[i]-r.terrainNormal[i])).toBeLessThanOrEqual(1e-3);
    }
});
test("M4 sixteen offline samples have fractional vector edge coverage and unchanged reference ID AOV", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12Jitter());
    expect(r.covered).toBeGreaterThan(100);
    expect(r.fractional16).toBeGreaterThan(20);
    expect(r.fractional16).toBeGreaterThan(r.fractionalOne);
    expect(r.idDelta).toBe(0);
});
test("L1 absent scene vectors retain runtime layers and explicit null removes them", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12SceneKeep());
    expect(r.covered).toBeGreaterThan(300);
    expect(r.delta).toBe(0);
    expect(r.removed).toBe(0);
});
test("L2 vector geometry limits throw the public Forge3DError with RESOURCE_LIMIT_EXCEEDED", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12Limits());
    expect(r.code).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(r.isForge3DError).toBe(true);
});
test("L4 graph styles retain drape and only an explicitly set input overrides both", async ({ page }) => {
    const r = await page.evaluate(() => (window as any).__w12GraphDrape());
    expect(r[0].drapes).toEqual([true,true]);
    expect(r[0].covered).toBeGreaterThan(100);
    expect(r[0].minY).toBeCloseTo(.77,4);
    expect(r[1].drapes).toEqual([false,false]);
    expect(r[1].covered).toBe(0);
    expect(r[2].drapes).toEqual([true,true]);
    expect(r[2].covered).toBeGreaterThan(100);
    expect(r[2].minY).toBeCloseTo(.77,4);
});

test("M5 stable parallel compaction is byte-identical to project_and_cull and 200k GPU triangles are no slower", async ({ page }) => {
    test.setTimeout(180000);
    const r=await page.evaluate(()=>(window as any).__w12Compaction());
    expect(r.vertexCount).toBeGreaterThan(6);
    expect(r.gpuBytes).toBe(r.cpuBytes);
    expect(r.byteIdentical,JSON.stringify(r)).toBe(true);
    expect(r.byteDelta).toBe(0);
    expect(r.triangleCount).toBe(200000);
    expect(r.largeVertexCount).toBeGreaterThan(5000);
    expect(r.largeByteDelta).toBe(0);
    expect(r.gpu.median,JSON.stringify(r)).toBeLessThanOrEqual(r.cpu.median);
});
test("M6 2000 selected IDs with 32px outline/glow cost at most twice the unselected frame and exceed old cap", async ({ page }) => {
    test.setTimeout(120000);
    const r=await page.evaluate(()=>(window as any).__w12Incremental());
    expect(r.green).toBeGreaterThan(100);
    expect(r.selected.median,JSON.stringify(r)).toBeLessThanOrEqual(r.plain.median*2);
    expect(r.aboveCap.featureCount).toBe(5000);
});
test("M7 point picking uses at most three padded rows at 1920x1080 and clean picks do not render", async ({ page }) => {
    const r=await page.evaluate(()=>(window as any).__w12PickingBounds());
    expect(r.hit).toBe(1);expect(r.again).toBe(1);
    expect(r.ledgerPeakBytes).toBeLessThanOrEqual(3*256);
    expect(r.first.pickReadbackPeakBytes).toBeLessThanOrEqual(3*256);
    expect(r.first.pickReadbackPeakBytes).toBeGreaterThan(0);
    expect(r.first.pickRenderCount).toBe(r.before.pickRenderCount);
    expect(r.second.pickRenderCount).toBe(r.first.pickRenderCount);
    expect(r.rect).toEqual([1]);expect(r.lasso).toEqual([1]);
    expect(r.rectReport.pickReadbackPeakBytes).toBeLessThanOrEqual(3*256*4);
    expect(r.lassoReport.pickReadbackPeakBytes).toBeLessThanOrEqual(3*256*4);
});
test("M8 selection hover and time commits create no pipelines or vertex buffers", async ({ page }) => {
    test.setTimeout(120000);
    const r=await page.evaluate(()=>(window as any).__w12Incremental());
    expect(r.before.pipelineCreations).toBeGreaterThan(0);
    expect(r.before.vertexBufferCreations).toBeGreaterThan(0);
    expect(r.after.pipelineCreations).toBe(r.before.pipelineCreations);
    expect(r.after.vertexBufferCreations).toBe(r.before.vertexBufferCreations);
    expect(r.hoverTime.pipelineCreations).toBe(r.before.pipelineCreations);
    expect(r.hoverTime.vertexBufferCreations).toBe(r.before.vertexBufferCreations);
    expect(r.sceneBefore.vertexBufferCreations).toBe(r.before.vertexBufferCreations);
    expect(r.sceneAfter.vertexBufferCreations).toBe(r.before.vertexBufferCreations);
    expect(r.sceneBefore.pipelineCreations).toBe(r.before.pipelineCreations);
    expect(r.sceneAfter.pipelineCreations).toBe(r.before.pipelineCreations);
});
test("M8 Luxembourg selection commits in less than 50ms without geometry or pipeline creation", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto("/examples/luxembourg-vector.html");await page.waitForFunction(()=>(window as any).__luxembourg);
    const r=await page.evaluate(()=>{const {runtime,layers,terrain}=(window as any).__luxembourg;const before=runtime.getVectorReport();const start=performance.now();layers.setSelection("active",[1,2,3],{outline:true,outlineWidth:32,glow:true,glowRadius:32});runtime.setVectorLayers(layers,terrain);return {ms:performance.now()-start,before,after:runtime.getVectorReport()};});
    expect(r.ms,JSON.stringify(r)).toBeLessThan(50);
    expect(r.after.pipelineCreations).toBe(r.before.pipelineCreations);
    expect(r.after.vertexBufferCreations).toBe(r.before.vertexBufferCreations);
});
