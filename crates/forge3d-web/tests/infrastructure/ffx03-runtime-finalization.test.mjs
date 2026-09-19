import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { executeHardwareBrowserLane } from "../../scripts/browser-lane-runtime.mjs";
import { validFfx03Proof } from "../browser/ffx03-proof-fixture.mjs";

test("stable Firefox writes PASS only after successful observed cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "ffx03-finalize-"));
  const output = join(root, "evidence.json");
  const events = [];
  try {
    const request = fixtureRequest(output, events);
    await executeHardwareBrowserLane(request);
    assert.deepEqual(events, ["page", "close"]);
    const evidence = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(evidence.result, "PASS");
    assert.equal(evidence.ffx03Proof.cleanup.ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stable Firefox cleanup failure emits no acceptable PASS", async () => {
  const root = mkdtempSync(join(tmpdir(), "ffx03-finalize-fail-"));
  const output = join(root, "evidence.json");
  try {
    const request = fixtureRequest(output, []);
    request.dependencies.openSession = async () => fakeSession([], async () => {
      throw new Error("forced quit failure");
    });
    await assert.rejects(() => executeHardwareBrowserLane(request), /forced quit failure/u);
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stable Firefox runtime consumer rejects malformed nested workload evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ffx03-nested-invalid-"));
  const output = join(root, "evidence.json");
  try {
    const request = fixtureRequest(output, []);
    request.dependencies.openSession = async () => {
      const session = fakeSession([]);
      const original = session.runPage;
      session.runPage = async (...args) => {
        const result = await original(...args);
        result.ffx03Workload.schemaVersion = 2;
        result.ffx03Workload.driver.pointerCapture.pointerId = 0;
        return result;
      };
      return session;
    };
    await assert.rejects(() => executeHardwareBrowserLane(request), /schemaVersion/u);
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [outcome, adapterValue] of [["PROBE_PASS", adapter({ assetId: "FW-LNX-I12-01",
  profile: "/tmp/nightly-profile" })], ["UNAVAILABLE", null],
  ["PRODUCT_FAILURE", null]]) test(`Nightly Firefox emits only the closed ${outcome} record after cleanup`, async () => {
  const root = mkdtempSync(join(tmpdir(), "ffx03-nightly-"));
  const output = join(root, "evidence.json");
  const events = [];
  try {
    const request = nightlyRequest(output, events, outcome, adapterValue);
    const record = await executeHardwareBrowserLane(request);
    assert.deepEqual(events, ["page", "close"]);
    assert.equal(record.outcome, outcome);
    assert.equal(record.result, undefined);
    assert.deepEqual(record.adapter, adapterValue);
    assert.equal(JSON.parse(readFileSync(output, "utf8")).outcome, outcome);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Nightly Firefox cleanup failure retains no typed outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "ffx03-nightly-cleanup-"));
  const output = join(root, "evidence.json");
  try {
    const request = nightlyRequest(output, [], "UNAVAILABLE", null);
    request.dependencies.openSession = async () => nightlySession([], "UNAVAILABLE", null,
      async () => { throw new Error("nightly quit failed"); });
    await assert.rejects(() => executeHardwareBrowserLane(request), /nightly quit failed/u);
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Firefox runtime rejects authorization classification drift before opening a session", async () => {
  const stable = fixtureRequest("/unused/stable.json", []);
  stable.required = false;
  await assert.rejects(() => executeHardwareBrowserLane(stable), /required classification/u);
  const nightly = nightlyRequest("/unused/nightly.json", [], "UNAVAILABLE", null);
  nightly.required = true;
  await assert.rejects(() => executeHardwareBrowserLane(nightly), /required classification/u);
});

function fixtureRequest(outputPath, events) {
  return {
    lane: "firefox-macos-m2", assetId: "FW-MAC-M2-01", hostId: "FW-MAC-M2-01",
    platform: "darwin", architecture: "arm64",
    required: true,
    binding: { lane: "firefox-macos-m2", runId: 11, jobId: 12, assetId: "FW-MAC-M2-01",
      commit: "a".repeat(40), packageSha256: "b".repeat(64) },
    route: { applicationUrl: "https://fixture.example/run/", assetUrl: "https://asset.example/run/" },
    browserPolicy: { tools: { geckodriver: "0.36.0", selenium: "4.35.0" }, prohibitedLaunchArguments: [] },
    deviceMatrix: {}, inventory: inventory(), outputPath,
    dependencies: { openSession: async () => fakeSession(events) },
  };
}

function nightlyRequest(outputPath, events, outcome, adapterValue) {
  return {
    lane: "firefox-nightly-linux-intel12", assetId: "FW-LNX-I12-01", hostId: "FW-LNX-I12-01",
    platform: "linux", architecture: "x64",
    required: false,
    binding: { lane: "firefox-nightly-linux-intel12", runId: 21, jobId: 22,
      assetId: "FW-LNX-I12-01", commit: "a".repeat(40), packageSha256: "b".repeat(64) },
    route: { applicationUrl: "https://fixture.example/run/", assetUrl: "https://asset.example/run/" },
    browserPolicy: { tools: { geckodriver: "0.36.0", selenium: "4.35.0" }, prohibitedLaunchArguments: [] },
    deviceMatrix: {}, inventory: nightlyInventory(), outputPath,
    dependencies: { openSession: async () => nightlySession(events, outcome, adapterValue) },
  };
}

function fakeSession(events, close = async () => ({ sessionDeleted: true, driverStopped: true,
  driverAbsent: true, browserAbsent: true, ok: true })) {
  const proof = validFfx03Proof();
  return {
    browser: proof.browser, driverVersion: "0.36.0", driverExecutable: "/opt/forge3d/geckodriver",
    clientVersion: "4.35.0", observedExecutable: "/Applications/Firefox.app/Contents/MacOS/firefox",
    launchArgumentsObserved: true, launchArgumentSource: "darwin-live-browser-process", browserProcessId: 42,
    effectiveLaunchArguments: ["-profile", "/tmp/profile"],
    async runPage() { events.push("page"); return { adapter: adapter(), assertions: { passed: true,
      supportAssertionsExecuted: true }, routeReadiness: { trustedHttps: true },
      ffx03Workload: proof.workload, configuration: proof.configuration }; },
    async close() { events.push("close"); return close(); },
  };
}

function nightlySession(events, outcome, adapterValue, close = async () => ({ sessionDeleted: true,
  driverStopped: true, driverAbsent: true, browserAbsent: true, ok: true })) {
  return {
    browser: { name: "firefox", channel: "nightly", version: "148.0a1" },
    driverVersion: "0.36.0", driverExecutable: "/opt/forge3d/geckodriver",
    clientVersion: "4.35.0", observedExecutable: "/opt/firefox-nightly/firefox",
    launchArgumentsObserved: true, launchArgumentSource: "linux-live-browser-process", browserProcessId: 84,
    effectiveLaunchArguments: ["-profile", "/tmp/nightly-profile"],
    async runPage() { events.push("page"); return { probeOutcome: outcome,
      adapter: adapterValue, diagnostic: outcome === "PROBE_PASS" ? undefined : `${outcome} fixture`,
      configuration: { source: "geckodriver-generated-profile-observation", freshProfile: true,
        profilePathSha256: "c".repeat(64), requestedOverrides: { "dom.webgpu.enabled": true },
        observedWebGpuUserOverrides: { "dom.webgpu.enabled": true },
        afterWorkload: { "dom.webgpu.enabled": true } } }; },
    async close() { events.push("close"); return close(); },
  };
}

function inventory() {
  return { schemaVersion: 1, assetId: "FW-MAC-M2-01", platform: "darwin", architecture: "arm64",
    osBuild: "fixture-build", headed: true, displayServer: "WindowServer",
    session: { interactive: true, locked: false, remote: false, identifier: "console" },
    browsers: [{ id: "firefox-release", channel: "release", classification: "required",
      automation: "selenium", version: "147.0", executable: "/Applications/Firefox.app/Contents/MacOS/firefox" }],
    tools: { selenium: "4.35.0", geckodriver: "0.36.0" }, capturedAt: "2026-09-19T00:00:00.000Z" };
}

function nightlyInventory() {
  return { schemaVersion: 1, assetId: "FW-LNX-I12-01", platform: "linux", architecture: "x64",
    osBuild: "fixture-build", headed: true, displayServer: "X11",
    session: { interactive: true, locked: false, remote: false, identifier: "console" },
    browsers: [{ id: "firefox-nightly", channel: "nightly", classification: "probe",
      automation: "selenium", version: "148.0a1", executable: "/opt/firefox-nightly/firefox" }],
    tools: { selenium: "4.35.0", geckodriver: "0.36.0" }, capturedAt: "2026-09-19T00:00:00.000Z" };
}

function adapter({ assetId = "FW-MAC-M2-01", profile = "/tmp/profile" } = {}) {
  return { schemaVersion: 1, runId: 11, jobId: 12, assetId,
    commit: "a".repeat(40), packageSha256: "b".repeat(64), secureContext: true,
    navigatorGpu: true, adapterInfoAvailable: true, adapterInfo: { vendor: "fixture" },
    isFallbackAdapter: false, deviceAdapterInfo: { vendor: "fixture" },
    limits: { maxTextureDimension2D: 8192 }, deviceCreated: true, surfaceCreated: true,
    surfacePresented: true, lumaChanged: true, presentedFrameLumaSamples: [0.1, 0.6],
    presentedFrameLumaDelta: 0.5, effectiveLaunchArguments: ["-profile", profile] };
}
