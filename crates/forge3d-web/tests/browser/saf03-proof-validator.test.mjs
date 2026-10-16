import assert from "node:assert/strict";
import test from "node:test";

import { validateSaf03SafariProof, validateSaf03TechnologyPreviewResult } from "../../scripts/saf03-proof-validator.mjs";
import { validAbsentStpResult, validSaf03Proof, validStpResult } from "./saf03-proof-fixture.mjs";

const inventory = {
  browsers: [{ id: "safari-technology-preview", channel: "technology-preview", classification: "probe", automation: "safaridriver", version: "26.1", executable: "/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview" }],
  tools: { safariTechnologyPreviewDriverPath: "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver", safariTechnologyPreviewDriverVersion: "26.1" },
};

test("SAF-03 validates the complete stable Safari proof and separate STP result", () => {
  assert.equal(validateSaf03SafariProof(validSaf03Proof()).schemaVersion, 1);
  assert.equal(validateSaf03TechnologyPreviewResult(validStpResult(inventory), inventory).result, "PASS");
});

test("SAF-03 records optional STP absence without fabricating a session cleanup", () => {
  const absentInventory = { browsers: [], tools: {
    safariTechnologyPreviewDriverPath: false,
    safariTechnologyPreviewDriverVersion: false,
  } };
  assert.equal(validateSaf03TechnologyPreviewResult(validAbsentStpResult(), absentInventory).result, "ABSENT");
  for (const mutate of [
    (result) => { result.cleanup.notStarted = false; },
    (result) => { result.cleanup.sessionDeleted = true; },
    (result) => { result.driverVersion = "fabricated"; },
    (result) => { result.probe = { submittedFrames: 1 }; },
  ]) {
    const result = validAbsentStpResult();
    mutate(result);
    assert.throws(() => validateSaf03TechnologyPreviewResult(result, absentInventory));
  }
});

test("SAF-03 rejects every binding, action, screenshot, lifecycle, benchmark, and cleanup edge", () => {
  const mutations = [
    (p) => { p.kind = "legacy-safari-smoke"; },
    (p) => { p.binding.commit = "f".repeat(40); },
    (p) => { p.browser.channel = "technology-preview"; },
    (p) => { p.driver.clientVersion = "4.34.0"; },
    (p) => { p.system.architecture = "x64"; },
    (p) => { p.system.osVersion = "25.6"; },
    (p) => { p.secureContext = false; },
    (p) => { p.adapter.isFallbackAdapter = true; },
    (p) => { p.actions.orbit.after = structuredClone(p.actions.orbit.before); },
    (p) => { p.actions.pan.after.submittedFrames = p.actions.pan.before.submittedFrames; },
    (p) => { p.actions.wheelZoom.after.pixels.terrainPixelCount = 0; },
    (p) => { p.actions.orbit.after.pixels.sha256 = p.actions.orbit.before.pixels.sha256; },
    (p) => { p.actions.reset.after.view.near += 1e-8; },
    (p) => { p.actions.reset.after.pixels.sha256 = p.actions.reset.before.pixels.sha256; },
    (p) => { p.actions.resize.fixtureControl = "script"; },
    (p) => { p.actions.resize.pixelsAfter.sha256 = p.actions.resize.pixelsBefore.sha256; },
    (p) => { p.screenshots.native.pixels.decoded = false; },
    (p) => { p.screenshots.viewer.sha256 = "bad"; },
    (p) => { p.visibilityCycles.pop(); },
    (p) => { p.visibilityCycles[4].cycle = 4; },
    (p) => { p.visibilityCycles[3].viewerIdentityAfter = "replaced"; },
    (p) => { p.visibilityCycles[2].visibleEvent.sequence = p.visibilityCycles[1].visibleEvent.sequence; },
    (p) => { [p.visibilityCycles[0].hiddenEvent.sequence, p.visibilityCycles[0].visibleEvent.sequence] = [p.visibilityCycles[0].visibleEvent.sequence, p.visibilityCycles[0].hiddenEvent.sequence]; },
    (p) => { p.visibilityCycles[0].visibleEvent.sequence = p.visibilityCycles[0].hiddenEvent.sequence; },
    (p) => { for (const cycle of p.visibilityCycles) { cycle.submittedFramesBefore = 1; cycle.submittedFramesAfter = 2; } },
    (p) => { p.visibilityCycles[1].ownership.activeRuntimes = 2; },
    (p) => { p.visibilityCycles[1].ownership.ownedListeners += 1; },
    (p) => { p.bfcacheCycles.pop(); },
    (p) => { p.bfcacheCycles[0].events[0].persisted = false; },
    (p) => { p.bfcacheCycles[2].documentIdentityAfter = "reloaded"; },
    (p) => { p.bfcacheCycles[0].viewerIdentityBefore = "different-viewer"; },
    (p) => { p.bfcacheCycles[0].ownership.ownedListeners += 1; },
    (p) => { p.bfcacheCycles[0].events[0].sequence = p.visibilityCycles.at(-1).visibleEvent.sequence; },
    (p) => { [p.bfcacheCycles[0].events[0].sequence, p.bfcacheCycles[0].events[1].sequence] = [p.bfcacheCycles[0].events[1].sequence, p.bfcacheCycles[0].events[0].sequence]; },
    (p) => { p.bfcacheCycles[0].events[1].sequence = p.bfcacheCycles[0].events[0].sequence; },
    (p) => { for (const cycle of p.bfcacheCycles) { cycle.submittedFramesBefore = 1; cycle.submittedFramesAfter = 2; } },
    (p) => { p.hardReload.pageshowPersisted = true; },
    (p) => { p.hardReload.documentIdentity = p.hardReload.previousDocumentIdentity; },
    (p) => { p.hardReload.previousDocumentIdentity = "not-the-final-bfcache-document"; },
    (p) => { p.disposal.ownedListeners = 1; },
    (p) => { p.benchmark.rafTimestampsMs[600] += 1; },
    (p) => { p.errors.push("GPUValidationError"); },
    (p) => { p.errorObservations.beforeReload.push("console.error:pre-reload failure"); },
    (p) => { p.errorObservations.reloadBoundary.push("console.error:pagehide failure"); },
  ];
  for (const mutate of mutations) {
    const proof = validSaf03Proof(); mutate(proof);
    assert.throws(() => validateSaf03SafariProof(proof, { commit: "a".repeat(40), packageSha256: "b".repeat(64) }));
  }
  for (const mutate of [
    (r) => { r.replacesStable = true; },
    (r) => { r.executable = "/Applications/Safari.app"; },
    (r) => { r.driverVersion = "wrong"; },
    (r) => { r.binding.commit = "f".repeat(40); },
    (r) => { r.unexpected = true; },
    (r) => { r.browser.channel = "stable"; },
    (r) => { delete r.cleanup.notStarted; },
    (r) => { r.cleanup.notStarted = true; r.cleanup.sessionDeleted = null; r.cleanup.driverStopped = null; },
    (r) => { r.cleanup.sessionDeleted = null; },
    (r) => { r.cleanup.driverStopped = null; },
    (r) => { r.cleanup.processAbsent = false; r.cleanup.ok = false; },
    (r) => { r.probe = null; },
    (r) => { r.probe.binding.commit = "f".repeat(40); },
    (r) => { r.probe.route = "https://other.example.invalid/run/"; },
    (r) => { r.probe.screenshot.pixels.terrainPixelCount = 0; },
    (r) => { r.probe.errors.push("console.error:rendered but failed"); },
    (r) => { r.result = "PRODUCT_FAILURE"; r.warning = null; },
  ]) {
    const result = validStpResult(inventory); mutate(result);
    assert.throws(() => validateSaf03TechnologyPreviewResult(result, inventory, {
      commit: "a".repeat(40), packageSha256: "b".repeat(64),
    }, "https://safari.example.invalid/run/"));
  }
});

test("SAF-03 closes every STP product-failure provenance and cleanup state", () => {
  const retained = validStpResult(inventory);
  Object.assign(retained, { result: "PRODUCT_FAILURE", warning: "STP_PRODUCT_FAILURE probe error", probe: null });
  assert.equal(validateSaf03TechnologyPreviewResult(retained, inventory).result, "PRODUCT_FAILURE");

  const launchedWithoutBrowser = structuredClone(retained);
  launchedWithoutBrowser.browser = null;
  launchedWithoutBrowser.cleanup.sessionDeleted = null;
  assert.equal(validateSaf03TechnologyPreviewResult(launchedWithoutBrowser, inventory).result, "PRODUCT_FAILURE");

  const preflight = structuredClone(launchedWithoutBrowser);
  preflight.driverExecutable = null;
  preflight.driverVersion = null;
  preflight.cleanup = { notStarted: true, sessionDeleted: null, driverStopped: null, processAbsent: true, ok: true };
  assert.equal(validateSaf03TechnologyPreviewResult(preflight, inventory).result, "PRODUCT_FAILURE");

  for (const [source, mutate] of [
    [retained, (r) => { r.cleanup.sessionDeleted = null; }],
    [retained, (r) => { r.driverExecutable = null; }],
    [launchedWithoutBrowser, (r) => { r.driverVersion = null; }],
    [launchedWithoutBrowser, (r) => { r.cleanup.driverStopped = null; }],
    [preflight, (r) => { r.driverExecutable = inventory.tools.safariTechnologyPreviewDriverPath; }],
    [preflight, (r) => { r.browser = { name: "safari", channel: "technology-preview", version: "26.1" }; }],
    [preflight, (r) => { r.cleanup.sessionDeleted = true; }],
  ]) {
    const invalid = structuredClone(source); mutate(invalid);
    assert.throws(() => validateSaf03TechnologyPreviewResult(invalid, inventory));
  }
});
