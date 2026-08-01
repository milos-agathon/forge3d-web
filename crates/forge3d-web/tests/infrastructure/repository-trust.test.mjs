import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyLiveRepositoryTrust,
  verifyRepositoryTrustSnapshot,
} from "../../scripts/verify-repository-trust.mjs";

const infrastructureRoot = dirname(fileURLToPath(import.meta.url));
const checkedPolicy = readJson(join(infrastructureRoot, "repository-trust-policy.json"));
const actionsLock = readJson(join(infrastructureRoot, "workflow-actions-lock.json"));

test("checked policy remains explicitly incomplete before the protected-main canary", () => {
  assert.throws(
    () => verifyRepositoryTrustSnapshot(makeInput({ policy: checkedPolicy })),
    /bootstrap is incomplete/u,
  );
});

test("accepts the exact active protected-main snapshot", () => {
  const input = makeInput();
  const result = verifyRepositoryTrustSnapshot(input);
  assert.equal(result.ok, true);
  assert.equal(result.actionsShaPinning, "enabled");
  assert.deepEqual(
    result.requiredChecks.map((check) => check.name).sort(),
    [
      "Web Runtime / Browser Preflight",
      "Web Runtime / Build And Contract Tests",
    ],
  );
  assert.deepEqual(result.requiredChecks[0].app, {
    id: 15368,
    slug: "github-actions",
  });
  assert.equal(result.requiredChecks[0].headSha, input.branch.commit.sha);
  assert.equal(result.requiredChecks[0].status, "completed");
  assert.equal(result.requiredChecks[0].workflowJobId, 1000);
});

test("live verification fetches and binds the exact current-main check-run response", async () => {
  const context = makeLiveContext();
  const result = await runLiveVerification(context);
  const checkRunsResponse = result.liveResponses.find(
    (response) => response.name === "checkRuns",
  );
  assert.equal(result.liveResponses.length, 9);
  assert.equal(
    checkRunsResponse.endpoint,
    context.checkRunsEndpoint,
  );
  assert.equal(context.requested.includes(checkRunsResponse.endpoint), true);
  for (const request of context.requests) {
    assert.equal(
      request.authorization,
      request.endpoint === context.checkRunsEndpoint
        ? "Bearer workflow-token"
        : "Bearer observer-token",
      `wrong credential for ${request.endpoint}`,
    );
  }
});

test("live verification requires distinct observer and workflow credentials", async () => {
  const context = makeLiveContext();
  await assert.rejects(
    verifyLiveRepositoryTrust({
      policy: context.input.policy,
      actionsLock,
      observerToken: "shared-token",
      workflowToken: "shared-token",
      apiBase: "https://api.github.test",
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    }),
    /must be distinct/u,
  );
});

for (const [name, mutate, expectedError] of [
  [
    "an incomplete workflow-run page",
    (context) => {
      context.workflowRuns.total_count = 2;
    },
    /workflow runs response is incomplete/u,
  ],
  [
    "duplicate matching workflow runs",
    (context) => {
      const duplicate = structuredClone(context.workflowRuns.workflow_runs[0]);
      duplicate.id = 7002;
      context.workflowRuns.workflow_runs.push(duplicate);
      context.workflowRuns.total_count = 2;
    },
    /exactly one completed Web Runtime push run/u,
  ],
  [
    "a failed workflow run",
    (context) => {
      context.workflowRuns.workflow_runs[0].conclusion = "failure";
    },
    /not a completed successful run/u,
  ],
  [
    "a workflow run without a positive integer id",
    (context) => {
      context.workflowRuns.workflow_runs[0].id = 0;
    },
    /not a completed successful run/u,
  ],
]) {
  test(`live verification rejects ${name}`, async () => {
    const context = makeLiveContext();
    mutate(context);
    await assert.rejects(runLiveVerification(context), expectedError);
  });
}

for (const [name, mutate, expected] of [
  [
    "repository id",
    (input) => {
      input.repository.id += 1;
    },
    /repository ID mismatch/u,
  ],
  [
    "strict checks",
    (input) => {
      input.protection.required_status_checks.strict = false;
    },
    /strict required status checks mismatch/u,
  ],
  [
    "any-source check",
    (input) => {
      input.protection.required_status_checks.checks[0].app_id = -1;
    },
    /any-source/u,
  ],
  [
    "source app",
    (input) => {
      input.protection.required_status_checks.checks[0].app_id += 1;
    },
    /required status checks mismatch/u,
  ],
  [
    "stale review dismissal",
    (input) => {
      input.protection.required_pull_request_reviews.dismiss_stale_reviews = false;
    },
    /stale approval dismissal mismatch/u,
  ],
  [
    "required approving reviews",
    (input) => {
      input.protection.required_pull_request_reviews.required_approving_review_count = 1;
    },
    /required approving reviews mismatch/u,
  ],
  [
    "latest push approval",
    (input) => {
      input.protection.required_pull_request_reviews.require_last_push_approval = true;
    },
    /latest push approval mismatch/u,
  ],
  [
    "conversation resolution",
    (input) => {
      input.protection.required_conversation_resolution.enabled = false;
    },
    /conversation resolution mismatch/u,
  ],
  [
    "admin enforcement",
    (input) => {
      input.protection.enforce_admins.enabled = false;
    },
    /administrator enforcement mismatch/u,
  ],
  [
    "force pushes",
    (input) => {
      input.protection.allow_force_pushes.enabled = true;
    },
    /force pushes mismatch/u,
  ],
  [
    "branch deletion",
    (input) => {
      input.protection.allow_deletions.enabled = true;
    },
    /branch deletion mismatch/u,
  ],
  [
    "bypass actor",
    (input) => {
      input.protection.required_pull_request_reviews.bypass_pull_request_allowances.users.push(
        { login: "bypass" },
      );
    },
    /bypass users/u,
  ],
  [
    "failed check",
    (input) => {
      input.actionJobs.jobs[0].conclusion = "failure";
    },
    /not a completed successful check/u,
  ],
  [
    "missing check run",
    (input) => {
      input.checkRuns.check_runs.pop();
      input.checkRuns.total_count -= 1;
    },
    /exactly one GitHub Actions workflow job and check run/u,
  ],
  [
    "duplicate check run",
    (input) => {
      const duplicate = structuredClone(input.checkRuns.check_runs[0]);
      duplicate.id = 9001;
      duplicate.url = `${duplicate.url.slice(0, duplicate.url.lastIndexOf("/") + 1)}9001`;
      input.checkRuns.check_runs.push(duplicate);
      input.checkRuns.total_count += 1;
    },
    /exactly one GitHub Actions workflow job and check run/u,
  ],
  [
    "duplicate workflow job",
    (input) => {
      const duplicate = structuredClone(input.actionJobs.jobs[0]);
      duplicate.id = 9002;
      input.actionJobs.jobs.push(duplicate);
      input.actionJobs.total_count += 1;
    },
    /exactly one GitHub Actions workflow job and check run/u,
  ],
  [
    "stale check-run SHA",
    (input) => {
      input.checkRuns.check_runs[0].head_sha = "c".repeat(40);
    },
    /stale for current main/u,
  ],
  [
    "stale workflow-job SHA",
    (input) => {
      input.actionJobs.jobs[0].head_sha = "c".repeat(40);
    },
    /stale for current main/u,
  ],
  [
    "check-run app id",
    (input) => {
      input.checkRuns.check_runs[0].app.id = 1;
    },
    /not owned by GitHub Actions App/u,
  ],
  [
    "check-run app slug",
    (input) => {
      input.checkRuns.check_runs[0].app.slug = "lookalike-actions";
    },
    /not owned by GitHub Actions App/u,
  ],
  [
    "workflow-job/check-run binding",
    (input) => {
      input.actionJobs.jobs[0].check_run_url += "-other";
    },
    /workflow job\/check-run binding is mismatched/u,
  ],
  [
    "partial check-run response",
    (input) => {
      input.checkRuns.total_count += 1;
    },
    /check runs response is incomplete/u,
  ],
  [
    "checked required-check app identity",
    (input) => {
      input.policy.branchProtection.requiredStatusChecks.checks[0].sourceAppId = 1;
      input.policy.branchProtection.requiredStatusChecks.checks[0].sourceAppSlug =
        "lookalike-actions";
      input.protection.required_status_checks.checks[0].app_id = 1;
      input.checkRuns.check_runs[0].app = {
        id: 1,
        slug: "lookalike-actions",
      };
    },
    /must use the GitHub Actions App 15368\/github-actions/u,
  ],
  [
    "SHA pinning",
    (input) => {
      input.actionsPermissions.sha_pinning_required = false;
    },
    /full-SHA policy mismatch/u,
  ],
  [
    "epoch",
    (input) => {
      input.trustEpochComparison.status = "identical";
      input.trustEpochComparison.ahead_by = 0;
    },
    /strict descendant/u,
  ],
  [
    "runner at rest",
    (input) => {
      input.repositoryRunners = {
        total_count: 1,
        runners: [{ id: 1, name: "persistent" }],
      };
    },
    /no registered runner/u,
  ],
]) {
  test(`fails closed when ${name} changes`, () => {
    const input = makeInput();
    mutate(input);
    assert.throws(() => verifyRepositoryTrustSnapshot(input), expected);
  });
}

test("records an unavailable live SHA-pinning setting without relaxing static pins", () => {
  const input = makeInput();
  input.actionsPermissions = { enabled: true, allowed_actions: "all" };
  assert.equal(
    verifyRepositoryTrustSnapshot(input).actionsShaPinning,
    "unavailable",
  );
});

function makeInput({ policy = makeActivePolicy() } = {}) {
  const requiredChecks = policy.branchProtection.requiredStatusChecks.checks;
  const currentMainSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const actionJobs = requiredChecks.map((check, index) => {
    const checkRunId = 2000 + index;
    return {
      id: 1000 + index,
      name: check.context,
      head_sha: currentMainSha,
      status: "completed",
      conclusion: "success",
      check_run_url: `https://api.github.com/repos/${policy.repository.fullName}/check-runs/${checkRunId}`,
    };
  });
  const checkRuns = requiredChecks.map((check, index) => {
    const checkRunId = 2000 + index;
    return {
      id: checkRunId,
      name: check.context,
      head_sha: currentMainSha,
      status: "completed",
      conclusion: "success",
      url: `https://api.github.com/repos/${policy.repository.fullName}/check-runs/${checkRunId}`,
      app: { id: 15368, slug: "github-actions" },
    };
  });
  return {
    policy: structuredClone(policy),
    actionsLock,
    repository: {
      id: policy.repository.id,
      full_name: policy.repository.fullName,
      default_branch: "main",
    },
    branch: {
      name: "main",
      protected: true,
      commit: { sha: currentMainSha },
    },
    protection: {
      required_status_checks: {
        strict: true,
        contexts: requiredChecks.map((check) => check.context),
        checks: requiredChecks.map((check) => ({
          context: check.context,
          app_id: check.sourceAppId,
        })),
      },
      required_pull_request_reviews: {
        required_approving_review_count: 0,
        dismiss_stale_reviews: true,
        require_last_push_approval: false,
        bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
      },
      required_conversation_resolution: { enabled: true },
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      restrictions: null,
    },
    actionJobs: {
      total_count: actionJobs.length,
      jobs: actionJobs,
    },
    checkRuns: {
      total_count: checkRuns.length,
      check_runs: checkRuns,
    },
    actionsPermissions: {
      enabled: true,
      allowed_actions: "all",
      sha_pinning_required: true,
    },
    repositoryRunners: { total_count: 0, runners: [] },
    trustEpochComparison: { status: "ahead", ahead_by: 1 },
  };
}

function makeLiveContext() {
  const input = makeInput();
  const repositoryPath = `/repos/${input.policy.repository.fullName}`;
  const workflowRun = {
    id: 7001,
    path: ".github/workflows/web.yml",
    head_branch: "main",
    head_sha: input.branch.commit.sha,
    status: "completed",
    conclusion: "success",
  };
  const workflowRuns = { total_count: 1, workflow_runs: [workflowRun] };
  const workflowRunsEndpoint =
    `${repositoryPath}/actions/runs?branch=main&head_sha=${input.branch.commit.sha}` +
    "&event=push&status=completed&per_page=100";
  const checkRunsEndpoint =
    `${repositoryPath}/commits/${input.branch.commit.sha}/check-runs` +
    "?filter=all&per_page=100";
  const routes = new Map([
    [repositoryPath, input.repository],
    [`${repositoryPath}/branches/main`, input.branch],
    [`${repositoryPath}/branches/main/protection`, input.protection],
    [`${repositoryPath}/actions/permissions`, input.actionsPermissions],
    [`${repositoryPath}/actions/runners?per_page=100`, input.repositoryRunners],
    [workflowRunsEndpoint, workflowRuns],
    [
      `${repositoryPath}/actions/runs/${workflowRun.id}/jobs?filter=latest&per_page=100`,
      input.actionJobs,
    ],
    [checkRunsEndpoint, input.checkRuns],
    [
      `${repositoryPath}/compare/${input.policy.trustEpochSha}...${input.branch.commit.sha}`,
      input.trustEpochComparison,
    ],
  ]);
  return {
    input,
    repositoryPath,
    workflowRuns,
    workflowRunsEndpoint,
    checkRunsEndpoint,
    routes,
    requested: [],
    requests: [],
  };
}

function runLiveVerification(context) {
  return verifyLiveRepositoryTrust({
    policy: context.input.policy,
    actionsLock,
    observerToken: "observer-token",
    workflowToken: "workflow-token",
    apiBase: "https://api.github.test",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      const key = `${parsed.pathname}${parsed.search}`;
      context.requested.push(key);
      context.requests.push({
        endpoint: key,
        authorization: options.headers.Authorization,
      });
      const value = context.routes.get(key);
      return {
        ok: value !== undefined,
        status: value === undefined ? 404 : 200,
        json: async () => structuredClone(value),
      };
    },
  });
}

function makeActivePolicy() {
  const policy = structuredClone(checkedPolicy);
  policy.bootstrapState = "active";
  policy.trustEpochSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return policy;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
