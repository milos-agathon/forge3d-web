import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  createHash,
} from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createManualFinalizerRecord,
  pollRunnerAbsent,
  verifySignedManualSession,
} from "../../scripts/finalize-manual-session.mjs";
import { createManualSession } from "../../../../tools/browser-lab-controller/src/manual-session.mjs";
import { createTestPrivateKeySigner } from "../../../../tools/browser-lab-controller/test/test-signer.mjs";
import { exactHostInventory } from "./host-inventory-fixture.mjs";
import {
  diagnosticRetentionFixture,
  serviceInstallationFixture,
} from "./service-installation-fixture.mjs";

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicJwk = keys.publicKey.export({ format: "jwk" });
const keyId = "controller-fw-mac-m2-01-p256-v1";
const matrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const matrixHost = matrix.hosts.find(
  (host) => host.assetId === "FW-MAC-M2-01",
);
matrixHost.controller = { state: "online", signingKeyId: keyId, publicJwk };
const hostInventory = exactHostInventory(matrix, "FW-MAC-M2-01");
const authorization = {
  record: {
    workflow: { sha: "c".repeat(40) },
    run: { id: 20, attempt: 1 },
    queuedHardwareJob: { id: 21 },
    runnerName: `FW-MAC-M2-01-${"d".repeat(32)}`,
    runnerNonce: "d".repeat(32),
    trustedSha: "a".repeat(40),
    packageRunId: 10,
    lane: "manual-safari-trackpad",
    hostId: "FW-MAC-M2-01",
    assetId: "FW-TRACKPAD-01",
    manualSession: {
      mediaChallenge: "9".repeat(32),
      intakeManifestSha256: "2".repeat(64),
    },
    labReadiness: {
      runId: 5,
      manifestSha256: "5".repeat(64),
      labInfrastructureDigest: "6".repeat(64),
    },
  },
  sha256: "1".repeat(64),
};
const intake = {
  trustedSha: authorization.record.trustedSha,
  packageSha256: "b".repeat(64),
  hostId: authorization.record.hostId,
  assetId: authorization.record.assetId,
  mediaChallenge: authorization.record.manualSession.mediaChallenge,
  sha256: authorization.record.manualSession.intakeManifestSha256,
};
const signedSession = createManualSession({
  authorization: {
    ...authorization.record,
    sha256: authorization.sha256,
  },
  intake,
  runner: { id: 44, name: authorization.record.runnerName },
  system: { os: hostInventory.platform, build: hostInventory.osBuild },
  loginSession: { interactive: true, locked: false, remote: false },
  browser: { name: "Safari", channel: "stable", version: "26.0" },
  driver: { name: "safaridriver", version: "26.0" },
  origins: { application: "https://app.example", asset: "https://asset.example" },
  routeBasePath: `/runs/20/21/${"e".repeat(32)}/`,
  packageRecord: {
    runId: 10,
    sha256: intake.packageSha256,
    harnessSha256: "f".repeat(64),
  },
  startedAt: "2026-07-29T10:00:00.000Z",
  endedAt: "2026-07-29T10:20:00.000Z",
  cleanup: {
    browserStopped: true,
    driverStopped: true,
    fixtureStopped: true,
    tunnelStopped: true,
    updatesRestored: true,
    runnerAbsent: true,
  },
  installations: {
    controller: serviceInstallationFixture({
      component: "controller",
      instanceId: authorization.record.hostId,
      targetSha: authorization.record.trustedSha,
      inventory: hostInventory,
    }),
    broker: serviceInstallationFixture({
      component: "broker",
      instanceId: "browser-lab-broker",
      targetSha: authorization.record.trustedSha,
    }),
  },
  diagnosticRetention: diagnosticRetentionFixture({
    authorizationDigest: authorization.sha256,
    hostId: authorization.record.hostId,
    run: authorization.record.run,
    runnerNonce: authorization.record.runnerNonce,
    retainedAt: "2026-07-29T10:20:30.000Z",
  }),
  controllerCompletion: {
    state: "completed",
    brokerCleanup: "deleted",
    runnerAbsent: true,
    workRootWiped: true,
    hostCleanupComplete: true,
    hostLockReleased: true,
    quarantined: false,
    completedAt: "2026-07-29T10:21:00.000Z",
  },
  hostInventory,
  signer: createTestPrivateKeySigner({
    privateKey: keys.privateKey,
    signingKeyId: keyId,
  }),
});
const hardwareJob = {
  id: 21,
  name: "Browser Hardware / Ephemeral Execution",
  status: "completed",
  conclusion: "success",
  runner_id: 44,
  runner_name: authorization.record.runnerName,
};
test("finalizer verifies controller signature, exact job tuple, and absent runner", async () => {
  const session = verifySignedManualSession({
    signedSession,
    authorization,
    hardwareJob,
    matrix,
    hostInventory,
  });
  let time = 0;
  const replies = [
    apiResponse(200, {
      id: 44,
      name: authorization.record.runnerName,
    }),
    apiResponse(404, { message: "Not Found" }),
  ];
  const observations = await pollRunnerAbsent({
    repository: "milos-agathon/forge3d-web",
    token: "installation-token",
    runner: session.runner,
    fetchImpl: async () => replies.shift(),
    delayImpl: async () => {
      time += 5_000;
    },
    now: () => new Date(1_000 + time),
  });
  const record = createManualFinalizerRecord({
    session,
    terminalJobState: "success",
    absenceObservations: observations,
    finalizer: {
      workflowSha: "c".repeat(40),
      run: { id: 20, attempt: 1 },
      job: "finalize-manual-session",
      environment: "forge3d-trust-observer",
      observedAt: "2026-07-29T10:21:00.000Z",
    },
  });
  assert.equal(record.absenceObservations.at(-1).status, 404);
  assert.equal(record.runner.id, 44);
});

test("wrong job tuple, unpinned key, missing token, and five-minute presence fail", async () => {
  assert.throws(() =>
    verifySignedManualSession({
      signedSession,
      authorization,
      hardwareJob: { ...hardwareJob, runner_name: "other" },
      matrix,
      hostInventory,
    }),
  );
  assert.throws(
    () =>
      verifySignedManualSession({
        signedSession,
        authorization: {
          ...authorization,
          record: {
            ...authorization.record,
            labReadiness: {
              ...authorization.record.labReadiness,
              manifestSha256: "0".repeat(64),
            },
          },
        },
        hardwareJob,
        matrix,
        hostInventory,
      }),
    /runner authorization/u,
  );
  assert.throws(() =>
    verifySignedManualSession({
      signedSession,
      authorization,
      hardwareJob,
      hostInventory,
      matrix: {
        ...matrix,
        hosts: matrix.hosts.map((host) =>
          host.assetId === "FW-MAC-M2-01"
            ? {
                ...host,
                controller: { ...host.controller, state: "unprovisioned" },
              }
            : host,
        ),
      },
    }),
  );
  await assert.rejects(() =>
    pollRunnerAbsent({
      repository: "milos-agathon/forge3d-web",
      token: "",
      runner: signedSession.record.runner,
    }),
  );
  let time = 0;
  await assert.rejects(
    () =>
      pollRunnerAbsent({
        repository: "milos-agathon/forge3d-web",
        token: "installation-token",
        runner: signedSession.record.runner,
        timeoutMs: 300_000,
        fetchImpl: async () =>
          apiResponse(200, {
            id: 44,
            name: authorization.record.runnerName,
          }),
        delayImpl: async () => {
          time += 300_000;
        },
        now: () => new Date(time),
      }),
    /five minutes/u,
  );
});

function apiResponse(status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    status,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
