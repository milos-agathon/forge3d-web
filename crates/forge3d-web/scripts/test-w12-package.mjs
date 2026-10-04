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
import { resolvePackageGateMode } from "./package-gate-mode.mjs";
import { resolveInstalledTarballBrowserProfile } from "./installed-tarball-browser-profile.mjs";

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const evidenceMode=resolvePackageGateMode(process.env.FORGE3D_PACKAGE_GATE_MODE);
const browserProfile=resolveInstalledTarballBrowserProfile({evidenceMode,browserChannel:process.env.FORGE3D_BROWSER_CHANNEL,operatingSystem:process.platform});
function assertVectorOit(report,requested,available,context){
 const optional=requested==="auto"||requested==="dual-source";
 assert.equal(typeof available,"boolean",context);
 assert.equal(report.requestedOit,requested,context);
 assert.equal(report.effectiveOit,optional?(available?"dual-source":"wboit"):requested,context);
 assert.equal(report.fallbackReason,optional&&!available?"dual-source-blending-unavailable":null,context);
}
function assertColorTransfer(r){
 assert.equal(typeof r.available,"boolean");assert.equal(r.opaque.length,24);assert.equal(r.hdr.length,48);
 for(const c of r.opaque){const context=JSON.stringify(c);assert.deepEqual(c.actual,c.expected,context);assert.equal(c.pick,1,context);assert.ok(c.covered>100,context);assertVectorOit(c.report,c.mode,r.available,context);if(c.disjoint)assert.ok(c.disjointCovered>100,context);else assert.equal(c.disjointCovered,0,context);}
 for(const c of r.hdr){const context=JSON.stringify(c);assertVectorOit(c.report,c.mode,r.available,context);assert.ok(c.hdrDelta<=.001,context);assert.ok(c.mappedDelta<=.001,context);assert.ok(c.displayDelta<=1,context);assert.equal(c.postfxReport.outputEncoding,"srgb",context);assert.deepEqual(c.postfxReport.passOrder,["gbuffer:primary","gbuffer:surface","hzb","map:resolve","output:srgb","overlay"],context);}
}
function assertDepthOcclusion(rows,masked=false){
 assert.equal(rows.length,41);
 for(const r of rows){const context=JSON.stringify(r);
  if(r.kind==="arithmetic"){assert.ok(r.gpuCovered>100,context);assert.ok(r.cpuCovered>100,context);assert.ok(r.colorDelta<=1,context);assert.equal(r.idDelta,0,context);assert.equal(r.byteIdentical,true,context);assert.ok(r.vertexCount>1000,context);assert.equal(r.gpuReport.effectiveCulling,"gpu",context);assert.equal(r.cpuReport.effectiveCulling,"cpu",context);continue;}
  assert.ok(r.reference.back>r.reference.front,context);assert.ok(r.reference.separation>2**-24,context);assert.ok(r.reference.separation>.01*1e-5,context);assert.equal(r.reference.coarseFront,r.reference.coarseBack,context);assert.ok(r.reference.coarseBack<r.reference.front,context);assert.equal(r.report.effectiveCulling,r.culling,context);assert.equal(r.byteIdentical,true,context);assert.ok(r.vertexCount>0,context);
  if(r.kind==="terrain"){assert.ok(r.terrainCovered>1000,context);assert.equal(r.red,0,context);assert.equal(r.picked,0,context);assert.equal(r.terrainDelta,0,context);}
  else {if(masked)assert.equal(r.available,false,context);assertVectorOit(r.report,r.mode,r.available,context);assert.ok(r.covered>100,context);assert.equal(r.wrongPick,0,context);assert.equal(r.wrongColor,0,context);assert.equal(r.centerId,1,context);assert.deepEqual(r.centerColor,[255,0,0,255],context);}
 }
}
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
 browser=await chromium.launch({headless:true,...(browserProfile.playwrightChannel?{channel:browserProfile.playwrightChannel}:{}),args:browserProfile.launchArguments});
 const page=await browser.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
 const requests=[];page.on("request",r=>requests.push(r.url()));
 await page.goto(`${origin}/examples/test-w12-vector.html`);await page.waitForFunction(()=>window.__w12Ready);
 const rendering=await page.evaluate(()=>window.__w12Render());
 assert.ok(rendering.covered>300);assert.deepEqual(rendering.ids,[7,12,4294967295]);assert.equal(rendering.alignment,0);assert.ok(rendering.delta<=1);assert.equal(rendering.idDelta,0);assert.equal(rendering.point,4294967295);assert.deepEqual(rendering.lasso,rendering.ids);assert.ok(rendering.highlightDelta>20);assert.ok(rendering.editedIds.includes(4294967295));assert.equal(rendering.cancel,"REQUEST_CANCELLED");assert.equal(rendering.after.gpuBytes,0);assert.equal(rendering.report.effectiveCulling,"gpu");assert.equal(rendering.cpuReport.effectiveCulling,"cpu");
 const oit=await page.evaluate(()=>window.__w12Oit());assert.ok(oit.center[0]+oit.center[2]>30);assert.ok(oit.weightedDelta<=1);assert.ok(oit.standardDelta>20);assert.ok(oit.dualDelta<=1);assertVectorOit(oit.dualReport,"dual-source",oit.available);
 const styles=await page.evaluate(()=>window.__w12Styles());assert.deepEqual(styles.ids,[100,101,102,103,104,105,300,301,302,303,304,305,306,307,308]);assert.ok(styles.aa>30);assert.ok(styles.delta<=1);assert.equal(styles.idDelta,0);
 const drape=await page.evaluate(()=>window.__w12Drape());assert.ok(drape.count>100);assert.ok(drape.minY>.25);assert.ok(drape.maxY>.45);assert.ok(drape.postDelta>10);assert.equal(drape.restoreDelta,0);assert.ok(drape.aovCovered>100);assert.equal(drape.hdrFinite,true);
 const lifecycle=await page.evaluate(()=>window.__w12Lifecycle());assert.equal(lifecycle.recoveryDelta,0);assert.deepEqual(lifecycle.resized,[64,48]);assert.equal(lifecycle.stable,true);assert.equal(lifecycle.budget,"RESOURCE_LIMIT_EXCEEDED");assert.equal(lifecycle.rollback,0);
 const wrappers=await page.evaluate(()=>window.__w12Wrappers());assert.deepEqual(wrappers.ids,[7,12,4294967295]);assert.equal(wrappers.report.featureCount,3);assert.equal(wrappers.offscreenReport.featureCount,3);

 const regressions={};
 regressions.opaque=await page.evaluate(()=>window.__w12Opaque());assert.equal(regressions.opaque.length,4);for(const r of regressions.opaque){assert.deepEqual(r.center,[255,0,0,255]);assert.equal(r.pick,1);assert.ok(r.covered>100);assert.equal(r.mismatch,0);}
 regressions.joins=await page.evaluate(()=>window.__w12JoinGeometry());{const r=regressions.joins;assert.ok(r.covered>500);assert.equal(r.miterMissing,0);assert.equal(r.bevelMissing,0);assert.ok(r.miterExtra>0);assert.equal(r.limitDelta,0);assert.ok(r.capCounts.round>r.capCounts.butt);assert.ok(r.capCounts.square>r.capCounts.round);assert.equal(r.roundMissing,0);assert.equal(r.squareMissing,0);}
 regressions.dualEquation={available:oit.available,outcome:oit.available?"passed":"unsupported"};
 regressions.dual=oit.available?await page.evaluate(()=>window.__w12DualEquation()):[];
 if(oit.available){assert.equal(regressions.dual.length,2);for(const r of regressions.dual){assertVectorOit(r.report,"dual-source",true);assert.ok(r.actual[0]+r.actual[2]>30);assert.ok(r.delta<=1,JSON.stringify(r));}}
 regressions.colorTransfer=await page.evaluate(()=>window.__w12ColorTransfer());assertColorTransfer(regressions.colorTransfer);
 regressions.auto=await page.evaluate(()=>window.__w12Auto());assertVectorOit(regressions.auto.report,"auto",regressions.auto.available);
 regressions.aovs=await page.evaluate(()=>window.__w12Aovs());{const r=regressions.aovs;assert.equal(r.terrainId,1);assert.equal(r.vectorId,0xffffffef);assert.notEqual(r.vectorId,r.terrainId);assert.equal(r.pickId,1);for(let i=0;i<3;i++){assert.ok(Math.abs(r.vectorNormal[i]-[0,1,0][i])<=1e-3);assert.ok(Math.abs(r.vectorNormal[i]-r.terrainNormal[i])<=1e-3);}}
 regressions.jitter=await page.evaluate(()=>window.__w12Jitter());{const r=regressions.jitter;assert.ok(r.covered>100);assert.ok(r.fractional16>20);assert.ok(r.fractional16>r.fractionalOne);assert.equal(r.idDelta,0);}

 regressions.compaction=await page.evaluate(()=>window.__w12Compaction());{const r=regressions.compaction;assert.ok(r.vertexCount>6);assert.equal(r.gpuBytes,r.cpuBytes);assert.equal(r.byteIdentical,true,JSON.stringify(r));assert.equal(r.byteDelta,0);assert.equal(r.triangleCount,200000);assert.ok(r.largeVertexCount>5000);assert.equal(r.largeByteDelta,0);if(evidenceMode==="required")assert.ok(r.gpu.median<=r.cpu.median,JSON.stringify(r));}
 regressions.incremental=await page.evaluate(()=>window.__w12Incremental());{const r=regressions.incremental;assert.ok(r.green>100);assert.equal(r.recomputedFrames,12);if(evidenceMode==="required")assert.ok(r.selected.median<=r.plain.median*2,JSON.stringify(r));assert.equal(r.aboveCap.featureCount,5000);assert.ok(r.before.pipelineCreations>0);assert.ok(r.before.vertexBufferCreations>0);assert.equal(r.after.pipelineCreations,r.before.pipelineCreations);assert.equal(r.after.vertexBufferCreations,r.before.vertexBufferCreations);assert.equal(r.hoverTime.pipelineCreations,r.before.pipelineCreations);assert.equal(r.hoverTime.vertexBufferCreations,r.before.vertexBufferCreations);assert.equal(r.sceneBefore.vertexBufferCreations,r.before.vertexBufferCreations);assert.equal(r.sceneAfter.vertexBufferCreations,r.before.vertexBufferCreations);assert.equal(r.sceneBefore.pipelineCreations,r.before.pipelineCreations);assert.equal(r.sceneAfter.pipelineCreations,r.before.pipelineCreations);}
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
 regressions.depthOcclusion=await page.evaluate(()=>window.__w12DepthOcclusion());assertDepthOcclusion(regressions.depthOcclusion);
 await page.goto(`${origin}/examples/test-w12-vector.html`);await page.waitForFunction(()=>window.__w12Ready);

 await page.addInitScript(()=>{const gpu=navigator.gpu,request=gpu.requestAdapter.bind(gpu);gpu.requestAdapter=async options=>{const adapter=await request(options);if(adapter)Object.defineProperty(adapter,"features",{value:new Set([...adapter.features].filter(f=>f!=="dual-source-blending"))});return adapter;};});
 await page.reload();await page.waitForFunction(()=>window.__w12Ready);const fallback=await page.evaluate(()=>window.__w12Oit());assert.equal(fallback.available,false);assertVectorOit(fallback.dualReport,"dual-source",false);assert.ok(fallback.center[0]+fallback.center[2]>30);assert.ok(fallback.weightedDelta<=1);assert.ok(fallback.standardDelta>20);assert.ok(fallback.dualDelta<=1);const autoFallback=await page.evaluate(()=>window.__w12Auto());assert.equal(autoFallback.available,false);assertVectorOit(autoFallback.report,"auto",false);
 regressions.fallbackColorTransfer=await page.evaluate(()=>window.__w12ColorTransfer());assert.equal(regressions.fallbackColorTransfer.available,false);assertColorTransfer(regressions.fallbackColorTransfer);
 await page.goto(`${origin}/examples/test-w12-camera.html`);await page.waitForFunction(()=>window.__w12CameraReady);
 regressions.fallbackDepthOcclusion=await page.evaluate(()=>window.__w12DepthOcclusion());assertDepthOcclusion(regressions.fallbackDepthOcclusion,true);
 await page.goto(`${origin}/examples/luxembourg-vector.html`);await page.waitForFunction(()=>window.__luxembourg,null,{timeout:120000});
 const lux=await page.evaluate(async()=>{const {runtime,layers}=window.__luxembourg;const map=await runtime.readVectorPickMap();return {features:layers.snapshot().layers[0].features.length,covered:map.ids.reduce((n,id)=>n+Number(id!==0),0)};});assert.equal(lux.features,2035);assert.ok(lux.covered>1000);
 const luxSelection=await page.evaluate(()=>{const {runtime,layers,terrain}=window.__luxembourg;const before=runtime.getVectorReport(),start=performance.now();layers.setSelection("active",[1,2,3],{outline:true,outlineWidth:32,glow:true,glowRadius:32});runtime.setVectorLayers(layers,terrain);return {ms:performance.now()-start,before,after:runtime.getVectorReport()};});if(evidenceMode==="required")assert.ok(luxSelection.ms<50,JSON.stringify(luxSelection));assert.equal(luxSelection.after.pipelineCreations,luxSelection.before.pipelineCreations);assert.equal(luxSelection.after.vertexBufferCreations,luxSelection.before.vertexBufferCreations);
 await page.goto(`${origin}/examples/vector-picking.html`);await page.waitForFunction(()=>window.__picking);await page.locator("#lasso").click();await page.waitForFunction(()=>window.__picking.layers.getSelection("active")?.ids.length===3);
 assert.deepEqual(errors,[]);assert.ok(requests.some(url=>url.endsWith("forge3d_web_bg.wasm")));assert.ok(requests.every(url=>!url.includes("src-ts/")));
 const evidence={revision,packageSha256:digest,evidenceMode,browserProfile,browser:browser.version(),rendering,oit,fallback,styles,drape,lifecycle,wrappers,regressions,autoFallback,luxSelection,luxembourg:lux};
 const results=join(root,"test-results","w12-package");mkdirSync(results,{recursive:true});writeFileSync(join(results,"evidence.json"),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({ok:true,evidenceMode,revision,packageSha256:digest,luxembourg:lux,covered:rendering.covered,workerIds:wrappers.ids}));
}finally{
 await browser?.close();if(server)await new Promise(r=>server.close(r));
 // mkdtemp supplies an absolute directory within the OS temporary root.
 assert.ok(resolve(temporary).startsWith(resolve(tmpdir())+"\\")||resolve(temporary).startsWith(resolve(tmpdir())+"/"));
 rmSync(temporary,{recursive:true,force:true});
}
