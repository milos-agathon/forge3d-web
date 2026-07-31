import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../.github/workflows/publish-web-release.yml",
  ),
  "utf8",
);
const observer = block(
  "observe-release-publication-trust",
  "validate-release-candidate",
);
const preflight = block("validate-release-candidate", "publish-release");
const publisher = block("publish-release", null);

test("supported publication is manual-only and requires target, readiness, and SemVer tag", () => {
  for (const input of ["target_sha", "readinessRunId", "tag"]) {
    assert.match(workflow, new RegExp(`      ${input}:`, "u"));
  }
  assert.match(observer, /inputs\.target_sha != github\.sha/u);
  assert.equal(workflow.includes("pull_request:"), false);
  assert.equal(workflow.includes("workflow_call:"), false);
});

test("observer secret is isolated from read-only preflight and protected publisher", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  for (const value of [preflight, publisher]) {
    assert.equal(value.includes("TRUST_OBSERVER"), false);
    assert.equal(value.includes("secrets."), false);
  }
  assert.match(preflight, /browser-hardware-release-readiness/u);
  assert.match(preflight, /validateReleaseCandidate/u);
  assert.match(
    preflight,
    /artifactDigest: `sha256:\$\{process\.env\.OBSERVATION_ARTIFACT_DIGEST\}`/u,
  );
});

test("evidence records are reproduced from the exact API run and artifact tuple", () => {
  assert.match(preflight, /resolveSelectedWorkflowArtifact/u);
  assert.match(preflight, /finalizeMatrixRecord/u);
  assert.match(preflight, /runId: Number\(process\.argv\[4\]\)/u);
  assert.match(preflight, /event: "workflow_dispatch"/u);
  assert.match(preflight, /status: "completed"/u);
  assert.match(preflight, /resolution,/u);
  assert.match(
    preflight,
    /evidence-assets\/\$\{artifact_id\}-metadata\.json/u,
  );
});

test("every workflow caller supplies finalizeMatrixRecord an exact resolution", () => {
  const workflowDirectory = resolve(
    import.meta.dirname,
    "../../../../.github/workflows",
  );
  const callers = readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => ({
      name,
      content: readFileSync(resolve(workflowDirectory, name), "utf8"),
    }))
    .filter(({ content }) => content.includes("finalizeMatrixRecord({"));
  assert.ok(callers.length > 0);
  for (const { content } of callers) {
    assert.match(
      content,
      /finalizeMatrixRecord\(\{[\s\S]{0,500}\n\s+resolution,/u,
    );
  }
});

test("publisher has no checkout and performs approval, draft-first, byte, CLI, and intake gates", () => {
  assert.match(publisher, /environment: forge3d-web-release/u);
  assert.equal(publisher.includes("actions/checkout@"), false);
  assert.match(publisher, /test ! -d \.git/u);
  assert.match(publisher, /contents: write/u);
  assert.match(publisher, /attestations: read/u);
  assert.match(publisher, /gh release create/u);
  assert.match(publisher, /--draft/u);
  assert.match(publisher, /gh release edit "\$\{RELEASE_TAG\}" --draft=false/u);
  assert.match(publisher, /gh release verify "\$\{RELEASE_TAG\}"/u);
  assert.match(publisher, /gh release verify-asset/u);
  assert.match(publisher, /intakeReleaseId/u);
  assert.match(publisher, /retention-days: 90/u);
});

function block(startId, nextId) {
  const start = workflow.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1);
  const end = nextId ? workflow.indexOf(`  ${nextId}:`, start + 1) : workflow.length;
  assert.notEqual(end, -1);
  return workflow.slice(start, end);
}
