import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";

export function validateReleaseCandidate({
  targetSha,
  tag,
  packageVersion,
  readiness,
  repositorySettings,
  existingRelease,
  existingTag,
  repositoryTrust,
}) {
  if (
    !/^[0-9a-f]{40}$/u.test(targetSha ?? "") ||
    tag !== `v${packageVersion}` ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(
      packageVersion ?? "",
    ) ||
    readiness.status !== "RELEASE_MATRIX_READY" ||
    readiness.supportClaim !== true ||
    readiness.targetSha !== targetSha ||
    repositoryTrust.verified !== true ||
    repositoryTrust.targetSha !== targetSha ||
    repositoryTrust.currentMainSha !== targetSha ||
    repositorySettings.immutableReleases !== true ||
    existingRelease !== null ||
    existingTag !== null
  ) {
    throw new Error("supported release candidate is not publication-safe");
  }
  return true;
}

export function validateCanaryCandidate({
  candidateSha,
  publicationRunId,
  labInfrastructureDigest,
  repositorySettings,
  existingRelease,
  existingTag,
  repositoryTrust,
}) {
  const tag = `browser-lab-canary-${labInfrastructureDigest}-${publicationRunId}`;
  if (
    !/^[0-9a-f]{40}$/u.test(candidateSha ?? "") ||
    !/^[0-9a-f]{64}$/u.test(labInfrastructureDigest ?? "") ||
    !Number.isInteger(publicationRunId) ||
    publicationRunId < 1 ||
    repositoryTrust.verified !== true ||
    repositoryTrust.targetSha !== candidateSha ||
    repositoryTrust.currentMainSha !== candidateSha ||
    repositorySettings.immutableReleases !== true ||
    existingRelease !== null ||
    existingTag !== null
  ) {
    throw new Error("laboratory canary candidate is not publication-safe");
  }
  return { tag, supportClaim: false };
}

export function validateIndependentPublisher({
  actor,
  implementationActors,
  approvals,
}) {
  const approved = approvals.filter((approval) => approval.state === "approved");
  if (
    !actor ||
    implementationActors.includes(actor) ||
    approved.length < 1 ||
    approved.some(
      (approval) =>
        approval.user.login === actor ||
        implementationActors.includes(approval.user.login),
    )
  ) {
    throw new Error("publisher and every approval must be independent");
  }
  return approved.map((approval) => ({
    id: approval.user.id,
    login: approval.user.login,
  }));
}

export function createPublicationPreflight({
  mode,
  supportClaim,
  targetSha,
  tag,
  readiness,
  assets,
  observation,
  run,
  workflowSha,
  publisher,
  implementationActors,
  createdAt = new Date(),
}) {
  if (
    !["supported-release", "laboratory-canary"].includes(mode) ||
    supportClaim !== (mode === "supported-release") ||
    !/^[0-9a-f]{40}$/u.test(targetSha ?? "") ||
    !Array.isArray(assets) ||
    assets.length < 1 ||
    assets.some(
      (asset) =>
        !Number.isInteger(asset.sourceId) ||
        asset.sourceId < 1 ||
        !/^[0-9a-f]{64}$/u.test(asset.sha256 ?? "") ||
        !asset.name,
    ) ||
    new Set(assets.map((asset) => asset.name)).size !== assets.length
  ) {
    throw new Error("publication preflight asset set is invalid");
  }
  if (!publisher.actor || implementationActors.includes(publisher.actor)) {
    throw new Error("publication actor must be independent of implementation");
  }
  const record = {
    schemaVersion: 1,
    mode,
    supportClaim,
    repository: "milos-agathon/forge3d-web",
    workflow: run.workflow,
    workflowSha,
    run: { id: run.id, attempt: run.attempt },
    targetSha,
    tag,
    readiness: {
      runId: readiness.runId,
      artifactId: readiness.artifactId,
      sha256: readiness.sha256,
      status: readiness.status,
    },
    observation: {
      artifactId: observation.artifactId,
      artifactName: observation.artifactName,
      artifactDigest: observation.artifactDigest,
      contentSha256: observation.contentSha256,
    },
    assets: [...assets].sort((left, right) => left.name.localeCompare(right.name)),
    publisher: {
      job: publisher.job,
      environment: "forge3d-web-release",
      actor: publisher.actor,
      approvers: [],
    },
    implementationActors: [...implementationActors].sort(),
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(
      new Date(createdAt).getTime() + 30 * 60 * 1000,
    ).toISOString(),
  };
  return {
    record,
    canonical: canonicalJson(record),
    sha256: sha256Hex(record),
  };
}

export function verifyPublicationHandoff({
  preflight,
  expected,
  now = new Date(),
}) {
  if (
    preflight.workflowSha !== expected.workflowSha ||
    preflight.run.id !== expected.runId ||
    preflight.run.attempt !== expected.runAttempt ||
    preflight.targetSha !== expected.targetSha ||
    preflight.tag !== expected.tag ||
    preflight.publisher.job !== expected.publisherJob ||
    preflight.publisher.environment !== "forge3d-web-release" ||
    preflight.observation.artifactId !== expected.observationArtifactId ||
    preflight.observation.artifactName !== expected.observationArtifactName ||
    preflight.observation.artifactDigest !==
      expected.observationArtifactDigest ||
    preflight.observation.contentSha256 !== expected.observationContentSha256 ||
    sha256Hex(preflight) !== expected.preflightSha256 ||
    new Date(preflight.expiresAt) <= new Date(now)
  ) {
    throw new Error("publication preflight handoff is missing, stale, or mismatched");
  }
  return preflight;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const operation = process.argv[3];
  const result =
    operation === "create-preflight"
      ? createPublicationPreflight(input)
      : operation === "verify-handoff"
        ? verifyPublicationHandoff(input)
        : operation === "validate-release"
          ? validateReleaseCandidate(input)
          : operation === "validate-canary"
            ? validateCanaryCandidate(input)
            : null;
  if (result === null) throw new Error("unknown release-publication operation");
  if (process.argv[4]) {
    writeFileSync(
      process.argv[4],
      `${result.canonical ?? canonicalJson(result)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  console.log(JSON.stringify({ ok: true, operation }));
}
