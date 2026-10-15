import { test, expect } from "../browser/webgpu-fixture";
import licenses from '../fixtures/w21/licenses.json' with { type: 'json' };

declare global { interface Window { __w21: any; } }
for(const source of [true,false]){
  const label=source?'source':'dist';
  test.describe(label,()=>{
    test.beforeEach(async({page})=>{await page.goto('/examples/utilities.html'+(source?'?source':''));await page.waitForFunction(()=>window.__w21?.ready);});
    test(`W21 ${label}: offline WebCrypto and pure JS licensing, gates, persistence and expiry`,async({page,context})=>{
      await context.setOffline(true);
      const result=await page.evaluate(async keys=>{
        const {api}=window.__w21;
        let blocked=false;try{api.compileStyle(api.parseStyle({layers:[]}),{});}catch(e:any){blocked=e.code==='LICENSE_REQUIRED';}
        const native=await api.setLicenseKey(keys.active),pure=new api.LicenseManager({verifier:'noble'}),fallback=await pure.setKey(keys.enterprise);
        let forged=false;try{await pure.setKey(keys.active.replace('20991231','20991230'));}catch(e:any){forged=e.code==='LICENSE_REQUIRED';}
        const warnings:string[]=[],grace=new api.LicenseManager({now:()=>new Date('2026-10-15T23:59:59Z'),onWarning:(m:string)=>warnings.push(m)});await grace.setKey(keys.grace);grace.requirePro('test');
        const store=api.opfsByteStore('w21-license');await api.licenseManager.save(store);api.licenseManager.clear();await api.licenseManager.load(store);const restored=api.getLicenseInfo();await store.clear();
        const png=await api.arrayToPng({width:1,height:1,channels:4,data:new Uint8Array([12,34,56,0])});
        const offlinePixels=Array.from((await api.pngToArray(png)).data);
        const offlineBenchmark=await api.runBenchmark({op:'png_to_array',width:2,height:2,warmup:1,iterations:2});
        const compiled=api.compileStyle(api.parseStyle({layers:[]}),{}).layers.length;
        await api.setLicenseKey(keys.expired);let expired=false;try{api.requirePro('Scene bundle save');}catch(e:any){expired=e.message.includes('expired');}
        await api.setLicenseKey('');return {blocked,native,fallback,forged,grace:grace.getInfo(),warnings,restored,offlinePixels,offlineBenchmark,compiled,expired,cleared:api.getLicenseInfo()};
      },licenses);
      expect(result.offlinePixels).toEqual([12,34,56,0]);expect(result.offlineBenchmark.samplesMs).toHaveLength(2);expect(result.blocked).toBe(true);expect(result.native.verifier).toBe('webcrypto');expect(result.fallback.verifier).toBe('noble');expect(result.forged).toBe(true);
      expect(result.grace.status).toBe('grace');expect(result.warnings).toHaveLength(1);expect(result.restored.status).toBe('active');expect(result.compiled).toBe(0);expect(result.expired).toBe(true);expect(result.cleared.status).toBe('missing');
    });
    test(`W21 ${label}: exact PNG and ImageData arrays in DOM and a module worker`,async({page})=>{
      const result=await page.evaluate(async()=>{
        const {api}=window.__w21,data=Uint8Array.from({length:7*5*4},(_,i)=>i%4===3?i%3:(i*37)%256),image={width:7,height:5,channels:4,data};
        const blob=await api.arrayToPng(image),decoded=await api.pngToArray(blob),loaded=await api.loadImage(blob),pixels=api.imageArrayToImageData(image),canvas=new OffscreenCanvas(1,1);
        api.displayImageArray(canvas,image);
        const repeat=await api.loadImage(await api.exportImage(decoded)),exact=(v:any)=>v.data.every((x:number,i:number)=>x===data[i]);
        const WorkerCtor=Worker,worker=new WorkerCtor(new URL('/examples/utilities-worker.js',location.origin),{type:'module'});
        const workerResult=await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=reject;worker.postMessage({source:location.search.includes('source'),data,width:7,height:5});}).finally(()=>worker.terminate());
        return {exact:exact(decoded)&&exact(loaded)&&exact(repeat)&&exact(pixels),size:[canvas.width,canvas.height],workerResult};
      });
      expect(result.exact).toBe(true);expect(result.size).toEqual([7,5]);expect(result.workerResult).toEqual({exact:true,width:7,height:5});
    });
    test(`W21 ${label}: browser image fallback and interactive controls`,async({page})=>{
      const result=await page.evaluate(async()=>{
        const {api}=window.__w21,image={width:4,height:3,data:Uint8ClampedArray.from({length:48},(_,i)=>[240,20,30,255][i%4]!)},jpeg=await api.exportImage(image,{type:'image/jpeg',quality:1});
        const oldBitmap=globalThis.createImageBitmap,oldCanvas=globalThis.OffscreenCanvas;
        try{Object.defineProperty(globalThis,'createImageBitmap',{value:undefined,configurable:true});Object.defineProperty(globalThis,'OffscreenCanvas',{value:undefined,configurable:true});const decoded=await api.loadImage(jpeg);return {width:decoded.width,height:decoded.height,red:decoded.data[0]};}
        finally{Object.defineProperty(globalThis,'createImageBitmap',{value:oldBitmap,configurable:true});Object.defineProperty(globalThis,'OffscreenCanvas',{value:oldCanvas,configurable:true});}
      });
      expect(result.width).toBe(4);expect(result.height).toBe(3);expect(result.red).toBeGreaterThan(230);
      await page.locator('#license').fill(licenses.active);await page.locator('#verify').click();await expect(page.locator('#license-status')).toContainText('active');
      await page.locator('#clear').click();await expect(page.locator('#license-status')).toHaveText('No license loaded');
      const downloadPromise=page.waitForEvent('download');await page.locator('#png').click();const download=await downloadPromise;expect(download.suggestedFilename()).toBe('forge3d-pixels.png');
      await page.locator('#benchmark').click();await expect(page.locator('#result')).toContainText('"schemaVersion": 1');
    });
    test(`W21 ${label}: real renderer completion, W02 config, memory and stable benchmark schema`,async({page},info)=>{
      const result=await page.evaluate(async()=>{
        const {api}=window.__w21,canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;document.body.append(canvas);
        const session=await api.Forge3DSession.create(canvas,{runtime:{width:32,height:24},renderer:new api.RendererConfig({quality:'low',memoryBudgetBytes:64*1024*1024})});
        try{
          const scene=api.Forge3DScene.create();scene.addOverlay({name:'coverage',bounds:[0,0,32,24],color:[.8,.2,.1,1]});session.setScene(scene);
          const reports=await api.runBenchmarkSuite(['renderer_rgba','scene_rgba','renderer_png'].map(op=>({op,width:32,height:24,warmup:1,iterations:3,target:session,budget:{maxMemoryBytes:64*1024*1024}})));
          const rgba=await session.readRgba();return {reports,coverage:rgba.filter((v:number,i:number)=>i%4===0&&v>100).length};
        }finally{session.dispose();canvas.remove();}
      });
      expect(result.coverage).toBe(32*24);
      for(const report of result.reports){expect(report.schemaVersion).toBe(1);expect(report.samplesMs).toHaveLength(3);expect(report.renderer.quality).toBe('low');expect(report.environment.capabilities.deviceState).toBe('ready');expect(report.memory.before.currentBytes).toBeGreaterThan(0);expect(report.budget.passed).toBe(true);expect(report.timing).toBe('cpu-completion');}
      await info.attach(`w21-${label}-benchmark.json`,{body:JSON.stringify(result,null,2),contentType:'application/json'});
    });
  });
}
