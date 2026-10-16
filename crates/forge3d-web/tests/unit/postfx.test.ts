import { describe,it,expect } from "vitest";
import { PostFxChain,normalizePostFx,createIdentityColorLut,validatePostFxSnapshot } from "../../src-ts/postfx.js";
import { Forge3DScene } from "../../src-ts/scene.js";
import type { PostFxInput } from "../../src-ts/postfx-types.js";
describe("W11 ordered HDR chain",()=>{
  it("preserves the supplied HDR order and inserts the display resolve before lens",()=>{
    const result=normalizePostFx([{kind:"dof",id:"focus"},{kind:"bloom",id:"glow"},{kind:"lens",id:"glass"}]);
    expect(result.effects.map(e=>e.id)).toEqual(["focus","glow","display","glass"]);
    expect(result.effects[1]?.params.slice(0,4)).toEqual([1.5,.5,.3,1]);
    expect(result.effects[0]?.params.slice(0,4)).toEqual([.1,10,50,36]);
  });
  it("toggles independent passes and retains snapshot ownership",()=>{
    const chain=new PostFxChain([{kind:"ssao",id:"ao"},{kind:"bloom",id:"bloom"}]);
    chain.setEnabled("ao",false);expect(chain.snapshot().effects.find(e=>e.id==="bloom")?.enabled).toBe(true);
    const snapshot=chain.snapshot();snapshot.effects[1]!.params[2]=9;expect(chain.snapshot().effects[1]!.params[2]).toBe(.3);
    const scene=Forge3DScene.create();scene.setPostFx(chain);const copy=scene.copy();chain.setEnabled("bloom",false);
    expect(copy.snapshot().postFx).toEqual(scene.snapshot().postFx);expect(copy.getPostFx()?.effects[1]?.enabled).toBe(true);
    scene.setPostFx(null);expect(scene.snapshot().postFx).toBe(null);
    scene.dispose();expect(()=>scene.setPostFx(chain)).toThrow();expect(()=>scene.getPostFx()).toThrow();
  });
  it("round trips every effect through the canonical worker snapshot",()=>{
    const effects:PostFxInput[]=[{kind:"ssao"},{kind:"gtao"},{kind:"ssgi"},{kind:"ssr"},{kind:"bloom"},{kind:"dof"},{kind:"motion-blur"},{kind:"taa"},{kind:"accumulation-aa",enabled:false},{kind:"denoise"},{kind:"tonemap",operator:"aces",lut:createIdentityColorLut(3)},{kind:"lens"}];
    const snapshot=normalizePostFx(effects);expect(validatePostFxSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    snapshot.effects[0]!.params[0]=NaN;expect(()=>validatePostFxSnapshot(snapshot)).toThrow();
  });
  for(const input of [
    [{kind:"tonemap"},{kind:"bloom"}], [{kind:"lens"},{kind:"dof"}], [{kind:"taa"},{kind:"accumulation-aa"}],
    [{kind:"bloom",id:"same"},{kind:"dof",id:"same"}], [{kind:"ssr",steps:129}], [{kind:"taa",historyWeight:1}],
    [{kind:"bloom",strength:NaN}], [{kind:"dof",quality:"magic"}], [{kind:"tonemap",operator:"magic"}],
    [{kind:"lens",vignetteSoftness:0}], [{kind:"tonemap",gamma:.01}], [{kind:"ssao",samples:1.5}],
    [{kind:"tonemap",lut:{size:2,data:[0,1]}}], [{kind:"bloom",unknown:true}], [{kind:"bloom",enabled:"yes"}], [{kind:"unknown"}],
  ])it(`rejects invalid settings ${JSON.stringify(input)}`,()=>expect(()=>normalizePostFx(input as any)).toThrow());
  it("checks debug names, empty chains, and identity LUT ordering",()=>{
    expect(normalizePostFx([]).effects).toEqual([]);
    expect(()=>normalizePostFx({effects:[{kind:"taa",id:"aa"}],debug:{view:"effect",effectId:"missing"}})).toThrow();
    expect(()=>normalizePostFx({debug:{view:"effect"}})).toThrow();
    const lut=createIdentityColorLut(2);expect(Array.from(lut.data).slice(0,12)).toEqual([0,0,0,1,0,0,0,1,0,1,1,0]);
    expect(()=>createIdentityColorLut(1)).toThrow();
  });
});
