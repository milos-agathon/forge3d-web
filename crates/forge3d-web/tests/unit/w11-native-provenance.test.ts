import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {expect,it} from "vitest";
import {adaptNativeDofSource,nativeSsrInputs} from "../browser/w11-native-oracle.js";
it("pins every independent W11 native shader source",()=>{
  const base=new URL("../golden/w11/",import.meta.url),manifest=JSON.parse(readFileSync(new URL("provenance.json",base),"utf8"));
  expect(manifest.baselineCommit).toBe("bf8db93233e5158f6d226991fc5d230832c2d806");expect(manifest.sources.length).toBe(17);
  for(const source of manifest.sources)expect(createHash("sha256").update(readFileSync(new URL("native/"+source.file,base))).digest("hex"),source.source).toBe(source.sha256);
});
it("maps native SSR inputs to matching view rays and fractional specular LOD",()=>{
  const projection=new Float32Array(16);projection[0]=1.7;projection[5]=2.3;
  const matrices=new Float32Array(88);matrices[48]=1/projection[0];matrices[53]=1/projection[5];
  const packed=new Float32Array([.5,1,.5,0,.5,.5,1,0]);
  const world=new Float32Array([0,1,0,.15,0,0,1,.8]);
  const input=nativeSsrInputs(packed,world,projection,matrices);
  for(const ndc of [[-.9,.7],[.3,-.4],[0,0]]){
    const view=[ndc[0]/input.camera[48],ndc[1]/input.camera[53],-1];
    // Projecting the native reconstruction must return its source pixel.
    expect(view[0]*projection[0]).toBeCloseTo(ndc[0],6);
    expect(view[1]*projection[5]).toBeCloseTo(ndc[1],6);
  }
  expect((-.9/matrices[48])*projection[0]).not.toBeCloseTo(-.9,2);
  for(let i=3;i<world.length;i+=4){
    expect(input.normal[i]*4).toBeCloseTo(world[i]**2*4,6);
    expect(input.normal[i]*4).toBeGreaterThan(0);
  }
  expect(Array.from(input.normal).filter((_,i)=>i%4!==3)).toEqual(Array.from(packed).filter((_,i)=>i%4!==3));
  expect(packed[3]).toBe(0);expect(matrices[48]).toBeCloseTo(1/projection[0]);
});
it("adapts the pinned DOF debug overlay without changing its RGB expression or alpha",()=>{
  const source=readFileSync(new URL("../golden/w11/native/src__shaders__dof.wgsl",import.meta.url),"utf8");
  const adapted=adaptNativeDofSource(source);
  expect(source).toContain("final_color.rgb = mix(final_color.rgb, vec3<f32>(1.0, 1.0, 0.0), coc_overlay * 0.3);");
  expect(adapted).toContain("final_color = vec4<f32>(mix(final_color.rgb, vec3<f32>(1.0, 1.0, 0.0), coc_overlay * 0.3), final_color.a);");
  const base=new URL("../golden/w11/",import.meta.url),manifest=JSON.parse(readFileSync(new URL("provenance.json",base),"utf8"));
  for(const entry of manifest.sources.filter((entry:any)=>entry.file.endsWith(".wgsl"))){
    const code=readFileSync(new URL("native/"+entry.file,base),"utf8");
    expect(entry.source.endsWith("/dof.wgsl")?adaptNativeDofSource(code):code,entry.source).not.toMatch(/\.[rgbaxyzw]{2,4}\s*[+\-*/]?=/);
  }
});
