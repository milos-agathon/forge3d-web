import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';

// Instrument public calls and actual download links outside workflows.js. Stage-returned statistics are
// deliberately not inputs to the execution verdict.
export async function observeStages(page:Page){
  page.on('console',message=>{if(message.text().startsWith('W23 stage timing: '))console.log(message.text());});
  await page.evaluate(()=>{
    const api=window.__w23.api,events:any[]=[],pending:Promise<void>[]=[],pixels=new WeakMap<object,Uint8Array>();
    const runtimeIds=new WeakMap<object,number>(),datasetIds=new WeakMap<object,number>(),triangleFrames:any[]=[];
    let runtimeCounter=0;
    const stage=()=>document.querySelector('#status')?.textContent??'';
    // Independent timing diagnostics survive a run timeout without changing the
    // workflow or contributing any execution evidence to the verdict.
    let previousStage=stage(),started=performance.now();
    new MutationObserver(()=>{const current=stage();if(current!==previousStage){
      console.info('W23 stage timing: '+JSON.stringify({stage:previousStage.startsWith('Running ')?previousStage:'idle',milliseconds:Math.round(performance.now()-started),next:current.startsWith('Running ')?current:'idle'}));
      previousStage=current;started=performance.now();
    }}).observe(document.querySelector('#status')!,{childList:true,characterData:true,subtree:true});
    const record=(kind:string,data:any={},label=stage())=>{if(label.startsWith('Running ')){const event={label,kind,...data};events.push(event);return event;}};
    const runtimeId=(self:object)=>{if(!runtimeIds.has(self))runtimeIds.set(self,++runtimeCounter);return runtimeIds.get(self);};
    const delta=(a:Uint8Array,b:Uint8Array)=>{let changed=0;for(let i=0;i<b.length;i+=4)if([0,1,2].some(c=>Math.abs(b[i+c]-a[i+c])>1))changed++;return changed;};
    const digest=async(data:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(data)))].map(v=>v.toString(16).padStart(2,'0')).join('');
    function wrap(owner:any,name:string,after:(self:any,args:any[],result:any)=>any){const original=owner[name];owner[name]=function(...args:any[]){const result=original.apply(this,args);if(result&&typeof result.then==='function')return result.then(async(value:any)=>{await after(this,args,value);return value;});after(this,args,result);return result;};}
    wrap(api.ImageBasedLighting,'fromRGBE',()=>record('ibl.load'));
    wrap(api.ImageBasedLighting.prototype,'prepare',(_self,_args,result)=>record('ibl.prepare',{prepared:result.prepared}));
    wrap(api.Forge3DRuntime.prototype,'setIbl',()=>record('ibl.bind'));
    wrap(api.Forge3DRuntime.prototype,'render',()=>record('gpu.render'));
    wrap(api.Forge3DRuntime.prototype,'readRgba',(self,_args,result)=>{
      const last=pixels.get(self),current=Uint8Array.from(result);let coverage=0;
      for(let i=0;i<current.length;i+=4)if(current[i]+current[i+1]+current[i+2]>40)coverage++;
      record('gpu.read',{runtimeId:runtimeId(self),coverage});
      if(last)record('gpu.rgb',{changed:delta(last,current)});pixels.set(self,current);
    });
    wrap(api.Forge3DRuntime.prototype,'completeHeightTile',(self,args,result)=>record('cog.upload',{runtimeId:runtimeId(self),lod:args[0],samples:args[3].length,accepted:result.accepted}));
    wrap(api.CogDataset,'open',(_self,args,result)=>{datasetIds.set(result,events.length+1);record('cog.open',{datasetId:datasetIds.get(result),source:String(args[0]),overviewCount:result.overviewCount});});
    wrap(api.CogDataset.prototype,'readTile',(self,args,result)=>record('cog.tile',{datasetId:datasetIds.get(self),x:args[0],y:args[1],overview:self.selectOverview(args[2]??0),samples:result.length}));
    wrap(api.TerrainStreamer.prototype,'whenConverged',self=>record('cog.converged',{converged:self.converged}));
    wrap(api.Forge3DRuntime.prototype,'getPostFxReport',(_self,_args,result)=>record('postfx.report',{report:structuredClone(result)}));
    wrap(api.Forge3DRuntime.prototype,'getVectorReport',(_self,_args,result)=>record('vector.report',{effectiveOit:result.effectiveOit}));
    wrap(api.VectorLayers.prototype,'setOit',(_self,args)=>record('oit.mode',{mode:args[0]}));
    for(const [name,Type]of Object.entries({orbit:api.TerrainOrbitRig,rail:api.TerrainRailRig,follow:api.TerrainTargetFollowRig})as [string,any][]){
      wrap(Type.prototype,'bake',(_self,args,path)=>{let clearance=Infinity;const keys=path.getKeyframes(),end=keys.at(-1).time;for(let t=0;t<=16;t++){const eye=api.cameraStateEye(path.evaluate(end*t/16));clearance=Math.min(clearance,eye[1]-args[0].heightAt(eye[0],eye[2]));}record('rig.bake',{rig:name,keyframes:keys.length,clearance});});
    }
    wrap(api.MapScene.prototype,'render',async(self,_args,result)=>{
      record('scene.frame',{shadows:self.recipe.value.shadows,recipeHash:result.recipeHash,coverage:result.metrics.coveragePixels});
      const label=stage();if(!label.endsWith(': triangle…'))return;
      const recipe=structuredClone(self.recipe.value),triangle=recipe.layers.some((l:any)=>l.kind==='mesh'&&l.layerId==='triangle');
      recipe.layers=recipe.layers.filter((l:any)=>!(l.kind==='mesh'&&l.layerId==='triangle'));
      const recipeWithoutTriangle=JSON.stringify(recipe),data=Uint8Array.from(result.frame.data);
      const event=record('triangle.frame',{triangle,recipeWithoutTriangle,width:result.frame.width,height:result.frame.height,sha256:await digest(data),coverage:result.metrics.coveragePixels},label);
      const peer=triangleFrames.find(p=>p.label===label&&p.event.triangle!==triangle&&p.event.recipeWithoutTriangle===recipeWithoutTriangle&&p.data.length===data.length);
      if(peer){event.changedPixels=peer.event.changedPixels=delta(peer.data,data);}
      triangleFrames.push({label,event,data});
    });
    // Exercise the native encoder itself, preserving its static capability probes.
    const NativeVideoEncoder=globalThis.VideoEncoder;let encoderCounter=0;
    if(NativeVideoEncoder)globalThis.VideoEncoder=class extends NativeVideoEncoder{
      observedId:number;
      constructor(init:VideoEncoderInit){
        const encoderId=++encoderCounter;
        super({...init,output:(chunk,metadata)=>{record('video.output',{encoderId,bytes:chunk.byteLength,timestamp:chunk.timestamp});init.output(chunk,metadata);}});
        this.observedId=encoderId;
      }
      configure(config:VideoEncoderConfig){super.configure(config);record('video.configure',{encoderId:this.observedId,codec:config.codec});}
      encode(frame:VideoFrame,options?:VideoEncoderEncodeOptions){super.encode(frame,options);record('video.encode',{encoderId:this.observedId,timestamp:frame.timestamp});}
      async flush(){await super.flush();record('video.flush',{encoderId:this.observedId});}
    };
    // Capture each real download while its owning stage is active. Decoding may
    // finish later, so retain the original label rather than sampling it then.
    wrap(document.querySelector('#downloads'),'append',(_self,args)=>{
      for(const link of args)if(link instanceof HTMLAnchorElement&&(/-triangle\.png$|\.mp4$/).test(link.download)){
        const event=record('download',{name:link.download});if(!event)continue;
        const href=link.href;
        pending.push((async()=>{
          try{
            const response=await fetch(href);if(!response.ok)throw Error('Download fetch failed: '+response.status);
            const blob=await response.blob();event.bytes=blob.size;
            if(link.download.endsWith('.mp4'))event.mp4Bytes=[...new Uint8Array(await blob.arrayBuffer())];
            else{
              const bitmap=await createImageBitmap(blob),canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
              try{const context=canvas.getContext('2d')!;context.drawImage(bitmap,0,0);event.width=bitmap.width;event.height=bitmap.height;event.sha256=await digest(new Uint8Array(context.getImageData(0,0,bitmap.width,bitmap.height).data));}
              finally{bitmap.close();}
            }
          }catch(error:any){event.error=error.message;}
        })());
      }
    });
    window.__w23.observed=events;window.__w23.observedPending=pending;
  });
}

// Parse ISO BMFF boxes, including actual sample entries inside stsd. An avc1
// byte substring in media payload is not evidence of an AVC video track.
export function parseMp4(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),types:string[]=[],sampleCounts:number[]=[];
  const text=(at:number)=>String.fromCharCode(...bytes.subarray(at,at+4));
  function boxes(start:number,end:number){
    for(let at=start;at<end;){
      assert(at+8<=end,'Truncated MP4 box');let size=view.getUint32(at),header=8;
      const type=text(at+4);
      if(size===1){assert(at+16<=end,'Truncated large MP4 box');size=Number(view.getBigUint64(at+8));header=16;}
      if(size===0)size=end-at;
      assert(Number.isSafeInteger(size)&&size>=header&&at+size<=end,'Invalid MP4 box size: '+type);types.push(type);
      if(['moov','trak','mdia','minf','stbl'].includes(type))boxes(at+header,at+size);
      if(type==='stsd'){
        assert(at+header+8<=at+size,'Truncated MP4 stsd');const count=view.getUint32(at+header+4);
        let entry=at+header+8;
        for(let i=0;i<count;i++){assert(entry+8<=at+size,'Truncated MP4 sample entry');const n=view.getUint32(entry);assert(n>=8&&entry+n<=at+size,'Invalid MP4 sample entry size');types.push('sample:'+text(entry+4));entry+=n;}
        assert.equal(entry,at+size,'MP4 sample entry count mismatch');
      }
      if(type==='stsz'){
        assert(at+header+12<=at+size,'Truncated MP4 stsz');const sampleSize=view.getUint32(at+header+4),count=view.getUint32(at+header+8);
        assert.equal(size,header+12+(sampleSize===0?4*count:0),'MP4 stsz table size mismatch');sampleCounts.push(count);
      }
      at+=size;
    }
  }
  boxes(0,bytes.length);return {ftyp:types.includes('ftyp'),avc1:types.includes('sample:avc1'),sampleCounts};
}

export async function readStageEvidence(page:Page){
  const events=await page.evaluate(async()=>{await Promise.all(window.__w23.observedPending);return window.__w23.observed;});
  for(const event of events)if(event.mp4Bytes){event.mp4=parseMp4(Uint8Array.from(event.mp4Bytes));delete event.mp4Bytes;}
  return events;
}

export function assertStageEvidence(examples:any[],events:any[]){
  for(const example of examples)for(const step of example.steps){
    const label=`Running ${example.name}: ${step.workflow}…`;
    const observed=events.filter(e=>e.label===label);
    const has=(kind:string)=>observed.filter(e=>e.kind===kind);
    if(step.workflow==='triangle'){
      const frames=has('triangle.frame'),triangles=frames.filter(e=>e.triangle&&e.coverage>500&&e.changedPixels>8);
      assert(triangles.some(t=>frames.some(c=>!c.triangle&&c.recipeWithoutTriangle===t.recipeWithoutTriangle&&c.changedPixels>8)),'Triangle mesh/removal RGB contribution missing: '+example.name);
      assert(triangles.some(t=>has('download').some(d=>d.name.endsWith('-triangle.png')&&!d.error&&d.width===t.width&&d.height===t.height&&d.sha256===t.sha256)),'Downloaded triangle PNG differs from observed mesh frame: '+example.name);
    }
    if(step.workflow==='cog'){
      assert(has('cog.open').some(d=>d.overviewCount>=2&&new Set(has('cog.tile').filter(t=>t.datasetId===d.datasetId&&t.samples>0).map(t=>t.overview)).size>=2),'COG open/read across overview levels missing: '+example.name);
      const uploads=has('cog.upload').filter(e=>e.accepted&&e.samples>0),converged=has('cog.converged').filter(e=>e.converged);
      assert(uploads.length>0,'COG runtime height tile upload missing: '+example.name);
      assert(converged.length>0,'COG convergence missing: '+example.name);
      assert(has('gpu.read').some(r=>r.coverage>100&&uploads.some(u=>u.runtimeId===r.runtimeId&&observed.indexOf(u)<observed.indexOf(r))&&converged.some(c=>observed.indexOf(c)<observed.indexOf(r))),'COG converged readback coverage missing: '+example.name);
    }
    if(step.workflow==='video'){
      const expected=example.name==='khumbu_icefall_sentinel_timelapse.py'?8:3,encodes=has('video.encode');
      assert.equal(encodes.length,expected,'VideoEncoder frame count mismatch: '+example.name);
      assert.equal(has('video.output').length,expected,'VideoEncoder output count mismatch: '+example.name);
      assert(has('video.configure').some(c=>c.codec.startsWith('avc1')&&encodes.every(e=>e.encoderId===c.encoderId)&&has('video.flush').some(f=>f.encoderId===c.encoderId)),'AVC encoder configure/encode/flush missing: '+example.name);
      assert(has('download').some(d=>d.name.endsWith('.mp4')&&!d.error&&d.mp4?.ftyp&&d.mp4?.avc1&&d.mp4.sampleCounts.length===1&&d.mp4.sampleCounts[0]===expected),'Downloaded MP4 boxes/sample count mismatch: '+example.name);
    }
    if(step.workflow==='ibl'){
      assert(has('ibl.load').length&&has('ibl.prepare').some(e=>e.prepared)&&has('ibl.bind').length,'HDR IBL API execution missing: '+example.name);
      assert(has('gpu.rgb').some(e=>e.changed>8),'HDR IBL GPU contribution missing: '+example.name);
    }
    if(step.workflow==='effects'){
      assert(has('oit.mode').some(e=>e.mode==='wboit')&&has('vector.report').some(e=>e.effectiveOit==='wboit'),'OIT API execution missing: '+example.name);
      assert(has('postfx.report').some(e=>e.report.enabled&&e.report.historyValid&&e.report.historyFrames>=3&&e.report.passOrder.some((p:string)=>p.includes('taa'))),'TAA GPU history missing: '+example.name);
      assert(has('gpu.render').length>=7,'TAA/OIT draws missing: '+example.name);
    }
    if(step.workflow==='rigs')for(const name of ['orbit','rail','follow'])assert(has('rig.bake').some(e=>e.rig===name&&e.keyframes>1&&e.clearance>=1.99),'Native rig execution/clearance missing: '+name);
    if(step.workflow==='materials')assert(has('scene.frame').some(e=>e.shadows?.enabled&&e.coverage>500),'Shadow rendering missing: '+example.name);
  }
}
