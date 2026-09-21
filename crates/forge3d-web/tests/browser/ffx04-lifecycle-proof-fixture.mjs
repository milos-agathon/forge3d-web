export function validFfx04LifecycleProof({
  lane = "firefox-macos-m2",
  assetId = "FW-MAC-M2-01",
  platform = "darwin",
  commit = "a".repeat(40),
  packageSha256 = "b".repeat(64),
  browserVersion = "147.0",
  driverVersion = "geckodriver 0.36.0",
  runId = 10,
  jobId = 20,
} = {}) {
  const diagnostics = (frames) => ({ generation: 1, submittedFrames: frames, skippedFrames: 0,
    activeRuntimes: 1, activeObservers: 1, activePointers: 0, recoveryAttempts: 0,
    pendingAnimationFrame: false, ownedAnimationFrameCount: 0, ownedListeners: 16,
    screenshotInFlight: false });
  const snapshot = (frames) => ({ documentToken: "same-document", sameViewer: true, sameCanvas: true,
    status: "ready", disposed: false, view: { yawDegrees: 0 }, diagnostics: diagnostics(frames), errors: [] });
  const basePath = `/runs/${runId}/${jobId}/${"c".repeat(32)}/`;
  return {
    schemaVersion: 1, task: "FFX-04", binding: { lane, runId, jobId, assetId, platform, commit, packageSha256 },
    route: { viewerUrl: `https://firefox.webgpu-ci.forge3d.dev${basePath}lifecycle-viewer.html`,
      awayUrl: `https://firefox.webgpu-ci.forge3d.dev${basePath}lifecycle-away.html`, basePath },
    browser: { name: "firefox", channel: "release", version: browserVersion },
    driver: { name: "selenium-firefox", version: driverVersion },
    launchObservation: { observed: true, source: `${platform}-live-browser-process`, browserProcessId: 42 },
    sourceContract: "stock-firefox-geckodriver-bfcache-v1", trustedPersistedLifecycle: true,
    cycleCount: 3,
    cycles: [1, 2, 3].map((cycle) => ({ cycle, prepared: { cycle, ...snapshot(cycle - 1) },
      hidden: { trusted: true, persisted: true, ...snapshot(cycle - 1) },
      shown: { trusted: true, persisted: true, ...snapshot(cycle - 1) }, restored: snapshot(cycle) })),
    input: { inputBoundary: "dom-dispatch", before: { yawDegrees: 0 }, after: { yawDegrees: 2 },
      snapshot: { ...snapshot(4), view: { yawDegrees: 2 } } },
    disposed: { ...snapshot(4), status: "disposed", disposed: true, view: { yawDegrees: 2 },
      diagnostics: { ...diagnostics(4), ownedListeners: 0, activeObservers: 0, activeRuntimes: 0 } },
    result: "PASS",
  };
}
