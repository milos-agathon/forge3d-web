import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {expect,it} from "vitest";
import {adaptNativeDofSource} from "../browser/w11-native-oracle.js";
it("pins every independent W11 native shader source",()=>{
  const base=new URL("../golden/w11/",import.meta.url),manifest=JSON.parse(readFileSync(new URL("provenance.json",base),"utf8"));
  expect(manifest.baselineCommit).toBe("bf8db93233e5158f6d226991fc5d230832c2d806");expect(manifest.sources.length).toBe(17);
  for(const source of manifest.sources)expect(createHash("sha256").update(readFileSync(new URL("native/"+source.file,base))).digest("hex"),source.source).toBe(source.sha256);
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
