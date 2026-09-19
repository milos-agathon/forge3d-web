import assert from "node:assert/strict";
import {
  existsSync,
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
import { validChr03HardwareProof } from "../browser/chr03-hardware-proof-fixture.mjs";
import { validChr04HardwareProof } from "../browser/chr04-hardware-proof-fixture.mjs";
import { validSaf02Conformance } from "../browser/saf02-conformance-fixture.mjs";
import { validAbsentStpResult, validSaf03Proof } from "../browser/saf03-proof-fixture.mjs";

const binding = {
  lane: "chrome-linux-rtx3070",
  runId: 10,
  jobId: 20,
  assetId: "FW-LNX-NV-01",
  trustedSha: "a".repeat(40),
  packageSha256: "b".repeat(64),
};
const adapter = {
  secureContext: true,
  deviceCreated: true,
  surfacePresented: true,
  presentedFrameLumaSamples: [0.1, 0.8],
  presentedFrameLumaDelta: 0.7,
  lumaChanged: true,
  isFallbackAdapter: false,
};
const desktopInventory = {
  schemaVersion: 1,
  assetId: binding.assetId,
  platform: "linux",
  osVersion: "6.8.0",
  osBuild: "Linux 6.8.0 checked",
  architecture: "x86_64",
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

test("challenged infrastructure canary remains adapter-only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-canary-runtime-"));
  let payload;
  try {
    await executeHardwareBrowserLane({
      lane: "infrastructure-canary",
      assetId: binding.assetId,
      platform: "linux",
      hostId: binding.assetId,
      binding: {
        ...binding,
        lane: "infrastructure-canary",
        expectedTester: "tester-login",
      },
      route: {
        applicationUrl: `https://linux.example/runs/10/20/${"a".repeat(32)}/`,
        assetUrl: `https://assets.example/runs/10/20/${"a".repeat(32)}/`,
        basePath: `/runs/10/20/${"a".repeat(32)}/`,
      },
      browserPolicy: {
        prohibitedLaunchArguments: [],
        tools: { playwright: "1.56.1" },
      },
      deviceMatrix: { devices: [] },
      inventory: desktopInventory,
      mediaChallenge: "9".repeat(32),
      outputPath: join(directory, "evidence.json"),
      manualSessionInputPath: join(directory, "manual-input.json"),
      watermarkPath: join(directory, "watermark.json"),
      manualSessionReadinessPath: join(directory, "readiness.json"),
      controllerCaptureWindowPath: join(directory, "window.json"),
      dependencies: {
        announceManualReadiness: async () => undefined,
        waitForControllerWindow: async () => ({
          startedAt: "2026-07-29T10:00:00.000Z",
          endedAt: "2026-07-29T10:20:00.000Z",
        }),
        waitUntil: async () => undefined,
        openSession: async () => ({
          browser: { name: "chrome", channel: "stable", version: "150.0.0.0" },
          driverVersion: "1.56.1",
          effectiveLaunchArguments: [],
          launchArgumentsObserved: true,
          launchArgumentSource: "chromium-cdp-browser-command-line",
          browserProcessId: 1,
          runPage: async (value) => {
            payload = value;
            return {
              adapter,
              assertions: {
                passed: true,
                supportAssertionsExecuted: false,
              },
              routeReadiness: { trustedHttps: true },
              watermark: {
                mediaChallenge: "9".repeat(32),
                visible: true,
              },
            };
          },
          close: async () => undefined,
        }),
      },
    });
    assert.equal(payload.lane, "infrastructure-canary");
    assert.equal(payload.binding.lane, undefined);
    assert.equal(payload.sessionContext.expectedTester, "tester-login");
    assert.equal(payload.supportAssertions, false);
    assert.equal(existsSync(join(directory, "manual-input.json")), true);
    assert.equal(existsSync(join(directory, "watermark.json")), true);

    const ordinaryInput = join(directory, "ordinary-manual-input.json");
    await executeHardwareBrowserLane({
      lane: "infrastructure-canary",
      assetId: binding.assetId,
      platform: "linux",
      hostId: binding.assetId,
      binding: { ...binding, lane: "infrastructure-canary" },
      route: {
        applicationUrl: `https://linux.example/runs/10/20/${"a".repeat(32)}/`,
        assetUrl: `https://assets.example/runs/10/20/${"a".repeat(32)}/`,
        basePath: `/runs/10/20/${"a".repeat(32)}/`,
      },
      browserPolicy: {
        prohibitedLaunchArguments: [],
        tools: { playwright: "1.56.1" },
      },
      deviceMatrix: { devices: [] },
      inventory: desktopInventory,
      outputPath: join(directory, "ordinary-evidence.json"),
      manualSessionInputPath: ordinaryInput,
      dependencies: {
        openSession: async () => ({
          browser: { name: "chrome", channel: "stable", version: "150.0.0.0" },
          driverVersion: "1.56.1",
          effectiveLaunchArguments: [],
          launchArgumentsObserved: true,
          launchArgumentSource: "chromium-cdp-browser-command-line",
          browserProcessId: 1,
          runPage: async () => ({ adapter, assertions: { passed: true }, watermark: null }),
          close: async () => undefined,
        }),
      },
    });
    assert.equal(existsSync(ordinaryInput), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
        driver: "playwright-chrome",
        binding,
        adapterSmoke: async () => ({
          ...adapter,
          presentedFrameLumaDelta: 0.9,
        }),
        assertions: async () => ({ passed: true }),
        cleanup: async () => ({ ok: true }),
      }),
    /required hardware presentation/u,
  );
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
  let invalidProof = false;
  try {
    const outputPath = join(directory, "evidence.json");
    const request = {
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
          runPage: async (payload) => {
            calls.push("page");
            assert.equal(payload.binding.lane, binding.lane);
            assert.deepEqual(Object.keys(payload.binding).sort(), [
              "assetId", "commit", "jobId", "lane", "packageSha256", "runId",
            ]);
            const chr03Proof = validChr03HardwareProof({
              lane: binding.lane,
              assetId: binding.assetId,
              commit: binding.trustedSha,
              packageSha256: binding.packageSha256,
            });
            if (invalidProof) chr03Proof.systemInfo.available = "false";
            return {
              adapter,
              assertions: {
                passed: true,
                supportAssertionsExecuted: true,
              },
              watermark: null,
              chr03Proof,
            };
          },
          close: async () => calls.push("close"),
        }),
      },
    };
    await executeHardwareBrowserLane(request);
    const record = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(record.result, "PASS");
    assert.equal(record.browser.version, "150.0.0.0");
    assert.equal(record.driver.version, "1.56.1");
    assert.equal(record.system.osBuild, "Linux 6.8.0 checked");
    assert.equal(record.session.interactive, true);
    assert.equal(record.launchObservation.browserProcessId, 501);
    assert.deepEqual(calls, ["page", "close"]);
    invalidProof = true;
    await assert.rejects(executeHardwareBrowserLane({ ...request, outputPath: join(directory, "invalid.json") }), /expected type boolean/u);
    assert.deepEqual(calls, ["page", "close", "page", "close"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production Safari lane dispatches the authorized SAF-02 binding and validates its proof", async () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-safari-runtime-"));
  const nonce = "ab".repeat(16);
  const safariBinding = {
    ...binding,
    lane: "safari-macos-m2",
    assetId: "FW-MAC-M2-01",
    commit: binding.trustedSha,
  };
  const route = {
    applicationUrl: `https://mac-m2.webgpu-ci.forge3d.dev/runs/10/20/${nonce}/`,
    assetUrl: `https://assets-mac-m2.webgpu-ci.forge3d.dev/runs/10/20/${nonce}/`,
  };
  try {
    const outputPath = join(directory, "evidence.json");
    await executeHardwareBrowserLane({
      lane: safariBinding.lane,
      assetId: safariBinding.assetId,
      hostId: safariBinding.assetId,
      platform: "darwin",
      binding: safariBinding,
      route,
      browserPolicy: {
        prohibitedLaunchArguments: ["--ignore-certificate-errors"],
        tools: { safaridriver: "26.0" },
      },
      deviceMatrix: { devices: [] },
      inventory: {
        ...desktopInventory,
        assetId: "FW-MAC-M2-01",
        platform: "darwin",
        osBuild: "Darwin 25.0.0 checked",
        displayServer: "WindowServer",
        browsers: [{ id: "safari-stable", version: "26.0", executable: "/usr/bin/safaridriver" }],
        tools: { safaridriverVersion: "26.0" },
      },
      outputPath,
      dependencies: {
        openSession: async () => ({
          browser: { name: "safari", channel: "stable", version: "26.0" },
          driverVersion: "26.0",
          effectiveLaunchArguments: [],
          launchArgumentsObserved: true,
          launchArgumentSource: "darwin-live-browser-process",
          browserProcessId: 502,
          runPage: async (payload) => {
            assert.deepEqual(payload.binding, {
              lane: "safari-macos-m2", runId: 10, jobId: 20,
              assetId: "FW-MAC-M2-01", hostId: "FW-MAC-M2-01",
              commit: binding.trustedSha, packageSha256: binding.packageSha256,
            });
            return {
              adapter,
              assertions: { passed: true, supportAssertionsExecuted: true },
              saf02Proof: validSaf02Conformance({
                runId: 10, jobId: 20, commit: binding.trustedSha,
                packageSha256: binding.packageSha256, nonce,
              }),
              saf03Proof: validSaf03Proof({
                commit: binding.trustedSha,
                packageSha256: binding.packageSha256,
              }),
            };
          },
          runTechnologyPreview: async () => validAbsentStpResult(),
          close: async () => undefined,
        }),
      },
    });
    const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(evidence.saf02Proof.result, "PASS");
    assert.equal(evidence.saf03Proof.kind, "forge3d-saf03-safari-acceptance-v1");
    assert.equal(evidence.safariTechnologyPreview.result, "ABSENT");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opened browser session closes when provenance validation rejects it", async () => {
  let closed = 0;
  await assert.rejects(() => executeHardwareBrowserLane({
    lane: binding.lane, assetId: binding.assetId, hostId: binding.assetId,
    platform: "linux", binding: { ...binding, commit: binding.trustedSha },
    route: { applicationUrl: "https://example.invalid/run/" },
    browserPolicy: { prohibitedLaunchArguments: [], tools: { playwright: "1.56.1" } },
    deviceMatrix: { devices: [] }, inventory: { ...desktopInventory, headed: false },
    outputPath: "/tmp/unused-chr03-evidence.json",
    dependencies: {
      now: () => new Date(), waitUntil: async () => undefined,
      openSession: async () => ({
        browser: { name: "chrome", channel: "stable", version: "150.0.0.0" },
        driverVersion: "1.56.1", effectiveLaunchArguments: [], launchArgumentsObserved: true,
        launchArgumentSource: "chromium-cdp-browser-command-line", runPage: async () => { throw new Error("must not run"); },
        close: async () => { closed += 1; },
      }),
    },
  }), /headed session/u);
  assert.equal(closed, 1);
});

test("Edge runtime routes exact CHR-04 proof and rejects borrowed Chrome proof before PASS", async () => {
  assert.deepEqual(resolveLaneRuntime({ lane: "edge-linux-rtx3070", assetId: "FW-LNX-NV-01", platform: "linux" }), {
    driver: "playwright-edge", browser: "msedge", supportAssertions: true, manual: false, mobile: false,
  });
  const directory = mkdtempSync(join(tmpdir(), "forge3d-chr04-runtime-"));
  let mutateProof = () => undefined;
  try {
    const edgeBinding = { ...binding, lane: "edge-linux-rtx3070", commit: binding.trustedSha };
    const request = {
      lane: edgeBinding.lane, assetId: edgeBinding.assetId, hostId: edgeBinding.assetId, platform: "linux",
      binding: edgeBinding,
      route: { applicationUrl: "https://edge.example/run/" },
      browserPolicy: { prohibitedLaunchArguments: ["--enable-unsafe-webgpu", "--ignore-certificate-errors"], tools: { playwright: "1.56.1" } },
      deviceMatrix: { devices: [] },
      inventory: { ...desktopInventory, browsers: [{ id: "edge-stable", version: "150.0.0.0", executable: "/usr/bin/microsoft-edge" }] },
      outputPath: join(directory, "edge.json"),
      dependencies: { openSession: async () => ({
        browser: { name: "msedge", channel: "stable", version: "150.0.0.0" }, driverVersion: "1.56.1",
        effectiveLaunchArguments: [], launchArgumentsObserved: true,
        launchArgumentSource: "chromium-cdp-browser-command-line", browserProcessId: 77,
        runPage: async (payload) => {
          assert.equal(payload.binding.platform, "linux");
          const proof = validChr04HardwareProof({ lane: edgeBinding.lane, assetId: edgeBinding.assetId,
            platform: "linux", commit: edgeBinding.commit, packageSha256: edgeBinding.packageSha256 });
          mutateProof(proof);
          return { adapter, assertions: { passed: true, supportAssertionsExecuted: true }, chr04Proof: proof };
        },
        close: async () => undefined,
      }) },
    };
    await executeHardwareBrowserLane(request);
    assert.equal(JSON.parse(readFileSync(request.outputPath, "utf8")).chr04Proof.binding.platform, "linux");
    for (const [name, mutate] of [
      ["borrowed", (proof) => { proof.kind = "forge3d-chr03-chrome-hardware-proof-v1"; }],
      ["touch", (proof) => { proof.edgeAcceptance.touch.viewChanged = false; }],
      ["code", (proof) => { proof.edgeAcceptance.unsupported.nullAdapter.publicCode = "WEBGPU_UNAVAILABLE"; }],
      ["ui", (proof) => { proof.edgeAcceptance.unsupported.nullAdapter.unsupportedVisible = false; }],
      ["bypass", (proof) => { proof.edgeAcceptance.unsupported.nullAdapter.hasBypassAdvice = true; }],
    ]) {
      mutateProof = mutate;
      await assert.rejects(() => executeHardwareBrowserLane({ ...request, outputPath: join(directory, `${name}.json`) }));
    }
    mutateProof = () => undefined;
    const unsafe = { ...request, outputPath: join(directory, "certificate.json") };
    unsafe.dependencies = { openSession: async () => ({
      ...(await request.dependencies.openSession()), effectiveLaunchArguments: ["--ignore-certificate-errors=value"],
    }) };
    await assert.rejects(() => executeHardwareBrowserLane(unsafe), /prohibited browser launch arguments/u);
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
        expectedTester: "tester-login",
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
        osVersion: "26.0",
        osBuild: "Darwin 25.0.0 checked",
        architecture: "arm64",
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
        announceManualReadiness: async ({ readiness }) => {
          assert.equal(readiness.fixtureReady, true);
          assert.equal(readiness.mediaChallenge, challenge);
        },
        waitForControllerWindow: async () => ({
          startedAt: "2026-07-29T10:00:00.000Z",
          endedAt: "2026-07-29T10:20:00.000Z",
        }),
        waitUntil: async (end, assertHealthy) => {
          await assertHealthy();
          waits.push(end.toISOString());
        },
        openSession: async () => ({
          browser: { name: "safari", channel: "stable", version: "26.0" },
          driverVersion: "10.0.0",
          effectiveLaunchArguments: [],
          launchArgumentsObserved: true,
          launchArgumentSource: "appium-effective-session-capabilities",
          browserProcessId: null,
          device: { assetId: "FW-IOS-OLD-01" },
          assertHealthy: async () => undefined,
          runPage: async (payload) => {
            assert.equal(payload.lane, "manual-mobile-multitouch");
            assert.equal(payload.binding.lane, undefined);
            assert.equal(payload.sessionContext.expectedTester, "tester-login");
            return {
              adapter,
              assertions: {
                passed: true,
                supportAssertionsExecuted: false,
              },
              routeReadiness: { trustedHttps: true },
              watermark: {
                mediaChallenge: challenge,
                nonDismissable: true,
                overlayTarget: "viewer-shell-not-canvas",
                visible: true,
              },
            };
          },
          close: async () => undefined,
        }),
      },
    });
    const input = JSON.parse(
      readFileSync(join(directory, "manual-input.json"), "utf8"),
    );
    assert.equal(Object.hasOwn(input, "startedAt"), false);
    assert.equal(Object.hasOwn(input, "endedAt"), false);
    assert.deepEqual(waits, ["2026-07-29T10:20:00.000Z"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Safari product manual lane reaches page composition without changing attestation binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-safari-manual-"));
  const challenge = "ef".repeat(16);
  try {
    await executeHardwareBrowserLane({
      lane: "manual-safari-trackpad",
      assetId: "FW-TRACKPAD-01",
      hostId: "FW-MAC-M2-01",
      platform: "darwin",
      binding: {
        ...binding,
        lane: "manual-safari-trackpad",
        assetId: "FW-TRACKPAD-01",
        expectedTester: "tester-login",
      },
      route: { applicationUrl: "https://example.invalid/run/" },
      browserPolicy: { prohibitedLaunchArguments: [], tools: {} },
      deviceMatrix: { devices: [] },
      inventory: {
        ...desktopInventory,
        assetId: "FW-MAC-M2-01",
        platform: "darwin",
        osVersion: "26.0",
        osBuild: "Darwin 25.0.0 checked",
        architecture: "arm64",
        displayServer: "WindowServer",
        tools: { safaridriverVersion: "26.0" },
        browsers: [{ id: "safari-stable", version: "26.0", executable: "/usr/bin/safaridriver" }],
      },
      mediaChallenge: challenge,
      outputPath: join(directory, "evidence.json"),
      manualSessionInputPath: join(directory, "manual-input.json"),
      watermarkPath: join(directory, "watermark.json"),
      dependencies: {
        announceManualReadiness: async () => undefined,
        waitForControllerWindow: async () => ({ startedAt: "2026-07-29T10:00:00.000Z", endedAt: "2026-07-29T10:20:00.000Z" }),
        waitUntil: async () => undefined,
        openSession: async () => ({
          browser: { name: "safari", channel: "stable", version: "26.0" },
          driverVersion: "26.0",
          effectiveLaunchArguments: [],
          launchArgumentsObserved: true,
          launchArgumentSource: "darwin-live-browser-process",
          browserProcessId: null,
          runPage: async (payload) => {
            assert.equal(payload.lane, "manual-safari-trackpad");
            assert.equal(payload.binding.lane, undefined);
            return {
              adapter,
              assertions: { passed: true, submittedFrame: true, runtimeReady: true },
              routeReadiness: { trustedHttps: true },
              watermark: { mediaChallenge: challenge, visible: true },
            };
          },
          close: async () => undefined,
        }),
      },
    });
    assert.equal(existsSync(join(directory, "manual-input.json")), true);
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
