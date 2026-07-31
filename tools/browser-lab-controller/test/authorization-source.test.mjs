import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../../browser-lab-broker/src/canonical-json.mjs";
import { validateAuthorizationRecord } from "../../browser-lab-broker/src/runner-authorization.mjs";
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
  lane: "chrome-linux-rtx3070",
  required: true,
  assetId: "FW-LNX-NV-01",
  hostId: "FW-LNX-NV-01",
  runnerNonce: nonce,
  nonceLabel: `jit-${nonce}`,
  runnerName: `FW-LNX-NV-01-${nonce}`,
  customLabels: ["forge3d-web", "hw-linux-rtx3070", `jit-${nonce}`],
  platformLabels: ["self-hosted", "Linux"],
  workFolder: "_work",
  repositoryJitRunnerGroupId: 1,
  packageRunId: 8,
  packageManifestSha256: "d".repeat(64),
  labReadiness: {
    runId: 7,
    manifestSha256: "f".repeat(64),
    labInfrastructureDigest: "e".repeat(64),
  },
  manualSession: null,
  issuedAt: "2026-07-29T10:00:00.000Z",
  expiresAt: "2026-07-29T10:10:00.000Z",
};
const bytes = Buffer.from(canonicalJson(authorization));
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
      listRunAttemptJobs: async (runId, runAttempt) => {
        assert.equal(runId, run.id);
        assert.equal(runAttempt, run.attempt);
        return jobs();
      },
    },
    artifactClient: {
      listRunArtifacts: async (runId) => {
        assert.equal(runId, run.id);
        return [artifact()];
      },
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
  const ambiguousNonceJobs = jobs();
  ambiguousNonceJobs[0].labels.push(`jit-${"cd".repeat(16)}`);
  await assert.rejects(
    () =>
      resolveAuthorizationForQueuedJob({
        hostId: authorization.hostId,
        expectedHardwareLabel: "hw-linux-rtx3070",
        run,
        jobsClient: {
          listRunAttemptJobs: async () => ambiguousNonceJobs,
        },
      }),
    /exactly one queued runner nonce label/u,
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

test("controller rejects a selected API run or attempt that disagrees with the attested record", async () => {
  await assert.rejects(
    () =>
      resolve({
        selectedRun: { ...run, id: 99 },
        artifactValue: artifact({ workflowRunId: 99 }),
      }),
    /does not match API-visible jobs/u,
  );
  await assert.rejects(
    () => resolve({ selectedRun: { ...run, attempt: 2 } }),
    /does not match API-visible jobs/u,
  );
});

test("controller rejects a signed workflow SHA that disagrees with the selected API run", async () => {
  const wrongWorkflow = structuredClone(authorization);
  wrongWorkflow.workflow.sha = "0".repeat(40);
  await assert.rejects(
    () => resolve({ authorizationValue: wrongWorkflow }),
    /does not match API-visible jobs/u,
  );
});

test("controller rejects missing, extra, or duplicate API labels", async () => {
  const missing = jobs();
  missing[0].labels = missing[0].labels.filter(
    (label) => label !== "hw-linux-rtx3070",
  );
  await assert.rejects(
    () => resolve({ jobsValue: missing }),
    /exactly one matching queued hardware job/u,
  );

  const extra = jobs();
  extra[0].labels.push("unreviewed-extra-label");
  await assert.rejects(
    () => resolve({ jobsValue: extra }),
    /does not match API-visible jobs/u,
  );

  const duplicate = jobs();
  duplicate[0].labels.push("self-hosted");
  await assert.rejects(
    () => resolve({ jobsValue: duplicate }),
    /does not match API-visible jobs/u,
  );
});

test("controller rejects the wrong attempt-derived authorization artifact name", async () => {
  await assert.rejects(
    () => resolve({ artifactValue: artifact({ name: "runner-authorization-wrong" }) }),
    /missing, duplicated, expired, or mismatched/u,
  );
});

test("controller rejects an authorization whose attestation signature is invalid", async () => {
  await assert.rejects(
    () =>
      resolve({
        verify: async () => {
          throw new Error("authorization attestation signature is invalid");
        },
      }),
    /attestation signature is invalid/u,
  );
});

test("controller-resolved authorization satisfies the current broker field contract", async () => {
  const resolved = await resolve();
  assert.doesNotThrow(() =>
    validateAuthorizationRecord({
      authorization: resolved.authorization,
      digest: resolved.authorizationDigest,
      controllerAssetId: authorization.hostId,
      policy: { trustEpochSha: authorization.trustEpochSha },
      now: new Date("2026-07-29T10:05:00.000Z"),
      enforceExpiry: true,
    }),
  );
});

function artifact(overrides = {}) {
  return {
    id: 20,
    name: `runner-authorization-${nonce}`,
    expired: false,
    workflowRunId: run.id,
    digest: archiveDigest,
    ...overrides,
  };
}

function resolve({
  selectedRun = run,
  artifactValue = artifact(),
  authorizationValue = authorization,
  jobsValue = jobs(),
  verify,
} = {}) {
  const authorizationBytes = Buffer.from(canonicalJson(authorizationValue));
  return resolveAuthorizationForQueuedJob({
    hostId: authorization.hostId,
    expectedHardwareLabel: "hw-linux-rtx3070",
    run: selectedRun,
    now: new Date("2026-07-29T10:05:00.000Z"),
    jobsClient: { listRunAttemptJobs: async () => jobsValue },
    artifactClient: {
      listRunArtifacts: async () => [artifactValue],
      downloadById: async () => ({
        archiveBytes,
        archiveDigest,
        files: [{ name: "runner-authorization.json", bytes: authorizationBytes }],
      }),
    },
    attestationVerifier: { verify: verify ?? (async () => undefined) },
  });
}

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
