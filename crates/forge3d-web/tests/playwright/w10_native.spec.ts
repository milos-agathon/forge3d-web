import { expect, skipRenderAssertionsWhenProbing, test } from "../browser/webgpu-fixture";
import { writeFileSync } from "node:fs";

test("W10 terrain agrees with independently rendered native and historical scenes", async ({page,webgpuAvailability}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w07-materials.html");
  await page.waitForFunction(() => typeof (window as any).__w10NativeTerrain === "function");
  const results = await page.evaluate(() => (window as any).__w10NativeTerrain());
  console.log("Native results",Object.fromEntries(Object.entries<any>(results).map(([k,v])=>[k,{...v,actual:undefined}])));
  for(const [name,r] of Object.entries<any>(results)) {
    writeFileSync(`test-results/w10-${name}-web.rgba`,Buffer.from(r.actual));
    expect(r.ssim,name).toBeGreaterThanOrEqual(0.98);
    expect(r.historicalSsim,name).toBeGreaterThanOrEqual(0.98);
    if(r.reflectionDelta!==undefined){expect(r.reflectionDelta,name).toBeGreaterThan(r.nativeReflectionDelta*.5);expect(r.disabledNativeSsim,name).toBeGreaterThanOrEqual(.98);}
    if(r.controlSsim!==undefined)expect(r.controlSsim,name).toBeLessThan(0.98);
  }
});

for(const capped of [false,true]) test(`W10 planar reflections shade only the explicit terrain water mask (${capped ? "16 textures" : "adapter"})`,async({page,webgpuAvailability})=>{
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  if(capped)await page.addInitScript(()=>{const original=GPU.prototype.requestAdapter;GPU.prototype.requestAdapter=async function(...args){const adapter=await original.apply(this,args);if(adapter){const limits:Record<string,number>={};for(const key in adapter.limits)limits[key]=(adapter.limits as any)[key];limits.maxSampledTexturesPerShaderStage=16;Object.defineProperty(adapter,"limits",{value:limits,configurable:true});}return adapter;};});
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/examples/test-w07-materials.html");
  await page.waitForFunction(()=>typeof(window as any).__w10MaskedTerrain==="function");
  const result=await page.evaluate(()=>(window as any).__w10MaskedTerrain());
  console.log("Masked terrain reflections",result);
  expect(result.delta).toBeGreaterThan(.1);expect(result.changed).toBeGreaterThan(100);
  expect(result.landMax).toBe(0);expect(result.repeat).toBe(0);expect(result.cleared).toBe(0);
  expect(result.hdrDelta).toBeGreaterThan(1e-4);expect(result.hdrRepeat).toBe(0);expect(result.guidesStable).toBe(true);expect(result.covered).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});
