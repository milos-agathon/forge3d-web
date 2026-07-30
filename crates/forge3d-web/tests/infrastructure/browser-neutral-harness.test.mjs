import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  executeHardwareBrowserLane,
  resolveLaneRuntime,
} from "../../scripts/browser-lane-runtime.mjs";
import { cleanupBrowserHardware } from "../../scripts/cleanup-browser-hardware.mjs";
import { createUpdateWindow } from "../../scripts/manage-browser-update-window.mjs";
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
const desktopInventory = {
  schemaVersion: 1,
  assetId: binding.assetId,
  platform: "linux",
  osBuild: "Linux 6.8.0 checked",
  headed: true,
  displayServer: "GNOME Wayland",
  session: {
    interactive: true,
    locked: false,
    remote: false,
    identifier: "7",
  },
  browsers: [
    {
      id: "chrome-stable",
      version: "150.0.0.0",
      executable: "/opt/google/chrome/chrome",
    },
  ],
  tools: { playwright: "1.56.1" },
  capturedAt: "2026-07-29T09:59:00.000Z",
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

test("production lane executor opens a headed browser and captures live page evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-browser-runtime-"));
  const calls = [];
  try {
    const outputPath = join(directory, "evidence.json");
    await executeHardwareBrowserLane({
      lane: binding.lane,
      assetId: binding.assetId,
      hostId: binding.assetId,
      platform: "linux",
      binding: {
        ...binding,
        commit: binding.trustedSha,
      },
      route: {
        applicationUrl:
          "https://linux-nv.webgpu-ci.forge3d.dev/runs/10/20/" +
          "ab".repeat(16) +
          "/",
      },
      browserPolicy: {
        prohibitedLaunchArguments: [],
        tools: { playwright: "1.56.1" },
      },
      deviceMatrix: { devices: [] },
      inventory: desktopInventory,
      outputPath,
      dependencies: {
        now: () => new Date("2026-07-29T10:00:00.000Z"),
        waitUntil: async () => undefined,
        openSession: async () => ({
          browser: { name: "chrome", channel: "stable", version: "150.0.0.0" },
          driverVersion: "1.56.1",
          effectiveLaunchArguments: [],
          launchArgumentsObserved: true,
          launchArgumentSource: "chromium-cdp-browser-command-line",
          browserProcessId: 501,
          runPage: async () => {
            calls.push("page");
            return {
              adapter,
              assertions: {
                passed: true,
                supportAssertionsExecuted: true,
              },
              watermark: null,
            };
          },
          close: async () => calls.push("close"),
        }),
      },
    });
    const record = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(record.result, "PASS");
    assert.equal(record.browser.version, "150.0.0.0");
    assert.equal(record.driver.version, "1.56.1");
    assert.equal(record.system.osBuild, "Linux 6.8.0 checked");
    assert.equal(record.session.interactive, true);
    assert.equal(record.launchObservation.browserProcessId, 501);
    assert.deepEqual(calls, ["page", "close"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual mobile runtime calls Appium class and retains the visible challenge window", async () => {
  assert.deepEqual(
    resolveLaneRuntime({
      lane: "manual-mobile-multitouch",
      assetId: "FW-IOS-OLD-01",
      platform: "darwin",
    }),
    {
      driver: "appium-xcuitest",
      browser: "safari",
      supportAssertions: false,
      manual: true,
      mobile: true,
    },
  );
  const directory = mkdtempSync(join(tmpdir(), "forge3d-manual-runtime-"));
  const waits = [];
  const challenge = "cd".repeat(16);
  try {
    await executeHardwareBrowserLane({
      lane: "manual-mobile-multitouch",
      assetId: "FW-IOS-OLD-01",
      hostId: "FW-MAC-M2-01",
      platform: "darwin",
      binding: {
        ...binding,
        lane: "manual-mobile-multitouch",
        assetId: "FW-IOS-OLD-01",
        commit: binding.trustedSha,
      },
      route: { applicationUrl: "https://example.invalid/run/" },
      browserPolicy: {
        prohibitedLaunchArguments: [],
        tools: { appiumXcuitest: "10.0.0" },
      },
      deviceMatrix: { devices: [] },
      inventory: {
        ...desktopInventory,
        assetId: "FW-MAC-M2-01",
        platform: "darwin",
        osBuild: "Darwin 25.0.0 checked",
        displayServer: "WindowServer",
        session: {
          interactive: true,
          locked: false,
          remote: false,
          identifier: "forge3d-lab",
        },
        browsers: [],
      },
      mediaChallenge: challenge,
      outputPath: join(directory, "evidence.json"),
      manualSessionInputPath: join(directory, "manual-input.json"),
      watermarkPath: join(directory, "watermark.json"),
      dependencies: {
        now: () => new Date("2026-07-29T10:00:00.000Z"),
        waitUntil: async (end) => waits.push(end.toISOString()),
        openSession: async () => ({
          browser: { name: "safari", channel: "stable", version: "26.0" },
          driverVersion: "10.0.0",
          effectiveLaunchArguments: [],
          launchArgumentsObserved: true,
          launchArgumentSource: "appium-effective-session-capabilities",
          browserProcessId: null,
          runPage: async () => ({
            adapter,
            assertions: {
              passed: true,
              supportAssertionsExecuted: false,
            },
            watermark: {
              mediaChallenge: challenge,
              nonDismissable: true,
              overlayTarget: "viewer-shell-not-canvas",
              visible: true,
            },
          }),
          close: async () => undefined,
        }),
      },
    });
    const input = JSON.parse(
      readFileSync(join(directory, "manual-input.json"), "utf8"),
    );
    assert.equal(input.startedAt, "2026-07-29T10:00:00.000Z");
    assert.equal(input.endedAt, "2026-07-29T10:20:00.000Z");
    assert.deepEqual(waits, ["2026-07-29T10:20:00.000Z"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unconditional cleanup stops route/driver/Appium processes and restores updates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-cleanup-runtime-"));
  const observedAt = "2026-07-29T10:00:00.000Z";
  const channel = { id: "chrome-stable", version: "150.0.0.0" };
  try {
    const routeStatePath = join(directory, "route.json");
    const processRegistryPath = join(directory, "processes.json");
    const updateStatePath = join(directory, "update.json");
    const outputPath = join(directory, "cleanup.json");
    writeFileSync(
      routeStatePath,
      JSON.stringify({
        schemaVersion: 1,
        processes: [
          { name: "fixture-application", pid: 101 },
          { name: "fixture-asset", pid: 102 },
          { name: "cloudflared", pid: 103 },
        ],
      }),
    );
    writeFileSync(
      processRegistryPath,
      JSON.stringify({
        schemaVersion: 1,
        processes: [
          { name: "safaridriver", pid: 104, stopped: false },
          { name: "appium", pid: 105, stopped: false },
        ],
      }),
    );
    writeFileSync(
      updateStatePath,
      JSON.stringify(
        createUpdateWindow({
          assetId: "FW-MAC-M2-01",
          resolvedChannels: [channel],
          policy: {
            acceptanceWindowHours: 24,
            channels: [{ id: channel.id }],
          },
          enforcement: {
            helper: "/opt/forge3d/bin/browser-update-control",
            observedAt,
            receipt: {
              schemaVersion: 1,
              operation: "freeze",
              assetId: "FW-MAC-M2-01",
              osUpdates: "disabled",
              browserUpdates: [{ ...channel, state: "disabled" }],
              observedAt,
            },
          },
        }),
      ),
    );
    const stopped = [];
    const stopProcess = async (pid) => {
      stopped.push(pid);
      return { stopped: true, exitObserved: true };
    };
    const result = await cleanupBrowserHardware({
      routeStatePath,
      processRegistryPath,
      updateStatePath,
      outputPath,
      updateHelper: "/opt/forge3d/bin/browser-update-control",
      dependencies: {
        now: () => new Date("2026-07-29T10:30:00.000Z"),
        stopProcess,
        route: {
          now: () => new Date("2026-07-29T10:30:00.000Z"),
          stopProcess,
        },
        execute: () =>
          JSON.stringify({
            schemaVersion: 1,
            operation: "unfreeze",
            assetId: "FW-MAC-M2-01",
            osUpdates: "restored",
            browserUpdates: [{ ...channel, state: "restored" }],
            observedAt: "2026-07-29T10:30:00.000Z",
          }),
      },
    });
    assert.equal(result.updatesRestored, true);
    assert.equal(result.tunnelsStopped, true);
    assert.equal(result.appiumStopped, true);
    assert.deepEqual(stopped, [103, 102, 101, 104, 105]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
