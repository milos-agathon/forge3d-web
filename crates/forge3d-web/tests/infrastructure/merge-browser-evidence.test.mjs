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
import { validChr03HardwareProof } from "../browser/chr03-hardware-proof-fixture.mjs";
import { validChr04HardwareProof } from "../browser/chr04-hardware-proof-fixture.mjs";
import { CHR04_LANES } from "../../scripts/chr04-lanes.mjs";
import { validSaf03Proof, validStpResult } from "../browser/saf03-proof-fixture.mjs";
import { validSaf02Conformance } from "../browser/saf02-conformance-fixture.mjs";

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
Object.assign(macInventory, { osVersion: "26.0", osBuild: "macOS build 25A123", architecture: "arm64" });
macInventory.browsers.push(
  { id: "safari-stable", channel: "stable", classification: "required", automation: "safaridriver", version: "26.0", executable: "/Applications/Safari.app/Contents/MacOS/Safari" },
  { id: "safari-technology-preview", channel: "technology-preview", classification: "probe", automation: "safaridriver", version: "26.1", executable: "/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview" },
);
Object.assign(macInventory.tools, {
  safaridriverPath: "/usr/bin/safaridriver",
  safaridriverVersion: "Included with Safari 26.0",
  safariTechnologyPreviewDriverPath: "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver",
  safariTechnologyPreviewDriverVersion: "26.1",
});
const rows = requiredEvidenceRows(matrix);
const records = rows.map((row, index) => {
  const safariTrackpad =
    row.lane === "safari-macos-m2" || row.checklistId === "safari-trackpad";
  const edge = row.lane.startsWith("edge-");
  const edgePlatform = edge ? CHR04_LANES[row.lane].platform : null;
  const system =
    row.kind === "manual"
      ? {
          os: "darwin",
          build: safariTrackpad ? macInventory.osBuild : "25A456",
        }
      : {
          platform: safariTrackpad ? "darwin" : edgePlatform ?? "linux",
          osVersion: safariTrackpad ? macInventory.osVersion : "fixture-version",
          osBuild: safariTrackpad
            ? macInventory.osBuild
            : "Ubuntu 24.04.1",
          architecture: safariTrackpad ? macInventory.architecture : "x64",
          displayServer: safariTrackpad || edgePlatform === "darwin" ? "WindowServer" : edgePlatform === "win32" ? "Desktop Window Manager" : "GNOME Wayland",
        };
  const browser = safariTrackpad
    ? { name: row.kind === "automated" ? "safari" : "Safari", channel: "stable", version: "26.0" }
    : edge ? { name: "msedge", channel: "stable", version: "150.0.1.2" }
    : { name: "chrome", channel: "stable", version: "150.0" };
  const driver = safariTrackpad
    ? { name: "safaridriver", version: macInventory.tools.safaridriverVersion }
    : edge ? { name: "playwright-edge", version: "1.56.1" }
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
          effectiveLaunchArguments: [],
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
          ...(row.lane.startsWith("chrome-") && row.lane !== "chrome-windows-intel12"
            ? { chr03Proof: validChr03HardwareProof({ lane: row.lane, assetId: row.assetId, commit: targetSha, packageSha256 }) }
            : {}),
          ...(edge ? { chr04Proof: validChr04HardwareProof({ lane: row.lane, assetId: row.assetId, platform: edgePlatform, commit: targetSha, packageSha256 }) } : {}),
          ...(row.lane === "safari-macos-m2" ? (() => {
            const saf02Proof = validSaf02Conformance({ runId: 100 + index, jobId: 900 + index, commit: targetSha, packageSha256 });
            const applicationUrl = `${saf02Proof.route.applicationOrigin}${saf02Proof.route.basePath}`;
            const assetUrl = `${saf02Proof.route.assetOrigin}${saf02Proof.route.basePath}`;
            const safariTechnologyPreview = validStpResult(macInventory, { commit: targetSha, packageSha256 });
            safariTechnologyPreview.probe.route = applicationUrl;
            return {
              hardwareJobId: 900 + index,
              saf02Proof,
              saf02Route: { applicationUrl, assetUrl },
              route: { applicationUrl, assetUrl },
              saf03Proof: validSaf03Proof({ commit: targetSha, packageSha256 }),
              safariTechnologyPreview,
            };
          })() : {}),
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
    records.map((record) =>
      record.lane === "chrome-linux-intel12"
        ? { ...record, chr03Proof: null }
        : record,
    ),
    records.map((record) =>
      record.lane === "chrome-linux-rtx3070"
        ? { ...record, chr03Proof: { ...record.chr03Proof, behaviors: { ...record.chr03Proof.behaviors, orbit: false } } }
        : record,
    ),
    records.map((record) =>
      record.lane === "edge-linux-rtx3070"
        ? { ...record, chr04Proof: { ...record.chr04Proof, kind: "forge3d-chr03-chrome-hardware-proof-v1" } }
        : record,
    ),
    ...["touch", "code", "ui", "bypass"].map((mutation) => records.map((record) => {
      if (record.lane !== "edge-linux-rtx3070") return record;
      const chr04Proof = structuredClone(record.chr04Proof);
      if (mutation === "touch") chr04Proof.edgeAcceptance.touch.viewChanged = false;
      if (mutation === "code") chr04Proof.edgeAcceptance.unsupported.nullAdapter.publicCode = "WEBGPU_UNAVAILABLE";
      if (mutation === "ui") chr04Proof.edgeAcceptance.unsupported.nullAdapter.unsupportedVisible = false;
      if (mutation === "bypass") chr04Proof.edgeAcceptance.unsupported.nullAdapter.hasBypassAdvice = true;
      return { ...record, chr04Proof };
    })),
    records.map((record) => record.lane === "edge-linux-rtx3070"
      ? { ...record, effectiveLaunchArguments: ["--ignore-certificate-errors=value"] }
      : record),
    records.map((record) => record.lane === "safari-macos-m2"
      ? { ...record, effectiveLaunchArguments: ["--ignore-certificate-errors=value"] }
      : record),
    records.map((record) => {
      if (record.lane !== "safari-macos-m2") return record;
      const unsafe = structuredClone(record);
      unsafe.effectiveLaunchArguments = ["--enable-features=CanvasOopRasterization,WebGPU"];
      unsafe.saf02Proof.environment.effectiveLaunchArguments = [...unsafe.effectiveLaunchArguments];
      return unsafe;
    }),
    records.map((record) => {
      if (record.lane !== "safari-macos-m2") return record;
      const replay = structuredClone(record);
      const nonce = replay.saf02Proof.route.nonce;
      replay.saf02Proof.route.basePath = `/runs/999/888/${nonce}/`;
      return replay;
    }),
    records.map((record) =>
      record.lane === "edge-linux-intel12"
        ? { ...record, system: { ...record.system, displayServer: "X11" } }
        : record,
    ),
    records.map((record) =>
      record.lane === "chrome-linux-rtx3070"
        ? { ...record, chr03Proof: { ...record.chr03Proof, systemInfo: { ...record.chr03Proof.systemInfo, available: "false" } } }
        : record,
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
    records.map((record) => record.lane === "safari-macos-m2"
      ? { ...record, saf03Proof: { ...record.saf03Proof, visibilityCycles: record.saf03Proof.visibilityCycles.slice(0, 29) } }
      : record),
    records.map((record) => record.lane === "safari-macos-m2"
      ? { ...record, safariTechnologyPreview: { ...record.safariTechnologyPreview, cleanup: { ...record.safariTechnologyPreview.cleanup, processAbsent: false, ok: false } } }
      : record),
    ...[
      (record) => { record.saf03Proof.browser.version = "26.1"; },
      (record) => { record.saf03Proof.driver.version = "wrong"; },
      (record) => { record.saf03Proof.system.osVersion = "25.6"; },
      (record) => { record.saf03Proof.system.osBuild = "macOS build 24Z999"; },
      (record) => { record.saf03Proof.system.architecture = "x64"; },
      (record) => { record.safariTechnologyPreview.probe.route = "https://unrelated.example.invalid/run/"; },
      (record) => { record.safariTechnologyPreview.cleanup.sessionDeleted = null; },
      (record) => {
        Object.assign(record.safariTechnologyPreview, { result: "PRODUCT_FAILURE", warning: "STP_PRODUCT_FAILURE probe error", probe: null });
        record.safariTechnologyPreview.cleanup.sessionDeleted = null;
      },
      (record) => {
        Object.assign(record.safariTechnologyPreview, { result: "PRODUCT_FAILURE", warning: "STP_PRODUCT_FAILURE preflight", probe: null });
        record.safariTechnologyPreview.cleanup = { notStarted: true, sessionDeleted: null, driverStopped: null, processAbsent: true, ok: true };
      },
    ].map((mutate) => records.map((record) => {
      const copy = structuredClone(record);
      if (copy.lane === "safari-macos-m2") mutate(copy);
      return copy;
    })),
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
