import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {expect,it} from "vitest";
it("pins every independent W11 native shader source",()=>{
  const base=new URL("../golden/w11/",import.meta.url),manifest=JSON.parse(readFileSync(new URL("provenance.json",base),"utf8"));
  expect(manifest.baselineCommit).toBe("bf8db93233e5158f6d226991fc5d230832c2d806");expect(manifest.sources.length).toBe(17);
  for(const source of manifest.sources)expect(createHash("sha256").update(readFileSync(new URL("native/"+source.file,base))).digest("hex"),source.source).toBe(source.sha256);
});
