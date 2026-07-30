import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

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
