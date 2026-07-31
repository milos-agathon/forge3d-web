import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileAuthorizationVerifier } from "../src/authorization-verifier.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";

const targetSha = "f".repeat(40);
const currentMainSha = "d".repeat(40);
const trustEpochSha = "e".repeat(40);
const repository = {
  id: 1259761852,
  fullName: "milos-agathon/forge3d-web",
  defaultBranch: "main",
};
const requiredChecks = [
  {
    context: "Web Runtime / Build And Contract Tests",
    sourceAppId: 15368,
    sourceAppSlug: "github-actions",
  },
  {
    context: "Web Runtime / Browser Preflight",
    sourceAppId: 15368,
    sourceAppSlug: "github-actions",
  },
];

test("issuance accepts the current canonical runner-authorization schema", async () => {
  const context = makeVerifier({
    jobStatus: "queued",
    branchSha: targetSha,
    expiresAt: "2026-07-28T12:30:00.000Z",
  });
  try {
    const authorization = await context.verifier.verify({
      digest: context.digest,
      controllerAssetId: "FW-LNX-NV-01",
      mode: "issuance",
    });
    assert.equal(authorization.jobId, 3001);
    assert.equal(authorization.targetAssetId, "FW-LNX-NV-01");
    assert.equal(authorization.hostAssetId, "FW-LNX-NV-01");
    assert.equal(authorization.hwLabel, "hw-linux-rtx3070");
    assert.equal(authorization.lane, "chrome-linux-rtx3070");
    assert.equal(authorization.hasLabReadiness, true);
    assert.equal(authorization.hasManualSession, false);
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test("cleanup mode verifies the exact completed ledger job without issuance-only gates", async () => {
  const context = makeVerifier({
    jobStatus: "completed",
    branchSha: currentMainSha,
    expiresAt: "2026-07-28T11:30:00.000Z",
  });
  try {
    const authorization = await context.verifier.verify({
      digest: context.digest,
      controllerAssetId: "FW-LNX-NV-01",
      mode: "cleanup",
    });
    assert.equal(authorization.jobId, 3001);
    assert.equal(context.github.listRunnerCalls, 0);
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test("authorization rejects missing or malformed laboratory manifest digests", async () => {
  for (const mutateAuthorization of [
    (authorization) => {
      delete authorization.labReadiness.manifestSha256;
    },
    (authorization) => {
      authorization.labReadiness.manifestSha256 = "0".repeat(63);
    },
  ]) {
    const context = makeVerifier({
      jobStatus: "queued",
      branchSha: targetSha,
      expiresAt: "2026-07-28T12:30:00.000Z",
      mutateAuthorization,
    });
    try {
      await assert.rejects(
        () =>
          context.verifier.verify({
            digest: context.digest,
            controllerAssetId: "FW-LNX-NV-01",
            mode: "issuance",
          }),
        /authorization/u,
      );
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  }
});

test("authorization rejects a manifest digest changed after its canonical digest was bound", async () => {
  const context = makeVerifier({
    jobStatus: "queued",
    branchSha: targetSha,
    expiresAt: "2026-07-28T12:30:00.000Z",
  });
  try {
    const changed = structuredClone(context.authorization);
    changed.labReadiness.manifestSha256 = "9".repeat(64);
    writeFileSync(
      join(context.directory, `${context.digest}.json`),
      canonicalJson(changed),
    );
    await assert.rejects(
      () =>
        context.verifier.verify({
          digest: context.digest,
          controllerAssetId: "FW-LNX-NV-01",
          mode: "issuance",
        }),
      /content does not match requested digest/u,
    );
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test("issuance mode still rejects a live job that is no longer queued", async () => {
  const context = makeVerifier({
    jobStatus: "completed",
    branchSha: targetSha,
    expiresAt: "2026-07-28T12:30:00.000Z",
  });
  try {
    await assert.rejects(
      context.verifier.verify({
        digest: context.digest,
        controllerAssetId: "FW-LNX-NV-01",
        mode: "issuance",
      }),
      /live job does not match runner authorization/u,
    );
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test("issuance rejects live review requirements that exceed checked policy", async () => {
  const context = makeVerifier({
    jobStatus: "queued",
    branchSha: targetSha,
    expiresAt: "2026-07-28T12:30:00.000Z",
    requiredApprovingReviewCount: 1,
    requireLastPushApproval: true,
  });
  try {
    await assert.rejects(
      context.verifier.verify({
        digest: context.digest,
        controllerAssetId: "FW-LNX-NV-01",
        mode: "issuance",
      }),
      /live branch protection does not match checked policy/u,
    );
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

for (const [name, mutate, expectedError] of [
  [
    "a required check run from the wrong app",
    (github) => {
      github.checkRuns.check_runs[0].app = {
        id: 1,
        slug: "lookalike-actions",
      };
    },
    /not owned by GitHub Actions App 15368\/github-actions/u,
  ],
  [
    "a stale required-check SHA",
    (github) => {
      github.runJobs.jobs[0].head_sha = "c".repeat(40);
    },
    /stale for target main/u,
  ],
  [
    "a missing required workflow job",
    (github) => {
      github.runJobs.jobs.pop();
      github.runJobs.total_count -= 1;
    },
    /exactly one GitHub Actions workflow job and check run/u,
  ],
  [
    "a missing required check run",
    (github) => {
      github.checkRuns.check_runs.pop();
      github.checkRuns.total_count -= 1;
    },
    /exactly one GitHub Actions workflow job and check run/u,
  ],
  [
    "a duplicate required workflow job",
    (github) => {
      const duplicate = structuredClone(github.runJobs.jobs[0]);
      duplicate.id = 9001;
      github.runJobs.jobs.push(duplicate);
      github.runJobs.total_count += 1;
    },
    /exactly one GitHub Actions workflow job and check run/u,
  ],
  [
    "a duplicate required check run",
    (github) => {
      const duplicate = structuredClone(github.checkRuns.check_runs[0]);
      duplicate.id = 9002;
      duplicate.url = `${duplicate.url.slice(0, duplicate.url.lastIndexOf("/") + 1)}9002`;
      github.checkRuns.check_runs.push(duplicate);
      github.checkRuns.total_count += 1;
    },
    /exactly one GitHub Actions workflow job and check run/u,
  ],
  [
    "a mismatched workflow-job/check-run URL",
    (github) => {
      github.runJobs.jobs[0].check_run_url += "-other";
    },
    /workflow job\/check-run binding is mismatched/u,
  ],
  [
    "a mismatched check-run ID and URL",
    (github) => {
      github.checkRuns.check_runs[0].id = 9003;
    },
    /workflow job\/check-run binding is mismatched/u,
  ],
  [
    "matching check-run URLs from a look-alike origin",
    (github) => {
      const lookalike = new URL(github.checkRuns.check_runs[0].url);
      lookalike.hostname = "example.invalid";
      github.checkRuns.check_runs[0].url = lookalike.href;
      github.runJobs.jobs[0].check_run_url = lookalike.href;
    },
    /workflow job\/check-run binding is mismatched/u,
  ],
  [
    "a truncated workflow-runs response",
    (github) => {
      github.workflowRuns.total_count += 1;
    },
    /workflow runs response is incomplete/u,
  ],
  [
    "a truncated workflow-jobs response",
    (github) => {
      github.runJobs.total_count += 1;
    },
    /workflow jobs response is incomplete/u,
  ],
  [
    "a truncated check-runs response",
    (github) => {
      github.checkRuns.total_count += 1;
    },
    /check runs response is incomplete/u,
  ],
  [
    "a failed Web Runtime workflow run",
    (github) => {
      github.workflowRuns.workflow_runs[0].conclusion = "failure";
    },
    /not a completed successful run/u,
  ],
]) {
  test(`issuance rejects ${name}`, async () => {
    const context = makeVerifier({
      jobStatus: "queued",
      branchSha: targetSha,
      expiresAt: "2026-07-28T12:30:00.000Z",
    });
    try {
      mutate(context.github);
      await assert.rejects(
        context.verifier.verify({
          digest: context.digest,
          controllerAssetId: "FW-LNX-NV-01",
          mode: "issuance",
        }),
        expectedError,
      );
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  });
}

function makeVerifier({
  jobStatus,
  branchSha,
  expiresAt,
  requiredApprovingReviewCount = 0,
  requireLastPushApproval = false,
  mutateAuthorization = null,
}) {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-authorization-"));
  const repositoryTrustPolicy = {
    schemaVersion: 1,
    repository,
    bootstrapState: "active",
    trustEpochSha,
    branchProtection: {
      requiredStatusChecks: {
        strict: true,
        checks: requiredChecks,
      },
      requiredPullRequestReviews: {
        requiredApprovingReviewCount: 0,
        dismissStaleReviews: true,
        requireLastPushApproval: false,
      },
    },
  };
  const authorization = {
    schemaVersion: 1,
    repository: {
      id: repository.id,
      name: repository.fullName,
    },
    workflow: {
      path: ".github/workflows/browser-hardware.yml",
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      event: "workflow_dispatch",
    },
    run: { id: 2001, attempt: 1 },
    promotionJobId: 2002,
    authorizationJobId: 2003,
    queuedHardwareJob: {
      id: 3001,
      name: "Browser Hardware / Ephemeral Execution",
      status: "queued",
    },
    trustedSha: targetSha,
    trustEpochSha,
    lane: "chrome-linux-rtx3070",
    required: true,
    assetId: "FW-LNX-NV-01",
    hostId: "FW-LNX-NV-01",
    runnerNonce: "ab".repeat(16),
    nonceLabel: `jit-${"ab".repeat(16)}`,
    runnerName: `FW-LNX-NV-01-${"ab".repeat(16)}`,
    customLabels: [
      "forge3d-web",
      "hw-linux-rtx3070",
      `jit-${"ab".repeat(16)}`,
    ],
    platformLabels: ["self-hosted", "Linux", "X64"],
    repositoryJitRunnerGroupId: 1,
    workFolder: "_work",
    packageRunId: 1001,
    packageManifestSha256: "b".repeat(64),
    labReadiness: {
      runId: 1002,
      manifestSha256: "d".repeat(64),
      labInfrastructureDigest: "c".repeat(64),
    },
    manualSession: null,
    issuedAt: "2026-07-28T11:50:00.000Z",
    expiresAt,
  };
  mutateAuthorization?.(authorization);
  const text = canonicalJson(authorization);
  const digest = createHash("sha256").update(text).digest("hex");
  writeFileSync(join(directory, `${digest}.json`), text);
  const github = new LiveTrustGitHub({
    jobStatus,
    branchSha,
    requiredApprovingReviewCount,
    requireLastPushApproval,
  });
  return {
    directory,
    digest,
    authorization,
    github,
    verifier: new FileAuthorizationVerifier({
      directory,
      github,
      repositoryTrustPolicy,
      attestationVerifier: async () => {},
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    }),
  };
}

class LiveTrustGitHub {
  constructor({
    jobStatus,
    branchSha,
    requiredApprovingReviewCount,
    requireLastPushApproval,
  }) {
    this.jobStatus = jobStatus;
    this.branchSha = branchSha;
    this.requiredApprovingReviewCount = requiredApprovingReviewCount;
    this.requireLastPushApproval = requireLastPushApproval;
    this.listRunnerCalls = 0;
    const runId = 7001;
    this.workflowRuns = {
      total_count: 1,
      workflow_runs: [
        {
          id: runId,
          path: ".github/workflows/web.yml",
          head_branch: repository.defaultBranch,
          head_sha: targetSha,
          event: "push",
          status: "completed",
          conclusion: "success",
        },
      ],
    };
    const jobs = requiredChecks.map((check, index) => {
      const checkRunId = 8001 + index;
      return {
        id: 7101 + index,
        name: check.context,
        head_sha: targetSha,
        status: "completed",
        conclusion: "success",
        check_run_url:
          `https://api.github.com/repos/${repository.fullName}` +
          `/check-runs/${checkRunId}`,
      };
    });
    this.runJobs = { total_count: jobs.length, jobs };
    const checkRuns = requiredChecks.map((check, index) => {
      const checkRunId = 8001 + index;
      return {
        id: checkRunId,
        name: check.context,
        head_sha: targetSha,
        status: "completed",
        conclusion: "success",
        url:
          `https://api.github.com/repos/${repository.fullName}` +
          `/check-runs/${checkRunId}`,
        app: { id: 15368, slug: "github-actions" },
      };
    });
    this.checkRuns = {
      total_count: checkRuns.length,
      check_runs: checkRuns,
    };
  }

  async getRepository() {
    return {
      id: repository.id,
      full_name: repository.fullName,
      default_branch: repository.defaultBranch,
    };
  }

  async getBranch() {
    return {
      protected: true,
      commit: { sha: this.branchSha },
    };
  }

  async getProtection() {
    return {
      required_status_checks: {
        strict: true,
        contexts: requiredChecks.map((check) => check.context),
        checks: requiredChecks.map((check) => ({
          context: check.context,
          app_id: check.sourceAppId,
        })),
      },
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_last_push_approval: this.requireLastPushApproval,
        required_approving_review_count:
          this.requiredApprovingReviewCount,
        bypass_pull_request_allowances: {
          users: [],
          teams: [],
          apps: [],
        },
      },
      required_conversation_resolution: { enabled: true },
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      restrictions: null,
    };
  }

  async getActionsPermissions() {
    return { sha_pinning_required: true };
  }

  async compareCommits(base, head) {
    assert.equal(base, trustEpochSha);
    assert.equal(head, targetSha);
    return { status: "ahead", ahead_by: 1 };
  }

  async getWorkflowRunsForSha(sha) {
    assert.equal(sha, targetSha);
    return structuredClone(this.workflowRuns);
  }

  async getRunJobs(id) {
    assert.equal(id, 7001);
    return structuredClone(this.runJobs);
  }

  async getCheckRunsForSha(sha) {
    assert.equal(sha, targetSha);
    return structuredClone(this.checkRuns);
  }

  async listRunners() {
    this.listRunnerCalls += 1;
    return { total_count: 0, runners: [] };
  }

  async getJob(id) {
    assert.equal(id, 3001);
    return {
      id,
      run_id: 2001,
      head_sha: targetSha,
      status: this.jobStatus,
      conclusion: this.jobStatus === "completed" ? "success" : null,
    };
  }
}
