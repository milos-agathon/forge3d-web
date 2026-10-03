// W12's installed-tarball acceptance. The full release gate remains separate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve, join, relative, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { resolveCommandInvocation } from "./command-executable.mjs";

const root=dirname(dirname(fileURLToPath(import.meta.url)));
function run(command,args,cwd=root,capture=false){
 const invocation=resolveCommandInvocation(command,args);
 const result=spawnSync(invocation.command,invocation.args,{cwd,encoding:"utf8",stdio:capture?["ignore","pipe","inherit"]:"inherit"});
 if(result.error)throw result.error;
 if(result.status!==0)throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
 return result.stdout??"";
}
const status=run("git",["status","--porcelain=v1","--untracked-files=all"],resolve(root,"../.."),true).trim();
assert.equal(status,"","Installed-tarball evidence requires a clean committed worktree");
const revision=run("git",["rev-parse","HEAD"],root,true).trim();
const temporary=mkdtempSync(join(tmpdir(),"forge3d-w12-consumer-"));
let browser,server;
try{
 run("npm",["run","build"]);
 run("npm",["run","test:api"]);
 run(process.execPath,["tests/api/package-contract.mjs"]);
 const pack=join(temporary,"pack");mkdirSync(pack);
 const [metadata]=JSON.parse(run("npm",["pack","--json","--pack-destination",pack],root,true));
 const tarball=join(pack,metadata.filename);
 const digest=createHash("sha256").update(readFileSync(tarball)).digest("hex");
 const consumer=join(temporary,"consumer");mkdirSync(consumer);
 writeFileSync(join(consumer,"package.json"),JSON.stringify({name:"w12-consumer",private:true,type:"module"}));
 run("npm",["install","--no-save","--ignore-scripts",tarball],consumer);
 run(process.execPath,["--input-type=module","--eval",'import {VectorLayers,VectorLayer,VectorPicker,pickVectorTerrain} from "@forge3d/web"; if ([VectorLayers,VectorLayer,VectorPicker,pickVectorTerrain].some(x=>typeof x!=="function")) throw new Error("missing vector exports");'],consumer);
 const examples=join(consumer,"examples");mkdirSync(examples);
 for(const name of ["test-w12-vector.html","luxembourg-vector.html","vector-picking.html","w12-worker.js"]){
  const source=readFileSync(join(root,"examples",name),"utf8");
  const built=source.replaceAll("../src-ts/index.ts","/node_modules/@forge3d/web/dist/index.js").replaceAll("../src-ts/session.ts","/node_modules/@forge3d/web/dist/session.js").replaceAll("../src-ts/runtime-internals.ts","/node_modules/@forge3d/web/dist/runtime-internals.js");
  assert.ok(!built.includes("src-ts/"),`${name} still imports source`);
  writeFileSync(join(examples,name),built);
 }
 server=createServer((request,response)=>{
  let path=new URL(request.url??"/","http://localhost").pathname;
  if(path.startsWith("/assets/"))path=`/node_modules/@forge3d/web${path}`;
  const file=resolve(consumer,`.${decodeURIComponent(path)}`),rel=relative(consumer,file);
  if(isAbsolute(rel)||rel===".."||rel.startsWith(`..${process.platform==="win32"?"\\":"/"}`)){response.writeHead(403).end();return;}
  try{const bytes=readFileSync(file);response.writeHead(200,{"content-type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".wasm":"application/wasm",".json":"application/json"})[extname(file)]??"application/octet-stream","cache-control":"no-store"});response.end(bytes);}catch{response.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,args:["--enable-unsafe-webgpu",...(process.platform==="win32"?["--use-angle=d3d11"]:[])]});
 const page=await browser.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
 const requests=[];page.on("request",r=>requests.push(r.url()));
 await page.goto(`${origin}/examples/test-w12-vector.html`);await page.waitForFunction(()=>window.__w12Ready);
 const rendering=await page.evaluate(()=>window.__w12Render());
 assert.ok(rendering.covered>300);assert.deepEqual(rendering.ids,[7,12,4294967295]);assert.equal(rendering.alignment,0);assert.ok(rendering.delta<=1);assert.equal(rendering.idDelta,0);assert.equal(rendering.point,4294967295);assert.deepEqual(rendering.lasso,rendering.ids);assert.ok(rendering.highlightDelta>20);assert.ok(rendering.editedIds.includes(4294967295));assert.equal(rendering.cancel,"REQUEST_CANCELLED");assert.equal(rendering.after.gpuBytes,0);assert.equal(rendering.report.effectiveCulling,"gpu");assert.equal(rendering.cpuReport.effectiveCulling,"cpu");
 const oit=await page.evaluate(()=>window.__w12Oit());assert.ok(oit.weightedDelta<=1);assert.ok(oit.standardDelta>20);assert.ok(oit.dualDelta<=1);assert.ok(["wboit","dual-source"].includes(oit.dualReport.effectiveOit));if(oit.dualReport.effectiveOit==="wboit")assert.equal(oit.dualReport.fallbackReason,"dual-source-blending-unavailable");
 const styles=await page.evaluate(()=>window.__w12Styles());assert.deepEqual(styles.ids,[100,101,102,103,104,105,300,301,302,303,304,305,306,307,308]);assert.ok(styles.aa>30);assert.ok(styles.delta<=1);assert.equal(styles.idDelta,0);
 const drape=await page.evaluate(()=>window.__w12Drape());assert.ok(drape.count>100);assert.ok(drape.minY>.25);assert.ok(drape.maxY>.45);assert.ok(drape.postDelta>10);assert.equal(drape.restoreDelta,0);assert.ok(drape.aovCovered>100);assert.equal(drape.hdrFinite,true);
 const lifecycle=await page.evaluate(()=>window.__w12Lifecycle());assert.equal(lifecycle.recoveryDelta,0);assert.deepEqual(lifecycle.resized,[64,48]);assert.equal(lifecycle.stable,true);assert.equal(lifecycle.budget,"RESOURCE_LIMIT_EXCEEDED");assert.equal(lifecycle.rollback,0);
 const wrappers=await page.evaluate(()=>window.__w12Wrappers());assert.deepEqual(wrappers.ids,[7,12,4294967295]);assert.equal(wrappers.report.featureCount,3);assert.equal(wrappers.offscreenReport.featureCount,3);
 await page.goto(`${origin}/examples/luxembourg-vector.html`);await page.waitForFunction(()=>window.__luxembourg,null,{timeout:120000});
 const lux=await page.evaluate(async()=>{const {runtime,layers}=window.__luxembourg;const map=await runtime.readVectorPickMap();return {features:layers.snapshot().layers[0].features.length,covered:map.ids.reduce((n,id)=>n+Number(id!==0),0)};});assert.equal(lux.features,2035);assert.ok(lux.covered>1000);
 await page.goto(`${origin}/examples/vector-picking.html`);await page.waitForFunction(()=>window.__picking);await page.locator("#lasso").click();await page.waitForFunction(()=>window.__picking.layers.getSelection("active")?.ids.length===3);
 assert.deepEqual(errors,[]);assert.ok(requests.some(url=>url.endsWith("forge3d_web_bg.wasm")));assert.ok(requests.every(url=>!url.includes("src-ts/")));
 const evidence={revision,packageSha256:digest,browser:browser.version(),rendering,oit,styles,drape,lifecycle,wrappers,luxembourg:lux};
 const results=join(root,"test-results","w12-package");mkdirSync(results,{recursive:true});writeFileSync(join(results,"evidence.json"),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({ok:true,revision,packageSha256:digest,luxembourg:lux,covered:rendering.covered,workerIds:wrappers.ids}));
}finally{
 await browser?.close();if(server)await new Promise(r=>server.close(r));
 // mkdtemp supplies an absolute directory within the OS temporary root.
 assert.ok(resolve(temporary).startsWith(resolve(tmpdir())+"\\")||resolve(temporary).startsWith(resolve(tmpdir())+"/"));
 rmSync(temporary,{recursive:true,force:true});
}
