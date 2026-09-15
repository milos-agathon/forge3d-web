import { existsSync, readFileSync } from "node:fs";

import { CHR03_LANES } from "./chr03-lanes.mjs";
import { assertJsonSchema } from "./json-schema-validator.mjs";

const sourceSchema = new URL("../tests/browser/chr03-hardware-proof.schema.json", import.meta.url);
const packagedSchema = new URL("./chr03-hardware-proof.schema.json", import.meta.url);
const proofSchema = JSON.parse(readFileSync(existsSync(packagedSchema) ? packagedSchema : sourceSchema, "utf8"));

const benchmarkConstants = Object.freeze({
  id: "forge3d-viewer-benchmark-v1",
  manifestSha256: "17493b8dc4ca3f1c43b7dc9ffbe50400d0980de20d6bb3c6a564f457eb4c6a4f",
  terrainSha256: "f7ac944a3dc3736384f1082bec5f850b45d88c36ca675e9c543d945d8741e5c6",
  traceSha256: "bcef9611960ee1b0f25be529d416135ca65ec2d0571049eca1b282e6e9ad905d",
  canvasCssWidth: 320, canvasCssHeight: 320, backingWidth: 640, backingHeight: 640,
  devicePixelRatio: 2, traceVersion: 1, warmupSamples: 120, measurementSamples: 600,
  traceSamplesApplied: 600, catchUpSamples: 0, submittedFramesDelta: 600, skippedFramesDelta: 0,
});
const benchmarkFields = Object.freeze([
  ...Object.keys(benchmarkConstants), "browserZoomBefore", "browserZoomAfter", "viewportScaleBefore",
  "viewportScaleAfter", "visibilityStateBefore", "visibilityStateAfter", "documentHasFocusBefore",
  "documentHasFocusAfter", "visibilityChangeCount", "windowBlurCount", "thermalStateBefore",
  "thermalStateAfter", "thermalSignalProvenance", "lowPowerModeBefore", "lowPowerModeAfter",
  "lowPowerSignalProvenance", "rafTimestampsMs", "rafIntervalsMs", "submittedFramesBefore",
  "submittedFramesAfter", "skippedFramesBefore", "skippedFramesAfter", "measuredDurationMs",
  "framesPerSecond", "p95RafIntervalMs", "scheduling",
]);

export function validateChr03HardwareProofContract(proof, expectedBinding = null) {
  assertJsonSchema(proof, proofSchema);
  if (proof?.schemaVersion !== 1 || proof.kind !== "forge3d-chr03-chrome-hardware-proof-v1" ||
      CHR03_LANES[proof.binding?.lane] !== proof.binding?.assetId) {
    throw new Error("CHR-03 lane does not match its exact checked hardware asset");
  }
  if (expectedBinding !== null) {
    for (const name of ["lane", "assetId", "commit", "packageSha256"]) {
      if (proof.binding[name] !== expectedBinding[name]) throw new Error(`CHR-03 proof ${name} does not match the authorized binding`);
    }
  }
  return validateHardwareProofPayload(proof);
}

export function validateHardwareProofPayload(proof) {
  const requiredBehaviors = ["orbit", "pan", "wheelZoom", "pointerCapture", "keyboard", "autoResize", "visibilityResume", "terrainSource", "screenshot", "disposal"];
  if (requiredBehaviors.some((name) => proof.behaviors?.[name] !== true)) throw new Error("CHR-03 named behavior proof is incomplete");
  const driver = proof.driver;
  if (!driver?.orbitChanged || !driver.panChanged || !driver.wheelChanged ||
      !driver.pointerCapture?.captured || !driver.pointerCapture.outsideMoveChanged ||
      !driver.pointerCapture.released || driver.pointerCapture.activePointersAfter !== 0 ||
      driver.pointerCapture.pointerId !== driver.pointerCapture.capturedPointerId ||
      driver.pointerCapture.pointerId !== driver.pointerCapture.releasedPointerId ||
      !keyboardEvidenceIsExact(driver.keyboard) ||
      Object.keys(driver.autoResize ?? {}).length !== 3 || Object.values(driver.autoResize).some((value) => value !== true)) {
    throw new Error("CHR-03 native driver observations are incomplete");
  }
  if (proof.visibility?.source !== "actual-document" || proof.visibility.cycleCount !== 30 ||
      !proof.visibility.hiddenObserved || !proof.visibility.visibleObserved || !proof.visibility.submittedEveryCycle) {
    throw new Error("CHR-03 actual visibility/resume proof is incomplete");
  }
  if (proof.terrainSource?.api !== "setTerrainFromSource" || proof.terrainSource?.crossOrigin !== true || proof.terrainSource.width !== 512 ||
      proof.terrainSource.height !== 512 || proof.terrainSource.byteLength !== 1_048_576 ||
      proof.terrainSource.completed !== true || proof.terrainSource.submittedFrame !== true ||
      !String(proof.terrainSource.url).startsWith("https://") || !validProgress(proof.terrainSource.progressEvents)) {
    throw new Error("CHR-03 terrain source proof is incomplete");
  }
  if (proof.screenshot?.mimeType !== "image/png" || !Number.isInteger(proof.screenshot.byteLength) ||
      proof.screenshot.byteLength < 1 || !/^[0-9a-f]{64}$/u.test(proof.screenshot.sha256 ?? "") ||
      !Number.isInteger(proof.screenshot.width) || proof.screenshot.width < 1 ||
      !Number.isInteger(proof.screenshot.height) || proof.screenshot.height < 1) {
    throw new Error("CHR-03 PNG screenshot proof is incomplete");
  }
  if (!Array.isArray(proof.lifecycleCycles) || proof.lifecycleCycles.length !== 50) throw new Error("CHR-03 requires exactly 50 lifecycle cycles");
  const identities = new Set();
  proof.lifecycleCycles.forEach((cycle, index) => {
    if (cycle.cycle !== index + 1 || !Number.isInteger(cycle.submittedFrames) || cycle.submittedFrames < 1) throw new Error("CHR-03 lifecycle cycles must be ordered and rendered");
    if (typeof cycle.runtimeIdentity !== "string" || identities.has(cycle.runtimeIdentity)) throw new Error("CHR-03 lifecycle runtime identities must be distinct");
    identities.add(cycle.runtimeIdentity);
    const after = cycle.afterDispose;
    if (after?.ownedListeners !== 0 || after.activeObservers !== 0 || after.activePointers !== 0 || after.activeRuntimes !== 0 || after.pendingAnimationFrame !== false || after.ownedAnimationFrameCount !== 0) throw new Error("CHR-03 lifecycle cycle leaked owned resources");
  });
  if (!Array.isArray(proof.errors) || proof.errors.length !== 0) throw new Error("CHR-03 proof contains browser or WebGPU errors");
  validateBenchmark(proof.benchmark);
  if (proof.systemInfo?.diagnosticOnly !== true ||
      (proof.systemInfo.available === true && proof.systemInfo.value === null) ||
      (proof.systemInfo.available === false && !proof.systemInfo.unavailableReason)) {
    throw new Error("CHR-03 SystemInfo diagnostic availability is inconsistent");
  }
  return proof;
}

function validateBenchmark(benchmark) {
  if (!benchmark || Object.keys(benchmark).length !== benchmarkFields.length ||
      benchmarkFields.some((field) => !Object.hasOwn(benchmark, field)) ||
      Object.entries(benchmarkConstants).some(([field, value]) => benchmark[field] !== value)) {
    throw new Error("CHR-03 benchmark does not match the complete canonical FND-07 identity");
  }
  if (![benchmark.submittedFramesBefore, benchmark.submittedFramesAfter, benchmark.skippedFramesBefore,
    benchmark.skippedFramesAfter, benchmark.visibilityChangeCount, benchmark.windowBlurCount].every(Number.isInteger) ||
    typeof benchmark.thermalSignalProvenance !== "string" || benchmark.thermalSignalProvenance.length === 0 ||
    typeof benchmark.lowPowerSignalProvenance !== "string" || benchmark.lowPowerSignalProvenance.length === 0) {
    throw new Error("CHR-03 benchmark counters and signal provenance must be observed and complete");
  }
  if (!Array.isArray(benchmark?.rafTimestampsMs) || benchmark.rafTimestampsMs.length !== 601) throw new Error("benchmark requires exactly 601 RAF timestamps");
  const intervals = benchmark.rafTimestampsMs.slice(1).map((value, index) => {
    const previous = benchmark.rafTimestampsMs[index];
    if (!Number.isFinite(value) || !Number.isFinite(previous) || value < previous) throw new Error("RAF timestamps must be finite and monotonic");
    return value - previous;
  });
  const duration = benchmark.rafTimestampsMs[600] - benchmark.rafTimestampsMs[0];
  const p95 = [...intervals].sort((a, b) => a - b)[569];
  const fps = benchmark.submittedFramesDelta * 1000 / duration;
  const close = (left, right) => Number.isFinite(left) && Math.abs(left - right) <= 0.000001;
  if (benchmark.id !== "forge3d-viewer-benchmark-v1" || benchmark.warmupSamples !== 120 ||
      benchmark.measurementSamples !== 600 || benchmark.traceSamplesApplied !== 600 || benchmark.catchUpSamples !== 0 ||
      !Array.isArray(benchmark.rafIntervalsMs) || benchmark.rafIntervalsMs.length !== 600 ||
      !benchmark.rafIntervalsMs.every((value, index) => close(value, intervals[index])) ||
      benchmark.submittedFramesAfter - benchmark.submittedFramesBefore !== 600 || benchmark.submittedFramesDelta !== 600 ||
      benchmark.skippedFramesAfter - benchmark.skippedFramesBefore !== 0 || benchmark.skippedFramesDelta !== 0 ||
      !close(benchmark.measuredDurationMs, duration) || !close(benchmark.framesPerSecond, fps) ||
      !close(benchmark.p95RafIntervalMs, p95)) throw new Error("CHR-03 benchmark raw workload or derived timing is incomplete");
  if (benchmark.visibilityStateBefore !== "visible" || benchmark.visibilityStateAfter !== "visible" ||
      !benchmark.documentHasFocusBefore || !benchmark.documentHasFocusAfter || benchmark.visibilityChangeCount !== 0 ||
      benchmark.windowBlurCount !== 0 || benchmark.browserZoomBefore !== 1 || benchmark.browserZoomAfter !== 1 ||
      benchmark.viewportScaleBefore !== 1 || benchmark.viewportScaleAfter !== 1) throw new Error("CHR-03 benchmark was hidden, blurred, zoomed, or throttled");
  if ([benchmark.thermalStateBefore, benchmark.thermalStateAfter].some((value) => ["serious", "critical"].includes(value)) ||
      [benchmark.lowPowerModeBefore, benchmark.lowPowerModeAfter].includes(true)) throw new Error("CHR-03 benchmark observed throttling");
  if (p95 > 50) throw new Error("CHR-03 benchmark p95 RAF interval exceeds 50 ms");
  const scheduling = benchmark.scheduling;
  const schedulingFields = ["observationSamples", "pendingBeforeInvalidation", "pendingAfterInvalidation",
    "maxOutstandingFrames", "finalOutstandingFrames", "duplicateRafObserved"];
  if (!scheduling || Object.keys(scheduling).length !== schedulingFields.length ||
      schedulingFields.some((field) => !Object.hasOwn(scheduling, field)) ||
      !schedulingFields.slice(0, 5).every((field) => Number.isInteger(scheduling[field])) ||
      scheduling.observationSamples !== 600 || scheduling.pendingBeforeInvalidation < 0 ||
      scheduling.pendingAfterInvalidation < 0 || scheduling.maxOutstandingFrames < 0 ||
      scheduling.maxOutstandingFrames > 1 || scheduling.finalOutstandingFrames !== 0 ||
      scheduling.duplicateRafObserved !== false) throw new Error("CHR-03 benchmark scheduler observations are invalid or contain duplicate RAF ownership");
}

function keyboardEvidenceIsExact(keyboard) {
  const expected = { orbit: "ArrowRight", pan: "Shift+ArrowRight", zoomIn: "Equal", zoomOut: "Minus", reset: "Home" };
  return keyboard && Object.keys(keyboard).length === 5 && Object.entries(expected).every(
    ([action, key]) => keyboard[action]?.key === key && keyboard[action]?.changed === true && Object.keys(keyboard[action]).length === 2,
  );
}

function validProgress(events) {
  return Array.isArray(events) && events.length > 0 && events.every((event) =>
    Number.isInteger(event.loaded) && Number.isInteger(event.total) && event.loaded >= 0 && event.total === 1_048_576 &&
    event.loaded <= event.total && typeof event.done === "boolean") &&
    events.at(-1).loaded === 1_048_576 && events.at(-1).done === true;
}
