import {compareNativeScatterShaders} from "../browser/w09-native-scatter";
import {expect,skipRenderAssertionsWhenProbing,test} from "../browser/webgpu-fixture";
import {readFileSync} from "node:fs";
declare global {interface Window {__w09:Record<string,()=>Promise<any>>}}
test("W09 GPU roughness and box-projected reflections match native cubemap pixels",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.reflections!());expect(r.count).toBe(18*1024);expect(r.faces).toEqual([0,1,2,3,4,5]);expect(r.cases).toBe(18);expect(r.maxAbs).toBeLessThanOrEqual(1e-3);expect(r.ssim).toBeGreaterThanOrEqual(.98);
});
test("W09 absent preserves independently rebuilt W08 display and HDR bytes",async({page,webgpuAvailability})=>{
 test.skip(process.env.FORGE3D_W09_COMPARE_W08!=="1","Requires a clean W08 dist copied to pkg/w08-base");
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html?old");await page.waitForFunction(()=>window.__w09!==undefined);
 const before=await page.evaluate(()=>window.__w09.baseline!());
 await page.goto("/examples/test-w09.html?dist");await page.waitForFunction(()=>window.__w09!==undefined);
 const after=await page.evaluate(()=>window.__w09.baseline!());expect(before.covered).toBeGreaterThan(1000);expect(after).toEqual(before);
});
test("W09 admission failures preserve frame and ledger, and release committed allocations",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.budgets!());expect(r.failures).toEqual(Array(3).fill("RESOURCE_LIMIT_EXCEEDED"));expect(r.before).toBe(r.after);expect(r.beforeBytes).toBe(r.afterBytes);expect(r.admitted).toBeLessThanOrEqual(r.budget);expect(r.released).toBe(r.baseBytes);expect(r.admitted-r.baseBytes).toBe(r.report.gpuBytes-64+r.scatterReport.gpuBytes);
});
test("W09 GPU irradiance matches native SH on covered terrain pixels",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.irradiance!());expect(r.count).toBeGreaterThan(100);expect(r.maxAbs).toBeLessThanOrEqual(1e-3);expect(r.ssim).toBeGreaterThanOrEqual(.98);
});
for(const dist of [false,true]) test(`W09 instancing, wind, LOD/HLOD, probes and capture (${dist?"dist":"source"})`,async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto(`/examples/test-w09.html${dist?"?dist":""}`);await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.render!());
 expect(r.ledger.currentBytes).toBeLessThanOrEqual(16*1024*1024);expect(r.scatterDelta).toBeGreaterThan(.2);expect(r.windDelta).toBeGreaterThan(.05);
 expect(r.fixedHash).toBe(r.disabledHash);expect(r.windHash).toBe(r.repeatHash);
 expect(r.baselineHash).toBe(r.clearedHash);
 expect(r.stats.totalInstances).toBe(2);expect(r.stats.visibleInstances).toBe(2);
 expect(r.memory.instanceBufferBytes).toBe(320);expect(r.memory.totalBufferBytes).toBeGreaterThan(1000);
 expect(r.scatterIds.length).toBe(2);
 expect(r.bakeExact).toBe(true);expect(r.reflectionExact).toBe(true);
 expect(r.probeDelta).toBeGreaterThan(.01);expect(r.debugDelta).toBeGreaterThan(.1);
 expect(r.zeroHash).toBe(r.noProbeHash);expect(r.probeMemory.probeCount).toBe(16);
 expect(r.hlod.hlodCoveredInstances).toBe(2);expect(r.hlod.hlodClusterDraws).toBe(1);
 expect(r.culled.culledInstances).toBe(2);expect(errors).toEqual([]);
 if(process.env.FORGE3D_W09_PINNED_HASH_PROFILE){const expected=JSON.parse(readFileSync(new URL(`../golden/w09/hashes-${process.env.FORGE3D_W09_PINNED_HASH_PROFILE}.json`,import.meta.url),"utf8"));expect(r.hashOracle).toEqual(expected.oracle);}

});
test("W09 scene and offline capture integration",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.scene!());expect(r.nonempty).toBe(true);expect(r.ids.length).toBe(2);expect(r.hash).not.toBe(r.timeHash);
});
test("W09 SH and reflection payloads match independently executed native bakers",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const cases=await page.evaluate(()=>window.__w09.native!());
 expect(cases.length).toBe(4);expect(cases[2].reflectionHash).not.toBe(cases[3].reflectionHash);
 for(const c of cases){expect(c.maxAbs).toBeLessThanOrEqual(1e-3);expect(c.ssim).toBeGreaterThanOrEqual(.98);expect(c.controlSsim).toBeLessThan(.98);for(const value of c.mipSsim)expect(value).toBeGreaterThanOrEqual(.98);if(c.name.startsWith("asymmetric"))expect(c.faceControlSsim).toBeLessThan(.98);}
});
test("W09 viewer replays scatter, time and probes after device loss",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.recovery!());expect(r.same).toBe(true);expect(r.stats.totalInstances).toBe(2);expect(r.probeMemory.probeCount).toBe(16);expect(r.diagnostics.recoveryAttempts).toBe(1);
});
test("W09 blend/contact and transparent offline capture",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.blending!());expect(r.blendDelta).toBeGreaterThan(.2);expect(r.contactDelta).toBeGreaterThan(.2);expect(r.captureIds.length).toBe(2);expect(r.rigidHash).toBe(r.plainHash);expect(r.noopHashes).toEqual(Array(3).fill(r.plainHash));expect(r.gustDelta).toBeGreaterThan(.05);expect(r.sequence.length).toBe(2);expect(r.sequence[0]).not.toBe(r.sequence[1]);
});
test("W09 worker reconstructs owned scatter and probe scene data",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.worker!());expect(r.nonempty).toBe(true);expect(r.hash).not.toBe(r.staticHash);expect(r.hash).not.toBe(r.timeHash);
});

test("W09 HLOD pixels use static clusters and exclude individual draws",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.hlodPixels!());expect(r.a).toBe(r.b);expect(r.a).toBe(r.static);expect(r.ids).toHaveLength(1);expect(r.clustered.hlodCoveredInstances).toBe(2);
});
test("W09 probes fade at edges, have zero outside weight, and retain valid data after rejection",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.probeBehavior!());expect(r.center).toBeGreaterThan(r.edge);expect(r.edge).toBeGreaterThan(r.outside);expect(r.outside).toBe(0);expect(r.stressCount).toBe(64);expect(r.stressResolution).toBe(4);expect(r.rejected).toBe(true);expect(r.before).toBe(r.after);expect(r.cleared).not.toBe(r.before);
});

test("W09 ridge GPU irradiance matches native SH across multiple surface normals",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const r=await page.evaluate(()=>window.__w09.irradiance!(1));expect(r.center).toBeLessThan(r.flatNativeUp);expect(r.normalDirections).toBeGreaterThan(1);expect(r.count).toBeGreaterThan(100);expect(r.maxAbs).toBeLessThanOrEqual(1e-3);expect(r.ssim).toBeGreaterThanOrEqual(.98);
});

test("W09 worker probe bake keeps the browser responsive and cancels a dispatched request",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");await page.waitForFunction(()=>window.__w09!==undefined);
 const result=await page.evaluate(()=>window.__w09.cancelBake!());expect(result).toEqual({responsive:true,code:"REQUEST_CANCELLED"});
});

test("W09 GPU wind, contact and blend math match executed historical native WGSL",async({page,webgpuAvailability})=>{
 skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w09.html");
 const result=await compareNativeScatterShaders(page);expect(result.windSamples).toBe(210);expect(result.shadeSamples).toBe(63);expect(result.windMaxAbs).toBeLessThanOrEqual(1e-5);expect(result.shadeMaxAbs).toBeLessThanOrEqual(1e-5);expect(result.windControl).toBeGreaterThan(1e-5);
});

test("W09 package facade keeps implementation helpers private",async({page})=>{
 await page.goto("/examples/test-w09.html?dist");const exports=await page.evaluate(async()=>Object.keys(await import("/dist/index.js")));
 for(const name of ["packTerrainProbes","validateProbeSnapshot","normalizeProbeGrid","normalizeScatterBatches","selectScatterLods","scatterMemoryReport","probeShBasis","probeCubeDirection"])expect(exports).not.toContain(name);
 for(const name of ["TerrainScatterBatch","TerrainLightingProbes","seededScatterTransforms","autoScatterLodLevels"])expect(exports).toContain(name);
});
