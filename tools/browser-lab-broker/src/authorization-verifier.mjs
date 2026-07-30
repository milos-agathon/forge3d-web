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
      (job.head_sha !== undefined &&
        job.head_sha !== authorization.trustedSha)
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
  const checks = (protection.required_status_checks?.checks ?? [])
    .map((check) => ({ context: check.context, appId: check.app_id }))
    .sort(compareChecks);
  const expectedChecks = required.checks
    .map((check) => ({ context: check.context, appId: check.sourceAppId }))
    .sort(compareChecks);
  if (
    protection.required_status_checks?.strict !== true ||
    (protection.required_status_checks?.contexts ?? []).length !== 0 ||
    canonicalJson(checks) !== canonicalJson(expectedChecks) ||
    protection.required_pull_request_reviews?.dismiss_stale_reviews !== true ||
    protection.required_pull_request_reviews?.require_last_push_approval !== true ||
    protection.required_pull_request_reviews?.required_approving_review_count !== 1 ||
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
  const workflowRuns = await github.getWorkflowRunsForSha(targetSha);
  const runs = (workflowRuns.workflow_runs ?? []).filter(
    (run) =>
      run.path === ".github/workflows/web.yml" &&
      run.head_branch === "main" &&
      run.head_sha === targetSha,
  );
  if (runs.length !== 1) {
    throw new Error("target main SHA does not have exactly one completed Web Runtime run");
  }
  const runJobs = await github.getRunJobs(runs[0].id);
  for (const requiredCheck of required.checks) {
    const jobs = (runJobs.jobs ?? []).filter(
      (job) => job.name === requiredCheck.context,
    );
    if (
      jobs.length !== 1 ||
      jobs[0].status !== "completed" ||
      jobs[0].conclusion !== "success"
    ) {
      throw new Error(`${requiredCheck.context} is not a unique successful Actions job`);
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
