import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mergeBrowserEvidence,
  parseEvidenceRunIds,
  requiredEvidenceRows,
} from "../../scripts/merge-browser-evidence.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";
import { exactHostInventory } from "./host-inventory-fixture.mjs";

const matrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const targetSha = "a".repeat(40);
const packageSha256 = "b".repeat(64);
const labDigest = "c".repeat(64);
const labIdentity = {
  runId: 80,
  manifestSha256: "d".repeat(64),
  labInfrastructureDigest: labDigest,
};
const macInventory = exactHostInventory(matrix, "FW-MAC-M2-01");
const rows = requiredEvidenceRows(matrix);
const records = rows.map((row, index) => {
  const safariTrackpad =
    row.lane === "safari-macos-m2" || row.checklistId === "safari-trackpad";
  const system =
    row.kind === "manual"
      ? {
          os: "darwin",
          build: safariTrackpad ? macInventory.osBuild : "25A456",
        }
      : {
          platform: safariTrackpad ? "darwin" : "linux",
          osBuild: safariTrackpad
            ? macInventory.osBuild
            : "Ubuntu 24.04.1",
          displayServer: safariTrackpad ? "WindowServer" : "GNOME Wayland",
        };
  const browser = safariTrackpad
    ? { name: "Safari", channel: "stable", version: "26.0" }
    : { name: "chrome", channel: "stable", version: "150.0" };
  const driver = safariTrackpad
    ? { name: "safaridriver", version: "26.0" }
    : { name: "playwright-chrome", version: "1.56.1" };
  const hostInventory = safariTrackpad
    ? structuredClone(macInventory)
    : null;
  return {
    schemaVersion: 1,
    ...row,
    trustedSha: targetSha,
    packageRunId: 50,
    packageSha256,
    labInfrastructureDigest: labDigest,
    labReadiness: { ...labIdentity },
    system,
    browser,
    driver,
    hostInventory,
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
            packageRunId: 50,
            packageSha256,
            assetId: row.assetId,
            hostId: row.hostId,
            labReadiness: { ...labIdentity },
            system: structuredClone(system),
            browser: structuredClone(browser),
            driver: structuredClone(driver),
            hostInventory: hostInventory
              ? structuredClone(hostInventory)
              : null,
            result: "success",
          },
          expiresAt: "2026-08-05T00:00:00.000Z",
        }
      : {
          adapter: {
            isFallbackAdapter: false,
            secureContext: true,
            deviceCreated: true,
            surfacePresented: true,
            presentedFrameLumaSamples: [0.1, 0.8],
            presentedFrameLumaDelta: 0.7,
            lumaChanged: true,
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
            page: {
              isFallbackAdapter: false,
              secureContext: true,
              surfacePresented: true,
              presentedFrameLumaSamples: [0.1, 0.8],
              presentedFrameLumaDelta: 0.7,
              lumaChanged: true,
            },
            host: {
              hostId: row.hostId,
              expectedGpuPresent: true,
              headedSessionAvailable: true,
            },
          },
        }),
  };
});
const labReadiness = {
  status: "LAB_INFRA_READY",
  run: { id: 80, attempt: 1, workflowSha: targetSha },
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
  assert.equal(merged.manifest.packageRunId, 50);
  assert.equal(merged.manifest.requiredKeys.length, 24);
  assert.equal(merged.manifest.recordDigests.length, 24);
});

test("evidence run ID input rejects whitespace, duplicates, and unsorted values", () => {
  for (const value of ["[1, 2]", "[1,1]", "[2,1]", "[]", '["1"]']) {
    assert.throws(() => parseEvidenceRunIds(value));
  }
});

test("prior head, other package, expired manual, missing, duplicate, and infra error fail", () => {
  for (const packageRunId of [0, null]) {
    assert.throws(() =>
      mergeBrowserEvidence({
        targetSha,
        packageSha256,
        labReadiness: { ...labReadiness, packageRunId },
        records,
        matrix,
        now: new Date("2026-07-30T00:00:00Z"),
      }),
    );
  }
  for (const changed of [
    records.map((record, index) =>
      index === 0 ? { ...record, trustedSha: "e".repeat(40) } : record,
    ),
    records.map((record, index) =>
      index === 0 ? { ...record, packageSha256: "f".repeat(64) } : record,
    ),
    records.map((record, index) =>
      index === 0 ? { ...record, packageRunId: 49 } : record,
    ),
    records.map((record, index) =>
      index === 0
        ? {
            ...record,
            labReadiness: {
              ...record.labReadiness,
              manifestSha256: "0".repeat(64),
            },
          }
        : record,
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
    records.map((record, index) =>
      index === 0
        ? {
            ...record,
            adapter: {
              ...record.adapter,
              presentedFrameLumaDelta: 0.9,
            },
          }
        : record,
    ),
    records.map((record) =>
      record.key === "manual:FW-TRACKPAD-01:safari-trackpad"
        ? {
            ...record,
            packageRunId: 49,
          }
        : record,
    ),
    records.map((record) =>
      record.kind === "manual"
        ? {
            ...record,
            session: { ...record.session, packageRunId: 49 },
          }
        : record,
    ),
    records.map((record) =>
      record.key === "manual:FW-TRACKPAD-01:safari-trackpad"
        ? {
            ...record,
            browser: { ...record.browser, version: "26.1" },
          }
        : record,
    ),
    records.map((record) =>
      record.key === "manual:FW-TRACKPAD-01:safari-trackpad"
        ? {
            ...record,
            hostInventory: {
              ...record.hostInventory,
              trackpad: {
                ...record.hostInventory.trackpad,
                firmware: "substituted",
              },
            },
          }
        : record,
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
