import assert from "node:assert/strict";
import test from "node:test";

import { validateFfx04LifecycleProof } from "../../scripts/ffx04-lifecycle-proof-validator.mjs";

const expected = {
  lane: "firefox-macos-m2",
  runId: 1,
  jobId: 2,
  assetId: "FW-MAC-M2-01",
  platform: "darwin",
  commit: "a".repeat(40),
  packageSha256: "b".repeat(64),
  browser: { name: "firefox", channel: "release", version: "147.0" },
  driver: { name: "selenium-firefox", version: "0.36.0" },
  applicationUrl: `https://mac.webgpu-ci.forge3d.dev/runs/1/2/${"c".repeat(32)}/`,
};

test("FFX-04 validator accepts only the closed three-cycle Firefox proof", () => {
  const proof = validProof();
  assert.equal(validateFfx04LifecycleProof(proof, expected), proof);
  const scheduledAtPageshow = validProof();
  scheduledAtPageshow.cycles[0].shown.diagnostics.pendingAnimationFrame = true;
  scheduledAtPageshow.cycles[0].shown.diagnostics.ownedAnimationFrameCount = 1;
  assert.equal(validateFfx04LifecycleProof(scheduledAtPageshow, expected), scheduledAtPageshow);
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.binding.commit = "c".repeat(40); },
    (value) => { value.binding.runId = 0; },
    (value) => { value.binding.jobId = 3; },
    (value) => { value.route.viewerUrl = value.route.viewerUrl.replace("https://", "https://user:pass@"); },
    (value) => { value.route.viewerUrl += "?credential=no"; },
    (value) => { value.route.awayUrl += "#fragment"; },
    (value) => { value.cycles[0].restored.extra = true; },
    (value) => { delete value.cycles[0].prepared.sameViewer; },
    (value) => { value.cycles[0].prepared.sameViewer = 1; },
    (value) => { value.cycles[0].prepared.sameViewer = false; },
    (value) => { delete value.cycles[0].prepared.sameCanvas; },
    (value) => { value.cycles[0].prepared.sameCanvas = "true"; },
    (value) => { value.cycles[0].prepared.sameCanvas = false; },
    (value) => { value.browser.version = "unknown"; },
    (value) => { value.driver.version = ""; },
    (value) => { value.launchObservation.observed = false; },
    (value) => { value.cycleCount = 2; },
    (value) => { value.cycles.pop(); },
    (value) => { value.cycles[0].hidden.trusted = false; },
    (value) => { value.cycles[0].shown.persisted = false; },
    (value) => { value.cycles[1].restored.documentToken = "new-document"; },
    (value) => { value.cycles[1].restored.diagnostics.generation = 2; },
    (value) => { value.cycles[1].restored.diagnostics.activeRuntimes = 2; },
    (value) => { value.cycles[1].restored.diagnostics.ownedListeners += 1; },
    (value) => { value.cycles[0].prepared.diagnostics.ownedListeners = 0; },
    (value) => { value.cycles[1].restored.diagnostics.recoveryAttempts = 1; },
    (value) => { value.cycles[1].restored.diagnostics.submittedFrames += 1; },
    (value) => { value.cycles[0].hidden.documentToken = 3; },
    (value) => { value.cycles[0].shown.view.yawDegrees = 1; },
    (value) => { value.cycles[0].shown.diagnostics.ownedAnimationFrameCount = 2; },
    (value) => { value.cycles[0].shown.diagnostics.ownedAnimationFrameCount = 1; },
    (value) => { value.cycles[0].shown.diagnostics.pendingAnimationFrame = true; },
    (value) => { value.cycles[1].prepared.diagnostics.skippedFrames += 1; },
    (value) => { value.input.snapshot.diagnostics.skippedFrames += 1; },
    (value) => { value.input.snapshot.errors.push("boom"); },
    (value) => { delete value.input.snapshot.diagnostics.screenshotInFlight; },
    (value) => { value.input.snapshot.diagnostics.screenshotInFlight = "false"; },
    (value) => { value.input.snapshot.diagnostics.screenshotInFlight = true; },
    (value) => { value.input.after = structuredClone(value.input.before); },
    (value) => { value.disposed.view.yawDegrees = 3; },
    (value) => { value.disposed.errors.push("boom"); },
    (value) => { value.disposed.diagnostics.recoveryAttempts = 1; },
    (value) => { delete value.disposed.diagnostics.screenshotInFlight; },
    (value) => { value.disposed.diagnostics.screenshotInFlight = 0; },
    (value) => { value.disposed.diagnostics.screenshotInFlight = true; },
    (value) => { value.disposed.diagnostics.activeObservers = 1; },
  ]) {
    const invalid = validProof();
    mutate(invalid);
    assert.throws(
      () => validateFfx04LifecycleProof(invalid, expected),
      /FFX04_LIFECYCLE_PROOF_INVALID/u,
    );
  }
});

function validProof() {
  const diagnostics = (frames) => ({
    generation: 1,
    submittedFrames: frames,
    skippedFrames: 0,
    activeRuntimes: 1,
    activeObservers: 1,
    activePointers: 0,
    recoveryAttempts: 0,
    pendingAnimationFrame: false,
    ownedAnimationFrameCount: 0,
    ownedListeners: 16,
    screenshotInFlight: false,
  });
  const snapshot = (frames) => ({
    documentToken: "same-document",
    sameViewer: true,
    sameCanvas: true,
    status: "ready",
    disposed: false,
    view: { yawDegrees: 0 },
    diagnostics: diagnostics(frames),
    errors: [],
  });
  return {
    schemaVersion: 1,
    task: "FFX-04",
    binding: {
      lane: expected.lane,
      runId: expected.runId,
      jobId: expected.jobId,
      assetId: expected.assetId,
      platform: expected.platform,
      commit: expected.commit,
      packageSha256: expected.packageSha256,
    },
    route: {
      viewerUrl: `https://mac.webgpu-ci.forge3d.dev/runs/1/2/${"c".repeat(32)}/lifecycle-viewer.html`,
      awayUrl: `https://mac.webgpu-ci.forge3d.dev/runs/1/2/${"c".repeat(32)}/lifecycle-away.html`,
      basePath: `/runs/1/2/${"c".repeat(32)}/`,
    },
    browser: { ...expected.browser },
    driver: { ...expected.driver },
    launchObservation: {
      observed: true,
      source: "darwin-live-browser-process",
      browserProcessId: 42,
    },
    sourceContract: "stock-firefox-geckodriver-bfcache-v1",
    trustedPersistedLifecycle: true,
    cycleCount: 3,
    cycles: [1, 2, 3].map((cycle) => ({
      cycle,
      prepared: { cycle, ...snapshot(cycle - 1) },
      hidden: {
        trusted: true,
        persisted: true,
        ...snapshot(cycle - 1),
      },
      shown: {
        trusted: true,
        persisted: true,
        ...snapshot(cycle - 1),
      },
      restored: snapshot(cycle),
    })),
    input: {
      inputBoundary: "dom-dispatch",
      before: { yawDegrees: 0 },
      after: { yawDegrees: 2 },
      snapshot: { ...snapshot(4), view: { yawDegrees: 2 } },
    },
    disposed: {
      documentToken: "same-document",
      sameViewer: true,
      sameCanvas: true,
      status: "disposed",
      disposed: true,
      view: { yawDegrees: 2 },
      errors: [],
      diagnostics: {
        ...diagnostics(4),
        ownedListeners: 0,
        activeObservers: 0,
        activeRuntimes: 0,
      },
    },
    result: "PASS",
  };
}
