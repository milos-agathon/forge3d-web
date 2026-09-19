import assert from "node:assert/strict";
import test from "node:test";
import { validateSaf02Conformance } from "../../scripts/saf02-conformance-validator.mjs";
import { comparePixels, withTimeout } from "../browser/saf02-conformance.js";

const commit = "a".repeat(40), packageSha256 = "b".repeat(64), nonce = "c".repeat(32);
const expected = { lane:"safari-macos-m2", assetId:"FW-MAC-M2-01", hostId:"FW-MAC-M2-01", runId:10, jobId:20,
  commit, packageSha256, applicationUrl:`https://mac-m2.webgpu-ci.forge3d.dev/runs/10/20/${nonce}/`,
  assetUrl:`https://assets-mac-m2.webgpu-ci.forge3d.dev/runs/10/20/${nonce}/`, effectiveLaunchArguments:[] };

function proof() {
  return { schemaVersion:1, kind:"forge3d-saf02-conformance-v1",
    binding:{ lane:expected.lane, assetId:expected.assetId, hostId:expected.hostId, runId:10, jobId:20, commit, packageSha256 },
    route:{ applicationOrigin:"https://mac-m2.webgpu-ci.forge3d.dev", assetOrigin:"https://assets-mac-m2.webgpu-ci.forge3d.dev", basePath:`/runs/10/20/${nonce}/`, nonce },
    environment:{secureContext:true,userAgent:"Safari",platform:"MacIntel",effectiveLaunchArguments:[]},
    wasm:{ outcomes:{correctMime:"PASS",allowedCors:"PASS",badMime:"WASM_LOAD_FAILED",deniedCors:"WASM_LOAD_FAILED",wrongOriginCors:"WASM_LOAD_FAILED"},
      retry:{id:"saf02-one",first:"WASM_LOAD_FAILED",second:"PASS",sameRealm:true,identicalUrl:true,observersComplete:true,observed:[],configureCalls:[{format:"bgra8unorm",alphaMode:"opaque"}]} },
    terrain:{outcomes:{sameOriginFull:"PASS",allowedCorsFull:"PASS",nonzero206:"PASS",zeroOffset200:"PASS",nonzero200:"IO_ERROR",range416:"IO_ERROR",corsDeny:"IO_ERROR",corsWrongOrigin:"IO_ERROR"}},
    render:{width:77,height:53,beforeBytes:100,afterBytes:101,beforePngSignature:true,afterPngSignature:true,beforeLumaRange:21,afterLumaRange:22,visiblePixels:4081,comparedPixels:4081,changedPixels:101,cameraChanged:true,submittedFramesBeforeCamera:2,submittedFramesAfterCamera:3,configure:null},
    observers:{installedBeforeInitialization:true,restored:true,windowErrors:[],unhandledRejections:[],consoleFindings:[],deviceUncapturedErrors:[],
      configureCalls:[{format:"bgra8unorm",alphaMode:"opaque"},{format:"bgra8unorm",alphaMode:"premultiplied"}],viewerErrors:[]}, result:"PASS" };
}

test("SAF-02 validator accepts only complete bound proof", () => {
  assert.equal(validateSaf02Conformance(proof(), expected).result, "PASS");
  for (const mutate of [
    value => { delete value.render.changedPixels; },
    value => { value.extra = true; },
    value => { value.binding.packageSha256 = "d".repeat(64); },
    value => { value.route.nonce = "e".repeat(32); },
    value => { value.render.changedPixels = 100; },
    value => { value.wasm.retry.second = "WASM_LOAD_FAILED"; },
    value => { value.observers.deviceUncapturedErrors.push("late validation"); },
    value => { value.observers.configureCalls.pop(); },
    value => { value.observers.installedBeforeInitialization = false; },
    value => { value.observers.restored = false; },
    value => { value.wasm.retry.observersComplete = false; },
    value => { value.render.submittedFramesAfterCamera = value.render.submittedFramesBeforeCamera; },
    value => { value.environment.userAgent = ""; },
    value => { value.environment.effectiveLaunchArguments = ["--ignore-certificate-errors"]; },
  ]) {
    const value = proof(); mutate(value);
    assert.throws(() => validateSaf02Conformance(value, expected));
  }
});

test("SAF-02 validator rejects independently unsafe or mismatched launch evidence and swapped route ids", () => {
  assert.throws(() => validateSaf02Conformance(proof(), {
    ...expected,
    effectiveLaunchArguments: ["--ignore-certificate-errors=value"],
  }), /launch arguments/u);
  const unsafe = proof();
  unsafe.environment.effectiveLaunchArguments = ["--ignore-certificate-errors=value"];
  assert.throws(() => validateSaf02Conformance(unsafe, {
    ...expected,
    effectiveLaunchArguments: ["--ignore-certificate-errors=value"],
  }), /prohibited browser launch arguments/u);
  const compound = proof();
  compound.environment.effectiveLaunchArguments = ["--enable-features=CanvasOopRasterization,WebGPU"];
  assert.throws(() => validateSaf02Conformance(compound, {
    ...expected,
    effectiveLaunchArguments: ["--enable-features=CanvasOopRasterization,WebGPU"],
  }), /prohibited browser launch arguments/u);
  const replay = proof();
  replay.route.basePath = `/runs/999/888/${nonce}/`;
  assert.throws(() => validateSaf02Conformance(replay, expected), /route/u);
});

test("SAF-02 quantitative comparison retains both luma ranges and RGB threshold", () => {
  const before = new Uint8ClampedArray([0, 10, 20, 255, 200, 210, 220, 255]);
  const after = new Uint8ClampedArray([40, 10, 20, 255, 150, 210, 220, 255]);
  assert.deepEqual(comparePixels(before, after), {
    beforeLumaRange: 200,
    afterLumaRange: 170,
    visiblePixels: 2,
    comparedPixels: 2,
    changedPixels: 2,
  });
});

test("SAF-02 whole-page deadline rejects unresolved work", async () => {
  await assert.rejects(withTimeout(new Promise(() => undefined), 1, "SAF-02 test page"), /timed out/u);
});
