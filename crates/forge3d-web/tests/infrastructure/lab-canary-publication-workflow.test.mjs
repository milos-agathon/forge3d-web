import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  bindSelectedWorkflowInputs,
  resolveSelectedWorkflowArtifact,
  verifySelectedWorkflowRecord,
} from "../../scripts/selected-workflow-record.mjs";

const workflow = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../.github/workflows/publish-browser-lab-canary.yml",
  ),
  "utf8",
);
const observer = block(
  "observe-lab-canary-publication-trust",
  "validate-lab-canary",
);
const preflight = block("validate-lab-canary", "publish-lab-canary");
const publisher = block("publish-lab-canary", null);

test("canary accepts only fixed host/manual IDs and derives candidate and tag", () => {
  for (const input of [
    "macHostCanaryRunId",
    "windowsHostCanaryRunId",
    "linuxIntelHostCanaryRunId",
    "linuxNvidiaHostCanaryRunId",
    "manualCanaryRunId",
    "manualIntakeReleaseId",
    "manualHardwareJobId",
  ]) {
    assert.match(workflow, new RegExp(`      ${input}:`, "u"));
  }
  for (const forbidden of ["target_sha:", "supportMatrix:", "readinessRunId:"]) {
    assert.equal(workflow.includes(forbidden), false);
  }
  assert.match(observer, /browser-lab-canary-\$\{digest\}-\$\{GITHUB_RUN_ID\}/u);
});

test("observer secret is isolated and canary cannot claim support readiness", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  for (const value of [preflight, publisher]) {
    assert.equal(value.includes("TRUST_OBSERVER"), false);
    assert.equal(value.includes("secrets."), false);
    assert.equal(value.includes("browser-hardware-release-readiness"), false);
  }
  assert.match(preflight, /supportClaim: false/u);
  assert.match(
    preflight,
    /artifactDigest: `sha256:\$\{process\.env\.OBSERVATION_ARTIFACT_DIGEST\}`/u,
  );
  assert.match(publisher, /makes no browser support claim/u);
});

test("host and manual records are rebound to normalized selected run artifacts", () => {
  assert.match(preflight, /resolveSelectedWorkflowArtifact/u);
  assert.match(preflight, /verifySelectedWorkflowRecord/u);
  assert.match(preflight, /resolved\/\$\{run\.id\}-resolution\.json/u);
  assert.match(preflight, /resolved\/manual-resolution\.json/u);
  for (const field of [
    'event: "workflow_dispatch"',
    'status: "completed"',
    'conclusion: "success"',
    "trusted_sha: process.env.GITHUB_SHA",
    "packageRunId: record.packageRunId",
  ]) {
    assert.match(preflight, new RegExp(field, "u"));
  }
  assert.match(
    preflight,
    /bindSelectedWorkflowInputs\(\s*resolution,\s*\{ packageRunId: record\.packageRunId \}\s*\)/u,
  );
  assert.equal(
    preflight.includes("bindSelectedWorkflowInputs(\n                  resolution,\n                  expectedInputs"),
    false,
  );
});

test("host artifact with the wrong independently selected host is rejected", () => {
  assertCanaryRecordRejected({
    lane: "infrastructure-canary",
    assetId: "FW-MAC-M2-01",
  });
});

test("host artifact with the wrong independently selected lane is rejected", () => {
  assertCanaryRecordRejected({
    lane: "chrome-linux-rtx3070",
    assetId: "FW-LNX-NV-01",
  });
});

test("correct host artifact preserves selected context and adds package run", () => {
  const { record, boundInputs } = verifyCanaryRecord({
    lane: "infrastructure-canary",
    assetId: "FW-LNX-NV-01",
  });
  assert.equal(record.assetId, "FW-LNX-NV-01");
  assert.equal(record.packageRunId, 50);
  assert.deepEqual(boundInputs, {
    lane: "infrastructure-canary",
    canaryMode: "host",
    assetId: "FW-LNX-NV-01",
    trusted_sha: "a".repeat(40),
    packageRunId: 50,
  });
});

test("publisher has no checkout, rechecks exact handoffs, publishes once, verifies, then deletes intake", () => {
  assert.match(publisher, /environment: forge3d-web-release/u);
  assert.equal(publisher.includes("actions/checkout@"), false);
  assert.match(publisher, /test ! -d \.git/u);
  assert.match(publisher, /contents: write/u);
  assert.match(publisher, /attestations: read/u);
  assert.match(publisher, /for subject in preflight\/canary-assets\/\*/u);
  assert.match(publisher, /gh release create/u);
  assert.match(publisher, /--draft/u);
  assert.match(publisher, /gh release edit "\$\{RELEASE_TAG\}" --draft=false/u);
  assert.match(publisher, /gh release verify "\$\{RELEASE_TAG\}"/u);
  assert.match(publisher, /gh release verify-asset/u);
  assert.match(publisher, /gh release delete "\$\{intake_tag\}" --cleanup-tag --yes/u);
});

function block(startId, nextId) {
  const start = workflow.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1);
  const end = nextId ? workflow.indexOf(`  ${nextId}:`, start + 1) : workflow.length;
  assert.notEqual(end, -1);
  return workflow.slice(start, end);
}

function assertCanaryRecordRejected({ lane, assetId }) {
  assert.throws(
    () => verifyCanaryRecord({ lane, assetId }),
    /inputs do not match/u,
  );
}

function verifyCanaryRecord({ lane, assetId }) {
  const trustedSha = "a".repeat(40);
  const resolution = resolveSelectedWorkflowArtifact({
    run: {
      id: 101,
      run_attempt: 2,
      path: ".github/workflows/browser-hardware.yml",
      head_branch: "main",
      head_sha: trustedSha,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
    },
    artifacts: [
      {
        id: 201,
        name: "finalized-browser-hardware-101-2",
        digest: `sha256:${"b".repeat(64)}`,
        expired: false,
      },
    ],
    expected: {
      runId: 101,
      path: ".github/workflows/browser-hardware.yml",
      ref: "refs/heads/main",
      headSha: trustedSha,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      inputs: {
        lane: "infrastructure-canary",
        canaryMode: "host",
        assetId: "FW-LNX-NV-01",
        trusted_sha: trustedSha,
      },
    },
  });
  const record = {
    runId: 101,
    runAttempt: 2,
    trustedSha,
    lane,
    canaryMode: "host",
    assetId,
    packageRunId: 50,
  };
  const boundResolution = bindSelectedWorkflowInputs(resolution, {
    packageRunId: record.packageRunId,
  });
  return {
    record: verifySelectedWorkflowRecord({
      resolution: boundResolution,
      record,
      expectedInputs: {
        lane: record.lane,
        canaryMode: record.canaryMode,
        assetId: record.assetId,
        trusted_sha: record.trustedSha,
        packageRunId: record.packageRunId,
      },
    }),
    boundInputs: boundResolution.run.inputs,
  };
}
