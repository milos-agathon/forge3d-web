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
  test.slow(); // Independent device, historical shader compilation and IBL preparation.
  skipRenderAssertionsWhenProbing(webgpuAvailability);await page.goto("/examples/test-w11-postfx.html");await page.waitForFunction(()=>(window as any).__w11Ready);
  const r=await page.evaluate(()=>(window as any).__w11Native());console.log("W11 native",JSON.stringify(r));
  expect(r["ssr-ibl-fallback"].roughnessControl).toBeLessThan(.98);
  const ssr=r["ssr-ibl-fallback"];expect(ssr.covered).toBeGreaterThan(1000);expect(ssr.missPixels).toBe(ssr.covered);
  expect(ssr.analytic.runtime.ssim).toBeGreaterThanOrEqual(.98);expect(ssr.analytic.native.ssim).toBeGreaterThanOrEqual(.98);
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


test("architecture #31: covered display/readback/offline/display transitions preserve history", async ({page,webgpuAvailability}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w11-postfx.html");
  await page.waitForFunction(()=>(window as any).__w11Ready);
  const result=await page.evaluate(async()=>{
    const {make,difference}=(window as any).__w11;
    const subject=await make(), control=await make();
    try {
      for(const {r} of [subject,control]) {r.setPostFx([{kind:"taa",id:"aa",jitter:false},{kind:"tonemap",operator:"aces"}]);for(let i=0;i<4;i++)r.render();}
      const r=subject.r, before=r.getPostFxReport(), display=await r.readRgba();
      const depth=await r.readPostFxIntermediate("depth");
      const readback=await r.readRgba(), afterRead=r.getPostFxReport();
      const offline=await r.capture({samples:2,aovs:["id","depth"]});
      const afterOffline=r.getPostFxReport(), afterCapture=await r.readRgba();
      r.render(); control.r.render();
      const final=await r.readRgba(), reference=await control.r.readRgba();
      return {covered:Array.from(depth.data as Float32Array).filter(x=>x<.999).length,
        offlineCovered:Array.from(offline.aovFrame.id() as Uint32Array).filter(x=>x!==0).length,
        before,afterRead,afterOffline,afterDisplay:r.getPostFxReport(),control:control.r.getPostFxReport(),
        readDelta:difference(display,readback),captureDelta:difference(display,afterCapture),finalDelta:difference(final,reference)};
    } finally {for(const x of [subject,control]){x.r.dispose();x.canvas.remove();}}
  });
  expect(result.covered).toBeGreaterThan(1000);expect(result.offlineCovered).toBeGreaterThan(1000);
  expect(result.before.historyFrames).toBeGreaterThan(1);
  for(const state of [result.afterRead,result.afterOffline]) {
    expect(state.historyFrames).toBe(result.before.historyFrames);
    expect(state.historyValid).toBe(result.before.historyValid);
    expect(state.historyReason).toBe(result.before.historyReason);
  }
  expect(result.afterDisplay.historyFrames).toBe(result.before.historyFrames+1);
  expect(result.afterDisplay.historyFrames).toBe(result.control.historyFrames);
  expect(result.readDelta).toBe(0);expect(result.captureDelta).toBe(0);expect(result.finalDelta).toBe(0);
});

test("architecture #32: rejected commits preserve history and camera edits refresh picks", async ({page,webgpuAvailability}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w11-postfx.html");await page.waitForFunction(()=>(window as any).__w11Ready);
  const result=await page.evaluate(async()=>{
    const api=await import(/* @vite-ignore */ "/src-ts/index.ts");
    const {make,camera,difference}=(window as any).__w11;
    const {r,canvas}=await make();
    try {
      const vectors=new api.VectorLayers();vectors.add({name:"pick",features:[{id:7,kind:"point",position:[0,2,0],style:{shape:"square",pointSize:18,color:[1,0,0,1]}}]});
      r.setVectorLayers(vectors);r.setPostFx([{kind:"taa",id:"aa",jitter:false},{kind:"tonemap",operator:"aces"}]);for(let i=0;i<4;i++)r.render();
      const before=r.getPostFxReport(),pixels=await r.readRgba(),memory=r.getMemoryReport().currentBytes;
      const invalid=api.normalizePostFx([{kind:"tonemap"}]);invalid.effects[0].params[15]=1;
      let rejection;try{r.setPostFx(invalid);}catch(error){rejection=(error as any).code;}
      const after=r.getPostFxReport(),afterPixels=await r.readRgba(),afterMemory=r.getMemoryReport().currentBytes;
      const original=await r.readVectorPickMap(),count=r.getVectorReport().pickRenderCount;
      r.setCamera({...camera,position:[5,3,5],target:[1,.4,0]});
      const shifted=await r.readVectorPickMap(),afterCamera=r.getVectorReport().pickRenderCount;
      const repeated=await r.readVectorPickMap(),afterRepeat=r.getVectorReport().pickRenderCount;
      // Rebuild the vectors to obtain an independent fresh-pick reference at the new camera.
      r.setVectorLayers(vectors);const rebuilt=await r.readVectorPickMap();
      return {rejection,before,after,memory,afterMemory,pixelDelta:difference(pixels,afterPixels),
        covered:Array.from(original.ids).filter(x=>x===7).length,
        shiftedCovered:Array.from(shifted.ids).filter(x=>x===7).length,
        changed:original.ids.some((id:number,i:number)=>id!==shifted.ids[i]),
        agrees:shifted.ids.every((id:number,i:number)=>id===rebuilt.ids[i]),
        repeated:shifted.ids.every((id:number,i:number)=>id===repeated.ids[i]),count,afterCamera,afterRepeat};
    }finally{r.dispose();canvas.remove();}
  });
  expect(result.rejection).toBe("INVALID_INPUT");expect(result.before.historyFrames).toBeGreaterThan(1);
  expect(result.after).toEqual(result.before);expect(result.pixelDelta).toBe(0);expect(result.afterMemory).toBe(result.memory);
  expect(result.covered).toBeGreaterThan(20);expect(result.shiftedCovered).toBeGreaterThan(20);expect(result.changed).toBe(true);
  expect(result.agrees).toBe(true);expect(result.repeated).toBe(true);
  expect(result.afterCamera).toBe(result.count+1);expect(result.afterRepeat).toBe(result.afterCamera);
});
