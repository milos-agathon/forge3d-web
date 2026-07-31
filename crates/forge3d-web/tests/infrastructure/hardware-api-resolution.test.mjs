import assert from "node:assert/strict";
import test from "node:test";

import { pollAndAuthorize } from "../../scripts/authorize-hardware-runner.mjs";
import { resolvePackageRun } from "../../scripts/resolve-hardware-promotion.mjs";

const trustedSha = "a".repeat(40);

test("package promotion resolves one exact successful main artifact by run ID", async () => {
  const responses = [
    {
      id: 10,
      path: ".github/workflows/browser-package.yml",
      head_sha: trustedSha,
      head_branch: "main",
      status: "completed",
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
  assert.deepEqual(result, {
    packageRunId: 10,
    packageArtifactId: 11,
    packageArtifactName: `browser-package-${trustedSha}`,
    packageArtifactDigest: `sha256:${"b".repeat(64)}`,
    packageWorkflowSha: trustedSha,
    packageRunAttempt: 1,
    packageRunPath: ".github/workflows/browser-package.yml",
    packageRunHeadBranch: "main",
    packageRunRef: "refs/heads/main",
    packageRunEvent: "push",
    packageRunStatus: "completed",
    packageRunConclusion: "success",
  });
});

test("package promotion rejects every incomplete or mismatched run tuple", async () => {
  for (const mutation of [
    (run) => (run.id = 11),
    (run) => (run.head_sha = "f".repeat(40)),
    (run) => (run.path = ".github/workflows/web.yml"),
    (run) => (run.head_branch = "dev"),
    (run) => (run.status = "in_progress"),
    (run) => (run.conclusion = "failure"),
    (run) => (run.event = "pull_request"),
    (run) => (run.run_attempt = 0),
  ]) {
    const run = {
      id: 10,
      path: ".github/workflows/browser-package.yml",
      head_sha: trustedSha,
      head_branch: "main",
      status: "completed",
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

test("package promotion rejects duplicate, expired, or malformed artifacts", async () => {
  for (const mutation of [
    (artifacts) => artifacts.push(structuredClone(artifacts[0])),
    (artifacts) => (artifacts[0].expired = true),
    (artifacts) => (artifacts[0].id = 0),
    (artifacts) => (artifacts[0].name = "other"),
    (artifacts) => (artifacts[0].digest = "sha256:invalid"),
    (artifacts) => (artifacts[0].workflow_run.id = 11),
    (artifacts) => (artifacts[0].workflow_run.head_sha = "f".repeat(40)),
  ]) {
    const run = {
      id: 10,
      path: ".github/workflows/browser-package.yml",
      head_sha: trustedSha,
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      event: "push",
      run_attempt: 1,
    };
    const artifacts = [
      {
        id: 11,
        name: `browser-package-${trustedSha}`,
        expired: false,
        digest: `sha256:${"b".repeat(64)}`,
        workflow_run: { id: 10, head_sha: trustedSha },
      },
    ];
    mutation(artifacts);
    const responses = [run, { artifacts }];
    await assert.rejects(
      () =>
        resolvePackageRun({
          repository: "milos-agathon/forge3d-web",
          packageRunId: 10,
          trustedSha,
          token: "test",
          fetchImpl: async () => response(responses.shift()),
        }),
      /artifact is missing, duplicated, expired, or mismatched/u,
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
