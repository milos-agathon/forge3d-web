import assert from "node:assert/strict";
import test from "node:test";

import { validateChr03HardwareProof } from "./chr03-hardware-proof-validator.mjs";
import { validateChr03HardwareProofContract } from "../../scripts/chr03-hardware-proof-validator.mjs";

test("validates exact CHR-03 behavior, lifecycle, and benchmark proof", () => {
  const proof = makeProof();
  assert.equal(validateChr03HardwareProof(proof, proof.binding), proof);
});

test("production entrypoint applies the same strict schema and semantic checks", () => {
  const proof = makeProof();
  proof.systemInfo.available = "false";
  assert.throws(() => validateChr03HardwareProofContract(proof), /expected type boolean/u);
  proof.systemInfo.available = false;
  delete proof.driver.pointerCapture.capturedPointerId;
  assert.throws(() => validateChr03HardwareProofContract(proof), /required property/u);
});

for (const [name, mutate, message] of [
  ["no-op control", (proof) => { proof.behaviors.orbit = false; }, /expected constant true/u],
  ["wrong asset", (proof) => { proof.binding.assetId = "FW-LNX-NV-01"; }, /exact checked hardware/u],
  ["duplicate runtime", (proof) => { proof.lifecycleCycles[1].runtimeIdentity = "runtime-1"; }, /distinct/u],
  ["leaked resource", (proof) => { proof.lifecycleCycles[4].afterDispose.activeObservers = 1; }, /expected constant 0/u],
  ["missing measured frame", (proof) => { proof.benchmark.submittedFramesDelta = 599; }, /submittedFramesDelta|raw workload/u],
  ["skipped frame", (proof) => { proof.benchmark.skippedFramesDelta = 1; }, /skippedFramesDelta|raw workload/u],
  ["malformed raw timing", (proof) => { proof.benchmark.rafTimestampsMs.pop(); }, /601 items|601 RAF timestamps/u],
  ["p95 above threshold", (proof) => {
    proof.benchmark.rafTimestampsMs = timestamps(51);
    updateDerived(proof.benchmark);
  }, /exceeds 50 ms/u],
  ["injected two-owned-RAF observation", (proof) => { proof.benchmark.scheduling.maxOutstandingFrames = 2; }, /scheduler observations/u],
  ["duplicate RAF", (proof) => { proof.benchmark.scheduling.duplicateRafObserved = true; }, /duplicateRafObserved|duplicate RAF/u],
  ["fractional queue sample", (proof) => { proof.benchmark.scheduling.pendingAfterInvalidation = 1.5; }, /expected type integer|scheduler observations/u],
  ["missing scheduler field", (proof) => { delete proof.benchmark.scheduling.observationSamples; }, /required property|scheduler observations/u],
  ["queue not empty", (proof) => { proof.benchmark.scheduling.finalOutstandingFrames = 1; }, /expected constant 0|scheduler observations/u],
  ["wrong canonical hash", (proof) => { proof.benchmark.traceSha256 = "0".repeat(64); }, /traceSha256|canonical FND-07/u],
  ["missing signal provenance", (proof) => { delete proof.benchmark.thermalSignalProvenance; }, /required property|canonical FND-07/u],
  ["wrong pointer identity", (proof) => { proof.driver.pointerCapture.releasedPointerId = 2; }, /driver observations/u],
  ["undocumented keyboard key", (proof) => { proof.driver.keyboard.reset.key = "KeyR"; }, /expected constant "Home"|driver observations/u],
  ["hidden benchmark", (proof) => { proof.benchmark.visibilityStateAfter = "hidden"; }, /hidden, blurred/u],
  ["missing SystemInfo reason", (proof) => { proof.systemInfo.unavailableReason = null; }, /availability is inconsistent/u],
]) {
  test(`rejects ${name}`, () => {
    const proof = makeProof();
    mutate(proof);
    assert.throws(() => validateChr03HardwareProof(proof), message);
  });
}

function timestamps(interval = 16) {
  return Array.from({ length: 601 }, (_, index) => index * interval);
}

function updateDerived(benchmark) {
  benchmark.rafIntervalsMs = benchmark.rafTimestampsMs.slice(1)
    .map((value, index) => value - benchmark.rafTimestampsMs[index]);
  benchmark.measuredDurationMs = benchmark.rafTimestampsMs.at(-1) - benchmark.rafTimestampsMs[0];
  benchmark.framesPerSecond = 600_000 / benchmark.measuredDurationMs;
  benchmark.p95RafIntervalMs = [...benchmark.rafIntervalsMs].sort((a, b) => a - b)[569];
}

function makeProof() {
  const rafTimestampsMs = timestamps();
  const benchmark = {
    id: "forge3d-viewer-benchmark-v1",
    manifestSha256: "17493b8dc4ca3f1c43b7dc9ffbe50400d0980de20d6bb3c6a564f457eb4c6a4f",
    terrainSha256: "f7ac944a3dc3736384f1082bec5f850b45d88c36ca675e9c543d945d8741e5c6",
    traceSha256: "bcef9611960ee1b0f25be529d416135ca65ec2d0571049eca1b282e6e9ad905d",
    canvasCssWidth: 320, canvasCssHeight: 320, backingWidth: 640, backingHeight: 640,
    devicePixelRatio: 2, traceVersion: 1,
    warmupSamples: 120,
    measurementSamples: 600,
    traceSamplesApplied: 600,
    catchUpSamples: 0,
    rafTimestampsMs,
    rafIntervalsMs: [],
    submittedFramesBefore: 10,
    submittedFramesAfter: 610,
    submittedFramesDelta: 600,
    skippedFramesBefore: 0,
    skippedFramesAfter: 0,
    skippedFramesDelta: 0,
    measuredDurationMs: 0,
    framesPerSecond: 0,
    p95RafIntervalMs: 0,
    visibilityStateBefore: "visible",
    visibilityStateAfter: "visible",
    documentHasFocusBefore: true,
    documentHasFocusAfter: true,
    visibilityChangeCount: 0,
    windowBlurCount: 0,
    browserZoomBefore: 1,
    browserZoomAfter: 1,
    viewportScaleBefore: 1,
    viewportScaleAfter: 1,
    thermalStateBefore: "unavailable",
    thermalStateAfter: "unavailable",
    thermalSignalProvenance: "browser API unavailable",
    lowPowerModeBefore: "unavailable",
    lowPowerModeAfter: "unavailable",
    lowPowerSignalProvenance: "browser API unavailable",
    scheduling: {
      observationSamples: 600,
      pendingBeforeInvalidation: 0,
      pendingAfterInvalidation: 600,
      maxOutstandingFrames: 1,
      finalOutstandingFrames: 0,
      duplicateRafObserved: false,
    },
  };
  updateDerived(benchmark);
  return {
    schemaVersion: 1,
    kind: "forge3d-chr03-chrome-hardware-proof-v1",
    binding: {
      lane: "chrome-linux-intel12",
      assetId: "FW-LNX-I12-01",
      commit: "a".repeat(40),
      packageSha256: "b".repeat(64),
    },
    behaviors: Object.fromEntries([
      "orbit", "pan", "wheelZoom", "pointerCapture", "keyboard", "autoResize",
      "visibilityResume", "terrainSource", "screenshot", "disposal",
    ].map((name) => [name, true])),
    driver: {
      orbitChanged: true, panChanged: true, wheelChanged: true,
      pointerCapture: { pointerId: 1, capturedPointerId: 1, releasedPointerId: 1, captured: true, outsideMoveChanged: true, released: true, activePointersAfter: 0 },
      keyboard: { orbit: { key: "ArrowRight", changed: true }, pan: { key: "Shift+ArrowRight", changed: true }, zoomIn: { key: "Equal", changed: true }, zoomOut: { key: "Minus", changed: true }, reset: { key: "Home", changed: true } },
      autoResize: { observerActive: true, dimensionsChanged: true, submittedFrame: true },
    },
    visibility: {
      source: "actual-document", cycleCount: 30, hiddenObserved: true,
      visibleObserved: true, submittedEveryCycle: true,
    },
    terrainSource: {
      api: "setTerrainFromSource", url: "https://assets.example/nonce/cors/allow/terrain.bin",
      crossOrigin: true, width: 512, height: 512, byteLength: 1_048_576,
      progressEvents: [{ loaded: 1_048_576, total: 1_048_576, done: true }], completed: true, submittedFrame: true,
    },
    screenshot: {
      mimeType: "image/png", byteLength: 100, sha256: "c".repeat(64), width: 640, height: 640,
    },
    lifecycleCycles: Array.from({ length: 50 }, (_, index) => ({
      cycle: index + 1, runtimeIdentity: `runtime-${index + 1}`, submittedFrames: 1,
      afterDispose: { ownedListeners: 0, activeObservers: 0, activePointers: 0, activeRuntimes: 0, pendingAnimationFrame: false, ownedAnimationFrameCount: 0 },
    })),
    errors: [], benchmark,
    systemInfo: { available: false, diagnosticOnly: true, value: null, unavailableReason: "CDP unavailable" },
  };
}
