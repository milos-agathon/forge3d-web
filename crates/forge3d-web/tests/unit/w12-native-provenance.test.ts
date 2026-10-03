import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {expect,it} from "vitest";
it("pins native vector/shader/picking/test sources independently of web output",()=>{
 const base=new URL("../golden/w12/",import.meta.url),manifest=JSON.parse(readFileSync(new URL("provenance.json",base),"utf8"));
 expect(manifest.baselineCommit).toBe("bf8db93233e5158f6d226991fc5d230832c2d806");expect(manifest.sources.length).toBe(18);
 for(const source of manifest.sources)expect(createHash("sha256").update(readFileSync(new URL("native/"+source.file,base))).digest("hex"),source.source).toBe(source.sha256);
 const native=readFileSync(new URL("native/src__vector__oit__blend.rs",base),"utf8");expect(native).toContain("alpha * (0.03 / (1e-5 + z_norm.powi(4))).clamp(1e-2, 3e3)");
});
