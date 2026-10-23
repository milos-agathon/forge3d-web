import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {installedRun} from "../../scripts/installed-run.mjs";

test("setup, browser spawn and PDF failures finalize distinct failed records",async()=>{
 const root=mkdtempSync(join(tmpdir(),"installed-evidence-")),destination=join(root,"report.json");
 mkdirSync(join(root,"dist"));writeFileSync(join(root,"dist/forge3d_web_bg.wasm"),"wasm");
 const artifact={revision:"revision",packageSha256:"a".repeat(64),tarball:"fixture.tgz",installed:root};
 try {
  const ids=new Set();
  for(const failed of ["setup","browser","pdf-verification"]) {
   await assert.rejects(installedRun({suite:"w20",destination,requiredPhases:["setup","browser","pdf-verification"]},async run=>{
    run.artifact(artifact);
    if(failed==="setup") throw Error("setup failed");
    run.phase("browser");if(failed==="browser") throw Error("spawn failed");
    run.observe({exitCode:0});run.phase("pdf-verification");throw Error("PDF failed");
   }));
   const record=JSON.parse(readFileSync(destination,"utf8"));
   assert.equal(record.status,"failed");assert.equal(record.failure.phase,failed);assert.notEqual(record.exitCode,0);
   assert.equal(record.packageSha256,artifact.packageSha256);assert.match(record.wasmSha256,/^[a-f0-9]{64}$/);
   assert.equal(record.phases.at(-1).status,"failed");ids.add(record.runId);
  }
  assert.equal(ids.size,3);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test("finalization cannot promote missing phases, observations or artifact identity",async()=>{
 const root=mkdtempSync(join(tmpdir(),"incomplete-evidence-")),destination=join(root,"report.json");
 try {
  for(const execute of [async()=>{},async run=>run.observe({exitCode:0}),async run=>{run.phase("browser");run.observe({exitCode:0});}]) {
   await assert.rejects(installedRun({suite:"gate",destination},execute),/Incomplete/);
   assert.equal(JSON.parse(readFileSync(destination,"utf8")).status,"failed");
  }
  mkdirSync(join(root,"dist"));writeFileSync(join(root,"dist/forge3d_web_bg.wasm"),"wasm");
  await installedRun({suite:"gate",destination},async run=>{
   run.artifact({revision:"revision",packageSha256:"a".repeat(64),tarball:"artifact.tgz",installed:root});
   run.phase("browser");run.observe({exitCode:0,proof:{pixels:100}});
  });
  const passed=JSON.parse(readFileSync(destination,"utf8"));assert.equal(passed.status,"passed");assert.equal(passed.observations.proof.pixels,100);
 } finally {rmSync(root,{recursive:true,force:true});}
});
