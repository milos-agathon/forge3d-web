import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { pollControllerOnce } from "../src/controller-daemon.mjs";

const runnerNonce = "ab".repeat(16);
const run = {
  id: 101,
  attempt: 2,
  workflowSha: "a".repeat(40),
};
const jobs = [
  {
    id: 201,
    name: "Browser Hardware / Promote Trusted Artifact",
    status: "completed",
    conclusion: "success",
    labels: ["ubuntu-latest"],
  },
  {
    id: 202,
    name: "Browser Hardware / Authorize JIT Runner",
    status: "completed",
    conclusion: "success",
    labels: ["ubuntu-latest"],
  },
  {
    id: 203,
    name: "Browser Hardware / Ephemeral Execution",
    status: "queued",
    labels: [
      "forge3d-web",
      "hw-linux-rtx3070",
      `jit-${runnerNonce}`,
    ],
  },
];
const authorization = {
  schemaVersion: 1,
  repository: { id: 1259761852, name: "milos-agathon/forge3d-web" },
  workflow: {
    path: ".github/workflows/browser-hardware.yml",
    ref: "refs/heads/main",
    sha: run.workflowSha,
    event: "workflow_dispatch",
  },
  run: { id: run.id, attempt: run.attempt },
  promotionJobId: 201,
  authorizationJobId: 202,
  queuedHardwareJob: {
    id: 203,
    name: "Browser Hardware / Ephemeral Execution",
    status: "queued",
  },
  trustedSha: "b".repeat(40),
  trustEpochSha: "c".repeat(40),
  lane: "chrome-linux-rtx3070",
  required: true,
  assetId: "FW-LNX-NV-01",
  hostId: "FW-LNX-NV-01",
  runnerNonce,
  nonceLabel: `jit-${runnerNonce}`,
  runnerName: `FW-LNX-NV-01-${runnerNonce}`,
  customLabels: [
    "forge3d-web",
    "hw-linux-rtx3070",
    `jit-${runnerNonce}`,
  ],
  platformLabels: ["self-hosted"],
  repositoryJitRunnerGroupId: 1,
  workFolder: "_work",
  packageRunId: 88,
  packageManifestSha256: "d".repeat(64),
  labReadiness: {
    runId: 77,
    labInfrastructureDigest: "e".repeat(64),
  },
  manualSession: null,
  issuedAt: "2026-07-29T10:00:00.000Z",
  expiresAt: "2026-07-29T10:10:00.000Z",
};

test("controller polling resolves an attested authorization and executes it", async () => {
  const bytes = Buffer.from(JSON.stringify(authorization));
  const archiveBytes = Buffer.from("checked authorization archive");
  const archiveDigest = `sha256:${sha256(archiveBytes)}`;
  const calls = [];
  const result = await pollControllerOnce({
    hostId: authorization.hostId,
    expectedHardwareLabel: "hw-linux-rtx3070",
    now: new Date("2026-07-29T10:05:00.000Z"),
    github: {
      listCandidateRuns: async () => [run],
      listRunAttemptJobs: async () => jobs,
      listRunArtifacts: async () => [
        {
          id: 301,
          name: `runner-authorization-${runnerNonce}`,
          expired: false,
          workflowRunId: run.id,
          runAttempt: run.attempt,
          digest: archiveDigest,
        },
      ],
      downloadArtifactById: async () => ({
        archiveBytes,
        archiveDigest,
        files: [{ name: "runner-authorization.json", bytes }],
      }),
      verifyAttestation: async (request) =>
        calls.push(["verify", request]),
    },
    controller: {
      execute: async (record) => {
        calls.push(["execute", record]);
        return { runnerId: 401 };
      },
    },
    audit: (record) => calls.push(["audit", record]),
  });
  assert.deepEqual(result, { scanned: 1, executed: 1 });
  assert.equal(calls.filter(([name]) => name === "verify").length, 1);
  assert.equal(calls.filter(([name]) => name === "execute").length, 1);
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
