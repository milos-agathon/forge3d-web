import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyRepositoryTrustSnapshot } from "../../scripts/verify-repository-trust.mjs";

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
});

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
    "any-source context",
    (input) => {
      input.protection.required_status_checks.contexts.push(
        "Web Runtime / Browser Preflight",
      );
    },
    /any-source/u,
  ],
  [
    "source app",
    (input) => {
      input.protection.required_status_checks.checks[0].app_id = null;
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
    "latest push approval",
    (input) => {
      input.protection.required_pull_request_reviews.require_last_push_approval = false;
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
      commit: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    },
    protection: {
      required_status_checks: {
        strict: true,
        contexts: [],
        checks: requiredChecks.map((check) => ({
          context: check.context,
          app_id: check.sourceAppId,
        })),
      },
      required_pull_request_reviews: {
        required_approving_review_count: 1,
        dismiss_stale_reviews: true,
        require_last_push_approval: true,
        bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
      },
      required_conversation_resolution: { enabled: true },
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      restrictions: null,
    },
    actionJobs: {
      jobs: requiredChecks.map((check, index) => ({
        id: 1000 + index,
        name: check.context,
        status: "completed",
        conclusion: "success",
      })),
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

function makeActivePolicy() {
  const policy = structuredClone(checkedPolicy);
  policy.bootstrapState = "active";
  policy.trustEpochSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return policy;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
