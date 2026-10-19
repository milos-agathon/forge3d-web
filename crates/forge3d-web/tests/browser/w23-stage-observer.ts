import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';

// Instrument public calls outside workflows.js. Stage-returned statistics are
// deliberately not inputs to the execution verdict.
export async function observeStages(page:Page){
  await page.evaluate(()=>{
    const api=window.__w23.api,events:any[]=[],pixels=new WeakMap<object,Uint8Array>();
    const stage=()=>document.querySelector('#status')?.textContent??'';
    const record=(kind:string,data:any={})=>{const label=stage();if(label.startsWith('Running '))events.push({label,kind,...data});};
    const delta=(a:Uint8Array,b:Uint8Array)=>{let changed=0;for(let i=0;i<b.length;i+=4)if([0,1,2].some(c=>Math.abs(b[i+c]-a[i+c])>1))changed++;return changed;};
    function wrap(owner:any,name:string,after:(self:any,args:any[],result:any)=>void){const original=owner[name];owner[name]=function(...args:any[]){const result=original.apply(this,args);if(result&&typeof result.then==='function')return result.then((value:any)=>{after(this,args,value);return value;});after(this,args,result);return result;};}
    wrap(api.ImageBasedLighting,'fromRGBE',()=>record('ibl.load'));
    wrap(api.ImageBasedLighting.prototype,'prepare',(_self,_args,result)=>record('ibl.prepare',{prepared:result.prepared}));
    wrap(api.Forge3DRuntime.prototype,'setIbl',()=>record('ibl.bind'));
    wrap(api.Forge3DRuntime.prototype,'render',()=>record('gpu.render'));
    wrap(api.Forge3DRuntime.prototype,'readRgba',(self,_args,result)=>{const last=pixels.get(self),current=Uint8Array.from(result);if(last)record('gpu.rgb',{changed:delta(last,current)});pixels.set(self,current);});
    wrap(api.Forge3DRuntime.prototype,'getPostFxReport',(_self,_args,result)=>record('postfx.report',{report:structuredClone(result)}));
    wrap(api.Forge3DRuntime.prototype,'getVectorReport',(_self,_args,result)=>record('vector.report',{effectiveOit:result.effectiveOit}));
    wrap(api.VectorLayers.prototype,'setOit',(_self,args)=>record('oit.mode',{mode:args[0]}));
    for(const [name,Type]of Object.entries({orbit:api.TerrainOrbitRig,rail:api.TerrainRailRig,follow:api.TerrainTargetFollowRig})as [string,any][]){
      wrap(Type.prototype,'bake',(_self,args,path)=>{let clearance=Infinity;const keys=path.getKeyframes(),end=keys.at(-1).time;for(let t=0;t<=16;t++){const eye=api.cameraStateEye(path.evaluate(end*t/16));clearance=Math.min(clearance,eye[1]-args[0].heightAt(eye[0],eye[2]));}record('rig.bake',{rig:name,keyframes:keys.length,clearance});});
    }
    wrap(api.MapScene.prototype,'render',(self,_args,result)=>record('scene.frame',{shadows:self.recipe.value.shadows,recipeHash:result.recipeHash,coverage:result.metrics.coveragePixels}));
    window.__w23.observed=events;
  });
}

export function assertStageEvidence(examples:any[],events:any[]){
  for(const example of examples)for(const step of example.steps){
    const label=`Running ${example.name}: ${step.workflow}`;
    const observed=events.filter(e=>e.label.startsWith(label));
    const has=(kind:string)=>observed.filter(e=>e.kind===kind);
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
