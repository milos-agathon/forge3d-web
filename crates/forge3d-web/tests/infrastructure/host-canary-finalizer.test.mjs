import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { finalizeHostLabCanary } from "../../scripts/finalize-host-lab-canary.mjs";
import { createHostLabCanary } from "../../../../tools/browser-lab-controller/src/lab-canary.mjs";
import { exactHostInventory } from "./host-inventory-fixture.mjs";
import {
  checkedHostRouteFixture,
  completeRouteReadinessFixture,
  diagnosticRetentionFixture,
  serviceInstallationFixture,
} from "./service-installation-fixture.mjs";

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const hostId = "FW-LNX-NV-01";
const keyId = "controller-fw-lnx-nv-01-p256-v1";
const matrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const originPolicy = JSON.parse(
  readFileSync(new URL("./https-origin-policy.json", import.meta.url), "utf8"),
);
const matrixHost = matrix.hosts.find((host) => host.assetId === hostId);
matrixHost.controller = {
  state: "online",
  signingKeyId: keyId,
  publicJwk: keys.publicKey.export({ format: "jwk" }),
};
const inventory = exactHostInventory(matrix, hostId);
const route = checkedHostRouteFixture({
  originPolicy,
  hostId,
  runId: 20,
  jobId: 21,
  packageSha256: "d".repeat(64),
});
const authorization = {
  record: {
    workflow: { sha: "a".repeat(40) },
    run: { id: 20, attempt: 2 },
    runnerNonce: "e".repeat(32),
    queuedHardwareJob: { id: 21 },
    lane: "infrastructure-canary",
    manualSession: null,
    hostId,
    assetId: hostId,
    trustedSha: "b".repeat(40),
    packageRunId: 12,
  },
  sha256: "c".repeat(64),
};
const signedRecord = createHostLabCanary({
  authorization: {
    ...authorization.record,
    sha256: authorization.sha256,
  },
  browserEvidence: {
    result: "PASS",
    packageSha256: "d".repeat(64),
    assertions: { supportAssertionsExecuted: false },
    adapter: {
      isFallbackAdapter: false,
      deviceCreated: true,
      surfacePresented: true,
    },
    route: { ...route, expectedPackageSha256: route.packageSha256 },
    routeReadiness: completeRouteReadinessFixture(),
  },
  adapterAttestation: {
    result: "PASS",
    required: true,
    binding: {
      runId: authorization.record.run.id,
      assetId: hostId,
      commit: authorization.record.trustedSha,
      packageSha256: "d".repeat(64),
    },
    host: {
      hostId,
      expectedGpuPresent: true,
      headedSessionAvailable: true,
    },
  },
  inventory,
  route,
  originPolicy,
  execution: {
    acceptedJobCount: 1,
    cleanupComplete: true,
    runnerId: 31,
    runnerName: `${hostId}-${"e".repeat(32)}`,
    runnerAbsent: true,
  },
  installations: {
    controller: serviceInstallationFixture({
      component: "controller",
      instanceId: hostId,
      targetSha: authorization.record.trustedSha,
      inventory,
    }),
    broker: serviceInstallationFixture({
      component: "broker",
      instanceId: "browser-lab-broker",
      targetSha: authorization.record.trustedSha,
    }),
  },
  diagnosticRetention: diagnosticRetentionFixture({
    authorizationDigest: authorization.sha256,
    hostId,
    run: authorization.record.run,
    runnerNonce: authorization.record.runnerNonce,
  }),
  controllerCompletion: {
    state: "completed",
    brokerCleanup: "deleted",
    runnerAbsent: true,
    workRootWiped: true,
    hostCleanupComplete: true,
    hostLockReleased: true,
    quarantined: false,
    completedAt: "2026-07-29T10:01:00.000Z",
  },
  privateKey: keys.privateKey,
  signingKeyId: keyId,
});
const hardwareJob = {
  id: 21,
  name: "Browser Hardware / Ephemeral Execution",
  status: "completed",
  conclusion: "success",
  runner_id: 31,
  runner_name: signedRecord.record.runner.name,
  started_at: "2026-07-29T07:50:00.000Z",
  completed_at: "2026-07-29T10:00:00.000Z",
};
const finalizer = {
  workflowSha: authorization.record.workflow.sha,
  run: authorization.record.run,
  job: "finalize-hardware-evidence",
  environment: "forge3d-trust-observer",
  observedAt: "2026-07-29T11:00:00.000Z",
};

test("host finalizer joins controller signature, exact job, and independent absence", () => {
  const result = finalizeHostLabCanary({
    signedRecord,
    authorization,
    hardwareJob,
    matrix,
    inventory,
    absenceObservations: [{ status: 404, sha256: "f".repeat(64) }],
    finalizer,
  });
  assert.equal(result.attestation.verified, true);
  assert.equal(result.controller.signatureVerified, true);
  assert.equal(result.finalizer.absenceObservations.at(-1).status, 404);
});

test("host finalizer rejects a substituted runner or missing absence", () => {
  assert.throws(() =>
    finalizeHostLabCanary({
      signedRecord,
      authorization,
      hardwareJob: { ...hardwareJob, runner_id: 99 },
      matrix,
      inventory,
      absenceObservations: [{ status: 200 }],
      finalizer,
    }),
  );
});
