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
  const matchingRuns = (responses.workflowRuns.workflow_runs ?? []).filter(
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
  endpoints.workflowJobs =
    `${repositoryPath}/actions/runs/${matchingRuns[0].id}/jobs?filter=latest&per_page=100`;
  responses.workflowJobs = await getJson(
    fetchImpl,
    `${apiBase}${endpoints.workflowJobs}`,
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

  const checkRunList = actionJobs.jobs ?? [];
  const verifiedChecks = desiredProtection.requiredStatusChecks.checks.map(
    (required) => {
      const candidates = checkRunList.filter(
        (check) =>
          check.name === required.context,
      );
      if (candidates.length !== 1) {
        throw new Error(
          `${required.context} must resolve to exactly one GitHub Actions check run`,
        );
      }
      const [check] = candidates;
      if (check.status !== "completed" || check.conclusion !== "success") {
        throw new Error(`${required.context} is not a completed successful check`);
      }
      return {
        id: check.id,
        name: check.name,
        conclusion: check.conclusion,
        sourceAppId: required.sourceAppId,
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
