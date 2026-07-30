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
  const jobs = await jobsClient.listRunAttemptJobs(run.id, run.attempt);
  const queued = jobs.filter(
    (job) =>
      job.name === "Browser Hardware / Ephemeral Execution" &&
      job.status === "queued" &&
      job.labels.includes("forge3d-web") &&
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
  const nonceLabel = queued[0].labels.find((label) =>
    /^jit-[0-9a-f]{32}$/u.test(label),
  );
  const artifactName = `runner-authorization-${nonceLabel.slice(4)}`;
  const artifacts = await artifactClient.listRunArtifacts(run.id);
  const matches = artifacts.filter(
    (artifact) =>
      artifact.name === artifactName &&
      artifact.expired === false &&
      artifact.workflowRunId === run.id &&
      artifact.runAttempt === run.attempt,
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
  if (
    authorization.run.id !== run.id ||
    authorization.run.attempt !== run.attempt ||
    authorization.queuedHardwareJob.id !== queued[0].id ||
    authorization.promotionJobId !== promotion.id ||
    authorization.authorizationJobId !== authorizationJob.id ||
    authorization.customLabels.some(
      (label) => !queued[0].labels.includes(label),
    )
  ) {
    throw new Error("authorization record does not match API-visible jobs");
  }
  return {
    authorization,
    authorizationArtifactId: matches[0].id,
    authorizationDigest: sha256(bytes),
  };
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
