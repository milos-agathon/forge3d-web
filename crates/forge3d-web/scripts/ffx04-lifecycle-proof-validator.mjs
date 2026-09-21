import { FFX04_LANES, isFfx04Lane } from "./ffx04-lanes.mjs";

export function validateFfx04LifecycleProof(proof, expected) {
  if (!isPlainObject(proof) || !isPlainObject(expected)) fail("proof missing");
  const allowedTop = new Set([
    "schemaVersion", "task", "binding", "route", "browser", "driver",
    "launchObservation", "sourceContract", "trustedPersistedLifecycle",
    "cycleCount", "cycles", "input", "disposed", "result",
  ]);
  if (Object.keys(proof).some((key) => !allowedTop.has(key))) fail("unknown field");
  noUnknown(proof.binding, ["lane", "runId", "jobId", "assetId", "platform", "commit", "packageSha256"], "binding");
  noUnknown(proof.route, ["viewerUrl", "awayUrl", "basePath"], "route");
  noUnknown(proof.browser, ["name", "channel", "version"], "browser");
  noUnknown(proof.driver, ["name", "version"], "driver");
  noUnknown(proof.launchObservation, ["observed", "source", "browserProcessId"], "launch observation");
  if (
    proof.schemaVersion !== 1 || proof.task !== "FFX-04" || proof.result !== "PASS" ||
    proof.sourceContract !== "stock-firefox-geckodriver-bfcache-v1" ||
    proof.trustedPersistedLifecycle !== true || proof.cycleCount !== 3 ||
    !Array.isArray(proof.cycles) || proof.cycles.length !== 3
  ) fail("top-level contract");
  if (!isFfx04Lane(expected.lane)) fail("expected lane");
  const lane = FFX04_LANES[expected.lane];
  for (const key of ["lane", "runId", "jobId", "assetId", "platform", "commit", "packageSha256"]) {
    if (proof.binding?.[key] !== expected[key]) fail(`binding ${key}`);
  }
  if (!positiveInteger(proof.binding.runId) || !positiveInteger(proof.binding.jobId) ||
      expected.assetId !== lane.assetId || expected.platform !== lane.platform) fail("lane identity");
  const viewerUrl = safeUrl(proof.route?.viewerUrl);
  const awayUrl = safeUrl(proof.route?.awayUrl);
  const applicationUrl = safeUrl(expected.applicationUrl);
  const routeMatch = /^\/runs\/([1-9][0-9]*)\/([1-9][0-9]*)\/([0-9a-f]{32})\/$/u.exec(proof.route?.basePath ?? "");
  if (
    viewerUrl.protocol !== "https:" || awayUrl.protocol !== "https:" ||
    viewerUrl.username || viewerUrl.password || awayUrl.username || awayUrl.password ||
    applicationUrl.username || applicationUrl.password ||
    viewerUrl.origin !== awayUrl.origin || viewerUrl.search || viewerUrl.hash ||
    viewerUrl.origin !== applicationUrl.origin || applicationUrl.search || applicationUrl.hash ||
    awayUrl.search || awayUrl.hash ||
    !routeMatch || Number(routeMatch[1]) !== proof.binding.runId ||
    Number(routeMatch[2]) !== proof.binding.jobId ||
    viewerUrl.pathname !== `${proof.route.basePath}lifecycle-viewer.html` ||
    awayUrl.pathname !== `${proof.route.basePath}lifecycle-away.html` ||
    applicationUrl.pathname !== proof.route.basePath
  ) fail("route provenance");
  for (const key of ["name", "channel", "version"]) {
    if (proof.browser?.[key] !== expected.browser?.[key]) fail(`browser ${key}`);
  }
  for (const key of ["name", "version"]) {
    if (proof.driver?.[key] !== expected.driver?.[key]) fail(`driver ${key}`);
  }
  if (
    proof.browser.name !== "firefox" || proof.browser.channel !== "release" ||
    proof.browser.version === "unknown" || proof.driver.name !== "selenium-firefox" ||
    proof.launchObservation?.observed !== true ||
    proof.launchObservation?.source !== `${expected.platform}-live-browser-process` ||
    !Number.isInteger(proof.launchObservation?.browserProcessId) ||
    proof.launchObservation.browserProcessId < 1
  ) fail("live provenance");
  let identity = null;
  let previousRestored = null;
  for (let index = 0; index < proof.cycles.length; index += 1) {
    const cycle = proof.cycles[index];
    noUnknown(cycle, ["cycle", "prepared", "hidden", "shown", "restored"], "cycle");
    noUnknown(cycle.prepared, [...snapshotKeys, "cycle"], "prepared snapshot");
    noUnknown(cycle.hidden, [...snapshotKeys, "trusted", "persisted"], "hidden transition");
    noUnknown(cycle.shown, [...snapshotKeys, "trusted", "persisted"], "shown transition");
    noUnknown(cycle.restored, snapshotKeys, "restored snapshot");
    if (cycle.cycle !== index + 1 || cycle.prepared?.cycle !== index + 1) fail("cycle number");
    for (const transition of [cycle.hidden, cycle.shown]) {
      if (transition?.trusted !== true || transition?.persisted !== true) fail("trusted persisted transition");
    }
    const prepared = cycle.prepared;
    const restored = cycle.restored;
    const stages = [prepared, cycle.hidden, cycle.shown, restored];
    for (const snapshot of stages) assertHealthySnapshot(snapshot);
    const stageIdentity = identityOf(prepared);
    identity ??= stageIdentity;
    if (!sameValue(stageIdentity, identity) || stages.some((stage) => !sameValue(identityOf(stage), identity))) {
      fail("identity stability");
    }
    if (stages.some((stage) => !sameValue(stage.view, prepared.view))) fail("view continuity");
    if (!(
      cycle.shown.diagnostics.pendingAnimationFrame === false &&
      cycle.shown.diagnostics.ownedAnimationFrameCount === 0
    ) && !(
      cycle.shown.diagnostics.pendingAnimationFrame === true &&
      cycle.shown.diagnostics.ownedAnimationFrameCount === 1
    )) fail("shown RAF ownership");
    if (
      prepared.diagnostics.pendingAnimationFrame !== false || prepared.diagnostics.ownedAnimationFrameCount !== 0 ||
      cycle.hidden?.diagnostics.pendingAnimationFrame !== false ||
      cycle.hidden?.diagnostics.ownedAnimationFrameCount !== 0 ||
      restored.diagnostics.pendingAnimationFrame !== false || restored.diagnostics.ownedAnimationFrameCount !== 0 ||
      cycle.hidden.diagnostics.submittedFrames !== prepared.diagnostics.submittedFrames ||
      cycle.shown.diagnostics.submittedFrames !== prepared.diagnostics.submittedFrames ||
      cycle.hidden.diagnostics.skippedFrames !== prepared.diagnostics.skippedFrames ||
      cycle.shown.diagnostics.skippedFrames !== prepared.diagnostics.skippedFrames ||
      restored.diagnostics.submittedFrames !== cycle.hidden.diagnostics.submittedFrames + 1 ||
      restored.diagnostics.skippedFrames !== cycle.hidden.diagnostics.skippedFrames
    ) fail("resume frame count");
    if (previousRestored && (!sameValue(prepared.view, previousRestored.view) ||
        prepared.diagnostics.submittedFrames !== previousRestored.diagnostics.submittedFrames ||
        prepared.diagnostics.skippedFrames !== previousRestored.diagnostics.skippedFrames)) fail("cycle continuity");
    previousRestored = restored;
  }
  noUnknown(proof.input, ["inputBoundary", "before", "after", "snapshot"], "input");
  noUnknown(proof.input.snapshot, snapshotKeys, "input snapshot");
  assertHealthySnapshot(proof.input.snapshot);
  if (proof.input?.inputBoundary !== "dom-dispatch" ||
      proof.input.snapshot.diagnostics.pendingAnimationFrame !== false ||
      proof.input.snapshot.diagnostics.ownedAnimationFrameCount !== 0 ||
      !sameValue(proof.input.before, previousRestored.view) || sameValue(proof.input.before, proof.input.after) ||
      !sameValue(proof.input.after, proof.input.snapshot.view) || !sameValue(identityOf(proof.input.snapshot), identity) ||
      proof.input.snapshot.diagnostics.submittedFrames !== previousRestored.diagnostics.submittedFrames + 1 ||
      proof.input.snapshot.diagnostics.skippedFrames !== previousRestored.diagnostics.skippedFrames) fail("post-restore input");
  const final = proof.disposed;
  noUnknown(final, snapshotKeys, "disposed snapshot");
  assertTypedSnapshot(final);
  if (
    final?.status !== "disposed" || final?.disposed !== true ||
    final?.sameViewer !== true || final?.sameCanvas !== true ||
    final.documentToken !== identity.token || final.diagnostics.generation !== identity.generation ||
    !sameValue(final.view, proof.input.after) ||
    final.errors.length !== 0 ||
    final.diagnostics.recoveryAttempts !== 0 ||
    final.diagnostics.screenshotInFlight !== false ||
    final.diagnostics.submittedFrames !== proof.input.snapshot.diagnostics.submittedFrames ||
    final.diagnostics.skippedFrames !== proof.input.snapshot.diagnostics.skippedFrames ||
    final?.diagnostics?.ownedListeners !== 0 || final?.diagnostics?.activeObservers !== 0 ||
    final?.diagnostics?.activePointers !== 0 || final?.diagnostics?.activeRuntimes !== 0 ||
    final?.diagnostics?.pendingAnimationFrame !== false || final?.diagnostics?.ownedAnimationFrameCount !== 0
  ) fail("final cleanup");
  return proof;
}

function assertHealthySnapshot(snapshot) {
  assertTypedSnapshot(snapshot);
  if (snapshot.status !== "ready" || snapshot.disposed !== false || snapshot.sameViewer !== true || snapshot.sameCanvas !== true ||
      snapshot.diagnostics.activeRuntimes !== 1 || snapshot.diagnostics.activeObservers !== 1 ||
      snapshot.diagnostics.activePointers !== 0 || snapshot.diagnostics.recoveryAttempts !== 0 ||
      snapshot.diagnostics.ownedListeners < 1 || snapshot.diagnostics.screenshotInFlight !== false ||
      snapshot.errors.length !== 0) fail("healthy snapshot");
}
function assertTypedSnapshot(snapshot) {
  const diagnostics = snapshot?.diagnostics;
  if (typeof snapshot?.documentToken !== "string" || snapshot.documentToken.length < 1 ||
      typeof snapshot?.sameViewer !== "boolean" || typeof snapshot?.sameCanvas !== "boolean" ||
      !isPlainObject(snapshot?.view) || !isPlainObject(diagnostics) || !Array.isArray(snapshot?.errors) ||
      !positiveInteger(diagnostics.generation) || !nonnegativeInteger(diagnostics.ownedListeners) ||
      !nonnegativeInteger(diagnostics.submittedFrames) || !nonnegativeInteger(diagnostics.skippedFrames) ||
      !nonnegativeInteger(diagnostics.activeRuntimes) || !nonnegativeInteger(diagnostics.activeObservers) ||
      !nonnegativeInteger(diagnostics.activePointers) || !nonnegativeInteger(diagnostics.recoveryAttempts) ||
      typeof diagnostics.pendingAnimationFrame !== "boolean" ||
      typeof diagnostics.screenshotInFlight !== "boolean" ||
      !nonnegativeInteger(diagnostics.ownedAnimationFrameCount)) fail("typed snapshot");
}
function identityOf(snapshot) { return { token: snapshot.documentToken, generation: snapshot.diagnostics.generation, listeners: snapshot.diagnostics.ownedListeners }; }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function sameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function isPlainObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeUrl(value) { try { return new URL(value); } catch { fail("route URL"); } }
const snapshotKeys = ["documentToken", "sameViewer", "sameCanvas", "status", "disposed", "view", "diagnostics", "errors"];
function noUnknown(value, allowed, label) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(`unknown ${label} field`);
}
function fail(reason) { throw new Error(`FFX04_LIFECYCLE_PROOF_INVALID ${reason}`); }
