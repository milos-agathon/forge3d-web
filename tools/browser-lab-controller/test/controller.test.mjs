import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  BrowserLabController,
  validateAuthorization,
} from "../src/controller.mjs";
import { sanitizedRunnerEnvironment } from "../src/runner-execution.mjs";

const nonce = "ab".repeat(16);
const authorization = {
  schemaVersion: 1,
  repository: { id: 1259761852, name: "milos-agathon/forge3d-web" },
  workflow: {
    path: ".github/workflows/browser-hardware.yml",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
    event: "workflow_dispatch",
  },
  run: { id: 10, attempt: 1 },
  queuedHardwareJob: {
    id: 11,
    name: "Browser Hardware / Ephemeral Execution",
    status: "queued",
  },
  trustedSha: "b".repeat(40),
  trustEpochSha: "c".repeat(40),
  packageManifestSha256: "d".repeat(64),
  hostId: "FW-LNX-NV-01",
  runnerNonce: nonce,
  nonceLabel: `jit-${nonce}`,
  runnerName: `FW-LNX-NV-01-${nonce}`,
  customLabels: ["forge3d-web", "hw-linux-rtx3070", `jit-${nonce}`],
  workFolder: "_work",
  repositoryJitRunnerGroupId: 1,
  issuedAt: "2026-07-29T10:00:00.000Z",
  expiresAt: "2026-07-29T10:10:00.000Z",
};

test("controller validates exact host, workflow, nonce labels, and ten-minute expiry", () => {
  assert.doesNotThrow(() =>
    validateAuthorization(
      authorization,
      authorization.hostId,
      new Date("2026-07-29T10:05:00.000Z"),
    ),
  );
  assert.throws(
    () =>
      validateAuthorization(
        { ...authorization, hostId: "FW-LNX-I12-01" },
        authorization.hostId,
        new Date("2026-07-29T10:05:00.000Z"),
      ),
    /different controller host/u,
  );
  assert.throws(
    () =>
      validateAuthorization(
        authorization,
        authorization.hostId,
        new Date("2026-07-29T10:10:00.000Z"),
      ),
    /expired/u,
  );
});

test("runner receives only checked runtime controls including dedicated WDA signing", () => {
  const environment = sanitizedRunnerEnvironment({
    PATH: "/usr/bin",
    FORGE3D_WDA_SIGNING_TEAM_ID: "TEAM",
    FORGE3D_WDA_BUNDLE_ID: "dev.forge3d.wda",
    FORGE3D_CLOUDFLARED_TOKEN: "secret",
    UNRELATED_SECRET: "must-not-cross",
  });
  assert.equal(environment.FORGE3D_WDA_SIGNING_TEAM_ID, "TEAM");
  assert.equal(environment.FORGE3D_WDA_BUNDLE_ID, "dev.forge3d.wda");
  assert.equal(environment.FORGE3D_CLOUDFLARED_TOKEN, "secret");
  assert.equal(Object.hasOwn(environment, "UNRELATED_SECRET"), false);
});

test("controller starts only run.sh --jitconfig, scrubs argv, and proves cleanup", async () => {
  const calls = [];
  const dependencies = successfulDependencies(calls);
  const controller = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });
  const result = await controller.execute(structuredClone(authorization));
  assert.equal(result.deletionResult, "deleted");
  const spawn = calls.find(([name]) => name === "spawn");
  assert.equal(spawn[1].command, "./run.sh");
  assert.equal(spawn[1].args[0], "--jitconfig");
  assert.equal(spawn[1].args[1], "<scrubbed>");
  assert.equal(spawn[1].shell, false);
  assert.equal(spawn[1].echo, false);
  assert.ok(calls.find(([name]) => name === "verify-before"));
  assert.ok(calls.find(([name]) => name === "verify-after"));
  assert.ok(calls.find(([name]) => name === "forward-diagnostics"));
  assert.ok(calls.find(([name]) => name === "wipe"));
  assert.ok(calls.find(([name]) => name === "release-lock"));
});

test("controller stores a signed host canary only after broker-proven runner absence", async () => {
  const calls = [];
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const dependencies = successfulDependencies(calls);
  dependencies.readHostCanaryInput = async () => ({
    browserEvidence: {
      result: "PASS",
      packageSha256: "d".repeat(64),
      assertions: { supportAssertionsExecuted: false },
      adapter: {
        isFallbackAdapter: false,
        deviceCreated: true,
        surfacePresented: true,
      },
    },
    adapterAttestation: hostAdapterAttestation({
      runId: authorization.run.id,
      assetId: authorization.hostId,
      commit: authorization.trustedSha,
      packageSha256: "d".repeat(64),
      hostId: authorization.hostId,
    }),
    inventory: {
      hostId: authorization.hostId,
      attachedAssetIds: [],
    },
    route: {
      httpsVerified: true,
      corsRangeControlsPassed: true,
    },
    execution: {},
  });
  dependencies.controllerSigningCredentials = async () => ({
    privateKey: keys.privateKey,
    signingKeyId: "controller-fw-lnx-nv-01-p256-v1",
  });
  dependencies.storeControllerReceipt = async (receipt) =>
    calls.push(["store-receipt", receipt]);
  const controller = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });
  const canaryAuthorization = {
    ...structuredClone(authorization),
    lane: "infrastructure-canary",
    manualSession: null,
    assetId: authorization.hostId,
    packageRunId: 12,
  };
  const result = await controller.execute(canaryAuthorization);
  const cleanupIndex = calls.findIndex(([name]) => name === "broker-cleanup");
  const storeIndex = calls.findIndex(([name]) => name === "store-receipt");
  assert.ok(cleanupIndex >= 0 && storeIndex > cleanupIndex);
  assert.match(result.controllerReceiptSha256, /^[0-9a-f]{64}$/u);
  const receipt = calls[storeIndex][1];
  assert.equal(receipt.signedRecord.record.runner.absentAfterRun, true);
  assert.equal(receipt.signedRecord.record.supportAssertionsExecuted, false);
});

test("controller creates the signed manual session after hardware and runner cleanup", async () => {
  const calls = [];
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const dependencies = successfulDependencies(calls);
  dependencies.readManualSessionInput = async () => ({
    system: { os: "macOS", build: "25A123" },
    loginSession: { interactive: true, locked: false, remote: false },
    browser: { name: "safari", channel: "stable", version: "26.0" },
    driver: { name: "safaridriver", version: "26.0" },
    origins: {
      application: "https://mac-m2.webgpu-ci.forge3d.dev",
      asset: "https://assets-mac-m2.webgpu-ci.forge3d.dev",
    },
    routeBasePath: `/runs/10/11/${"e".repeat(32)}/`,
    packageRecord: {
      runId: 12,
      sha256: "f".repeat(64),
      harnessSha256: "8".repeat(64),
    },
    startedAt: "2026-07-29T10:00:00.000Z",
    endedAt: "2026-07-29T10:20:00.000Z",
    cleanup: {
      browserStopped: true,
      driverStopped: true,
      fixtureStopped: true,
      tunnelStopped: true,
      updatesRestored: true,
    },
  });
  dependencies.controllerSigningCredentials = async () => ({
    privateKey: keys.privateKey,
    signingKeyId: "controller-fw-mac-m2-01-p256-v1",
  });
  dependencies.storeControllerReceipt = async (receipt) =>
    calls.push(["store-receipt", receipt]);
  const controller = new BrowserLabController({
    hostId: "FW-MAC-M2-01",
    platform: "darwin",
    dependencies,
    now: () => new Date("2026-07-29T10:20:01.000Z"),
  });
  const manualAuthorization = {
    ...structuredClone(authorization),
    hostId: "FW-MAC-M2-01",
    runnerName: `FW-MAC-M2-01-${nonce}`,
    customLabels: ["forge3d-web", "hw-macos-m2", `jit-${nonce}`],
    lane: "manual-safari-trackpad",
    assetId: "FW-TRACKPAD-01",
    packageRunId: 12,
    labReadiness: {
      runId: 9,
      labInfrastructureDigest: "7".repeat(64),
    },
    manualSession: {
      intakeReleaseId: 14,
      checklistId: "safari-trackpad",
      mediaChallenge: "9".repeat(32),
      intakeManifestSha256: "6".repeat(64),
    },
    issuedAt: "2026-07-29T10:15:00.000Z",
    expiresAt: "2026-07-29T10:25:00.000Z",
  };
  dependencies.broker.issue = async () => ({
    runnerId: 7,
    runnerName: manualAuthorization.runnerName,
    encodedJitConfig: "opaque-jit-config",
  });
  const result = await controller.execute(manualAuthorization);
  const cleanupIndex = calls.findIndex(([name]) => name === "broker-cleanup");
  const storeIndex = calls.findIndex(([name]) => name === "store-receipt");
  assert.ok(cleanupIndex >= 0 && storeIndex > cleanupIndex);
  assert.match(result.controllerReceiptSha256, /^[0-9a-f]{64}$/u);
  const receipt = calls[storeIndex][1];
  assert.equal(receipt.recordType, "manual-session");
  assert.equal(receipt.signedRecord.record.cleanup.runnerAbsent, true);
  assert.equal(receipt.signedRecord.record.mediaChallenge, "9".repeat(32));
});

test("online-unassigned requires stopped listener, queued job, non-busy runner, and cancellation", async () => {
  const calls = [];
  const dependencies = successfulDependencies(calls);
  dependencies.monitorOneJob = async () => ({
    reason: "online_unassigned",
    listenerStopped: true,
    jobStillQueued: true,
    runnerBusy: false,
    listenerStopEvidence: {
      attempted: true,
      stopped: true,
      processId: 1,
      observedAt: "2026-07-29T10:05:00.000Z",
    },
  });
  dependencies.broker.cleanup = async (request) => {
    calls.push(["broker-cleanup", request]);
    return { deletionResult: "deleted", cancellationResult: "cancelled" };
  };
  const controller = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });
  const result = await controller.execute(structuredClone(authorization));
  assert.equal(result.cancellationResult, "cancelled");

  const unsafeDependencies = successfulDependencies([]);
  unsafeDependencies.monitorOneJob = async () => ({
    reason: "online_unassigned",
    listenerStopped: false,
    jobStillQueued: true,
    runnerBusy: false,
  });
  const unsafe = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies: unsafeDependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });
  await assert.rejects(
    () => unsafe.execute(structuredClone(authorization)),
    /lacks fail-closed predicates/u,
  );
});

test("busy or unproven broker cleanup quarantines and retains the host lock", async () => {
  const calls = [];
  const dependencies = successfulDependencies(calls);
  dependencies.broker.cleanup = async () => ({
    deletionResult: "quarantined",
  });
  const controller = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });
  await assert.rejects(
    () => controller.execute(structuredClone(authorization)),
    /did not prove runner absence/u,
  );
  assert.ok(calls.find(([name]) => name === "quarantine"));
  assert.equal(calls.some(([name]) => name === "release-lock"), false);
});

test("unproven local runner absence quarantines without wiping its job root", async () => {
  const calls = [];
  const dependencies = successfulDependencies(calls);
  dependencies.stopRunner = async () => {
    calls.push(["stop-failed"]);
    throw new Error("runner process group is still present");
  };
  const controller = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });
  await assert.rejects(
    () => controller.execute(structuredClone(authorization)),
    /runner process group is still present/u,
  );
  assert.equal(
    calls.filter(([name]) => name === "stop-failed").length,
    2,
  );
  assert.ok(calls.find(([name]) => name === "quarantine"));
  assert.equal(calls.some(([name]) => name === "wipe"), false);
  assert.equal(calls.some(([name]) => name === "wipe-prepared"), false);
  assert.equal(calls.some(([name]) => name === "release-lock"), false);
});

test("lost JIT issuance response reconciles the broker before wipe and lock release", async () => {
  const calls = [];
  const dependencies = successfulDependencies(calls);
  dependencies.broker.issue = async () => {
    calls.push(["broker-issue-response-lost"]);
    throw new Error("broker JIT response was lost after issuance");
  };
  const controller = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });

  await assert.rejects(
    () => controller.execute(structuredClone(authorization)),
    /response was lost/u,
  );
  const cleanupIndex = calls.findIndex(([name]) => name === "broker-cleanup");
  const wipeIndex = calls.findIndex(([name]) => name === "wipe-prepared");
  const releaseIndex = calls.findIndex(([name]) => name === "release-lock");
  assert.ok(cleanupIndex >= 0);
  assert.ok(wipeIndex > cleanupIndex);
  assert.ok(releaseIndex > wipeIndex);
  assert.equal(calls.some(([name]) => name === "spawn"), false);
});

test("unreconciled JIT issuance quarantines without wipe or lock release", async () => {
  const calls = [];
  const dependencies = successfulDependencies(calls);
  dependencies.broker.issue = async () => {
    calls.push(["broker-issue-response-lost"]);
    throw new Error("broker JIT response was lost after issuance");
  };
  dependencies.broker.cleanup = async (request) => {
    calls.push(["broker-cleanup", request]);
    throw new Error("broker reconciliation unavailable");
  };
  const controller = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });

  await assert.rejects(
    () => controller.execute(structuredClone(authorization)),
    /response was lost/u,
  );
  assert.ok(calls.find(([name]) => name === "broker-cleanup"));
  assert.ok(calls.find(([name]) => name === "quarantine"));
  assert.equal(calls.some(([name]) => name === "wipe-prepared"), false);
  assert.equal(calls.some(([name]) => name === "release-lock"), false);
  assert.equal(calls.some(([name]) => name === "spawn"), false);
});

test("failed launch handshake cannot clean the broker or wipe without bridge absence proof", async () => {
  const calls = [];
  const dependencies = successfulDependencies(calls);
  dependencies.spawnRunner = async () => {
    calls.push(["spawn-failed"]);
    throw new Error("bridge returned no launch receipt");
  };
  const controller = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });

  await assert.rejects(
    () => controller.execute(structuredClone(authorization)),
    /no launch receipt/u,
  );
  assert.equal(calls.some(([name]) => name === "broker-cleanup"), false);
  assert.equal(calls.some(([name]) => name === "wipe-prepared"), false);
  assert.equal(calls.some(([name]) => name === "release-lock"), false);
  assert.ok(calls.find(([name]) => name === "quarantine"));
});

test("failed launch handshake cleans only after checked bridge termination evidence", async () => {
  const calls = [];
  const dependencies = successfulDependencies(calls);
  dependencies.spawnRunner = async () => {
    calls.push(["spawn-failed-clean"]);
    const error = new Error("bridge rejected its launch receipt");
    error.runnerAbsenceProven = true;
    error.listenerStopEvidence = {
      attempted: true,
      stopped: true,
      processId: 901,
      observedAt: "2026-07-29T10:05:00.000Z",
    };
    throw error;
  };
  const controller = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });

  await assert.rejects(
    () => controller.execute(structuredClone(authorization)),
    /rejected its launch receipt/u,
  );
  const cleanup = calls.find(([name]) => name === "broker-cleanup");
  assert.deepEqual(cleanup[1].listenerStop, {
    attempted: true,
    stopped: true,
    processId: 901,
    observedAt: "2026-07-29T10:05:00.000Z",
  });
  assert.ok(calls.find(([name]) => name === "wipe-prepared"));
  assert.ok(calls.find(([name]) => name === "release-lock"));
});

test("failed unconditional host cleanup cannot release the lock", async () => {
  const calls = [];
  const dependencies = successfulDependencies(calls);
  dependencies.cleanupHost = async () => {
    calls.push(["cleanup-host-failed"]);
    throw new Error("update restore failed");
  };
  const controller = new BrowserLabController({
    hostId: authorization.hostId,
    platform: "linux",
    dependencies,
    now: () => new Date("2026-07-29T10:05:00.000Z"),
  });
  await assert.rejects(
    () => controller.execute(structuredClone(authorization)),
    /update restore failed/u,
  );
  assert.equal(calls.some(([name]) => name === "release-lock"), false);
});

function successfulDependencies(calls) {
  return {
    acquireHostLock: async () => ({
      release: async () => calls.push(["release-lock"]),
    }),
    prepareJobRoot: async () => ({
      runnerDirectory: "/controller/jobs/nonce/runner",
    }),
    verifyRunnerDistribution: async ({ phase }) =>
      calls.push([`verify-${phase}`]),
    broker: {
      issue: async () => ({
        runnerId: 7,
        runnerName: authorization.runnerName,
        encodedJitConfig: "opaque-jit-config",
      }),
      cleanup: async (request) => {
        calls.push(["broker-cleanup", request]);
        return { deletionResult: "deleted", cancellationResult: null };
      },
    },
    spawnRunner: async (options) => {
      calls.push(["spawn", options]);
      return { pid: 42 };
    },
    runnerEnvironment: () => ({ PATH: "/usr/bin" }),
    monitorOneJob: async () => ({
      reason: "completed",
      listenerStopEvidence: {
        attempted: true,
        stopped: true,
        processId: 42,
        observedAt: "2026-07-29T10:05:00.000Z",
      },
    }),
    stopRunner: async () => calls.push(["stop"]),
    forwardDiagnostics: async () => calls.push(["forward-diagnostics"]),
    wipeJobRoot: async () => calls.push(["wipe"]),
    wipePreparedJobRoot: async () => calls.push(["wipe-prepared"]),
    cleanupHost: async (request) => calls.push(["cleanup-host", request]),
    quarantineHost: async (request) => calls.push(["quarantine", request]),
  };
}

function hostAdapterAttestation({
  runId,
  assetId,
  commit,
  packageSha256,
  hostId,
}) {
  return {
    result: "PASS",
    required: true,
    binding: { runId, assetId, commit, packageSha256 },
    host: {
      hostId,
      expectedGpuPresent: true,
      headedSessionAvailable: true,
    },
  };
}
