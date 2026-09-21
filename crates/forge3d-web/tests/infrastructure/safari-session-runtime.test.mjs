import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  openProductionSession,
  SAFARI_COMPOSED_SCRIPT_TIMEOUT_MS,
  SAFARI_HARDWARE_PAGE_TIMEOUT_BUDGET,
} from "../../scripts/browser-session-runtime.mjs";
import { validSaf02Conformance } from "../browser/saf02-conformance-fixture.mjs";
import { validSaf03Proof } from "../browser/saf03-proof-fixture.mjs";
import { validSaf04HardwareProof } from "../browser/saf04-hardware-proof-fixture.mjs";

const previousAcceptance = process.env.FORGE3D_SAFARI_ACCEPTANCE_MODULE;
const previousSelenium = process.env.FORGE3D_SELENIUM_MODULE;
process.env.FORGE3D_SAFARI_ACCEPTANCE_MODULE = "/private/tmp/forge3d-saf03-fake-acceptance.mjs";
process.env.FORGE3D_SELENIUM_MODULE = "/private/tmp/forge3d-saf03-fake-selenium.js";

test.after(() => {
  restoreEnvironment("FORGE3D_SAFARI_ACCEPTANCE_MODULE", previousAcceptance);
  restoreEnvironment("FORGE3D_SELENIUM_MODULE", previousSelenium);
});

test("SAF-03 production caller projects run/job bindings to the closed STP identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "saf03-binding-"));
  try {
    const request = stableRequest(directory, { includeStp: false });
    const session = await openProductionSession(request, dependencies(stableSession(91001)));
    const result = await session.runTechnologyPreview({
      binding: { lane: "safari-macos-m2", assetId: "FW-MAC-M2-01", commit: "a".repeat(40), packageSha256: "b".repeat(64), runId: 41, jobId: 42 },
      route: { applicationUrl: "https://safari.example.invalid/run/" },
    });
    assert.deepEqual(Object.keys(result.binding).sort(), ["assetId", "commit", "lane", "packageSha256"]);
    assert.equal(result.result, "ABSENT");
    await session.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual Safari trackpad retains the neutral WebDriver path", async () => {
  let neutralCalls = 0;
  const sentinel = { mode: "manual-neutral" };
  const result = await openProductionSession({
    lane: "manual-safari-trackpad",
    runtime: { driver: "safaridriver", browser: "safari", manual: true },
    routeUrl: "https://safari.example.invalid/run/",
    browserPolicy: { tools: { safaridriverPath: "/usr/bin/safaridriver" } },
    inventory: { tools: { safaridriverVersion: "26.0" } },
  }, {
    openLocalWebDriverSession: async () => { neutralCalls += 1; return sentinel; },
    acceptance: { openSeleniumSafariSession: () => assert.fail("manual lane used full SAF-03 acceptance") },
  });
  assert.equal(result, sentinel);
  assert.equal(neutralCalls, 1);
});

test("automated Selenium Safari admits near-bound composed work and rejects overrun", async () => {
  const directory = mkdtempSync(join(tmpdir(), "saf03-timeout-"));
  const calls = [];
  const nonce = "ab".repeat(16);
  const route = {
    applicationUrl: `https://mac-m2.webgpu-ci.forge3d.dev/runs/41/42/${nonce}/`,
    assetUrl: `https://assets-mac-m2.webgpu-ci.forge3d.dev/runs/41/42/${nonce}/`,
  };
  const neutral = {
    ok: true,
    value: {
      adapter: { isFallbackAdapter: false, secureContext: true, deviceCreated: true, surfacePresented: true },
      saf02Proof: validSaf02Conformance({
        runId: 41,
        jobId: 42,
        commit: "a".repeat(40),
        packageSha256: "b".repeat(64),
        nonce,
      }),
    },
  };
  try {
    const boundedStages = SAFARI_COMPOSED_SCRIPT_TIMEOUT_MS -
      SAFARI_HARDWARE_PAGE_TIMEOUT_BUDGET.webdriverTransportMargin;
    assert.equal(
      SAFARI_COMPOSED_SCRIPT_TIMEOUT_MS,
      Object.values(SAFARI_HARDWARE_PAGE_TIMEOUT_BUDGET)
        .reduce((total, value) => total + value, 0),
    );
    const driver = virtualTimedDriver(boundedStages - 1, neutral, calls);
    const stable = stableSession(91007, () => undefined, driver);
    const attachedSession = { attached: "selenium-session" };
    const acceptance = {
      SAF03_SELENIUM_VERSION: "4.35.0",
      openSeleniumSafariSession: async () => stable,
      runStableSafariAcceptance: async () => {
        calls.push(["saf03"]);
        return validSaf03Proof();
      },
    };
    const session = await openProductionSession(
      stableRequest(directory),
      dependencies(null, {
        acceptance,
        attachWebDriverSession: async (seleniumDriver) => {
          assert.equal(seleniumDriver, driver);
          return attachedSession;
        },
        runSafariBrowserAcceptance: async (attached, payload, options) => {
          calls.push(["saf04"]);
          assert.equal(attached, attachedSession);
          assert.equal(options.hardwarePageResult, neutral.value);
          return { ...options.hardwarePageResult, saf04Proof: validSaf04HardwareProof({
            commit: payload.binding.commit,
            packageSha256: payload.binding.packageSha256,
          }) };
        },
      }),
    );
    const pageResult = await session.runPage({
      binding: closedBinding(),
      route,
    });
    assert.deepEqual(calls.slice(0, 4), [
      ["timeouts", { script: SAFARI_COMPOSED_SCRIPT_TIMEOUT_MS }],
      ["execute", boundedStages - 1],
      ["saf04"],
      ["saf03"],
    ]);
    assert.equal(pageResult.saf04Proof.kind, "forge3d-saf04-safari-lifecycle-proof-v1");
    assert.equal(pageResult.saf03Proof.kind, "forge3d-saf03-safari-acceptance-v1");
    await session.close();

    const overrunCalls = [];
    const overrunDriver = virtualTimedDriver(
      SAFARI_COMPOSED_SCRIPT_TIMEOUT_MS + 1,
      neutral,
      overrunCalls,
    );
    const overrunSession = await openProductionSession(
      stableRequest(directory),
      dependencies(null, {
        acceptance: {
          ...acceptance,
          openSeleniumSafariSession: async () => stableSession(
            91008,
            () => undefined,
            overrunDriver,
          ),
        },
      }),
    );
    await assert.rejects(
      () => overrunSession.runPage({ binding: closedBinding(), route }),
      /script timeout exceeded/u,
    );
    assert.deepEqual(overrunCalls, [
      ["timeouts", { script: SAFARI_COMPOSED_SCRIPT_TIMEOUT_MS }],
      ["execute", SAFARI_COMPOSED_SCRIPT_TIMEOUT_MS + 1],
    ]);
    await overrunSession.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-open launch observation failure closes and records SafariDriver cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "saf03-observe-"));
  let closes = 0;
  try {
    const stable = stableSession(91002, () => { closes += 1; });
    await assert.rejects(() => openProductionSession(stableRequest(directory), dependencies(stable, {
      observeWebDriverLaunch: () => { throw new Error("forced launch observation failure"); },
    })), /forced launch observation failure/u);
    assert.equal(closes, 1);
    const registry = JSON.parse(readFileSync(join(directory, "processes.json"), "utf8"));
    assert.deepEqual(registry.processes, [{ name: "safaridriver", pid: 91002, stopped: true }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("clean STP launch failure is warning-only while cleanup uncertainty is hard", async () => {
  const directory = mkdtempSync(join(tmpdir(), "saf03-stp-"));
  try {
    const cleanFailure = new Error("STP launch rejected");
    cleanFailure.cleanup = { notStarted: false, sessionDeleted: null, driverStopped: true, processAbsent: true, ok: true };
    const cleanAcceptance = queuedAcceptance([stableSession(91003), cleanFailure]);
    const cleanSession = await openProductionSession(stableRequest(directory, { includeStp: true }), dependencies(null, { acceptance: cleanAcceptance }));
    const warning = await cleanSession.runTechnologyPreview({ binding: closedBinding(), route: { applicationUrl: "https://safari.example.invalid/run/" } });
    assert.equal(warning.result, "PRODUCT_FAILURE");
    assert.match(warning.warning, /STP launch rejected/u);
    await cleanSession.close();

    const hardDirectory = mkdtempSync(join(tmpdir(), "saf03-stp-hard-"));
    try {
      const hardAcceptance = queuedAcceptance([stableSession(91004), new Error("cleanup unproven")]);
      const hardSession = await openProductionSession(stableRequest(hardDirectory, { includeStp: true }), dependencies(null, { acceptance: hardAcceptance }));
      await assert.rejects(() => hardSession.runTechnologyPreview({ binding: closedBinding(), route: { applicationUrl: "https://safari.example.invalid/run/" } }), /cleanup unproven/u);
      await hardSession.close();
    } finally {
      rmSync(hardDirectory, { recursive: true, force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("STP rendered probe errors remain a cleaned product warning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "saf03-stp-probe-error-"));
  try {
    const preview = stableSession(91006);
    preview.browser = { name: "safari", channel: "technology-preview", version: "26.1" };
    preview.driverVersion = "26.1";
    const acceptance = queuedAcceptance([stableSession(91005), preview]);
    acceptance.runSafariTechnologyPreviewProbe = async () => {
      throw new Error("STP_PRODUCT_FAILURE viewer reported errors: console.error:rendered but failed");
    };
    const session = await openProductionSession(stableRequest(directory, { includeStp: true }), dependencies(null, { acceptance }));
    const result = await session.runTechnologyPreview({ binding: closedBinding(), route: { applicationUrl: "https://safari.example.invalid/run/" } });
    assert.equal(result.result, "PRODUCT_FAILURE");
    assert.equal(result.browser.channel, "technology-preview");
    assert.deepEqual(result.cleanup, { notStarted: false, sessionDeleted: true, driverStopped: true, processAbsent: true, ok: true });
    assert.equal(result.probe, null);
    await session.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stableRequest(directory, { includeStp = false } = {}) {
  return {
    lane: "safari-macos-m2",
    runtime: { driver: "safaridriver", browser: "safari", manual: false },
    routeUrl: "https://safari.example.invalid/run/",
    processRegistryPath: join(directory, "processes.json"),
    browserPolicy: { tools: { selenium: "4.35.0", safaridriverPath: "/usr/bin/safaridriver",
      safariTechnologyPreviewDriverPath: "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver" } },
    inventory: {
      browsers: [
        { id: "safari-stable", channel: "stable", classification: "required", version: "26.0" },
        ...(includeStp ? [{ id: "safari-technology-preview", channel: "technology-preview", classification: "probe", version: "26.1", executable: "/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview" }] : []),
      ],
      osVersion: "26.0",
      osBuild: "macOS build 25A123",
      architecture: "arm64",
      tools: { safaridriverVersion: "26.0", safariTechnologyPreviewDriverPath: includeStp ? "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver" : false,
        safariTechnologyPreviewDriverVersion: includeStp ? "26.1" : false },
    },
  };
}

function virtualTimedDriver(elapsedMs, result, calls) {
  let scriptTimeoutMs = 0;
  return {
    manage: () => ({
      setTimeouts: async (timeouts) => {
        scriptTimeoutMs = timeouts.script;
        calls.push(["timeouts", timeouts]);
      },
    }),
    executeAsyncScript: async () => {
      calls.push(["execute", elapsedMs]);
      if (elapsedMs > scriptTimeoutMs) throw new Error("script timeout exceeded");
      return result;
    },
  };
}

function dependencies(stable, overrides = {}) {
  return {
    installedPackageVersion: () => "4.35.0",
    observeWebDriverLaunch: () => ({ effectiveLaunchArguments: [], launchArgumentsObserved: true, launchArgumentSource: "darwin-live-browser-process", browserProcessId: null }),
    attachWebDriverSession: async () => ({ attached: "fake" }),
    runSafariBrowserAcceptance: async (_session, payload, options) => ({
      ...(options?.hardwarePageResult ?? {}),
      saf04Proof: validSaf04HardwareProof({
        commit: payload.binding.commit,
        packageSha256: payload.binding.packageSha256,
      }),
    }),
    acceptance: overrides.acceptance ?? { SAF03_SELENIUM_VERSION: "4.35.0", openSeleniumSafariSession: async () => stable },
    ...overrides,
  };
}

function stableSession(driverPid, onClose = () => undefined, driver = {}) {
  return { driverPid, browser: { name: "safari", channel: "stable", version: "26.0" }, driverVersion: "26.0",
    driver, close: async () => { onClose(); return { sessionDeleted: true, driverStopped: true, processAbsent: true, ok: true }; } };
}

function queuedAcceptance(values) {
  return { SAF03_SELENIUM_VERSION: "4.35.0", async openSeleniumSafariSession() {
    const value = values.shift();
    if (value instanceof Error) throw value;
    return value;
  } };
}

function closedBinding() {
  return { lane: "safari-macos-m2", assetId: "FW-MAC-M2-01", commit: "a".repeat(40), packageSha256: "b".repeat(64) };
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
