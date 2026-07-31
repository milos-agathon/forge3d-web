import assert from "node:assert/strict";
import test from "node:test";

import {
  bindSelectedWorkflowInputs,
  resolveSelectedWorkflowArtifact,
  verifySelectedWorkflowRecord,
} from "../../scripts/selected-workflow-record.mjs";

const sha = "a".repeat(40);
const run = {
  id: 101,
  run_attempt: 2,
  path: ".github/workflows/browser-hardware.yml",
  head_branch: "main",
  head_sha: sha,
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
};
const artifact = {
  id: 201,
  name: "finalized-browser-hardware-101-2",
  digest: `sha256:${"b".repeat(64)}`,
  expired: false,
};
const expected = {
  runId: 101,
  path: ".github/workflows/browser-hardware.yml",
  ref: "refs/heads/main",
  headSha: sha,
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  inputs: {
    lane: "infrastructure-canary",
    canaryMode: "host",
    assetId: "FW-LNX-NV-01",
    packageRunId: 50,
    trusted_sha: sha,
  },
};

test("resolves and verifies an exact attempt-qualified host record", () => {
  const resolution = resolveSelectedWorkflowArtifact({
    run,
    artifacts: [artifact],
    expected,
  });
  const record = {
    runId: 101,
    runAttempt: 2,
    trustedSha: sha,
  };
  assert.equal(
    verifySelectedWorkflowRecord({
      resolution,
      record,
      expectedInputs: expected.inputs,
    }),
    record,
  );
  assert.deepEqual(resolution.artifact, {
    id: 201,
    name: artifact.name,
    digest: artifact.digest,
  });
});

test("rejects substituted run and artifact tuple fields", () => {
  for (const changed of [
    { run: { ...run, id: 102 } },
    { run: { ...run, run_attempt: 3 } },
    {
      run: {
        ...run,
        path: ".github/workflows/submit-browser-manual-evidence.yml",
      },
    },
    { run: { ...run, head_branch: "feature" } },
    { run: { ...run, head_sha: "c".repeat(40) } },
    { run: { ...run, event: "push" } },
    { run: { ...run, status: "in_progress" } },
    { run: { ...run, conclusion: "failure" } },
    { artifact: { ...artifact, name: "finalized-browser-hardware-101-1" } },
    { artifact: { ...artifact, digest: `sha256:${"B".repeat(64)}` } },
  ]) {
    assert.throws(() =>
      resolveSelectedWorkflowArtifact({
        run: changed.run ?? run,
        artifacts: [changed.artifact ?? artifact],
        expected,
      }),
    );
  }
});

test("rejects a record with a substituted run identity or attempt", () => {
  const resolution = resolveSelectedWorkflowArtifact({
    run,
    artifacts: [artifact],
    expected,
  });
  for (const record of [
    { runId: 102, runAttempt: 2, trustedSha: sha },
    { runId: 101, runAttempt: 3, trustedSha: sha },
    { runId: 101, runAttempt: 2, trustedSha: "c".repeat(40) },
  ]) {
    assert.throws(() =>
      verifySelectedWorkflowRecord({ resolution, record }),
    );
  }
  assert.throws(() =>
    verifySelectedWorkflowRecord({
      resolution,
      record: { runId: 101, runAttempt: 2, trustedSha: sha },
      expectedInputs: {
        ...expected.inputs,
        assetId: "FW-MAC-M2-01",
      },
    }),
  );
});

test("verifies matrix source workflow identity without changing its shape", () => {
  const selected = resolveSelectedWorkflowArtifact({
    run,
    artifacts: [artifact],
    expected: {
      ...expected,
      inputs: {
        lane: "infrastructure-canary",
        assetId: "FW-LNX-NV-01",
      },
    },
  });
  const source = {
    kind: "automated",
    lane: "infrastructure-canary",
    assetId: "FW-LNX-NV-01",
    trustedSha: sha,
    workflow: {
      runId: 101,
      path: ".github/workflows/browser-hardware.yml",
      ref: "refs/heads/main",
      conclusion: "success",
    },
  };
  assert.equal(
    verifySelectedWorkflowRecord({
      resolution: selected,
      record: source,
      expectedInputs: {
        lane: source.lane,
        assetId: source.assetId,
      },
    }),
    source,
  );
  for (const changed of [
    { workflow: { ...source.workflow, runId: 102 } },
    { workflow: { ...source.workflow, path: "other.yml" } },
    { trustedSha: "c".repeat(40) },
  ]) {
    assert.throws(() =>
      verifySelectedWorkflowRecord({
        resolution: selected,
        record: { ...source, ...changed },
      }),
    );
  }
});

test("adds only previously unavailable input context", () => {
  const selected = resolveSelectedWorkflowArtifact({
    run,
    artifacts: [artifact],
    expected: {
      ...expected,
      inputs: {
        lane: "infrastructure-canary",
        canaryMode: "host",
        assetId: "FW-LNX-NV-01",
        trusted_sha: sha,
      },
    },
  });
  const bound = bindSelectedWorkflowInputs(selected, { packageRunId: 50 });
  assert.deepEqual(bound.run.inputs, expected.inputs);
  assert.throws(
    () => bindSelectedWorkflowInputs(selected, { assetId: "FW-MAC-M2-01" }),
    /cannot be replaced/u,
  );
  assert.deepEqual(selected.run.inputs, {
    lane: "infrastructure-canary",
    canaryMode: "host",
    assetId: "FW-LNX-NV-01",
    trusted_sha: sha,
  });
});
