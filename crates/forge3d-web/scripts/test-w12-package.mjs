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
 for(const name of ["test-w12-vector.html","test-w12-camera.html","luxembourg-vector.html","vector-picking.html","w12-worker.js"]){
  const source=readFileSync(join(root,"examples",name),"utf8");
  const built=source.replaceAll("../src-ts/index.ts","/node_modules/@forge3d/web/dist/index.js").replaceAll("../src-ts/session.ts","/node_modules/@forge3d/web/dist/session.js").replaceAll("../src-ts/runtime-internals.ts","/node_modules/@forge3d/web/dist/runtime-internals.js").replaceAll("../src-ts/vector-geometry.ts","/node_modules/@forge3d/web/dist/vector-geometry.js");
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

 const regressions={};
 regressions.opaque=await page.evaluate(()=>window.__w12Opaque());assert.equal(regressions.opaque.length,4);for(const r of regressions.opaque){assert.deepEqual(r.center,[255,0,0,255]);assert.equal(r.pick,1);assert.ok(r.covered>100);assert.equal(r.mismatch,0);}
 regressions.joins=await page.evaluate(()=>window.__w12JoinGeometry());{const r=regressions.joins;assert.ok(r.covered>500);assert.equal(r.miterMissing,0);assert.equal(r.bevelMissing,0);assert.ok(r.miterExtra>0);assert.equal(r.limitDelta,0);assert.ok(r.capCounts.round>r.capCounts.butt);assert.ok(r.capCounts.square>r.capCounts.round);assert.equal(r.roundMissing,0);assert.equal(r.squareMissing,0);}
 regressions.dual=await page.evaluate(()=>window.__w12DualEquation());assert.equal(regressions.dual.length,2);for(const r of regressions.dual){assert.equal(r.report.effectiveOit,"dual-source");assert.ok(r.actual[0]+r.actual[2]>30);assert.ok(r.delta<=1,JSON.stringify(r));}
 regressions.colorTransfer=await page.evaluate(()=>window.__w12ColorTransfer());{
  const r=regressions.colorTransfer;assert.equal(r.available,true);assert.equal(r.opaque.length,24);assert.equal(r.hdr.length,48);
  for(const c of r.opaque){const context=JSON.stringify(c);assert.deepEqual(c.actual,c.expected,context);assert.equal(c.pick,1,context);assert.ok(c.covered>100,context);assert.equal(c.report.effectiveOit,c.mode==="auto"?"dual-source":c.mode,context);assert.equal(c.report.fallbackReason,null,context);if(c.disjoint)assert.ok(c.disjointCovered>100,context);else assert.equal(c.disjointCovered,0,context);}
  for(const c of r.hdr){const context=JSON.stringify(c);assert.equal(c.report.effectiveOit,c.mode==="auto"?"dual-source":c.mode,context);assert.ok(c.hdrDelta<=.001,context);assert.ok(c.mappedDelta<=.001,context);assert.ok(c.displayDelta<=1,context);assert.equal(c.postfxReport.outputEncoding,"srgb",context);assert.deepEqual(c.postfxReport.passOrder,["gbuffer:primary","gbuffer:surface","hzb","map:resolve","output:srgb","overlay"],context);}
 }
 regressions.auto=await page.evaluate(()=>window.__w12Auto());assert.equal(regressions.auto.available,true);assert.equal(regressions.auto.report.effectiveOit,"dual-source");assert.equal(regressions.auto.report.fallbackReason,null);
 regressions.aovs=await page.evaluate(()=>window.__w12Aovs());{const r=regressions.aovs;assert.equal(r.terrainId,1);assert.equal(r.vectorId,0xffffffef);assert.notEqual(r.vectorId,r.terrainId);assert.equal(r.pickId,1);for(let i=0;i<3;i++){assert.ok(Math.abs(r.vectorNormal[i]-[0,1,0][i])<=1e-3);assert.ok(Math.abs(r.vectorNormal[i]-r.terrainNormal[i])<=1e-3);}}
 regressions.jitter=await page.evaluate(()=>window.__w12Jitter());{const r=regressions.jitter;assert.ok(r.covered>100);assert.ok(r.fractional16>20);assert.ok(r.fractional16>r.fractionalOne);assert.equal(r.idDelta,0);}

 regressions.compaction=await page.evaluate(()=>window.__w12Compaction());{const r=regressions.compaction;assert.ok(r.vertexCount>6);assert.equal(r.gpuBytes,r.cpuBytes);assert.equal(r.byteIdentical,true,JSON.stringify(r));assert.equal(r.byteDelta,0);assert.equal(r.triangleCount,200000);assert.ok(r.largeVertexCount>5000);assert.equal(r.largeByteDelta,0);assert.ok(r.gpu.median<=r.cpu.median,JSON.stringify(r));}
 regressions.incremental=await page.evaluate(()=>window.__w12Incremental());{const r=regressions.incremental;assert.ok(r.green>100);assert.equal(r.recomputedFrames,12);assert.ok(r.selected.median<=r.plain.median*2,JSON.stringify(r));assert.equal(r.aboveCap.featureCount,5000);assert.ok(r.before.pipelineCreations>0);assert.ok(r.before.vertexBufferCreations>0);assert.equal(r.after.pipelineCreations,r.before.pipelineCreations);assert.equal(r.after.vertexBufferCreations,r.before.vertexBufferCreations);assert.equal(r.hoverTime.pipelineCreations,r.before.pipelineCreations);assert.equal(r.hoverTime.vertexBufferCreations,r.before.vertexBufferCreations);assert.equal(r.sceneBefore.vertexBufferCreations,r.before.vertexBufferCreations);assert.equal(r.sceneAfter.vertexBufferCreations,r.before.vertexBufferCreations);assert.equal(r.sceneBefore.pipelineCreations,r.before.pipelineCreations);assert.equal(r.sceneAfter.pipelineCreations,r.before.pipelineCreations);}
 regressions.pickingBounds=await page.evaluate(()=>window.__w12PickingBounds());{const r=regressions.pickingBounds;assert.equal(r.hit,1);assert.equal(r.again,1);assert.ok(r.ledgerPeakBytes<=3*256);assert.ok(r.first.pickReadbackPeakBytes<=3*256);assert.ok(r.first.pickReadbackPeakBytes>0);assert.equal(r.first.pickRenderCount,r.before.pickRenderCount);assert.equal(r.second.pickRenderCount,r.first.pickRenderCount);assert.deepEqual(r.rect,[1]);assert.deepEqual(r.lasso,[1]);assert.ok(r.rectReport.pickReadbackPeakBytes<=3*256*4);assert.ok(r.lassoReport.pickReadbackPeakBytes<=3*256*4);}
 regressions.sceneKeep=await page.evaluate(()=>window.__w12SceneKeep());{const r=regressions.sceneKeep;assert.ok(r.covered>300);assert.equal(r.delta,0);assert.equal(r.removed,0);}
 regressions.limits=await page.evaluate(()=>window.__w12Limits());assert.equal(regressions.limits.code,"RESOURCE_LIMIT_EXCEEDED");assert.equal(regressions.limits.isForge3DError,true);
 regressions.graph=await page.evaluate(()=>window.__w12GraphDrape());{const r=regressions.graph;assert.deepEqual(r[0].drapes,[true,true]);assert.ok(r[0].covered>100);assert.ok(Math.abs(r[0].minY-.77)<1e-4);assert.deepEqual(r[1].drapes,[false,false]);assert.equal(r[1].covered,0);assert.deepEqual(r[2].drapes,[true,true]);assert.ok(r[2].covered>100);assert.ok(Math.abs(r[2].minY-.77)<1e-4);}

 await page.goto(`${origin}/examples/test-w12-camera.html`);await page.waitForFunction(()=>window.__w12CameraReady);
 regressions.camera={highlights:[],picks:[]};
 const hitIds=value=>Array.isArray(value)?value.map(hit=>hit.id):value===null?[]:[value.id];
 for(const mutation of ["translation","projection"]){
  for(const kind of ["selection","hover"]){const r=await page.evaluate(({kind,mutation})=>window.__w12CameraHighlight(kind,mutation),{kind,mutation});regressions.camera.highlights.push(r);assert.ok(r.oldCovered>100,JSON.stringify(r));assert.ok(r.covered>100);assert.equal(r.overlapping,0);assert.equal(r.tinted,r.covered);assert.equal(r.staleGreen,0);assert.equal(r.freshDelta,0);}
  const r=await page.evaluate(mutation=>window.__w12CameraPicks(mutation),mutation);regressions.camera.picks.push(r);assert.equal(r.cases.length,3);assert.notDeepEqual(r.oldCenter,r.newCenter);
  for(const c of r.cases){const context=JSON.stringify({mutation,...c});assert.deepEqual(hitIds(c.warmed),[1],context);assert.deepEqual(c.immediate,c.fresh,context);assert.deepEqual(hitIds(c.immediate),[],context);assert.deepEqual(hitIds(c.newHit),[1],context);assert.equal(c.immediateRenders,1,context);}
 }
 regressions.nearDrape=await page.evaluate(()=>window.__w12NearDrape());assert.equal(regressions.nearDrape.length,4);
 for(const r of regressions.nearDrape){const context=JSON.stringify(r);assert.equal(r.report.effectiveCulling,r.culling,context);assert.ok(r.red>100,context);assert.ok(r.picked>100,context);assert.equal(r.aligned,r.picked,context);assert.equal(r.byteIdentical,true,context);assert.ok(r.vertexCount>0,context);}
 regressions.depthOcclusion=await page.evaluate(()=>window.__w12DepthOcclusion());assert.equal(regressions.depthOcclusion.length,41);
 for(const r of regressions.depthOcclusion){const context=JSON.stringify(r);
  if(r.kind==="arithmetic"){assert.ok(r.gpuCovered>100,context);assert.ok(r.cpuCovered>100,context);assert.ok(r.colorDelta<=1,context);assert.equal(r.idDelta,0,context);assert.equal(r.byteIdentical,true,context);assert.ok(r.vertexCount>1000,context);assert.equal(r.gpuReport.effectiveCulling,"gpu",context);assert.equal(r.cpuReport.effectiveCulling,"cpu",context);continue;}
  assert.ok(r.reference.back>r.reference.front,context);assert.ok(r.reference.separation>2**-24,context);assert.equal(r.reference.coarseFront,r.reference.coarseBack,context);assert.ok(r.reference.coarseBack<r.reference.front,context);assert.equal(r.report.effectiveCulling,r.culling,context);assert.equal(r.byteIdentical,true,context);assert.ok(r.vertexCount>0,context);
  if(r.kind==="terrain"){assert.ok(r.terrainCovered>1000,context);assert.equal(r.red,0,context);assert.equal(r.picked,0,context);assert.equal(r.terrainDelta,0,context);}
  else {assert.equal(r.report.effectiveOit,r.mode==="auto"?"dual-source":r.mode,context);assert.ok(r.covered>100,context);assert.equal(r.wrongPick,0,context);assert.equal(r.wrongColor,0,context);assert.equal(r.centerId,1,context);assert.deepEqual(r.centerColor,[255,0,0,255],context);}
 }
 await page.goto(`${origin}/examples/test-w12-vector.html`);await page.waitForFunction(()=>window.__w12Ready);

 await page.addInitScript(()=>{const gpu=navigator.gpu,request=gpu.requestAdapter.bind(gpu);gpu.requestAdapter=async options=>{const adapter=await request(options);if(adapter)Object.defineProperty(adapter,"features",{value:new Set([...adapter.features].filter(f=>f!=="dual-source-blending"))});return adapter;};});
 await page.reload();await page.waitForFunction(()=>window.__w12Ready);const fallback=await page.evaluate(()=>window.__w12Oit());assert.equal(fallback.dualReport.effectiveOit,"wboit");assert.equal(fallback.dualReport.fallbackReason,"dual-source-blending-unavailable");assert.ok(fallback.dualDelta<=1);const autoFallback=await page.evaluate(()=>window.__w12Auto());assert.equal(autoFallback.available,false);assert.equal(autoFallback.report.effectiveOit,"wboit");assert.equal(autoFallback.report.fallbackReason,"dual-source-blending-unavailable");
 await page.goto(`${origin}/examples/luxembourg-vector.html`);await page.waitForFunction(()=>window.__luxembourg,null,{timeout:120000});
 const lux=await page.evaluate(async()=>{const {runtime,layers}=window.__luxembourg;const map=await runtime.readVectorPickMap();return {features:layers.snapshot().layers[0].features.length,covered:map.ids.reduce((n,id)=>n+Number(id!==0),0)};});assert.equal(lux.features,2035);assert.ok(lux.covered>1000);
 const luxSelection=await page.evaluate(()=>{const {runtime,layers,terrain}=window.__luxembourg;const before=runtime.getVectorReport(),start=performance.now();layers.setSelection("active",[1,2,3],{outline:true,outlineWidth:32,glow:true,glowRadius:32});runtime.setVectorLayers(layers,terrain);return {ms:performance.now()-start,before,after:runtime.getVectorReport()};});assert.ok(luxSelection.ms<50,JSON.stringify(luxSelection));assert.equal(luxSelection.after.pipelineCreations,luxSelection.before.pipelineCreations);assert.equal(luxSelection.after.vertexBufferCreations,luxSelection.before.vertexBufferCreations);
 await page.goto(`${origin}/examples/vector-picking.html`);await page.waitForFunction(()=>window.__picking);await page.locator("#lasso").click();await page.waitForFunction(()=>window.__picking.layers.getSelection("active")?.ids.length===3);
 assert.deepEqual(errors,[]);assert.ok(requests.some(url=>url.endsWith("forge3d_web_bg.wasm")));assert.ok(requests.every(url=>!url.includes("src-ts/")));
 const evidence={revision,packageSha256:digest,browser:browser.version(),rendering,oit,fallback,styles,drape,lifecycle,wrappers,regressions,autoFallback,luxSelection,luxembourg:lux};
 const results=join(root,"test-results","w12-package");mkdirSync(results,{recursive:true});writeFileSync(join(results,"evidence.json"),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({ok:true,revision,packageSha256:digest,luxembourg:lux,covered:rendering.covered,workerIds:wrappers.ids}));
}finally{
 await browser?.close();if(server)await new Promise(r=>server.close(r));
 // mkdtemp supplies an absolute directory within the OS temporary root.
 assert.ok(resolve(temporary).startsWith(resolve(tmpdir())+"\\")||resolve(temporary).startsWith(resolve(tmpdir())+"/"));
 rmSync(temporary,{recursive:true,force:true});
}
