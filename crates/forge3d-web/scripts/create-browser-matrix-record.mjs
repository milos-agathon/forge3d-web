import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-json.mjs";
import { verifySelectedWorkflowRecord } from "./selected-workflow-record.mjs";

export function createAutomatedMatrixRecord({
  promotion,
  evidence,
  attestation,
  run,
}) {
  if (
    promotion.lane === "infrastructure-canary" ||
    promotion.mode !== "automated" ||
    evidence.result !== "PASS" ||
    evidence.lane !== promotion.lane ||
    evidence.trustedSha !== promotion.trustedSha ||
    evidence.packageManifestSha256 !== promotion.packageManifestSha256 ||
    evidence.adapter?.isFallbackAdapter !== false ||
    evidence.adapter?.deviceCreated !== true ||
    evidence.adapter?.surfacePresented !== true ||
    attestation?.result !== "PASS" ||
    attestation.required !== true ||
    attestation.binding?.runId !== run.id ||
    attestation.binding?.assetId !== promotion.assetId ||
    attestation.binding?.commit !== promotion.trustedSha ||
    attestation.binding?.packageSha256 !== evidence.packageSha256 ||
    attestation.page?.isFallbackAdapter !== false ||
    attestation.host?.expectedGpuPresent !== true ||
    attestation.host?.headedSessionAvailable !== true ||
    attestation.host?.hostId !== promotion.hostId
  ) {
    throw new Error("automated matrix evidence does not match its promotion");
  }
  return {
    schemaVersion: 1,
    key: `automated:${promotion.assetId}:${promotion.lane}`,
    kind: "automated",
    hostId: promotion.hostId,
    assetId: promotion.assetId,
    lane: promotion.lane,
    checklistId: null,
    trustedSha: promotion.trustedSha,
    packageSha256: evidence.packageSha256,
    labInfrastructureDigest: promotion.labInfrastructureDigest,
    result: "PASS",
    infrastructureError: null,
    workflow: {
      runId: run.id,
      path: ".github/workflows/browser-hardware.yml",
      ref: "refs/heads/main",
      conclusion: "success",
    },
    adapter: evidence.adapter,
    adapterAttestation: attestation,
  };
}

export function createManualMatrixRecord({ evidence, run }) {
  if (
    !["mobile-multitouch", "safari-trackpad"].includes(evidence.checklistId) ||
    evidence.run.id !== run.id ||
    evidence.run.attempt !== run.attempt
  ) {
    throw new Error("manual matrix evidence identity is invalid");
  }
  const lane =
    evidence.checklistId === "safari-trackpad"
      ? "manual-safari-trackpad"
      : "manual-mobile-multitouch";
  return {
    schemaVersion: 1,
    key: `manual:${evidence.assetId}:${evidence.checklistId}`,
    kind: "manual",
    hostId: "FW-MAC-M2-01",
    assetId: evidence.assetId,
    lane,
    checklistId: evidence.checklistId,
    trustedSha: evidence.trustedSha,
    packageSha256: evidence.packageSha256,
    labInfrastructureDigest: evidence.labInfrastructureDigest,
    result: Object.values(evidence.stepResults).every(
      (value) => value === "pass",
    )
      ? "PASS"
      : "FAIL",
    infrastructureError: null,
    workflow: {
      runId: run.id,
      path: ".github/workflows/submit-browser-manual-evidence.yml",
      ref: "refs/heads/main",
      conclusion: "success",
    },
    stepResults: evidence.stepResults,
    session: {
      runId: evidence.manualSessionRunId,
      jobId: evidence.manualSessionJobId,
      trustedSha: evidence.trustedSha,
      packageSha256: evidence.packageSha256,
      assetId: evidence.assetId,
      hostId: "FW-MAC-M2-01",
      authorizationSha256: evidence.authorizationSha256,
      controllerSignatureSha256: evidence.controllerSignatureSha256,
      routeBasePath: evidence.routeBasePath,
      mediaChallenge: evidence.mediaChallenge,
      result: "success",
    },
    expiresAt: evidence.expiresAt,
  };
}

export function finalizeMatrixRecord({
  source,
  artifactId,
  resolution,
  attestation,
}) {
  if (
    !Number.isInteger(artifactId) ||
    artifactId < 1 ||
    resolution?.artifact?.id !== artifactId ||
    attestation?.verified !== true ||
    attestation.denySelfHostedRunners !== true
  ) {
    throw new Error("matrix record requires exact artifact and attestation proof");
  }
  const expectedKind = new Map([
    [".github/workflows/browser-hardware.yml", "automated"],
    [".github/workflows/submit-browser-manual-evidence.yml", "manual"],
  ]).get(resolution?.run?.path);
  if (expectedKind === undefined || source?.kind !== expectedKind) {
    throw new Error(
      "matrix source kind does not match the selected workflow path",
    );
  }
  verifySelectedWorkflowRecord({
    resolution,
    record: source,
    expectedInputs: {},
  });
  return {
    ...source,
    workflow: { ...source.workflow, artifactId },
    attestation,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2];
  const input = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const result =
    operation === "automated"
      ? createAutomatedMatrixRecord(input)
      : operation === "manual"
        ? createManualMatrixRecord(input)
        : operation === "finalize"
          ? finalizeMatrixRecord(input)
          : null;
  if (!result) throw new Error("unknown matrix-record operation");
  writeFileSync(process.argv[4], `${canonicalJson(result)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, key: result.key }));
}
