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
  },
  {
    context: "Web Runtime / Browser Preflight",
    sourceAppId: 15368,
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

function makeVerifier({
  jobStatus,
  branchSha,
  expiresAt,
  requiredApprovingReviewCount = 0,
  requireLastPushApproval = false,
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
      labInfrastructureDigest: "c".repeat(64),
    },
    manualSession: null,
    issuedAt: "2026-07-28T11:50:00.000Z",
    expiresAt,
  };
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
    return {
      workflow_runs: [
        {
          id: 7001,
          path: ".github/workflows/web.yml",
          head_branch: "main",
          head_sha: targetSha,
        },
      ],
    };
  }

  async getRunJobs(id) {
    assert.equal(id, 7001);
    return {
      jobs: requiredChecks.map((check) => ({
        name: check.context,
        status: "completed",
        conclusion: "success",
      })),
    };
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
