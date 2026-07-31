import assert from "node:assert/strict";
import test from "node:test";

import { pollAndAuthorize } from "../../scripts/authorize-hardware-runner.mjs";
import {
  resolvePackageRun,
  verifyPackageManifestProvenance,
} from "../../scripts/resolve-hardware-promotion.mjs";

const trustedSha = "a".repeat(40);

test("package promotion resolves one exact successful main artifact by run ID", async () => {
  const responses = [
    {
      id: 10,
      path: ".github/workflows/browser-package.yml",
      head_sha: trustedSha,
      head_branch: "main",
      conclusion: "success",
      event: "push",
      run_attempt: 1,
    },
    {
      artifacts: [
        {
          id: 11,
          name: `browser-package-${trustedSha}`,
          expired: false,
          digest: `sha256:${"b".repeat(64)}`,
          workflow_run: { id: 10, head_sha: trustedSha },
        },
      ],
    },
  ];
  const result = await resolvePackageRun({
    repository: "milos-agathon/forge3d-web",
    packageRunId: 10,
    trustedSha,
    token: "test",
    fetchImpl: async () => response(responses.shift()),
  });
  assert.equal(result.packageArtifactId, 11);
  assert.equal(result.repository, "milos-agathon/forge3d-web");
  assert.equal(result.packageRunAttempt, 1);
  assert.equal(result.packageWorkflowPath, ".github/workflows/browser-package.yml");
  assert.equal(result.packageWorkflowSha, trustedSha);
});

test("package manifest provenance joins the exact resolved API run", () => {
  const packageRun = {
    repository: "milos-agathon/forge3d-web",
    packageRunId: 10,
    packageRunAttempt: 2,
    packageWorkflowPath: ".github/workflows/browser-package.yml",
    packageWorkflowSha: trustedSha,
  };
  const manifest = {
    schemaVersion: 1,
    repository: packageRun.repository,
    runId: packageRun.packageRunId,
    runAttempt: packageRun.packageRunAttempt,
    targetSha: trustedSha,
    workflowPath: packageRun.packageWorkflowPath,
    workflowSha: packageRun.packageWorkflowSha,
  };
  assert.deepEqual(verifyPackageManifestProvenance({ manifest, packageRun }), {
    repository: manifest.repository,
    runId: manifest.runId,
    runAttempt: manifest.runAttempt,
    targetSha: manifest.targetSha,
    workflowPath: manifest.workflowPath,
    workflowSha: manifest.workflowSha,
  });
});

test("package manifest provenance rejects stale run, attempt, SHA, and workflow identity", () => {
  const packageRun = {
    repository: "milos-agathon/forge3d-web",
    packageRunId: 10,
    packageRunAttempt: 2,
    packageWorkflowPath: ".github/workflows/browser-package.yml",
    packageWorkflowSha: trustedSha,
  };
  const base = {
    schemaVersion: 1,
    repository: packageRun.repository,
    runId: packageRun.packageRunId,
    runAttempt: packageRun.packageRunAttempt,
    targetSha: trustedSha,
    workflowPath: packageRun.packageWorkflowPath,
    workflowSha: packageRun.packageWorkflowSha,
  };
  for (const mutate of [
    (manifest) => (manifest.runId = 9),
    (manifest) => (manifest.runAttempt = 1),
    (manifest) => (manifest.targetSha = "f".repeat(40)),
    (manifest) => (manifest.workflowPath = ".github/workflows/web.yml"),
    (manifest) => (manifest.workflowSha = "e".repeat(40)),
  ]) {
    const manifest = structuredClone(base);
    mutate(manifest);
    assert.throws(
      () => verifyPackageManifestProvenance({ manifest, packageRun }),
      /does not match the resolved API run/u,
    );
  }
});

test("package manifest provenance rejects missing or malformed run attempts on both records", () => {
  const basePackageRun = {
    repository: "milos-agathon/forge3d-web",
    packageRunId: 10,
    packageRunAttempt: 2,
    packageWorkflowPath: ".github/workflows/browser-package.yml",
    packageWorkflowSha: trustedSha,
  };
  const baseManifest = {
    schemaVersion: 1,
    repository: basePackageRun.repository,
    runId: basePackageRun.packageRunId,
    runAttempt: basePackageRun.packageRunAttempt,
    targetSha: trustedSha,
    workflowPath: basePackageRun.packageWorkflowPath,
    workflowSha: basePackageRun.packageWorkflowSha,
  };
  for (const attempt of [undefined, null, 0, -1, 1.5, "1"]) {
    const manifest = structuredClone(baseManifest);
    const packageRun = structuredClone(basePackageRun);
    if (attempt === undefined) {
      delete manifest.runAttempt;
      delete packageRun.packageRunAttempt;
    } else {
      manifest.runAttempt = attempt;
      packageRun.packageRunAttempt = attempt;
    }
    assert.throws(
      () => verifyPackageManifestProvenance({ manifest, packageRun }),
      /does not match the resolved API run/u,
    );
  }
});

test("package promotion rejects missing or malformed API run attempts", async () => {
  for (const attempt of [undefined, null, 0, -1, 1.5, "1"]) {
    const run = {
      id: 10,
      path: ".github/workflows/browser-package.yml",
      head_sha: trustedSha,
      head_branch: "main",
      conclusion: "success",
      event: "push",
      run_attempt: attempt,
    };
    if (attempt === undefined) delete run.run_attempt;
    await assert.rejects(
      () =>
        resolvePackageRun({
          repository: "milos-agathon/forge3d-web",
          packageRunId: 10,
          trustedSha,
          token: "test",
          fetchImpl: async () => response(run),
        }),
      /not the successful exact-main/u,
    );
  }
});

test("package promotion rejects prior SHA, wrong workflow, failed, duplicate, or expired artifact", async () => {
  for (const mutation of [
    (run) => (run.head_sha = "f".repeat(40)),
    (run) => (run.path = ".github/workflows/web.yml"),
    (run) => (run.conclusion = "failure"),
  ]) {
    const run = {
      id: 10,
      path: ".github/workflows/browser-package.yml",
      head_sha: trustedSha,
      head_branch: "main",
      conclusion: "success",
      event: "push",
      run_attempt: 1,
    };
    mutation(run);
    await assert.rejects(
      () =>
        resolvePackageRun({
          repository: "milos-agathon/forge3d-web",
          packageRunId: 10,
          trustedSha,
          token: "test",
          fetchImpl: async () => response(run),
        }),
      /not the successful exact-main/u,
    );
  }
});

test("authorization waits through environment approval then selects exactly one queued job", async () => {
  const nonce = "12".repeat(16);
  const promotion = {
    trustedSha,
    trustEpochSha: "b".repeat(40),
    workflowSha: "c".repeat(40),
    lane: "chrome-linux-rtx3070",
    required: true,
    assetId: "FW-LNX-NV-01",
    hostId: "FW-LNX-NV-01",
    runnerNonce: nonce,
    nonceLabel: `jit-${nonce}`,
    runnerName: `FW-LNX-NV-01-${nonce}`,
    customLabels: ["forge3d-web", "hw-linux-rtx3070", `jit-${nonce}`],
    packageRunId: 10,
    packageManifestSha256: "d".repeat(64),
    labReadinessRunId: 20,
    labInfrastructureDigest: "e".repeat(64),
    labReadiness: {
      runId: 20,
      manifestSha256: "f".repeat(64),
      labInfrastructureDigest: "e".repeat(64),
    },
    manualSession: null,
  };
  const policy = { repositoryJitRunnerGroupId: 1, jitWorkFolder: "_work" };
  let polls = 0;
  const result = await pollAndAuthorize({
    repository: "milos-agathon/forge3d-web",
    token: "test",
    runId: 30,
    runAttempt: 1,
    promotion,
    policy,
    now: () => new Date(`2026-07-29T10:00:0${polls}.000Z`),
    delayImpl: async () => {
      polls += 1;
    },
    fetchImpl: async () =>
      response({
        jobs:
          polls === 0
            ? [
                {
                  id: 31,
                  name: "Browser Hardware / Ephemeral Execution",
                  status: "waiting",
                },
              ]
            : [
                {
                  id: 31,
                  name: "Browser Hardware / Ephemeral Execution",
                  status: "queued",
                  labels: [
                    "self-hosted",
                    "Linux",
                    ...promotion.customLabels,
                  ],
                },
                {
                  id: 32,
                  name: "Browser Hardware / Promote Trusted Artifact",
                  status: "completed",
                  conclusion: "success",
                },
                {
                  id: 33,
                  name: "Browser Hardware / Authorize JIT Runner",
                  status: "in_progress",
                },
              ],
      }),
  });
  assert.equal(polls, 1);
  assert.equal(result.record.queuedHardwareJob.id, 31);
  assert.deepEqual(result.record.platformLabels, ["Linux", "self-hosted"]);
});

function response(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(json),
  };
}
