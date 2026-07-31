import { createHash } from "node:crypto";

import { validateAuthorization } from "./controller.mjs";

export async function resolveAuthorizationForQueuedJob({
  hostId,
  expectedHardwareLabel,
  run,
  jobsClient,
  artifactClient,
  attestationVerifier,
  now = new Date(),
}) {
  if (
    !Number.isInteger(run?.id) ||
    run.id < 1 ||
    !Number.isInteger(run.attempt) ||
    run.attempt < 1 ||
    !/^[0-9a-f]{40}$/u.test(run.workflowSha ?? "")
  ) {
    throw new Error("selected API workflow run identity is invalid");
  }
  const jobs = await jobsClient.listRunAttemptJobs(run.id, run.attempt);
  const queued = jobs.filter(
    (job) =>
      job.name === "Browser Hardware / Ephemeral Execution" &&
      job.status === "queued" &&
      job.labels?.includes("forge3d-web") &&
      job.labels.includes(expectedHardwareLabel) &&
      job.labels.some((label) => /^jit-[0-9a-f]{32}$/u.test(label)),
  );
  if (queued.length !== 1) {
    throw new Error("controller requires exactly one matching queued hardware job");
  }
  const promotion = uniqueCompletedJob(
    jobs,
    "Browser Hardware / Promote Trusted Artifact",
  );
  const authorizationJob = uniqueCompletedJob(
    jobs,
    "Browser Hardware / Authorize JIT Runner",
  );
  const nonceLabels = queued[0].labels.filter((label) =>
    /^jit-[0-9a-f]{32}$/u.test(label),
  );
  if (nonceLabels.length !== 1) {
    throw new Error("controller requires exactly one queued runner nonce label");
  }
  const [nonceLabel] = nonceLabels;
  // The nonce comes from this exact attempt's jobs response. The artifact API is
  // run-scoped; attempt authority comes from these jobs and the attested record.
  const artifactName = `runner-authorization-${nonceLabel.slice(4)}`;
  const artifacts = await artifactClient.listRunArtifacts(run.id);
  const matches = artifacts.filter(
    (artifact) =>
      artifact.name === artifactName &&
      artifact.expired === false &&
      artifact.workflowRunId === run.id,
  );
  if (matches.length !== 1) {
    throw new Error("authorization artifact is missing, duplicated, expired, or mismatched");
  }
  const downloaded = await artifactClient.downloadById(matches[0].id);
  if (
    downloaded.files.length !== 1 ||
    downloaded.files[0].name !== "runner-authorization.json"
  ) {
    throw new Error("authorization artifact must contain one canonical record");
  }
  const bytes = downloaded.files[0].bytes;
  if (
    matches[0].digest !== `sha256:${sha256(downloaded.archiveBytes)}` ||
    downloaded.archiveDigest !== matches[0].digest
  ) {
    throw new Error("authorization artifact archive digest mismatch");
  }
  await attestationVerifier.verify({
    bytes,
    repository: "milos-agathon/forge3d-web",
    signerWorkflow:
      "milos-agathon/forge3d-web/.github/workflows/browser-hardware.yml",
    sourceRef: "refs/heads/main",
    sourceDigest: run.workflowSha,
    denySelfHostedRunners: true,
  });
  const authorization = JSON.parse(bytes.toString("utf8"));
  validateAuthorization(authorization, hostId, now);
  const signedLabels = [
    ...authorization.customLabels,
    ...authorization.platformLabels,
  ];
  if (
    authorization.workflow.sha !== run.workflowSha ||
    authorization.run.id !== run.id ||
    authorization.run.attempt !== run.attempt ||
    authorization.queuedHardwareJob.id !== queued[0].id ||
    authorization.promotionJobId !== promotion.id ||
    authorization.authorizationJobId !== authorizationJob.id ||
    authorization.customLabels[1] !== expectedHardwareLabel ||
    !sameUniqueLabels(queued[0].labels, signedLabels)
  ) {
    throw new Error("authorization record does not match API-visible jobs");
  }
  return {
    authorization,
    authorizationArtifactId: matches[0].id,
    authorizationDigest: sha256(bytes),
  };
}

function sameUniqueLabels(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return (
    actualSet.size === actual.length &&
    expectedSet.size === expected.length &&
    actualSet.size === expectedSet.size &&
    [...actualSet].every((label) => expectedSet.has(label))
  );
}

function uniqueCompletedJob(jobs, name) {
  const matches = jobs.filter(
    (job) =>
      job.name === name &&
      job.status === "completed" &&
      job.conclusion === "success",
  );
  if (matches.length !== 1) {
    throw new Error(`controller requires one successful ${name} job`);
  }
  return matches[0];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
