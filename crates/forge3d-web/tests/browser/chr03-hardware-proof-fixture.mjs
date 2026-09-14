export function validChr03HardwareProof({
  lane = "chrome-linux-rtx3070",
  assetId = "FW-LNX-NV-01",
  commit = "a".repeat(40),
  packageSha256 = "b".repeat(64),
} = {}) {
  const rafTimestampsMs = Array.from({ length: 601 }, (_, index) => index * 16);
  const rafIntervalsMs = rafTimestampsMs.slice(1).map((value, index) => value - rafTimestampsMs[index]);
  const benchmark = {
    id: "forge3d-viewer-benchmark-v1",
    manifestSha256: "17493b8dc4ca3f1c43b7dc9ffbe50400d0980de20d6bb3c6a564f457eb4c6a4f",
    terrainSha256: "f7ac944a3dc3736384f1082bec5f850b45d88c36ca675e9c543d945d8741e5c6",
    traceSha256: "bcef9611960ee1b0f25be529d416135ca65ec2d0571049eca1b282e6e9ad905d",
    canvasCssWidth: 320, canvasCssHeight: 320, backingWidth: 640, backingHeight: 640,
    devicePixelRatio: 2, traceVersion: 1, warmupSamples: 120, measurementSamples: 600,
    traceSamplesApplied: 600, catchUpSamples: 0, rafTimestampsMs, rafIntervalsMs,
    submittedFramesBefore: 10, submittedFramesAfter: 610, submittedFramesDelta: 600,
    skippedFramesBefore: 0, skippedFramesAfter: 0, skippedFramesDelta: 0,
    measuredDurationMs: 9600, framesPerSecond: 62.5, p95RafIntervalMs: 16,
    visibilityStateBefore: "visible", visibilityStateAfter: "visible",
    documentHasFocusBefore: true, documentHasFocusAfter: true,
    visibilityChangeCount: 0, windowBlurCount: 0,
    browserZoomBefore: 1, browserZoomAfter: 1, viewportScaleBefore: 1, viewportScaleAfter: 1,
    thermalStateBefore: "unavailable", thermalStateAfter: "unavailable",
    thermalSignalProvenance: "browser API unavailable",
    lowPowerModeBefore: "unavailable", lowPowerModeAfter: "unavailable",
    lowPowerSignalProvenance: "browser API unavailable",
    scheduling: { observationSamples: 600, pendingBeforeInvalidation: 0, pendingAfterInvalidation: 600,
      maxOutstandingFrames: 1, finalOutstandingFrames: 0, duplicateRafObserved: false },
  };
  return {
    schemaVersion: 1, kind: "forge3d-chr03-chrome-hardware-proof-v1",
    binding: { lane, assetId, commit, packageSha256 },
    behaviors: Object.fromEntries(["orbit", "pan", "wheelZoom", "pointerCapture", "keyboard", "autoResize", "visibilityResume", "terrainSource", "screenshot", "disposal"].map((name) => [name, true])),
    driver: {
      orbitChanged: true, panChanged: true, wheelChanged: true,
      pointerCapture: { pointerId: 1, capturedPointerId: 1, releasedPointerId: 1, captured: true, outsideMoveChanged: true, released: true, activePointersAfter: 0 },
      keyboard: { orbit: { key: "ArrowRight", changed: true }, pan: { key: "Shift+ArrowRight", changed: true }, zoomIn: { key: "Equal", changed: true }, zoomOut: { key: "Minus", changed: true }, reset: { key: "Home", changed: true } },
      autoResize: { observerActive: true, dimensionsChanged: true, submittedFrame: true },
    },
    visibility: { source: "actual-document", cycleCount: 30, hiddenObserved: true, visibleObserved: true, submittedEveryCycle: true },
    terrainSource: { api: "setTerrainFromSource", url: "https://assets.example/runs/1/2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cors/allow/terrain.bin", crossOrigin: true, width: 512, height: 512, byteLength: 1_048_576, progressEvents: [{ loaded: 1_048_576, total: 1_048_576, done: true }], completed: true, submittedFrame: true },
    screenshot: { mimeType: "image/png", byteLength: 100, sha256: "c".repeat(64), width: 640, height: 640 },
    lifecycleCycles: Array.from({ length: 50 }, (_, index) => ({ cycle: index + 1, runtimeIdentity: `runtime-${index + 1}`, submittedFrames: 1, afterDispose: { ownedListeners: 0, activeObservers: 0, activePointers: 0, activeRuntimes: 0, pendingAnimationFrame: false, ownedAnimationFrameCount: 0 } })),
    errors: [], benchmark,
    systemInfo: { available: false, diagnosticOnly: true, value: null, unavailableReason: "CDP unavailable" },
  };
}
