// Run against a separately built git archive of 7b738f9, served over HTTP.
// Copy test-w10.html, w10-acceptance.js, w10-native-probes.js and its worker
// into that archive's examples directory before starting Vite.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const origin=process.argv[2];
if(!origin)throw new Error("Provide the independently built W09 baseline URL");
const browser=await chromium.launch({channel:"chrome",headless:true});
try {
 const page=await browser.newPage();
 await page.goto(new URL("/examples/test-w10.html",origin).href);
 await page.waitForFunction(()=>window.__w10?.preservation);
 const adapter=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();if(!a)throw new Error("No WebGPU adapter");return {vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description,fallback:a.info.isFallbackAdapter};});
 const profileId=process.env.FORGE3D_W10_PINNED_HASH_PROFILE;
 if(!profileId)throw new Error("Set FORGE3D_W10_PINNED_HASH_PROFILE to name the recorded adapter/browser profile");
 const frames=await page.evaluate(()=>window.__w10.preservation());
 for(const r of Object.values(frames))if(r.covered<1000)throw new Error("Baseline has no covered geometry");
 writeFileSync(new URL("../tests/golden/w10/w09-preservation.json",import.meta.url),JSON.stringify({
  fixture:"w09-environment-absent-v1",profile:{id:profileId,platform:process.platform,browser:await browser.version(),adapter},provenance:{commit:"7b738f9",method:"git archive export, independent W09 wasm build",generator:"examples/w10-acceptance.js preservation",browser:await browser.version()},tolerances:{maxByteDifference:0},frames,
 },null,2)+"\n");
}finally{await browser.close();}
