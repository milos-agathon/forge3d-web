import { randomUUID, createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Every exit from the callback reaches finalization. A successfully written JSON
// file is not a successful run: phase completion and observations decide status.
export async function installedRun({ suite, destination, requiredPhases = ["setup", "browser"] }, execute) {
  const record = { schemaVersion:1, runId:randomUUID(), suite, startedAt:new Date().toISOString(), status:"running", phases:[], observations:{} };
  mkdirSync(dirname(destination), {recursive:true});
  const save=()=>writeFileSync(destination,JSON.stringify(record,null,2)+"\n");
  let active;
  function phase(name) {
    if(active) {active.status="passed";active.finishedAt=new Date().toISOString();}
    if(record.phases.some(p=>p.name===name)) throw Error(`Repeated installed phase: ${name}`);
    active={name,status:"running",startedAt:new Date().toISOString()};record.phases.push(active);save();
  }
  const run={
    phase,
    artifact(artifact) {
      Object.assign(record,{revision:artifact.revision,packageSha256:artifact.packageSha256,tarball:artifact.tarball,installed:artifact.installed});
      save();
      record.wasmSha256=createHash("sha256").update(readFileSync(join(artifact.installed,"dist/forge3d_web_bg.wasm"))).digest("hex");
      record.wasmRebuilt=true;save();
    },
    observe(observations) {Object.assign(record.observations,observations);save();},
  };
  phase("setup");
  try {
    await execute(run);
    if(active) {active.status="passed";active.finishedAt=new Date().toISOString();}
    if(requiredPhases.some(name=>!record.phases.some(p=>p.name===name&&p.status==="passed"))) throw Error("Incomplete installed phase observations");
    if(record.observations.exitCode!==0 || !record.packageSha256 || !record.wasmSha256) throw Error("Incomplete installed artifact observations");
    record.status="passed";record.exitCode=0;
    return record;
  } catch(error) {
    if(active) {active.status="failed";active.finishedAt=new Date().toISOString();}
    record.status="failed";record.exitCode=record.observations.exitCode || 1;
    record.failure={phase:active?.name??"setup",message:error instanceof Error?error.message:String(error)};
    throw error;
  } finally {
    record.verifiedAt=new Date().toISOString();save();
  }
}
