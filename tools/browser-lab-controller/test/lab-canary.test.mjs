import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createHostLabCanary } from "../src/lab-canary.mjs";
import { verifyControllerRecord } from "../../../crates/forge3d-web/scripts/verify-controller-record.mjs";
import { exactHostInventory } from "../../../crates/forge3d-web/tests/infrastructure/host-inventory-fixture.mjs";
import {
  checkedHostRouteFixture,
  completeRouteReadinessFixture,
  diagnosticRetentionFixture,
  serviceInstallationFixture,
} from "../../../crates/forge3d-web/tests/infrastructure/service-installation-fixture.mjs";

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const keyId = "controller-fw-lnx-nv-01-p256-v1";
const hostId = "FW-LNX-NV-01";
const matrix = JSON.parse(
  readFileSync(
    new URL(
      "../../../crates/forge3d-web/tests/infrastructure/hardware-matrix.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const originPolicy = JSON.parse(
  readFileSync(
    new URL(
      "../../../crates/forge3d-web/tests/infrastructure/https-origin-policy.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const deviceMatrix = JSON.parse(
  readFileSync(
    new URL(
      "../../../crates/forge3d-web/tests/device/device-matrix.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("host canary is controller-signed, non-support, and signature-verifiable", () => {
  const runnerNonce = "d".repeat(32);
  const inventory = exactHostInventory(matrix, hostId);
  const route = checkedHostRouteFixture({
    originPolicy,
    hostId,
    runId: 10,
    jobId: 12,
    packageSha256: "c".repeat(64),
  });
  const signed = createHostLabCanary({
    authorization: {
      run: { id: 10, attempt: 1 },
      queuedHardwareJob: { id: 12 },
      lane: "infrastructure-canary",
      manualSession: null,
      hostId,
      assetId: hostId,
      trustedSha: "a".repeat(40),
      packageRunId: 11,
      sha256: "b".repeat(64),
      runnerNonce,
    },
    browserEvidence: {
      result: "PASS",
      packageSha256: "c".repeat(64),
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
        runId: 10,
        assetId: hostId,
        commit: "a".repeat(40),
        packageSha256: "c".repeat(64),
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
      runnerId: 20,
      runnerName: `${hostId}-${runnerNonce}`,
      runnerAbsent: true,
    },
    installations: {
      controller: serviceInstallationFixture({
        component: "controller",
        instanceId: hostId,
        inventory,
      }),
      broker: serviceInstallationFixture({
        component: "broker",
        instanceId: "browser-lab-broker",
      }),
    },
    diagnosticRetention: diagnosticRetentionFixture({
      authorizationDigest: "b".repeat(64),
      hostId,
      run: { id: 10, attempt: 1 },
      runnerNonce,
    }),
    controllerCompletion: {
      state: "completed",
      brokerCleanup: "deleted",
      runnerAbsent: true,
      workRootWiped: true,
      hostCleanupComplete: true,
      hostLockReleased: true,
      quarantined: false,
      completedAt: "2026-07-29T10:00:00.000Z",
    },
    privateKey: keys.privateKey,
    signingKeyId: keyId,
  });
  const record = verifyControllerRecord({
    signed,
    matrix: {
      hosts: [
        {
          assetId: hostId,
          controller: {
            state: "online",
            signingKeyId: keyId,
            publicJwk: keys.publicKey.export({ format: "jwk" }),
          },
        },
      ],
    },
    recordType: "host-lab-canary",
  });
  assert.equal(record.supportAssertionsExecuted, false);
  assert.equal(record.runner.absentAfterRun, true);
  assert.equal(record.attestation.verified, false);
});

test("fallback adapter cannot produce a host canary", () => {
  assert.throws(() =>
    createHostLabCanary({
      authorization: {
        lane: "infrastructure-canary",
        manualSession: null,
      },
      browserEvidence: {
        result: "PASS",
        assertions: { supportAssertionsExecuted: false },
        adapter: {
          isFallbackAdapter: true,
          deviceCreated: true,
          surfacePresented: true,
        },
      },
      adapterAttestation: {},
      execution: {},
      inventory: {},
      route: {},
    }),
  );
});

test("Mac controller cannot sign without the complete mobile route evidence", () => {
  const macHostId = "FW-MAC-M2-01";
  const runnerNonce = "e".repeat(32);
  const inventory = exactHostInventory(matrix, macHostId);
  const route = checkedHostRouteFixture({
    originPolicy,
    hostId: macHostId,
    runId: 30,
    jobId: 32,
    packageSha256: "c".repeat(64),
  });
  assert.throws(
    () =>
      createHostLabCanary({
        authorization: {
          run: { id: 30, attempt: 1 },
          queuedHardwareJob: { id: 32 },
          lane: "infrastructure-canary",
          manualSession: null,
          hostId: macHostId,
          assetId: macHostId,
          trustedSha: "a".repeat(40),
          packageRunId: 31,
          sha256: "b".repeat(64),
          runnerNonce,
        },
        browserEvidence: {
          result: "PASS",
          packageSha256: "c".repeat(64),
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
            runId: 30,
            assetId: macHostId,
            commit: "a".repeat(40),
            packageSha256: "c".repeat(64),
          },
          host: {
            hostId: macHostId,
            expectedGpuPresent: true,
            headedSessionAvailable: true,
          },
        },
        inventory,
        route,
        originPolicy,
        mobileRouteReadiness: null,
        deviceMatrix,
        execution: {
          acceptedJobCount: 1,
          cleanupComplete: true,
          runnerId: 33,
          runnerName: `${macHostId}-${runnerNonce}`,
          runnerAbsent: true,
        },
        installations: {
          controller: serviceInstallationFixture({
            component: "controller",
            instanceId: macHostId,
            inventory,
          }),
          broker: serviceInstallationFixture({
            component: "broker",
            instanceId: "browser-lab-broker",
          }),
        },
        diagnosticRetention: diagnosticRetentionFixture({
          authorizationDigest: "b".repeat(64),
          hostId: macHostId,
          run: { id: 30, attempt: 1 },
          runnerNonce,
        }),
        controllerCompletion: {
          state: "completed",
          brokerCleanup: "deleted",
          runnerAbsent: true,
          workRootWiped: true,
          hostCleanupComplete: true,
          hostLockReleased: true,
          quarantined: false,
          completedAt: "2026-07-29T10:00:00.000Z",
        },
        privateKey: keys.privateKey,
        signingKeyId: keyId,
      }),
    /observations are incomplete/u,
  );
});

test("controller-record verifier rejects non-host record contracts", () => {
  assert.throws(() =>
    verifyControllerRecord({
      signed: { record: { recordType: "manual-lab-canary" } },
      matrix: { hosts: [] },
      recordType: "manual-lab-canary",
    }),
  );
});
