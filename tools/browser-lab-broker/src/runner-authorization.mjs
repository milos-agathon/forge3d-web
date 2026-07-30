import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.mjs";
import { FIXED_REPOSITORY } from "./protocol.mjs";

export function validateAuthorizationRecord({
  authorization,
  digest,
  controllerAssetId,
  policy,
  now,
  enforceExpiry,
}) {
  assertExactKeys(authorization, [
    "schemaVersion",
    "repository",
    "workflow",
    "run",
    "promotionJobId",
    "authorizationJobId",
    "queuedHardwareJob",
    "trustedSha",
    "trustEpochSha",
    "lane",
    "required",
    "assetId",
    "hostId",
    "runnerNonce",
    "nonceLabel",
    "runnerName",
    "customLabels",
    "platformLabels",
    "repositoryJitRunnerGroupId",
    "workFolder",
    "packageRunId",
    "packageManifestSha256",
    "labReadiness",
    "manualSession",
    "issuedAt",
    "expiresAt",
  ]);
  assertExactKeys(authorization.repository, ["id", "name"]);
  assertExactKeys(authorization.workflow, ["path", "ref", "sha", "event"]);
  assertExactKeys(authorization.run, ["id", "attempt"]);
  assertExactKeys(authorization.queuedHardwareJob, ["id", "name", "status"]);
  if (
    authorization.schemaVersion !== 1 ||
    authorization.repository?.id !== FIXED_REPOSITORY.id ||
    authorization.repository?.name !== FIXED_REPOSITORY.fullName ||
    authorization.workflow?.path !==
      ".github/workflows/browser-hardware.yml" ||
    authorization.workflow?.ref !== "refs/heads/main" ||
    authorization.workflow?.event !== "workflow_dispatch" ||
    authorization.hostId !== controllerAssetId ||
    authorization.trustEpochSha !== policy.trustEpochSha ||
    authorization.queuedHardwareJob?.name !==
      "Browser Hardware / Ephemeral Execution" ||
    authorization.queuedHardwareJob?.status !== "queued" ||
    authorization.workFolder !== "_work" ||
    authorization.repositoryJitRunnerGroupId !== 1 ||
    authorization.customLabels?.length !== 3 ||
    authorization.customLabels[0] !== "forge3d-web" ||
    !/^hw-[a-z0-9-]+$/u.test(authorization.customLabels[1] ?? "") ||
    authorization.customLabels[2] !==
      `jit-${authorization.runnerNonce}` ||
    authorization.nonceLabel !==
      `jit-${authorization.runnerNonce}` ||
    !/^[0-9a-f]{32}$/u.test(authorization.runnerNonce ?? "") ||
    authorization.runnerName !==
      `${authorization.hostId}-${authorization.runnerNonce}` ||
    !/^[a-z0-9-]+$/u.test(authorization.lane ?? "") ||
    typeof authorization.required !== "boolean" ||
    !/^FW-[A-Z0-9-]+$/u.test(authorization.assetId ?? "") ||
    !Array.isArray(authorization.platformLabels) ||
    !authorization.platformLabels.every(
      (label) => typeof label === "string" && label.length > 0,
    ) ||
    !isPositiveInteger(authorization.promotionJobId) ||
    !isPositiveInteger(authorization.authorizationJobId) ||
    !isPositiveInteger(authorization.packageRunId) ||
    !/^[0-9a-f]{64}$/u.test(
      authorization.packageManifestSha256 ?? "",
    ) ||
    !/^[0-9a-f]{40}$/u.test(authorization.trustedSha ?? "") ||
    !/^[0-9a-f]{40}$/u.test(authorization.workflow.sha ?? "") ||
    !isPositiveInteger(authorization.run?.id) ||
    !isPositiveInteger(authorization.run?.attempt) ||
    !isPositiveInteger(authorization.queuedHardwareJob?.id) ||
    !Number.isFinite(Date.parse(authorization.issuedAt)) ||
    !Number.isFinite(Date.parse(authorization.expiresAt)) ||
    (enforceExpiry &&
      Date.parse(authorization.expiresAt) <= now.getTime()) ||
    digest !== sha256Canonical(authorization)
  ) {
    throw new Error("runner authorization fields are invalid or expired");
  }
  validateOptionalBindings(authorization);
}

export function normalizeAuthorization(authorization) {
  return {
    schemaVersion: 1,
    repository: {
      id: authorization.repository.id,
      fullName: authorization.repository.name,
    },
    operation: "run-hardware-job",
    targetSha: authorization.trustedSha,
    workflowSha: authorization.workflow.sha,
    signerWorkflow: authorization.workflow.path,
    runId: authorization.run.id,
    jobId: authorization.queuedHardwareJob.id,
    jobStatus: authorization.queuedHardwareJob.status,
    targetAssetId: authorization.assetId,
    hostAssetId: authorization.hostId,
    hwLabel: authorization.customLabels[1],
    runnerNonce: authorization.runnerNonce,
    expiresAt: authorization.expiresAt,
    lane: authorization.lane,
    hasLabReadiness: authorization.labReadiness !== null,
    hasManualSession: authorization.manualSession !== null,
  };
}

function validateOptionalBindings(authorization) {
  const readiness = authorization.labReadiness;
  if (readiness !== null) {
    assertExactKeys(readiness, ["runId", "labInfrastructureDigest"]);
    if (
      !isPositiveInteger(readiness.runId) ||
      !/^[0-9a-f]{64}$/u.test(readiness.labInfrastructureDigest ?? "")
    ) {
      throw new Error("runner authorization readiness binding is invalid");
    }
  }
  const manual = authorization.manualSession;
  if (manual !== null) {
    assertExactKeys(manual, [
      "intakeReleaseId",
      "checklistId",
      "mediaChallenge",
      "intakeManifestSha256",
    ]);
    if (
      !isPositiveInteger(manual.intakeReleaseId) ||
      typeof manual.checklistId !== "string" ||
      manual.checklistId.length === 0 ||
      !/^[0-9a-f]{32}$/u.test(manual.mediaChallenge ?? "") ||
      !/^[0-9a-f]{64}$/u.test(manual.intakeManifestSha256 ?? "")
    ) {
      throw new Error("runner authorization manual binding is invalid");
    }
  }
}

function assertExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runner authorization object is invalid");
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error("runner authorization contains missing or extra fields");
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function sha256Canonical(value) {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}
