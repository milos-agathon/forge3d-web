import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "./canonical-json.mjs";
import { FIXED_REPOSITORY } from "./protocol.mjs";
import {
  normalizeAuthorization,
  validateAuthorizationRecord,
} from "./runner-authorization.mjs";

const githubActionsApp = Object.freeze({ id: 15368, slug: "github-actions" });

export class FileAuthorizationVerifier {
  constructor({
    directory,
    github,
    repositoryTrustPolicy,
    attestationVerifier = verifyAuthorizationAttestation,
    now = () => new Date(),
  }) {
    this.directory = directory;
    this.github = github;
    this.repositoryTrustPolicy = repositoryTrustPolicy;
    this.attestationVerifier = attestationVerifier;
    this.now = now;
  }

  async verify({
    digest,
    controllerAssetId,
    mode = "issuance",
  }) {
    if (!["issuance", "cleanup"].includes(mode)) {
      throw new Error("authorization verification mode is invalid");
    }
    const cleanup = mode === "cleanup";
    if (!/^[0-9a-f]{64}$/u.test(digest ?? "")) {
      throw new Error("authorization digest is invalid");
    }
    const path = join(this.directory, `${digest}.json`);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("authorization record must be a regular non-symlink file");
    }
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error("authorization file content does not match requested digest");
    }
    const text = bytes.toString("utf8");
    const authorization = JSON.parse(text);
    if (canonicalJson(authorization) !== text) {
      throw new Error("runner authorization is not canonical JSON");
    }
    validateAuthorizationRecord({
      authorization,
      digest,
      controllerAssetId,
      policy: this.repositoryTrustPolicy,
      now: this.now(),
      enforceExpiry: !cleanup,
    });
    await this.attestationVerifier({
      path,
      bundlePath: join(this.directory, `${digest}.bundle.jsonl`),
      authorization,
    });
    await verifyLiveRepositoryTrust({
      github: this.github,
      policy: this.repositoryTrustPolicy,
      targetSha: authorization.trustedSha,
      allowRegisteredRunners: cleanup,
      requireCurrentTarget: !cleanup,
    });
    const job = await this.github.getJob(
      authorization.queuedHardwareJob.id,
    );
    if (
      job.id !== authorization.queuedHardwareJob.id ||
      job.run_id !== authorization.run.id ||
      (!cleanup && job.status !== "queued") ||
      job.head_sha !== authorization.trustedSha
    ) {
      throw new Error("live job does not match runner authorization");
    }
    return normalizeAuthorization(authorization);
  }
}

export async function verifyLiveRepositoryTrust({
  github,
  policy,
  targetSha,
  allowRegisteredRunners = false,
  requireCurrentTarget = true,
}) {
  if (
    policy.bootstrapState !== "active" ||
    !/^[0-9a-f]{40}$/u.test(policy.trustEpochSha ?? "")
  ) {
    throw new Error("repository trust epoch is not active");
  }
  const [repository, branch, protection, actionsPermissions] = await Promise.all([
    github.getRepository(),
    github.getBranch(policy.repository.defaultBranch),
    github.getProtection(policy.repository.defaultBranch),
    github.getActionsPermissions(),
  ]);
  if (
    repository.id !== policy.repository.id ||
    repository.full_name !== policy.repository.fullName ||
    repository.default_branch !== policy.repository.defaultBranch ||
    branch.protected !== true ||
    (requireCurrentTarget && branch.commit?.sha !== targetSha)
  ) {
    throw new Error("live repository/default-branch identity does not match authorization");
  }
  const comparison = await github.compareCommits(policy.trustEpochSha, targetSha);
  if (comparison.status !== "ahead" || comparison.ahead_by < 1) {
    throw new Error("authorization target is not a strict trust-epoch descendant");
  }
  const required = policy.branchProtection.requiredStatusChecks;
  if (
    required.checks.some(
      (check) =>
        check.sourceAppId !== githubActionsApp.id ||
        check.sourceAppSlug !== githubActionsApp.slug,
    )
  ) {
    throw new Error(
      "checked required status checks must use the GitHub Actions App 15368/github-actions",
    );
  }
  const checks = (protection.required_status_checks?.checks ?? [])
    .map((check) => ({ context: check.context, appId: check.app_id }))
    .sort(compareChecks);
  const expectedChecks = required.checks
    .map((check) => ({ context: check.context, appId: check.sourceAppId }))
    .sort(compareChecks);
  const requiredReviews =
    policy.branchProtection.requiredPullRequestReviews;
  if (
    protection.required_status_checks?.strict !== true ||
    canonicalJson(checks) !== canonicalJson(expectedChecks) ||
    protection.required_pull_request_reviews?.dismiss_stale_reviews !==
      requiredReviews.dismissStaleReviews ||
    protection.required_pull_request_reviews?.require_last_push_approval !==
      requiredReviews.requireLastPushApproval ||
    protection.required_pull_request_reviews?.required_approving_review_count !==
      requiredReviews.requiredApprovingReviewCount ||
    protection.required_conversation_resolution?.enabled !== true ||
    protection.enforce_admins?.enabled !== true ||
    protection.allow_force_pushes?.enabled !== false ||
    protection.allow_deletions?.enabled !== false
  ) {
    throw new Error("live branch protection does not match checked policy");
  }
  for (const kind of ["users", "teams", "apps"]) {
    if (
      (protection.required_pull_request_reviews?.bypass_pull_request_allowances?.[
        kind
      ] ?? []).length > 0
    ) {
      throw new Error("live branch protection contains a bypass actor");
    }
  }
  if (protection.restrictions !== null && protection.restrictions !== undefined) {
    for (const kind of ["users", "teams", "apps"]) {
      if ((protection.restrictions[kind] ?? []).length > 0) {
        throw new Error("live branch protection contains a restriction bypass actor");
      }
    }
  }
  if (
    Object.hasOwn(actionsPermissions, "sha_pinning_required") &&
    actionsPermissions.sha_pinning_required !== true
  ) {
    throw new Error("live Actions full-SHA policy is disabled");
  }
  const workflowRuns = completeCollection(
    await github.getWorkflowRunsForSha(targetSha),
    "workflow_runs",
    "workflow runs",
  );
  const runs = workflowRuns.filter(
    (run) =>
      run.path === ".github/workflows/web.yml" &&
      run.head_branch === policy.repository.defaultBranch &&
      run.head_sha === targetSha &&
      run.event === "push",
  );
  if (runs.length !== 1) {
    throw new Error("target main SHA does not have exactly one completed Web Runtime run");
  }
  const [run] = runs;
  if (
    !Number.isInteger(run.id) ||
    run.id < 1 ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error(
      "target-main Web Runtime push run is not a completed successful run",
    );
  }
  const [runJobsResponse, checkRunsResponse] = await Promise.all([
    github.getRunJobs(run.id),
    github.getCheckRunsForSha(targetSha),
  ]);
  const runJobs = completeCollection(runJobsResponse, "jobs", "workflow jobs");
  const checkRuns = completeCollection(
    checkRunsResponse,
    "check_runs",
    "check runs",
  );
  for (const requiredCheck of required.checks) {
    const jobs = runJobs.filter(
      (job) => job.name === requiredCheck.context,
    );
    const matchingCheckRuns = checkRuns.filter(
      (checkRun) => checkRun.name === requiredCheck.context,
    );
    if (
      jobs.length !== 1 ||
      matchingCheckRuns.length !== 1
    ) {
      throw new Error(
        `${requiredCheck.context} must resolve to exactly one GitHub Actions workflow job and check run`,
      );
    }
    const [job] = jobs;
    const [checkRun] = matchingCheckRuns;
    if (
      !Number.isInteger(job.id) ||
      job.id < 1 ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    ) {
      throw new Error(
        `${requiredCheck.context} workflow job is not a completed successful check`,
      );
    }
    if (
      !Number.isInteger(checkRun.id) ||
      checkRun.id < 1 ||
      checkRun.status !== "completed" ||
      checkRun.conclusion !== "success"
    ) {
      throw new Error(
        `${requiredCheck.context} check run is not a completed successful check`,
      );
    }
    if (job.head_sha !== targetSha || checkRun.head_sha !== targetSha) {
      throw new Error(`${requiredCheck.context} is stale for target main`);
    }
    if (
      checkRun.app?.id !== githubActionsApp.id ||
      checkRun.app?.slug !== githubActionsApp.slug
    ) {
      throw new Error(
        `${requiredCheck.context} check run is not owned by GitHub Actions App 15368/github-actions`,
      );
    }
    if (
      typeof job.check_run_url !== "string" ||
      typeof checkRun.url !== "string" ||
      job.check_run_url !== checkRun.url ||
      !isExactCheckRunUrl(checkRun.url, checkRun.id)
    ) {
      throw new Error(
        `${requiredCheck.context} workflow job/check-run binding is mismatched`,
      );
    }
  }
  if (!allowRegisteredRunners) {
    const runners = await github.listRunners();
    if (runners.total_count !== 0 || (runners.runners ?? []).length !== 0) {
      throw new Error("repository has a registered runner before JIT issuance");
    }
  }
  return { currentMainSha: branch.commit.sha };
}

function verifyAuthorizationAttestation({
  path,
  bundlePath,
  authorization,
}) {
  const result = spawnSync(
    "gh",
    [
      "attestation",
      "verify",
      path,
      "--bundle",
      bundlePath,
      "--repo",
      FIXED_REPOSITORY.fullName,
      "--signer-workflow",
      `${FIXED_REPOSITORY.fullName}/${authorization.workflow.path}`,
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      authorization.workflow.sha,
      "--deny-self-hosted-runners",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`runner authorization attestation failed: ${result.stderr.trim()}`);
  }
}

function compareChecks(left, right) {
  return left.context.localeCompare(right.context) || left.appId - right.appId;
}

function completeCollection(response, property, label) {
  const entries = response?.[property];
  if (
    !Array.isArray(entries) ||
    !Number.isInteger(response?.total_count) ||
    response.total_count !== entries.length
  ) {
    throw new Error(`${label} response is incomplete`);
  }
  return entries;
}

function isExactCheckRunUrl(value, id) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname ===
        `/repos/${FIXED_REPOSITORY.fullName}/check-runs/${id}` &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
