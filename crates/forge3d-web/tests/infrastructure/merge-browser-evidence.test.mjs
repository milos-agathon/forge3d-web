import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mergeBrowserEvidence,
  parseEvidenceRunIds,
  requiredEvidenceRows,
} from "../../scripts/merge-browser-evidence.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const matrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const targetSha = "a".repeat(40);
const packageSha256 = "b".repeat(64);
const labDigest = "c".repeat(64);
const rows = requiredEvidenceRows(matrix);
const records = rows.map((row, index) => ({
  schemaVersion: 1,
  ...row,
  trustedSha: targetSha,
  packageSha256,
  labInfrastructureDigest: labDigest,
  result: "PASS",
  infrastructureError: null,
  workflow: {
    runId: 100 + index,
    artifactId: 200 + index,
    path:
      row.kind === "manual"
        ? ".github/workflows/submit-browser-manual-evidence.yml"
        : ".github/workflows/browser-hardware.yml",
    ref: "refs/heads/main",
    conclusion: "success",
  },
  attestation: { verified: true, denySelfHostedRunners: true },
  ...(row.kind === "manual"
    ? {
        stepResults: { A: "pass", B: "pass", C: "pass", D: "pass" },
        session: {
          trustedSha: targetSha,
          packageSha256,
          assetId: row.assetId,
          hostId: row.hostId,
          result: "success",
        },
        expiresAt: "2026-08-05T00:00:00.000Z",
      }
    : {
        adapter: {
          isFallbackAdapter: false,
          deviceCreated: true,
          surfacePresented: true,
        },
        adapterAttestation: {
          result: "PASS",
          required: true,
          binding: {
            runId: 100 + index,
            assetId: row.assetId,
            commit: targetSha,
            packageSha256,
          },
          page: { isFallbackAdapter: false },
          host: {
            hostId: row.hostId,
            expectedGpuPresent: true,
            headedSessionAvailable: true,
          },
        },
      }),
}));
const labReadiness = {
  status: "LAB_INFRA_READY",
  runId: 80,
  packageRunId: 50,
  candidateSha: targetSha,
  packageSha256,
  manifestSha256: "d".repeat(64),
  labInfrastructureDigest: labDigest,
};

test("merger closes every required automated, mobile, and manual matrix row", () => {
  assert.deepEqual(parseEvidenceRunIds("[1,2,30]"), [1, 2, 30]);
  assert.equal(rows.length, 24);
  const merged = mergeBrowserEvidence({
    targetSha,
    packageSha256,
    labReadiness,
    records,
    matrix,
    now: new Date("2026-07-30T00:00:00Z"),
  });
  assertJsonSchema(
    merged.manifest,
    JSON.parse(
      readFileSync(
        new URL(
          "./browser-hardware-release-readiness.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  assert.equal(merged.manifest.status, "RELEASE_MATRIX_READY");
  assert.equal(merged.manifest.requiredKeys.length, 24);
  assert.equal(merged.manifest.recordDigests.length, 24);
});

test("evidence run ID input rejects whitespace, duplicates, and unsorted values", () => {
  for (const value of ["[1, 2]", "[1,1]", "[2,1]", "[]", '["1"]']) {
    assert.throws(() => parseEvidenceRunIds(value));
  }
});

test("prior head, other package, expired manual, missing, duplicate, and infra error fail", () => {
  for (const changed of [
    records.map((record, index) =>
      index === 0 ? { ...record, trustedSha: "e".repeat(40) } : record,
    ),
    records.map((record, index) =>
      index === 0 ? { ...record, packageSha256: "f".repeat(64) } : record,
    ),
    records.map((record) =>
      record.kind === "manual"
        ? { ...record, expiresAt: "2026-07-29T00:00:00Z" }
        : record,
    ),
    records.slice(1),
    [...records.slice(0, -1), records[0]],
    records.map((record, index) =>
      index === 0
        ? { ...record, result: "INFRA_ERROR", infrastructureError: "quarantined" }
        : record,
    ),
    records.map((record, index) =>
      index === 0 ? { ...record, adapterAttestation: null } : record,
    ),
  ]) {
    assert.throws(() =>
      mergeBrowserEvidence({
        targetSha,
        packageSha256,
        labReadiness,
        records: changed,
        matrix,
        now: new Date("2026-07-30T00:00:00Z"),
      }),
    );
  }
});
