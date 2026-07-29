import assert from "node:assert/strict";
import test from "node:test";

import { runBrowserLane } from "../hardware/run-browser-lane.mjs";

const binding = {
  lane: "chrome-linux-rtx3070",
  runId: 10,
  jobId: 20,
  assetId: "FW-LNX-NV-01",
  trustedSha: "a".repeat(40),
  packageSha256: "b".repeat(64),
};
const adapter = {
  deviceCreated: true,
  surfacePresented: true,
  isFallbackAdapter: false,
};

test("browser-neutral harness runs the browser-owned payload after adapter smoke", async () => {
  const calls = [];
  const result = await runBrowserLane({
    lane: binding.lane,
    driver: "playwright-chrome",
    binding,
    adapterSmoke: async () => {
      calls.push("adapter");
      return adapter;
    },
    assertions: async () => {
      calls.push("assertions");
      return { passed: true, supportAssertionsExecuted: true };
    },
    cleanup: async () => {
      calls.push("cleanup");
      return { ok: true };
    },
  });
  assert.equal(result.result, "PASS");
  assert.deepEqual(calls, ["adapter", "assertions", "cleanup"]);
});

test("infrastructure canary cannot execute browser support assertions", async () => {
  let assertionsCalled = false;
  const result = await runBrowserLane({
    lane: "infrastructure-canary",
    driver: "infrastructure-canary",
    binding: { ...binding, lane: "infrastructure-canary" },
    adapterSmoke: async () => adapter,
    assertions: async () => {
      assertionsCalled = true;
      return { passed: true };
    },
    cleanup: async () => ({ ok: true }),
  });
  assert.equal(assertionsCalled, false);
  assert.equal(result.assertions.supportAssertionsExecuted, false);
});

test("fallback adapter and unreviewed drivers fail closed while cleanup still runs", async () => {
  let cleaned = false;
  await assert.rejects(
    () =>
      runBrowserLane({
        lane: binding.lane,
        driver: "playwright-chrome",
        binding,
        adapterSmoke: async () => ({
          ...adapter,
          isFallbackAdapter: true,
        }),
        assertions: async () => ({ passed: true }),
        cleanup: async () => {
          cleaned = true;
          return { ok: true };
        },
      }),
    /required hardware presentation/u,
  );
  assert.equal(cleaned, true);
  await assert.rejects(
    () =>
      runBrowserLane({
        lane: binding.lane,
        driver: "shell-command",
        binding,
      }),
    /not a checked value/u,
  );
});
