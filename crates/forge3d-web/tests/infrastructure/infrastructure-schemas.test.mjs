import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const root = dirname(fileURLToPath(import.meta.url));

for (const name of [
  "browser-policy",
  "hardware-matrix",
  "repository-trust-policy",
  "runner-distribution-manifest",
  "runner-transient-path-policy",
  "workflow-actions-lock",
]) {
  test(`${name} matches its checked JSON schema`, () => {
    assertJsonSchema(readJson(`${name}.json`), readJson(`${name}.schema.json`));
  });
}

test("schemas reject unknown policy fields", () => {
  const policy = readJson("repository-trust-policy.json");
  policy.unreviewedBypass = true;
  assert.throws(
    () =>
      assertJsonSchema(policy, readJson("repository-trust-policy.schema.json")),
    /additional property/u,
  );
});

test("runner manifest contains all three pinned platform distributions", () => {
  const manifest = readJson("runner-distribution-manifest.json");
  assert.deepEqual(
    manifest.distributions.map((distribution) => distribution.platform),
    ["linux-x64", "osx-arm64", "win-x64"],
  );
  assert.equal(
    manifest.distributions.reduce(
      (sum, distribution) => sum + distribution.entries.length,
      0,
    ),
    23_144,
  );
});

test("broker protocol schema accepts only a frozen JIT request shape", () => {
  const request = {
    protocolVersion: "forge3d-browser-lab-broker/v1",
    authorizationDigest: "a".repeat(64),
    requestNonce: "b".repeat(32),
    controller: {
      assetId: "FW-LNX-NV-01",
      identity: "controller:FW-LNX-NV-01",
      signingKeyId: "controller-fw-lnx-nv-01-p256-v1",
    },
    signature: {
      algorithm: "SHA256withECDSA",
      signingKeyId: "controller-fw-lnx-nv-01-p256-v1",
      value: "base64url",
    },
  };
  const schema = readJson("broker-protocol.schema.json");
  assertJsonSchema(request, schema);
  request.runnerName = "caller-selected";
  assert.throws(() => assertJsonSchema(request, schema), /oneOf/u);
});

test("broker lifecycle schema freezes cleanup and redacted-ledger fields", () => {
  const record = {
    schemaVersion: 1,
    protocolVersion: "forge3d-browser-lab-broker/v1",
    authorizationDigest: "a".repeat(64),
    runId: 1,
    jobId: 2,
    targetSha: "b".repeat(40),
    hostAssetId: "FW-LNX-NV-01",
    controllerIdentity: "controller:FW-LNX-NV-01",
    runnerId: 3,
    runnerName: `FW-LNX-NV-01-${"c".repeat(32)}`,
    customLabels: [
      "forge3d-web",
      "hw-linux-rtx3070",
      `jit-${"c".repeat(32)}`,
    ],
    workFolder: "_work",
    state: "issued",
    issuedAt: "2026-07-28T12:00:00.000Z",
    authorizationExpiresAt: "2026-07-28T12:30:00.000Z",
    startDeadline: "2026-07-28T12:02:00.000Z",
    onlineAt: null,
    assignmentDeadline: null,
    everOnline: false,
    everBusy: false,
    lastRunnerObservation: null,
    lastJobObservation: { status: "queued" },
    localStopEvidence: null,
    deletionResult: null,
    cancellationResult: null,
    cleanupDecision: null,
  };
  const schema = readJson("broker-lifecycle.schema.json");
  assertJsonSchema(record, schema);
  record.encodedJitConfig = "forbidden";
  assert.throws(() => assertJsonSchema(record, schema), /additional property/u);
});

function readJson(name) {
  return JSON.parse(readFileSync(join(root, name), "utf8"));
}
