import assert from "node:assert/strict";
import test from "node:test";

import { runFirefoxLifecycleAcceptance } from "../../scripts/firefox-lifecycle-acceptance.mjs";
import { validFfx04LifecycleProof } from "../browser/ffx04-lifecycle-proof-fixture.mjs";

const baseUrl = `https://mac-m2.webgpu-ci.forge3d.dev/runs/10/20/${"a".repeat(32)}/`;
const input = {
  lane: "firefox-macos-m2",
  assetId: "FW-MAC-M2-01",
  platform: "darwin",
  binding: {
    lane: "firefox-macos-m2",
    runId: 10,
    jobId: 20,
    assetId: "FW-MAC-M2-01",
    commit: "b".repeat(40),
    packageSha256: "c".repeat(64),
  },
  route: { applicationUrl: baseUrl },
  browser: { name: "firefox", channel: "release", version: "147.0" },
  driver: { name: "selenium-firefox", version: "geckodriver 0.36.0" },
  launchObservation: {
    observed: true,
    source: "darwin-live-browser-process",
    browserProcessId: 42,
  },
};

test("stock Firefox lifecycle runner performs exactly three BFCache cycles and cleanup", async () => {
  const calls = [];
  let currentUrl = baseUrl;
  const session = fakeSession(calls, () => currentUrl, (value) => { currentUrl = value; });
  const proof = await runFirefoxLifecycleAcceptance({ session, ...input });
  assert.equal(proof.cycleCount, 3);
  assert.equal(proof.cycles.length, 3);
  assert.equal(proof.result, "PASS");
  assert.equal(calls.filter(([name]) => name === "back").length, 3);
  assert.equal(calls.filter(([name, action]) => name === "action" && action === "disposeViewerBfcacheLifecycle").length, 1);
  assert.deepEqual(calls.at(-1), ["navigate", baseUrl]);
});

test("stock Firefox lifecycle runner fails closed and attempts cleanup on malformed restore", async () => {
  const calls = [];
  let currentUrl = baseUrl;
  const session = fakeSession(
    calls,
    () => currentUrl,
    (value) => { currentUrl = value; },
    { changedGenerationAt: 2 },
  );
  await assert.rejects(
    () => runFirefoxLifecycleAcceptance({ session, ...input }),
    /FFX04_RESTORE_IDENTITY_CHANGED/u,
  );
  assert.equal(calls.some(([name, action]) => name === "action" && action === "disposeViewerBfcacheLifecycle"), true);
  assert.deepEqual(calls.at(-1), ["navigate", baseUrl]);
});

test("stock Firefox lifecycle runner validates the complete proof before returning PASS", async () => {
  const calls = [];
  let currentUrl = baseUrl;
  await assert.rejects(
    () => runFirefoxLifecycleAcceptance({
      session: fakeSession(calls, () => currentUrl, (value) => { currentUrl = value; }, { invalidShownCounterAt: 2 }),
      ...input,
    }),
    /FFX04_LIFECYCLE_PROOF_INVALID/u,
  );
  assert.equal(calls.some(([name, action]) => name === "action" && action === "disposeViewerBfcacheLifecycle"), true);
  assert.deepEqual(calls.at(-1), ["navigate", baseUrl]);
});

test("stock Firefox lifecycle runner rejects non-Firefox and non-live provenance before navigation", async () => {
  for (const override of [
    { lane: "infrastructure-canary" },
    { browser: { name: "firefox", channel: "playwright", version: "147.0" } },
    { launchObservation: { observed: false, source: "configuration", browserProcessId: null } },
    { binding: { ...input.binding, runId: 0 } },
    { binding: { ...input.binding, jobId: 21 } },
    { route: { applicationUrl: `${baseUrl}?credential=forbidden` } },
    { route: { applicationUrl: baseUrl.replace("https://", "https://user:pass@") } },
  ]) {
    const calls = [];
    await assert.rejects(
      () => runFirefoxLifecycleAcceptance({
        session: fakeSession(calls, () => baseUrl, () => {}),
        ...input,
        ...override,
      }),
      /FFX04_/u,
    );
    assert.deepEqual(calls, []);
  }
});

function fakeSession(calls, getUrl, setUrl, options = {}) {
  let cycle = 0;
  const fixture = validFfx04LifecycleProof({
    runId: 10, jobId: 20, commit: input.binding.commit,
    packageSha256: input.binding.packageSha256,
    driverVersion: input.driver.version,
  });
  return {
    async navigate(url) { calls.push(["navigate", url]); setUrl(url); },
    async currentUrl() { calls.push(["currentUrl"]); return getUrl(); },
    async historyBack() {
      calls.push(["back"]);
      setUrl(new URL("lifecycle-viewer.html", baseUrl).href);
    },
    async runBfcacheLifecycleAction(action, args = []) {
      calls.push(["action", action, args]);
      if (action === "prepareViewerBfcacheCycle") {
        cycle = args[0];
        return structuredClone(fixture.cycles[cycle - 1].prepared);
      }
      if (action === "observeViewerBfcacheRestore") {
        const restored = structuredClone(fixture.cycles[cycle - 1]);
        delete restored.prepared;
        if (options.changedGenerationAt === cycle) restored.restored.diagnostics.generation = 2;
        if (options.invalidShownCounterAt === cycle) restored.shown.diagnostics.skippedFrames += 1;
        return restored;
      }
      if (action === "exerciseViewerAfterBfcache") return structuredClone(fixture.input);
      if (action === "disposeViewerBfcacheLifecycle") return structuredClone(fixture.disposed);
      throw new Error("unexpected action");
    },
  };
}
