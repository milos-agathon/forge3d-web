import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const policyPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "repository-trust-policy.json",
);
const actionsLockPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "workflow-actions-lock.json",
);
const githubActionsApp = Object.freeze({ id: 15368, slug: "github-actions" });

export async function verifyLiveRepositoryTrust({
  policy = readJson(policyPath),
  actionsLock = readJson(actionsLockPath),
  token = process.env.GITHUB_TOKEN,
  apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com",
  fetchImpl = fetch,
} = {}) {
  if (!token) {
    throw new Error("GITHUB_TOKEN must be a short-lived trust-observer installation token");
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const repositoryPath = `/repos/${policy.repository.fullName}`;
  const endpoints = {
    repository: repositoryPath,
    branch: `${repositoryPath}/branches/${policy.repository.defaultBranch}`,
    protection: `${repositoryPath}/branches/${policy.repository.defaultBranch}/protection`,
    actionsPermissions: `${repositoryPath}/actions/permissions`,
    repositoryRunners: `${repositoryPath}/actions/runners?per_page=100`,
  };
  const responses = {};
  for (const [name, endpoint] of Object.entries(endpoints)) {
    responses[name] = await getJson(fetchImpl, `${apiBase}${endpoint}`, headers);
  }
  endpoints.workflowRuns =
    `${repositoryPath}/actions/runs?branch=${policy.repository.defaultBranch}` +
    `&head_sha=${responses.branch.commit.sha}&event=push&status=completed&per_page=100`;
  responses.workflowRuns = await getJson(
    fetchImpl,
    `${apiBase}${endpoints.workflowRuns}`,
    headers,
  );
  const workflowRunList = completeCollection(
    responses.workflowRuns,
    "workflow_runs",
    "workflow runs",
  );
  const matchingRuns = workflowRunList.filter(
    (run) =>
      run.path === ".github/workflows/web.yml" &&
      run.head_branch === policy.repository.defaultBranch &&
      run.head_sha === responses.branch.commit.sha,
  );
  if (matchingRuns.length !== 1) {
    throw new Error(
      "current main must have exactly one completed Web Runtime push run",
    );
  }
  const [matchingRun] = matchingRuns;
  if (
    !Number.isInteger(matchingRun.id) ||
    matchingRun.id < 1 ||
    matchingRun.status !== "completed" ||
    matchingRun.conclusion !== "success"
  ) {
    throw new Error(
      "current-main Web Runtime push run is not a completed successful run",
    );
  }
  endpoints.workflowJobs =
    `${repositoryPath}/actions/runs/${matchingRun.id}/jobs?filter=latest&per_page=100`;
  responses.workflowJobs = await getJson(
    fetchImpl,
    `${apiBase}${endpoints.workflowJobs}`,
    headers,
  );
  endpoints.checkRuns =
    `${repositoryPath}/commits/${responses.branch.commit.sha}/check-runs` +
    "?filter=all&per_page=100";
  responses.checkRuns = await getJson(
    fetchImpl,
    `${apiBase}${endpoints.checkRuns}`,
    headers,
  );
  if (policy.trustEpochSha) {
    responses.trustEpochComparison = await getJson(
      fetchImpl,
      `${apiBase}${repositoryPath}/compare/${policy.trustEpochSha}...${responses.branch.commit.sha}`,
      headers,
    );
    endpoints.trustEpochComparison =
      `${repositoryPath}/compare/${policy.trustEpochSha}...${responses.branch.commit.sha}`;
  }
  const result = verifyRepositoryTrustSnapshot({
    policy,
    actionsLock,
    repository: responses.repository,
    branch: responses.branch,
    protection: responses.protection,
    actionJobs: responses.workflowJobs,
    checkRuns: responses.checkRuns,
    actionsPermissions: responses.actionsPermissions,
    repositoryRunners: responses.repositoryRunners,
    trustEpochComparison: responses.trustEpochComparison,
  });
  result.liveResponses = Object.entries(responses)
    .map(([name, value]) => ({
      name,
      endpoint: endpoints[name],
      sha256: sha256Hex(value),
    }))
    .sort((left, right) => left.endpoint.localeCompare(right.endpoint));
  return result;
}

export function verifyRepositoryTrustSnapshot({
  policy,
  actionsLock,
  repository,
  branch,
  protection,
  actionJobs,
  checkRuns,
  actionsPermissions,
  repositoryRunners,
  trustEpochComparison,
}) {
  if (
    policy.bootstrapState !== "active" ||
    !/^[0-9a-f]{40}$/u.test(policy.trustEpochSha ?? "")
  ) {
    throw new Error(
      "repository trust bootstrap is incomplete: protect main, run the canary, and pin its merge SHA",
    );
  }
  assertEqual(repository.id, policy.repository.id, "repository ID");
  assertEqual(repository.full_name, policy.repository.fullName, "repository full name");
  assertEqual(repository.default_branch, policy.repository.defaultBranch, "default branch");
  assertEqual(branch.name, policy.repository.defaultBranch, "branch name");
  assertEqual(branch.protected, true, "main protection");
  assertMatch(branch.commit?.sha, /^[0-9a-f]{40}$/u, "main commit SHA");

  if (
    trustEpochComparison?.status !== "ahead" ||
    !Number.isInteger(trustEpochComparison.ahead_by) ||
    trustEpochComparison.ahead_by < 1
  ) {
    throw new Error(
      "current main must be a strict descendant of trustEpochSha; the epoch itself is ineligible",
    );
  }

  const desiredProtection = policy.branchProtection;
  if (
    desiredProtection.requiredStatusChecks.checks.some(
      (check) =>
        check.sourceAppId !== githubActionsApp.id ||
        check.sourceAppSlug !== githubActionsApp.slug,
    )
  ) {
    throw new Error(
      "checked required status checks must use the GitHub Actions App 15368/github-actions",
    );
  }
  const requiredStatusChecks = protection.required_status_checks;
  assertEqual(requiredStatusChecks?.strict, true, "strict required status checks");
  const actualChecks = [...(requiredStatusChecks?.checks ?? [])]
    .map((check) => ({ context: check.context, appId: check.app_id }))
    .sort(compareContexts);
  if (
    actualChecks.some(
      (check) => !Number.isInteger(check.appId) || check.appId < 0,
    )
  ) {
    throw new Error("required status checks cannot use any-source checks");
  }
  const desiredChecks = desiredProtection.requiredStatusChecks.checks
    .map((check) => ({ context: check.context, appId: check.sourceAppId }))
    .sort(compareContexts);
  assertDeepEqual(actualChecks, desiredChecks, "required status checks");

  const reviews = protection.required_pull_request_reviews;
  assertEqual(
    reviews?.required_approving_review_count,
    desiredProtection.requiredPullRequestReviews.requiredApprovingReviewCount,
    "required approving reviews",
  );
  assertEqual(
    reviews?.dismiss_stale_reviews,
    desiredProtection.requiredPullRequestReviews.dismissStaleReviews,
    "stale approval dismissal",
  );
  assertEqual(
    reviews?.require_last_push_approval,
    desiredProtection.requiredPullRequestReviews.requireLastPushApproval,
    "latest push approval",
  );
  assertNoBypassActors(reviews?.bypass_pull_request_allowances);
  assertEqual(
    protection.required_conversation_resolution?.enabled,
    desiredProtection.requiredConversationResolution,
    "conversation resolution",
  );
  assertEqual(
    protection.enforce_admins?.enabled,
    desiredProtection.enforceAdmins,
    "administrator enforcement",
  );
  assertEqual(
    protection.allow_force_pushes?.enabled,
    desiredProtection.allowForcePushes,
    "force pushes",
  );
  assertEqual(
    protection.allow_deletions?.enabled,
    desiredProtection.allowDeletions,
    "branch deletion",
  );
  if (protection.restrictions !== null && protection.restrictions !== undefined) {
    assertNoBypassActors(protection.restrictions);
  }

  const workflowJobList = completeCollection(actionJobs, "jobs", "workflow jobs");
  const checkRunList = completeCollection(checkRuns, "check_runs", "check runs");
  const verifiedChecks = desiredProtection.requiredStatusChecks.checks.map(
    (required) => {
      const workflowJobs = workflowJobList.filter(
        (job) => job.name === required.context,
      );
      const matchingCheckRuns = checkRunList.filter(
        (checkRun) => checkRun.name === required.context,
      );
      if (workflowJobs.length !== 1 || matchingCheckRuns.length !== 1) {
        throw new Error(
          `${required.context} must resolve to exactly one GitHub Actions workflow job and check run`,
        );
      }
      const [job] = workflowJobs;
      const [checkRun] = matchingCheckRuns;
      if (
        !Number.isInteger(job.id) ||
        job.id < 1 ||
        job.status !== "completed" ||
        job.conclusion !== "success"
      ) {
        throw new Error(
          `${required.context} workflow job is not a completed successful check`,
        );
      }
      if (
        !Number.isInteger(checkRun.id) ||
        checkRun.id < 1 ||
        checkRun.status !== "completed" ||
        checkRun.conclusion !== "success"
      ) {
        throw new Error(
          `${required.context} check run is not a completed successful check`,
        );
      }
      if (
        job.head_sha !== branch.commit.sha ||
        checkRun.head_sha !== branch.commit.sha
      ) {
        throw new Error(`${required.context} is stale for current main`);
      }
      if (
        checkRun.app?.id !== githubActionsApp.id ||
        checkRun.app?.slug !== githubActionsApp.slug
      ) {
        throw new Error(
          `${required.context} check run is not owned by GitHub Actions App 15368/github-actions`,
        );
      }
      if (
        typeof job.check_run_url !== "string" ||
        typeof checkRun.url !== "string" ||
        job.check_run_url !== checkRun.url
      ) {
        throw new Error(
          `${required.context} workflow job/check-run binding is mismatched`,
        );
      }
      return {
        id: checkRun.id,
        workflowJobId: job.id,
        name: checkRun.name,
        headSha: checkRun.head_sha,
        status: checkRun.status,
        conclusion: checkRun.conclusion,
        app: {
          id: checkRun.app.id,
          slug: checkRun.app.slug,
        },
      };
    },
  );

  let actionsShaPinning = "unavailable";
  if (Object.hasOwn(actionsPermissions, "sha_pinning_required")) {
    assertEqual(
      actionsPermissions.sha_pinning_required,
      true,
      "GitHub Actions full-SHA policy",
    );
    actionsShaPinning = "enabled";
  }
  if (
    repositoryRunners.total_count !== 0 ||
    (repositoryRunners.runners ?? []).length !== 0
  ) {
    throw new Error("repository must have no registered runner at observation time");
  }

  return {
    schemaVersion: 1,
    ok: true,
    repository: {
      id: repository.id,
      fullName: repository.full_name,
    },
    currentMainSha: branch.commit.sha,
    trustEpochSha: policy.trustEpochSha,
    policySha256: sha256Hex(policy),
    workflowActionsLockSha256: sha256Hex(actionsLock),
    requiredChecks: verifiedChecks,
    actionsShaPinning,
  };
}

async function getJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${new URL(url).pathname}`);
  }
  return response.json();
}

function completeCollection(response, property, label) {
  const entries = response?.[property];
  if (
    !Array.isArray(entries) ||
    !Number.isInteger(response.total_count) ||
    response.total_count !== entries.length
  ) {
    throw new Error(`${label} response is incomplete`);
  }
  return entries;
}

function assertNoBypassActors(value) {
  for (const kind of ["users", "teams", "apps"]) {
    if ((value?.[kind] ?? []).length !== 0) {
      throw new Error(`branch protection bypass ${kind} must be empty`);
    }
  }
}

function compareContexts(left, right) {
  return left.context.localeCompare(right.context) || left.appId - right.appId;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertMatch(actual, pattern, label) {
  if (typeof actual !== "string" || !pattern.test(actual)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await verifyLiveRepositoryTrust();
  console.log(canonicalJson(result));
}
