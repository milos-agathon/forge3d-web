import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { resolveAuthorizationForQueuedJob } from "../src/authorization-source.mjs";

const nonce = "ab".repeat(16);
const run = {
  id: 10,
  attempt: 1,
  workflowSha: "a".repeat(40),
};
const authorization = {
  schemaVersion: 1,
  repository: { id: 1259761852, name: "milos-agathon/forge3d-web" },
  workflow: {
    path: ".github/workflows/browser-hardware.yml",
    ref: "refs/heads/main",
    sha: run.workflowSha,
    event: "workflow_dispatch",
  },
  run: { id: 10, attempt: 1 },
  promotionJobId: 12,
  authorizationJobId: 13,
  queuedHardwareJob: {
    id: 11,
    name: "Browser Hardware / Ephemeral Execution",
    status: "queued",
  },
  trustedSha: "b".repeat(40),
  trustEpochSha: "c".repeat(40),
  hostId: "FW-LNX-NV-01",
  runnerNonce: nonce,
  nonceLabel: `jit-${nonce}`,
  runnerName: `FW-LNX-NV-01-${nonce}`,
  customLabels: ["forge3d-web", "hw-linux-rtx3070", `jit-${nonce}`],
  workFolder: "_work",
  repositoryJitRunnerGroupId: 1,
  packageManifestSha256: "d".repeat(64),
  issuedAt: "2026-07-29T10:00:00.000Z",
  expiresAt: "2026-07-29T10:10:00.000Z",
};
const bytes = Buffer.from(JSON.stringify(authorization));
const archiveBytes = Buffer.from("archive");
const archiveDigest = `sha256:${sha256(archiveBytes)}`;

test("controller resolves one exact-ID authorization and cross-checks every API job", async () => {
  let verified = null;
  const result = await resolveAuthorizationForQueuedJob({
    hostId: authorization.hostId,
    expectedHardwareLabel: "hw-linux-rtx3070",
    run,
    now: new Date("2026-07-29T10:05:00.000Z"),
    jobsClient: {
      listRunAttemptJobs: async () => jobs(),
    },
    artifactClient: {
      listRunArtifacts: async () => [
        {
          id: 20,
          name: `runner-authorization-${nonce}`,
          expired: false,
          workflowRunId: 10,
          runAttempt: 1,
          digest: archiveDigest,
        },
      ],
      downloadById: async (id) => {
        assert.equal(id, 20);
        return {
          archiveBytes,
          archiveDigest,
          files: [{ name: "runner-authorization.json", bytes }],
        };
      },
    },
    attestationVerifier: {
      verify: async (request) => {
        verified = request;
      },
    },
  });
  assert.equal(result.authorizationArtifactId, 20);
  assert.equal(verified.denySelfHostedRunners, true);
  assert.equal(verified.sourceDigest, run.workflowSha);
});

test("controller rejects duplicate queued jobs, name lookup substitution, and API mismatch", async () => {
  await assert.rejects(
    () =>
      resolveAuthorizationForQueuedJob({
        hostId: authorization.hostId,
        expectedHardwareLabel: "hw-linux-rtx3070",
        run,
        jobsClient: {
          listRunAttemptJobs: async () => [jobs()[0], ...jobs()],
        },
      }),
    /exactly one matching queued/u,
  );
  const mismatched = structuredClone(authorization);
  mismatched.queuedHardwareJob.id = 999;
  const mismatchedBytes = Buffer.from(JSON.stringify(mismatched));
  await assert.rejects(
    () =>
      resolveAuthorizationForQueuedJob({
        hostId: authorization.hostId,
        expectedHardwareLabel: "hw-linux-rtx3070",
        run,
        now: new Date("2026-07-29T10:05:00.000Z"),
        jobsClient: { listRunAttemptJobs: async () => jobs() },
        artifactClient: {
          listRunArtifacts: async () => [
            {
              id: 20,
              name: `runner-authorization-${nonce}`,
              expired: false,
              workflowRunId: 10,
              runAttempt: 1,
              digest: archiveDigest,
            },
          ],
          downloadById: async () => ({
            archiveBytes,
            archiveDigest,
            files: [
              { name: "runner-authorization.json", bytes: mismatchedBytes },
            ],
          }),
        },
        attestationVerifier: { verify: async () => undefined },
      }),
    /does not match API-visible jobs/u,
  );
});

function jobs() {
  return [
    {
      id: 11,
      name: "Browser Hardware / Ephemeral Execution",
      status: "queued",
      labels: [
        "self-hosted",
        "Linux",
        "forge3d-web",
        "hw-linux-rtx3070",
        `jit-${nonce}`,
      ],
    },
    {
      id: 12,
      name: "Browser Hardware / Promote Trusted Artifact",
      status: "completed",
      conclusion: "success",
    },
    {
      id: 13,
      name: "Browser Hardware / Authorize JIT Runner",
      status: "completed",
      conclusion: "success",
    },
  ];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
