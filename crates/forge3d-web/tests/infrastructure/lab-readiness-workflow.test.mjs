import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../.github/workflows/browser-lab-infrastructure-readiness.yml",
  ),
  "utf8",
).replace(/\r\n?/gu, "\n");
const readinessCli = readFileSync(
  resolve(
    import.meta.dirname,
    "../../scripts/compute-lab-readiness.mjs",
  ),
  "utf8",
).replace(/\r\n?/gu, "\n");
const deploymentPackageProofCli = readFileSync(
  resolve(
    import.meta.dirname,
    "../../scripts/create-deployment-package-proof.mjs",
  ),
  "utf8",
).replace(/\r\n?/gu, "\n");
const observer = block(
  "observe-lab-readiness-trust",
  "browser-lab-infrastructure-readiness",
);
const readiness = block("browser-lab-infrastructure-readiness", null);

test("laboratory readiness accepts one package, four hosts, one manual canary, and one release", () => {
  for (const input of [
    "candidate_sha",
    "packageRunId",
    "macHostCanaryRunId",
    "windowsHostCanaryRunId",
    "linuxIntelHostCanaryRunId",
    "linuxNvidiaHostCanaryRunId",
    "manualCanaryRunId",
    "manualIntakeReleaseId",
    "manualHardwareJobId",
    "labCanaryReleaseId",
  ]) {
    assert.match(workflow, new RegExp(`      ${input}:`, "u"));
  }
  assert.match(observer, /inputs\.candidate_sha != github\.sha/u);
  assert.equal(workflow.includes("pull_request:"), false);
  assert.equal(workflow.includes("workflow_call:"), false);
});

test("only observer receives trust secret and computation cannot schedule product lanes", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  assert.equal(readiness.includes("TRUST_OBSERVER"), false);
  assert.equal(readiness.includes("secrets."), false);
  assert.equal(readiness.includes("uses: ./.github/workflows/browser-hardware.yml"), false);
  assert.match(readiness, /resolveSelectedWorkflowArtifact/u);
  assert.match(readiness, /verifySelectedWorkflowRecord/u);
  assert.match(readiness, /lane: "infrastructure-canary"/u);
  assert.match(readiness, /canaryMode: "host"/u);
  assert.match(readiness, /lab-manual-canary-source\.json/u);
  assert.match(readiness, /lab-canary-assets\/manual-canary\.json/u);
  assert.match(
    readiness,
    /path: "\.github\/workflows\/submit-browser-manual-evidence\.yml"/u,
  );
  assert.match(readiness, /canary-publication-resolution\.json/u);
  assert.match(readiness, /compute-lab-readiness\.mjs/u);
  assert.match(readiness, /lab-deployment-provenance\.json/u);
  assert.match(readiness, /create-deployment-package-proof\.mjs/u);
  assert.match(
    readiness,
    /actions\/runs\/\$\{run_id\}\/attempts\/\$\{run_attempt\}/u,
  );
  assert.match(
    readiness,
    /actions\/artifacts\/\$\{artifact_id\}\/zip/u,
  );
  assert.match(readiness, /deploymentPackageProofs/u);
  assert.match(readiness, /deploymentProvenance/u);
  assert.match(
    deploymentPackageProofCli,
    /`browser-lab-\$\{service\}-\$\{deployment\.source\.targetSha\}-\$\{run\.id\}-\$\{run\.run_attempt\}`/u,
  );
});

test("every selected canary and publication artifact retains and rebinds its run tuple", () => {
  for (const value of [
    "host-canaries/${run.id}-resolution.json",
    "manual-resolution.json",
    "canary-publication-resolution.json",
  ]) {
    assert.equal(readiness.includes(value), true);
  }
  for (const field of [
    'event: "workflow_dispatch"',
    'status: "completed"',
    'conclusion: "success"',
    "trusted_sha: process.env.CANDIDATE_SHA",
    'runIdField: "publicationRunId"',
    "runAttemptField: null",
  ]) {
    assert.match(readiness, new RegExp(field, "u"));
  }
});

test("readiness CLI receives the protected checkout root", () => {
  assert.match(
    readiness,
    /node scripts\/compute-lab-readiness\.mjs \\\n\s+lab-readiness-input\.json \\\n\s+browser-lab-infrastructure-readiness\.json \\\n\s+"\$\{GITHUB_WORKSPACE\}"/u,
  );
  for (const [field, file] of [
    ["browserPolicy", "browser-policy.json"],
    ["runnerDistributionManifest", "runner-distribution-manifest.json"],
    ["runnerTransientPathPolicy", "runner-transient-path-policy.json"],
  ]) {
    assert.match(
      readinessCli,
      new RegExp(
        `input\\.${field} = JSON\\.parse\\([\\s\\S]*?join\\(infrastructureRoot, "${file}"\\)`,
        "u",
      ),
    );
  }
});

test("immutable computation name, permissions, fixed artifact, and attestation are pinned", () => {
  assert.match(readiness, /name: browser-lab-infrastructure-readiness/u);
  for (const permission of [
    "actions: read",
    "checks: read",
    "contents: read",
    "id-token: write",
    "attestations: write",
    "artifact-metadata: write",
  ]) {
    assert.match(readiness, new RegExp(permission, "u"));
  }
  assert.match(readiness, /name: browser-lab-infrastructure-readiness\n/u);
  assert.match(readiness, /retention-days: 90/u);
  assert.match(readiness, /actions\/attest@[0-9a-f]{40}/u);
});

function block(startId, nextId) {
  const start = workflow.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1);
  const end = nextId ? workflow.indexOf(`  ${nextId}:`, start + 1) : workflow.length;
  assert.notEqual(end, -1);
  return workflow.slice(start, end);
}
