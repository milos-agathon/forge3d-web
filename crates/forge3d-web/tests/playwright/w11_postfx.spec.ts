import {expect,test,skipRenderAssertionsWhenProbing} from "../browser/webgpu-fixture";
test("W11 effects execute, expose finite HDR intermediates and preserve the disabled path",async({page,webgpuAvailability})=>{
  skipRenderAssertionsWhenProbing(webgpuAvailability);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/examples/test-w11-postfx.html");await page.waitForFunction(()=>(window as any).__w11Ready);
  const result=await page.evaluate(()=>(window as any).__w11Effects());console.log("W11 effects",result);
  expect(result.covered).toBeGreaterThan(1000);expect(result.maxHdr).toBeGreaterThan(1);expect(result.disabledDelta).toBe(0);
  for(const name of ["ssao","gtao","ssgi","ssr","bloom","dof","motion-blur","taa","accumulation-aa","denoise","lens"]){
    expect(result[name].finite,name).toBe(true);expect(result[name].report.passOrder[0]).toBe("gbuffer:primary");expect(result[name].report.sampling).toBe("texture-load");
  }
  for(const name of ["ssao","gtao","ssgi","ssr","bloom","dof","lens"])expect(result[name].delta,name).toBeGreaterThan(.02);
  expect(errors).toEqual([]);
});
test("W11 disocclusion decay, stationary flicker, accumulation and HZB",async({page,webgpuAvailability})=>{
  skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w11-postfx.html");await page.waitForFunction(()=>(window as any).__w11Ready);
  const r=await page.evaluate(()=>(window as any).__w11Temporal());console.log("W11 temporal",r);
  expect(r.movement).toBeGreaterThan(1);expect(r.initialError).toBeGreaterThan(.01);expect(r.errors[7]).toBeLessThanOrEqual(.05*r.initialError);expect(r.flicker).toBeLessThanOrEqual(1/255);expect(r.jitterFlicker).toBeLessThanOrEqual(1/255);
  expect(r.accum.jitter.some((x:number)=>x!==0)).toBe(true);expect(r.maxHzbError).toBe(0);expect(r.parallelChannels).toEqual([4,2]);
  expect(r.freezeDelta).toBe(0);expect(r.cameraMotion).toBeGreaterThan(1);expect(r.blurDelta).toBeGreaterThan(.0001);
});
test("W11 viewer device loss replays the ordered chain with invalid history",async({page,webgpuAvailability})=>{
  skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w11-postfx.html");await page.waitForFunction(()=>(window as any).__w11Ready);
  const r=await page.evaluate(()=>(window as any).__w11Recovery());expect(r.delta).toBe(0);expect(r.attempts).toBe(1);expect(r.invalid.historyValid).toBe(false);expect(r.report.enabled).toBe(true);
});
test("W11 independent native shader images meet SSIM 0.98",async({page,webgpuAvailability})=>{
  skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w11-postfx.html");await page.waitForFunction(()=>(window as any).__w11Ready);
  const r=await page.evaluate(()=>(window as any).__w11Native());console.log("W11 native",JSON.stringify(r));
  for(const [name,result] of Object.entries(r) as [string,any][]){if(typeof result==="number"){expect(result,name).toBeLessThan(.0005);continue;}expect(result.ssim,name).toBeGreaterThanOrEqual(.98);expect(result.control,name).toBeLessThan(.98);}
});
test("W11 history, object motion, resize and 30 allocation cycles",async({page,webgpuAvailability})=>{
  skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w11-postfx.html");await page.waitForFunction(()=>(window as any).__w11Ready);
  const r=await page.evaluate(()=>(window as any).__w11Lifecycle());console.log("W11 lifecycle",r);
  expect(r.cycles).toEqual(new Array(30).fill(0));expect(r.readFrames).toBe(r.before.historyFrames);expect(r.readDelta).toBe(0);
  expect(r.reset.historyValid).toBe(false);expect(r.reset.historyReason).toBe("explicit");expect(r.resized.historyValid).toBe(false);expect(r.resized.historyReason).toBe("resize");
  expect(r.dimensions).toEqual([67,45]);expect(r.cut.historyReason).toBe("camera-cut");expect(r.cut.historyFrames).toBe(1);
  expect(r.moved).toBeGreaterThan(1);expect(r.stationary).toBeLessThan(1e-5);
});

test("W11 baseline formats, debug views, order, output transfer and transactional admission",async({page,webgpuAvailability})=>{
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.addInitScript(()=>{const request=GPU.prototype.requestAdapter;GPU.prototype.requestAdapter=async function(...args){const a=await request.apply(this,args);if(!a)return a;const limits:any={};for(const k in a.limits)limits[k]=(a.limits as any)[k];limits.maxSampledTexturesPerShaderStage=Math.min(16,limits.maxSampledTexturesPerShaderStage);Object.defineProperty(a,"limits",{value:limits});Object.defineProperty(a,"features",{value:new Set()});return a;};});
  await page.goto("/examples/test-w11-postfx.html");await page.waitForFunction(()=>(window as any).__w11Ready);
  const r=await page.evaluate(()=>(window as any).__w11Contracts());console.log("W11 contracts",r);
  expect(Object.values(r.views)).toEqual(new Array(7).fill(true));expect(r.transferError).toBeLessThanOrEqual(1);
  expect(r.order).toEqual(["gbuffer:primary","gbuffer:surface","hzb","glow:brightpass","glow:blur-0-x","glow:blur-0-y","glow:blur-1-x","glow:blur-1-y","glow:composite","clean:atrous-0","clean:atrous-1","aa:resolve","map:resolve","lens:resolve","output:srgb","overlay"]);
  expect(r.budgetCode).toBe("RESOURCE_LIMIT_EXCEEDED");expect(r.rollbackDelta).toBe(0);expect(r.bytes).toBe(r.afterBytes);expect(r.invalidCode).toBe("INVALID_INPUT");
  expect(r.format.gbufferFormat).toBe("rgba16float");expect(r.format.sampling).toBe("texture-load");expect(r.windMotion).toBeGreaterThan(1);expect(r.windStationary).toBeLessThan(1e-5);
});
test("W11 module worker consumes and clears serialized post-FX",async({page,webgpuAvailability})=>{
  skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w11-postfx.html");await page.waitForFunction(()=>(window as any).__w11Ready);
  const r=await page.evaluate(()=>(window as any).__w11Worker());expect(r.covered).toBeGreaterThan(1000);expect(r.delta).toBe(0);expect(r.disabledDelta).toBeGreaterThan(1);
});
