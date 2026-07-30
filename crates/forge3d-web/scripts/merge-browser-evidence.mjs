import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";

export function requiredEvidenceRows(matrix) {
  const rows = [];
  for (const host of matrix.hosts) {
    for (const lane of host.requiredBrowserLanes) {
      if (lane === "mobile-usb-controller") continue;
      rows.push({
        key: `automated:${host.assetId}:${lane}`,
        kind: "automated",
        hostId: host.assetId,
        assetId: host.assetId,
        lane,
        checklistId: null,
      });
    }
  }
  for (const asset of matrix.assets.filter((candidate) =>
    ["android", "ios", "ipados"].includes(candidate.kind),
  )) {
    rows.push({
      key: `automated:${asset.assetId}:mobile-usb-controller`,
      kind: "automated",
      hostId: asset.hostAssetId,
      assetId: asset.assetId,
      lane: "mobile-usb-controller",
      checklistId: null,
    });
    rows.push({
      key: `manual:${asset.assetId}:mobile-multitouch`,
      kind: "manual",
      hostId: asset.hostAssetId,
      assetId: asset.assetId,
      lane: "manual-mobile-multitouch",
      checklistId: "mobile-multitouch",
    });
  }
  const trackpad = matrix.assets.find(
    (candidate) => candidate.assetId === "FW-TRACKPAD-01",
  );
  if (!trackpad) throw new Error("checked trackpad asset is missing");
  rows.push({
    key: "manual:FW-TRACKPAD-01:safari-trackpad",
    kind: "manual",
    hostId: trackpad.hostAssetId,
    assetId: trackpad.assetId,
    lane: "manual-safari-trackpad",
    checklistId: "safari-trackpad",
  });
  return rows.sort((left, right) => left.key.localeCompare(right.key));
}

export function parseEvidenceRunIds(value) {
  const parsed = JSON.parse(value);
  if (
    canonicalJson(parsed) !== value ||
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.some((id) => !Number.isInteger(id) || id < 1) ||
    new Set(parsed).size !== parsed.length ||
    parsed.some((id, index) => index > 0 && parsed[index - 1] >= id)
  ) {
    throw new Error("evidence run IDs must be a canonical sorted unique array");
  }
  return parsed;
}

export function mergeBrowserEvidence({
  targetSha,
  packageSha256,
  labReadiness,
  records,
  matrix,
  now = new Date(),
}) {
  if (
    !/^[0-9a-f]{40}$/u.test(targetSha ?? "") ||
    !/^[0-9a-f]{64}$/u.test(packageSha256 ?? "") ||
    labReadiness?.status !== "LAB_INFRA_READY" ||
    labReadiness.candidateSha !== targetSha ||
    labReadiness.packageSha256 !== packageSha256 ||
    !/^[0-9a-f]{64}$/u.test(labReadiness.labInfrastructureDigest ?? "")
  ) {
    throw new Error("target, package, or laboratory readiness binding is invalid");
  }
  const expected = requiredEvidenceRows(matrix);
  if (records.length !== expected.length) {
    throw new Error("evidence record count does not equal the closed matrix");
  }
  const byKey = new Map();
  for (const record of records) {
    if (byKey.has(record.key)) throw new Error(`duplicate evidence key: ${record.key}`);
    byKey.set(record.key, record);
  }
  const accepted = expected.map((row) => {
    const record = byKey.get(row.key);
    if (!record) throw new Error(`missing required evidence key: ${row.key}`);
    validateRecord(record, row, {
      targetSha,
      packageSha256,
      labInfrastructureDigest: labReadiness.labInfrastructureDigest,
      now,
    });
    return record;
  });
  const extra = [...byKey.keys()].filter(
    (key) => !expected.some((row) => row.key === key),
  );
  if (extra.length > 0) throw new Error(`extra evidence key: ${extra[0]}`);
  const recordDigests = accepted.map((record) => ({
    key: record.key,
    workflowRunId: record.workflow.runId,
    artifactId: record.workflow.artifactId,
    sha256: sha256Hex(record),
  }));
  const manifest = {
    schemaVersion: 1,
    status: "RELEASE_MATRIX_READY",
    supportClaim: true,
    targetSha,
    packageRunId: labReadiness.packageRunId,
    packageSha256,
    labReadiness: {
      runId: labReadiness.runId,
      manifestSha256: labReadiness.manifestSha256,
      labInfrastructureDigest: labReadiness.labInfrastructureDigest,
    },
    requiredKeys: expected.map((row) => row.key),
    recordDigests,
    evidenceRunIds: [
      ...new Set(accepted.map((record) => record.workflow.runId)),
    ].sort((left, right) => left - right),
    createdAt: new Date(now).toISOString(),
  };
  return {
    manifest,
    canonical: canonicalJson(manifest),
    sha256: sha256Hex(manifest),
  };
}

function validateRecord(record, row, expected) {
  if (
    record.schemaVersion !== 1 ||
    record.key !== row.key ||
    record.kind !== row.kind ||
    record.hostId !== row.hostId ||
    record.assetId !== row.assetId ||
    record.lane !== row.lane ||
    record.trustedSha !== expected.targetSha ||
    record.packageSha256 !== expected.packageSha256 ||
    record.labInfrastructureDigest !== expected.labInfrastructureDigest ||
    record.result !== "PASS" ||
    record.infrastructureError !== null ||
    record.workflow.path !== ".github/workflows/browser-hardware.yml" &&
      record.workflow.path !==
        ".github/workflows/submit-browser-manual-evidence.yml" ||
    record.workflow.ref !== "refs/heads/main" ||
    record.workflow.conclusion !== "success" ||
    !Number.isInteger(record.workflow.runId) ||
    !Number.isInteger(record.workflow.artifactId) ||
    record.attestation?.verified !== true ||
    record.attestation.denySelfHostedRunners !== true
  ) {
    throw new Error(`evidence binding or outcome is invalid: ${row.key}`);
  }
  if (row.kind === "manual") {
    if (
      record.checklistId !== row.checklistId ||
      record.workflow.path !==
        ".github/workflows/submit-browser-manual-evidence.yml" ||
      Object.values(record.stepResults ?? {}).some((value) => value !== "pass") ||
      Object.keys(record.stepResults ?? {}).length < 4 ||
      record.session?.trustedSha !== expected.targetSha ||
      record.session?.packageSha256 !== expected.packageSha256 ||
      record.session?.assetId !== row.assetId ||
      record.session?.hostId !== row.hostId ||
      record.session?.result !== "success" ||
      new Date(record.expiresAt) <= new Date(expected.now)
    ) {
      throw new Error(`manual evidence is incomplete, failed, or expired: ${row.key}`);
    }
  } else if (
    record.workflow.path !== ".github/workflows/browser-hardware.yml" ||
    record.adapter?.isFallbackAdapter !== false ||
    record.adapter?.deviceCreated !== true ||
    record.adapter?.surfacePresented !== true ||
    record.adapterAttestation?.result !== "PASS" ||
    record.adapterAttestation.required !== true ||
    record.adapterAttestation.binding?.runId !== record.workflow.runId ||
    record.adapterAttestation.binding?.assetId !== row.assetId ||
    record.adapterAttestation.binding?.commit !== expected.targetSha ||
    record.adapterAttestation.binding?.packageSha256 !==
      expected.packageSha256 ||
    record.adapterAttestation.page?.isFallbackAdapter !== false ||
    record.adapterAttestation.host?.hostId !== row.hostId ||
    record.adapterAttestation.host?.expectedGpuPresent !== true ||
    record.adapterAttestation.host?.headedSessionAvailable !== true
  ) {
    throw new Error(`automated hardware evidence is incomplete: ${row.key}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const output = mergeBrowserEvidence(input);
  writeFileSync(process.argv[3], `${output.canonical}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, sha256: output.sha256 }));
}
