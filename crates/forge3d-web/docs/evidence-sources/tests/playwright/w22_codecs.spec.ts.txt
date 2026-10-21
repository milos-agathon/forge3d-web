import { test, expect, skipRenderAssertionsWhenProbing } from "../browser/webgpu-fixture";
declare global { interface Window { __w22: any; } }
for (const mode of ['source','dist']) test.describe(`W22 ${mode}`, () => {
  test.beforeEach(async ({ page, webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    await page.goto('/examples/codecs.html' + (mode === 'source' ? '?source' : ''));
    await page.waitForFunction(() => window.__w22?.ready);
  });
  test('every E05 fixture selects one codec, conforms and replays exact decoded bytes', async ({ page }, info) => {
    const result = await page.evaluate(async () => {
      const { api } = window.__w22;
      const records = new Map(), store = { get:async k=>records.get(k), put:async(k,v)=>{records.set(k,v.slice());}, delete:async k=>{records.delete(k);}, clear:async()=>{records.clear();} };
      const registry = new api.CodecRegistry({ store });
      const manifest = await (await fetch('/tests/fixtures/w22/manifest.json')).json(), results=[];
      const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
      const snapshot = value => ArrayBuffer.isView(value) ? {type:value.constructor.name,bytes:[...new Uint8Array(value.buffer,value.byteOffset,value.byteLength)]} : Array.isArray(value) ? value.map(snapshot) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,snapshot(v)])) : value === undefined ? {undefined:true} : value;
      const arrays = value => ArrayBuffer.isView(value) ? [new Uint8Array(value.buffer,value.byteOffset,value.byteLength)] : value && typeof value==='object' ? Object.values(value).flatMap(arrays) : [];
      for (const fixture of manifest.fixtures) {
        const bytes=new Uint8Array(await (await fetch('/tests/fixtures/w22/'+fixture.file)).arrayBuffer());
        if(await digest(bytes)!==fixture.sha256)throw Error('Fixture digest mismatch: '+fixture.file);
        const selection=registry.select(fixture.format);
        if(selection.status!=='selected')throw Error('Required fixture codec unavailable: '+JSON.stringify(selection));
        const decoded=await registry.decode(fixture.format,bytes), v=decoded.value;
        let conforms=false;
        if(fixture.format==='hdr')conforms=JSON.stringify([...v.data])===JSON.stringify(fixture.expected.pixels);
        if(fixture.format==='tiff')conforms=fixture.expected.pixels?v.width===3&&v.height===3&&v.crs===fixture.expected.crs&&v.nodata===fixture.expected.nodata&&JSON.stringify([...v.data])===JSON.stringify(fixture.expected.pixels):v.width===16&&v.height===16&&v.data.every((n,i)=>n===i*3+7);
        if(fixture.format==='laz')conforms=v.positions.length/3===fixture.expected.count && await digest(v.positions)===fixture.expected.positionsSha256 && await digest(v.colors)===fixture.expected.colorsSha256;
        if(fixture.format==='glb')conforms=v.primitives.length===1&&v.primitives[0].mesh.positions.length===9;
        if(fixture.format==='ktx2')conforms=v.width===fixture.expected.width&&v.height===fixture.expected.height&&v.levels[0].data.length===v.width*v.height*4&&(fixture.expected.pixels?JSON.stringify([...v.levels[0].data])===JSON.stringify(fixture.expected.pixels):await digest(v.levels[0].data)===fixture.expected.rgbaSha256);
        if(fixture.format==='glyph-pbf')conforms=v[0].name===fixture.expected.name&&v[0].glyphs[0].id===65&&v[0].glyphs[0].bitmap.every(n=>n===123);
        if(fixture.format==='exr')conforms=v.width===2&&v.height===1&&v.channels.every(c=>JSON.stringify([...c.data])===JSON.stringify(fixture.expected.channels[c.name]));
        const fresh=new api.CodecRegistry({store}); const replay=await fresh.replay(decoded.cacheKey);
        const a=arrays(v),b=arrays(replay.value);
        const exact=JSON.stringify(snapshot(v))===JSON.stringify(snapshot(replay.value))&&a.length===b.length&&a.every((values,i)=>values.length===b[i].length&&values.every((n,j)=>n===b[i][j]));
        await fresh.dispose();
        results.push({file:fixture.file,codec:decoded.codec.id,conforms,exact});
      }
      await registry.dispose();return {results,stats:registry.stats(),persisted:[...records.keys()].filter(k=>!k.endsWith('/index')).length};
    });
    expect(result.results).toHaveLength(9);
    for(const fixture of result.results){expect(fixture.conforms,fixture.file).toBe(true);expect(fixture.exact,fixture.file).toBe(true);}
    expect(result.stats).toMatchObject({disposed:true,activeOperations:0,cacheBytes:0,cacheEntries:0});
    expect(result.persisted).toBe(9);
    await info.attach('w22-fixture-conformance.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
  });
  test('corruption, capabilities, abort and disposal are typed', async ({ page }) => {
    const result=await page.evaluate(async()=>{
      const {api}=window.__w22, errors=[];
      const registry=new api.CodecRegistry();
      for(const format of ['tiff','laz','ktx2','hdr','exr','glb','glyph-pbf'])try{await registry.decode(format,new Uint8Array([1,2,3]));}catch(e){errors.push({format,code:e.code});}
      const disabled=new api.CodecRegistry({disabled:['exr']}),capability=disabled.select('exr');await disabled.dispose();
      const abort=new AbortController();abort.abort();let cancelled;
      try{await registry.decode('hdr',new Uint8Array(1),{signal:abort.signal});}catch(e){cancelled=e.code;}
      await registry.dispose();let disposed;try{await registry.replay('bad');}catch(e){disposed=e.code;}
      return {errors,capability,cancelled,disposed,stats:registry.stats()};
    });
    expect(result.errors).toHaveLength(7);for(const entry of result.errors)expect(entry.code,entry.format).toBe('INVALID_INPUT');
    expect(result.capability).toEqual({status:'unavailable',format:'exr',code:'UNSUPPORTED_FEATURE',reason:'codec-disabled'});
    expect(result.cancelled).toBe('REQUEST_CANCELLED');expect(result.disposed).toBe('RUNTIME_DISPOSED');expect(result.stats.activeOperations).toBe(0);
  });
  test('AOV-guided WebGPU denoiser quality and native memory accounting', async ({ page }, info) => {
    test.setTimeout(300_000);
    const result=await page.evaluate(async()=>{
      const {api,registry}=window.__w22, width=1920,height=1080,pixels=width*height;
      const session=await api.Forge3DRuntime.create(document.querySelector('canvas'),{width:96,height:64,devicePixelRatio:1,diagnostics:true,memoryBudgetBytes:1024*1024*1024});
      const color=new Float32Array(pixels*4),noisy=new Float32Array(pixels*4),albedo=new Float32Array(pixels*3),normal=new Float32Array(pixels*3),depth=new Float32Array(pixels);
      let seed=0;
      const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const i=y*width+x,edge=x<width/2?0.25:0.75;
        for(let c=0;c<3;c++){color[i*4+c]=edge+(y/height)*0.1;noisy[i*4+c]=color[i*4+c]+(random()-0.5)*0.25;albedo[i*3+c]=edge;}
        color[i*4+3]=noisy[i*4+3]=1;normal[i*3+1]=1;depth[i]=x<width/2?0.25:0.75;
      }
      const clean=new api.HdrFrame(width,height,color),input=new api.HdrFrame(width,height,noisy),guides=new api.AovFrame({width,height,near:0.1,far:100,albedo,normal,depth});
      const metric=f=>api.compareImages(f.data,clean.data,{width,height,channels:4,compareChannels:3,dataRange:1});
      const before=await metric(input),baseline=session.getMemoryReport().currentBytes;
      const output=await registry.denoise(session,input,guides,{settings:{method:'oidn',guides:{depth:true}}});
      const after=await metric(output),converged=await registry.denoise(session,clean,guides,{settings:{guides:{depth:true}}}),regression=await metric(converged);
      const afterMemory=session.getMemoryReport().currentBytes;
      const selection=registry.denoiserCapability(session,'oidn'),adapterInfo=session.getCapabilities().adapterInfo;
      const cpu=await api.atrousDenoise({width,height,color:input.data,albedo,normal,depth,guides:{depth:true}});
      let maxAbs=0;for(let i=0;i<cpu.length;i++)maxAbs=Math.max(maxAbs,Math.abs(cpu[i]-output.data[i]));
      session.dispose();await registry.dispose();
      return {size:[width,height],before,after,regression,baseline,afterMemory,maxAbs,selection,adapterInfo,stats:registry.stats()};
    });
    expect(result.size).toEqual([1920,1080]);expect(result.after.ssim-result.before.ssim).toBeGreaterThanOrEqual(0.02);
    expect(result.after.mse).toBeLessThanOrEqual(result.before.mse*0.8);expect(1-result.regression.ssim).toBeLessThanOrEqual(0.005);
    expect(result.maxAbs).toBeLessThanOrEqual(1e-4);expect(result.afterMemory).toBe(result.baseline);
    expect(result.selection).toMatchObject({status:'selected',id:'webgpu-atrous',requested:'oidn',equivalent:true});
    expect(result.stats).toMatchObject({disposed:true,activeOperations:0,cacheBytes:0});
    await info.attach('w22-denoise-quality.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
  });
  test('W02 persistent stores replay offline and reject corrupted artifacts', async ({ page,context }) => {
    // Preload all modules while online, then prove replay needs no source URL.
    await page.evaluate(async()=>{
      const {api}=window.__w22;
      const bytes=new Uint8Array(await (await fetch('/tests/fixtures/w22/linear.hdr')).arrayBuffer());
      await window.__w22.registry.decode('hdr',bytes);
    });
    await context.setOffline(true);
    const result=await page.evaluate(async()=>{
      const {api}=window.__w22, results=[];
      const bytes=new Uint8Array([...new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),128,64,32,129]);
      for(const Constructor of [api.CacheStorageByteCache,api.IndexedDbByteCache,api.OpfsByteCache]){
        const store=new Constructor({name:'w22-'+Constructor.name}), first=new api.CodecRegistry({store});
        const decoded=await first.decode('hdr',bytes);await first.dispose();
        const replay=new api.CodecRegistry({store}), restored=await replay.replay(decoded.cacheKey);await replay.dispose();
        await store.put(decoded.cacheKey,new Uint8Array([1,2,3]));
        const corrupt=new api.CodecRegistry({store});let reason;
        try{await corrupt.replay(decoded.cacheKey);}catch(e){reason=e.details.reason;}
        await corrupt.dispose();await store.clear();results.push({store:Constructor.name,pixel:[...restored.value.data],reason});
      }
      return results;
    });
    expect(result).toHaveLength(3);for(const store of result){expect(store.pixel).toEqual([1,0.5,0.25,1]);expect(store.reason).toBe('cache-corrupt');}
    await context.setOffline(false);
  });
  test('device loss, replacement runtime and disposal during GPU work release allocations',async({page})=>{
    const result=await page.evaluate(async()=>{
      const {api}=window.__w22;
      const internal=await import(location.search.includes('source')?'/src-ts/runtime-internals.ts':'/dist/runtime-internals.js');
      const registry=new api.CodecRegistry(), canvas=document.querySelector('canvas');
      const make=()=>api.Forge3DRuntime.create(canvas,{width:16,height:16,devicePixelRatio:1,diagnostics:true});
      let runtime=await make();
      const data=new Float32Array(16*16*4).fill(0.5),a=new Float32Array(16*16*3).fill(0.5),n=new Float32Array(16*16*3);for(let i=1;i<n.length;i+=3)n[i]=1;
      const frame=new api.HdrFrame(16,16,data),guides=new api.AovFrame({width:16,height:16,near:0.1,far:100,albedo:a,normal:n});
      await registry.denoise(runtime,frame,guides);
      internal.simulateRuntimeDeviceLossForTests(runtime);await new Promise(r=>setTimeout(r,50));let lost;
      try{await registry.denoise(runtime,frame,guides);}catch(e){lost=e.code;}
      runtime.dispose();runtime=await make();
      const baseline=runtime.getMemoryReport().currentBytes;
      const recovered=await registry.denoise(runtime,frame,guides);let enter;const entered=new Promise(r=>{enter=r;});
      const target={denoiseHdrFrame(...args){const work=runtime.denoiseHdrFrame(...args);enter();return work;}};
      const pending=registry.denoise(target,frame,guides).catch(e=>e.code);await entered;await registry.dispose();
      const disposed=await pending,memory=runtime.getMemoryReport().currentBytes;runtime.dispose();
      return {lost,recovered:recovered.width,disposed,baseline,memory,stats:registry.stats()};
    });
    expect(result.lost).toBe('DEVICE_LOST');expect(result.recovered).toBe(16);expect(result.disposed).toBe('RUNTIME_DISPOSED');
    expect(result.memory).toBe(result.baseline);expect(result.stats).toMatchObject({activeOperations:0,cacheBytes:0,disposed:true});
  });

  test('real fixture truncation and structural bit flips reach typed decoder failures',async({page},info)=>{
    const results=await page.evaluate(async()=>{
      const {api}=window.__w22,manifest=await(await fetch('/tests/fixtures/w22/manifest.json')).json(),results=[];
      for(const fixture of manifest.fixtures){
        const original=new Uint8Array(await(await fetch('/tests/fixtures/w22/'+fixture.file)).arrayBuffer());
        const changed=original.slice(),v=new DataView(changed.buffer);
        if(fixture.format==='tiff')v.setUint32(4,0xfffffff0,true);
        if(fixture.format==='laz')v.setUint32(96,0xfffffff0,true);
        if(fixture.format==='glb')v.setUint32(4,3,true);
        if(fixture.format==='ktx2')v.setUint32(80,0xfffffff0,true);
        if(fixture.format==='hdr'){const marker=new TextDecoder().decode(changed).indexOf('-Y ');changed[marker+1]=90;}
        if(fixture.format==='exr'){const marker=new TextDecoder().decode(changed).indexOf('compression\0compression\0');if(marker<0)throw Error('missing EXR compression');changed[marker+24+4]=255;}
        if(fixture.format==='glyph-pbf')changed[0]=15;
        for(const [kind,bytes] of [['truncated',original.slice(0,-1)],['structural-bit-flip',changed]]){
          const registry=new api.CodecRegistry();let failure;
          try{await registry.decode(fixture.format,bytes);}catch(e){failure={code:e.code,reason:e.details?.reason};}
          await registry.dispose();results.push({file:fixture.file,kind,failure,stats:registry.stats()});
        }
      }
      return results;
    });
    for(const r of results){expect(r.failure,`${r.file} ${r.kind}`).toBeDefined();expect(['INVALID_INPUT','UNSUPPORTED_FEATURE'],`${r.file} ${r.kind}`).toContain(r.failure.code);expect(r.failure.reason).toBeTruthy();expect(r.stats).toMatchObject({activeOperations:0,workingBytes:0,cacheBytes:0});}
    await info.attach('w22-real-corruption.json',{body:JSON.stringify(results,null,2),contentType:'application/json'});
  });
  test('missing WASM and worker support return exact browser capability reasons',async({page})=>{
    const result=await page.evaluate(async()=>{
      const {api}=window.__w22,r=new api.CodecRegistry(),wasm=globalThis.WebAssembly,worker=globalThis.Worker;
      let noWasm,noWorker;
      try{globalThis.WebAssembly=undefined;noWasm=['ktx2','exr','laz'].map(format=>r.select(format));globalThis.WebAssembly=wasm;globalThis.Worker=undefined;noWorker=r.select('laz');}
      finally{globalThis.WebAssembly=wasm;globalThis.Worker=worker;await r.dispose();}
      return {noWasm,noWorker};
    });
    for(const selection of result.noWasm)expect(selection).toMatchObject({status:'unavailable',code:'UNSUPPORTED_FEATURE',reason:'webassembly-unavailable'});
    expect(result.noWorker).toMatchObject({status:'unavailable',format:'laz',code:'UNSUPPORTED_FEATURE',reason:'worker-hard-stop-unavailable'});
  });
  test('example decodes, replays and denoises an embedded HDR input',async({page})=>{
    const demo=await page.evaluate(()=>window.__w22.demo);
    expect(demo.decodedPixel).toEqual([1,0.5,0.25,1]);expect(demo.replayedPixel).toEqual(demo.decodedPixel);expect(demo.denoisedPixel).toEqual(demo.decodedPixel);
  });
  test('bounded repeated workflows and injected adapter quota failures release owned memory',async({page},info)=>{
    const iterations=process.env.FORGE3D_W22_SOAK==='1'?128:8;
    const result=await page.evaluate(async iterations=>{
      const {api}=window.__w22,records=new Map(),store={get:async k=>records.get(k),put:async(k,v)=>{records.set(k,v.slice());},delete:async k=>{records.delete(k);},clear:async()=>records.clear()};
      const runtime=await api.Forge3DRuntime.create(document.querySelector('canvas'),{width:16,height:16,devicePixelRatio:1,diagnostics:true}),baseline=runtime.getMemoryReport().currentBytes;
      const frame=new api.HdrFrame(16,16,new Float32Array(16*16*4).fill(0.5)),normal=new Float32Array(16*16*3);for(let i=1;i<normal.length;i+=3)normal[i]=1;
      const guides=new api.AovFrame({width:16,height:16,near:0.1,far:10,albedo:new Float32Array(normal.length).fill(0.5),normal});
      let maxPersistent=0;
      try{for(let i=0;i<iterations;i++){
        const r=new api.CodecRegistry({store,persistentCacheBytes:1300,maxInputBytes:1024,maxDecodedBytes:65536});
        const bytes=new Uint8Array([...new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),100+i%128,64,32,129]);
        try{const d=await r.decode('hdr',bytes);await r.replay(d.cacheKey);await r.denoise(runtime,frame,guides);}finally{await r.dispose();}
        const stats=r.stats();if(stats.workingBytes||stats.activeOperations||stats.cacheBytes)throw Error('retained registry allocation');
        maxPersistent=Math.max(maxPersistent,[...records.values()].reduce((n,b)=>n+b.length,0));
        if(runtime.getMemoryReport().currentBytes!==baseline)throw Error('retained native allocation');
      }}finally{runtime.dispose();}
      const quota=[];
      for(const Constructor of [api.CacheStorageByteCache,api.IndexedDbByteCache,api.OpfsByteCache]){
        const s=new Constructor({name:'w22-quota-'+Constructor.name}),put=s.put;s.put=async()=>{throw new DOMException('injected storage quota','QuotaExceededError');};
        const r=new api.CodecRegistry({store:s});let error;
        try{await r.decode('hdr',new Uint8Array([...new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),128,64,32,129]));}catch(e){error={code:e.code,reason:e.details.reason};}
        finally{await r.dispose();s.put=put;await s.clear();}
        quota.push({adapter:Constructor.name,error,stats:r.stats()});
      }
      return {iterations,baseline,maxPersistent,quota};
    },iterations);
    expect(result.iterations).toBe(iterations);expect(result.maxPersistent).toBeLessThanOrEqual(1300);
    for(const r of result.quota){expect(r.error).toEqual({code:'IO_ERROR',reason:'cache-store-failed'});expect(r.stats).toMatchObject({activeOperations:0,workingBytes:0,cacheBytes:0});}
    await info.attach('w22-soak-quota.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
  });

  test('M3 offline-denoise-v1 runs the original fixture through CodecRegistry',async({page},info)=>{
    test.setTimeout(600_000);
    await page.goto('/examples/test-w06-capture.html?registry'+(mode==='dist'?'&dist':''));
    await page.waitForFunction(()=>!!(window as any).__forge3dW06?.fixture);
    const r=await page.evaluate(()=>(window as any).__forge3dW06.fixture());
    expect(r.registry.calls).toBe(3);
    expect(r.registry.stats).toMatchObject({disposed:true,activeOperations:0,workingBytes:0,cacheBytes:0});
    expect(r.exact.size).toEqual([1920,1080]);expect(r.exact.covered).toBeGreaterThan(100_000);
    expect(r.exact.colorMax).toBeLessThanOrEqual(1e-5);expect(r.exact.aovMax).toBeLessThanOrEqual(1e-5);expect(r.exact.depthMax).toBeLessThanOrEqual(1e-6);
    expect(r.ladder[1].used).toBe(1);expect(r.ladder[4].used).toBe(4);expect(r.ladder[16].used).toBe(16);
    expect(r.ladder[4].psnr).toBeGreaterThan(r.ladder[1].psnr);expect(r.ladder[16].psnr).toBeGreaterThan(r.ladder[4].psnr);
    expect(r.denoise.size).toEqual([1920,1080]);
    expect(r.denoise.after.ssim-r.denoise.before.ssim).toBeGreaterThanOrEqual(0.02);
    expect(r.denoise.after.mse).toBeLessThanOrEqual(r.denoise.before.mse*0.8);
    expect(1-r.denoise.regression.ssim).toBeLessThanOrEqual(0.005);expect(r.denoise.gpuCpuMaxAbs).toBeLessThanOrEqual(1e-4);
    expect(r.stream).toMatchObject({count:120,blank:0,exact:true,last:Math.round(119*1e6/30)});expect(r.stream.memoryAfter).toBe(r.stream.memoryBefore);
    await info.attach('w22-offline-denoise-v1.json',{body:JSON.stringify(r,null,2),contentType:'application/json'});
  });

});
