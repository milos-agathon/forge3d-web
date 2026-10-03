import {expect,test,skipRenderAssertionsWhenProbing} from "../browser/webgpu-fixture";
test.beforeEach(async({page,webgpuAvailability})=>{skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w12-vector.html");await page.waitForFunction(()=>(window as any).__w12Ready);});
test("W12 visible point/AA line/polygon pixels have exact stable pick IDs and CPU/GPU parity",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));const r=await page.evaluate(()=>(window as any).__w12Render());
 expect(r.covered).toBeGreaterThan(300);expect(r.ids).toEqual([7,12,4294967295]);expect(r.alignment).toBe(0);expect(r.delta).toBeLessThanOrEqual(1);expect(r.idDelta).toBe(0);expect(r.report.effectiveCulling).toBe("gpu");expect(r.cpuReport.effectiveCulling).toBe("cpu");expect(r.point).toBe(4294967295);expect(r.lasso).toEqual(r.ids);expect(r.highlightDelta).toBeGreaterThan(20);expect(r.editedIds).toContain(4294967295);expect(r.cancel).toBe("REQUEST_CANCELLED");expect(r.after.gpuBytes).toBe(0);expect(errors).toEqual([]);
});
test("W12 WBOIT is order independent and dual-source fallback is observable",async({page})=>{
 const r=await page.evaluate(()=>(window as any).__w12Oit());expect(r.center[0]+r.center[2]).toBeGreaterThan(30);expect(r.weightedDelta).toBeLessThanOrEqual(1);expect(r.standardDelta).toBeGreaterThan(20);expect(r.dualDelta).toBeLessThanOrEqual(1);expect(["wboit","dual-source"]).toContain(r.dualReport.effectiveOit);if(r.dualReport.effectiveOit==="wboit")expect(r.dualReport.fallbackReason).toBe("dual-source-blending-unavailable");
});
test("W12 all point shapes, atlas alpha/LOD and cap/join styles use identical GPU/CPU coverage",async({page})=>{
 const r=await page.evaluate(()=>(window as any).__w12Styles());expect(r.ids).toEqual([100,101,102,103,104,105,300,301,302,303,304,305,306,307,308]);expect(r.aa).toBeGreaterThan(30);expect(r.delta).toBeLessThanOrEqual(1);expect(r.idDelta).toBe(0);
});
test("W12 draped IDs survive terrain occlusion and the HDR post-FX capture path",async({page})=>{
 const r=await page.evaluate(()=>(window as any).__w12Drape());expect(r.count).toBeGreaterThan(100);expect(r.minY).toBeGreaterThan(.25);expect(r.maxY).toBeGreaterThan(.45);expect(r.postDelta).toBeGreaterThan(10);expect(r.restoreDelta).toBe(0);expect(r.aovCovered).toBeGreaterThan(100);expect(r.hdrFinite).toBe(true);
});
test("W12 resize/recovery replay, replacement accounting and rejected allocations",async({page})=>{
 const r=await page.evaluate(()=>(window as any).__w12Lifecycle());expect(r.recoveryDelta).toBe(0);expect(r.resized).toEqual([64,48]);expect(r.stable).toBe(true);expect(r.budget).toBe("RESOURCE_LIMIT_EXCEEDED");expect(r.rollback).toBe(0);
});
test("W12 vectors and full IDs reach worker and offscreen renderers",async({page})=>{
 const r=await page.evaluate(()=>(window as any).__w12Wrappers());expect(r.ids).toEqual([7,12,4294967295]);expect(r.report.featureCount).toBe(3);expect(r.offscreenReport.featureCount).toBe(3);
});
test("W12 Luxembourg and picking examples render covered features and selection",async({page})=>{
 test.setTimeout(120000);
 await page.goto("/examples/luxembourg-vector.html");await page.waitForFunction(()=>(window as any).__luxembourg);
 const lux=await page.evaluate(async()=>{const {runtime,layers}= (window as any).__luxembourg;const map=await runtime.readVectorPickMap();return {features:layers.snapshot().layers[0].features.length,covered:map.ids.reduce((n:number,id:number)=>n+Number(id!==0),0)};});expect(lux.features).toBe(2035);expect(lux.covered).toBeGreaterThan(1000);
 await page.goto("/examples/vector-picking.html");await page.waitForFunction(()=>(window as any).__picking);await page.locator("#lasso").click();await page.waitForFunction(()=>(window as any).__picking.layers.getSelection("active")?.ids.length===3);
 const ids=await page.evaluate(()=>(window as any).__picking.layers.getSelection("active").ids);expect(ids).toEqual([1,2,3]);
});
