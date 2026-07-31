import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createHostLabCanary } from "../src/lab-canary.mjs";
import { verifyControllerRecord } from "../../../crates/forge3d-web/scripts/verify-controller-record.mjs";

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const keyId = "controller-fw-lnx-nv-01-p256-v1";
const hostId = "FW-LNX-NV-01";

test("host canary is controller-signed, non-support, and signature-verifiable", () => {
  const signed = createHostLabCanary({
    authorization: {
      run: { id: 10, attempt: 1 },
      lane: "infrastructure-canary",
      manualSession: null,
      hostId,
      assetId: hostId,
      trustedSha: "a".repeat(40),
      packageRunId: 11,
      sha256: "b".repeat(64),
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
    inventory: { hostId, attachedAssetIds: [] },
    route: { httpsVerified: true, corsRangeControlsPassed: true },
    execution: {
      acceptedJobCount: 1,
      cleanupComplete: true,
      runnerId: 20,
      runnerName: "runner",
      runnerAbsent: true,
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

test("controller-record verifier rejects non-host record contracts", () => {
  assert.throws(() =>
    verifyControllerRecord({
      signed: { record: { recordType: "manual-lab-canary" } },
      matrix: { hosts: [] },
      recordType: "manual-lab-canary",
    }),
  );
});
