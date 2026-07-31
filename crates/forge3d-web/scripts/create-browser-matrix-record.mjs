import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-json.mjs";
import { validateHostInventory } from "./capture-host-inventory.mjs";
import { hasMeasuredLumaPresentation } from "./join-adapter-attestation.mjs";

export function createAutomatedMatrixRecord({
  promotion,
  evidence,
  attestation,
  run,
  hostInventory,
  matrix,
}) {
  assertWorkflowRun(run);
  assertPackageRunId(promotion.packageRunId);
  assertLabReadinessIdentity(
    promotion.labReadiness,
    promotion.labInfrastructureDigest,
  );
  assertRuntimeProvenance(evidence);
  const safariTrackpadRecord = promotion.lane === "safari-macos-m2";
  if (safariTrackpadRecord) {
    validateHostInventory(hostInventory, { matrix, requireTrackpad: true });
    if (
      promotion.hostId !== "FW-MAC-M2-01" ||
      promotion.assetId !== "FW-MAC-M2-01" ||
      evidence.browser.name.toLowerCase() !== "safari" ||
      evidence.system.platform !== hostInventory.platform ||
      evidence.system.osBuild !== hostInventory.osBuild
    ) {
      throw new Error("automated Safari provenance does not match SAF-03");
    }
  }
  if (
    promotion.lane === "infrastructure-canary" ||
    promotion.mode !== "automated" ||
    evidence.result !== "PASS" ||
    evidence.lane !== promotion.lane ||
    evidence.trustedSha !== promotion.trustedSha ||
    evidence.packageManifestSha256 !== promotion.packageManifestSha256 ||
    evidence.adapter?.isFallbackAdapter !== false ||
    evidence.adapter?.secureContext !== true ||
    evidence.adapter?.deviceCreated !== true ||
    evidence.adapter?.surfacePresented !== true ||
    !hasMeasuredLumaPresentation(evidence.adapter) ||
    attestation?.result !== "PASS" ||
    attestation.required !== true ||
    attestation.binding?.runId !== run.id ||
    attestation.binding?.assetId !== promotion.assetId ||
    attestation.binding?.commit !== promotion.trustedSha ||
    attestation.binding?.packageSha256 !== evidence.packageSha256 ||
    attestation.page?.isFallbackAdapter !== false ||
    attestation.page?.secureContext !== true ||
    !hasMeasuredLumaPresentation(attestation.page) ||
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
    packageRunId: promotion.packageRunId,
    packageSha256: evidence.packageSha256,
    labInfrastructureDigest: promotion.labInfrastructureDigest,
    labReadiness: { ...promotion.labReadiness },
    system: structuredClone(evidence.system),
    browser: structuredClone(evidence.browser),
    driver: structuredClone(evidence.driver),
    hostInventory: safariTrackpadRecord
      ? structuredClone(hostInventory)
      : null,
    result: "PASS",
    infrastructureError: null,
    workflow: {
      runId: run.id,
      runAttempt: run.attempt,
      path: ".github/workflows/browser-hardware.yml",
      ref: "refs/heads/main",
      conclusion: "success",
    },
    adapter: evidence.adapter,
    adapterAttestation: attestation,
  };
}

export function createManualMatrixRecord({ evidence, run }) {
  assertWorkflowRun(run);
  assertPackageRunId(evidence.packageRunId);
  assertLabReadinessIdentity(
    evidence.labReadiness,
    evidence.labInfrastructureDigest,
  );
  assertRuntimeProvenance(evidence);
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
    hostId: evidence.hostId,
    assetId: evidence.assetId,
    lane,
    checklistId: evidence.checklistId,
    trustedSha: evidence.trustedSha,
    packageRunId: evidence.packageRunId,
    packageSha256: evidence.packageSha256,
    labInfrastructureDigest: evidence.labInfrastructureDigest,
    labReadiness: { ...evidence.labReadiness },
    system: structuredClone(evidence.system),
    browser: structuredClone(evidence.browser),
    driver: structuredClone(evidence.driver),
    hostInventory: evidence.hostInventory
      ? structuredClone(evidence.hostInventory)
      : null,
    result: Object.values(evidence.stepResults).every(
      (value) => value === "pass",
    )
      ? "PASS"
      : "FAIL",
    infrastructureError: null,
    workflow: {
      runId: run.id,
      runAttempt: run.attempt,
      path: ".github/workflows/submit-browser-manual-evidence.yml",
      ref: "refs/heads/main",
      conclusion: "success",
    },
    stepResults: evidence.stepResults,
    session: {
      runId: evidence.manualSessionRunId,
      jobId: evidence.manualSessionJobId,
      trustedSha: evidence.trustedSha,
      packageRunId: evidence.packageRunId,
      packageSha256: evidence.packageSha256,
      assetId: evidence.assetId,
      hostId: evidence.hostId,
      labReadiness: { ...evidence.labReadiness },
      system: structuredClone(evidence.system),
      browser: structuredClone(evidence.browser),
      driver: structuredClone(evidence.driver),
      hostInventory: evidence.hostInventory
        ? structuredClone(evidence.hostInventory)
        : null,
      authorizationSha256: evidence.authorizationSha256,
      controllerSignatureSha256: evidence.controllerSignatureSha256,
      routeBasePath: evidence.routeBasePath,
      mediaChallenge: evidence.mediaChallenge,
      result: "success",
    },
    expiresAt: evidence.expiresAt,
  };
}

function assertPackageRunId(packageRunId) {
  if (!Number.isInteger(packageRunId) || packageRunId < 1) {
    throw new Error("matrix record package run ID must be a positive integer");
  }
}

function assertWorkflowRun(run) {
  if (
    !Number.isInteger(run?.id) ||
    run.id < 1 ||
    !Number.isInteger(run.attempt) ||
    run.attempt < 1
  ) {
    throw new Error("matrix record workflow run identity is invalid");
  }
}

function assertLabReadinessIdentity(identity, flatDigest) {
  if (
    identity === null ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join(",") !==
      "labInfrastructureDigest,manifestSha256,runId" ||
    !Number.isInteger(identity.runId) ||
    identity.runId < 1 ||
    !/^[0-9a-f]{64}$/u.test(identity.manifestSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(identity.labInfrastructureDigest ?? "") ||
    identity.labInfrastructureDigest !== flatDigest
  ) {
    throw new Error("matrix record laboratory readiness identity is invalid");
  }
}

function assertRuntimeProvenance(record) {
  const systemBuild = record.system?.build ?? record.system?.osBuild;
  if (
    !nonEmpty(systemBuild) ||
    !nonEmpty(record.browser?.name) ||
    !nonEmpty(record.browser?.channel) ||
    !nonEmpty(record.browser?.version) ||
    !nonEmpty(record.driver?.name) ||
    !nonEmpty(record.driver?.version)
  ) {
    throw new Error("matrix record runtime provenance is incomplete");
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function finalizeMatrixRecord({
  source,
  artifactId,
  attestation,
  selectedRun,
}) {
  const allowedWorkflowPaths = new Set([
    ".github/workflows/browser-hardware.yml",
    ".github/workflows/submit-browser-manual-evidence.yml",
  ]);
  if (
    !Number.isInteger(artifactId) ||
    artifactId < 1 ||
    attestation?.verified !== true ||
    attestation.denySelfHostedRunners !== true
  ) {
    throw new Error("matrix record requires exact artifact and attestation proof");
  }
  if (
    !Number.isInteger(selectedRun?.id) ||
    selectedRun.id < 1 ||
    !Number.isInteger(selectedRun.attempt) ||
    selectedRun.attempt < 1 ||
    !allowedWorkflowPaths.has(selectedRun.path) ||
    source?.workflow?.runId !== selectedRun.id ||
    source.workflow.runAttempt !== selectedRun.attempt ||
    source.workflow.path !== selectedRun.path
  ) {
    throw new Error("matrix record source does not match the selected workflow run");
  }
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
