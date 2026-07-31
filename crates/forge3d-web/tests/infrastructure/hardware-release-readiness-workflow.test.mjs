import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../.github/workflows/browser-hardware-release-readiness.yml",
  ),
  "utf8",
);
const observer = block(
  "observe-hardware-release-readiness-trust",
  "browser-hardware-release-readiness",
);
const readiness = block("browser-hardware-release-readiness", null);

test("release readiness accepts only exact target, lab run, and sorted evidence run IDs", () => {
  for (const input of ["target_sha", "labReadinessRunId", "evidenceRunIds"]) {
    assert.match(workflow, new RegExp(`      ${input}:`, "u"));
  }
  assert.match(observer, /inputs\.target_sha != github\.sha/u);
  assert.match(readiness, /parseEvidenceRunIds/u);
  assert.equal(workflow.includes("pull_request:"), false);
  assert.equal(workflow.includes("workflow_call:"), false);
});

test("only observer has trust secret and computation never schedules hardware", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  assert.equal(readiness.includes("TRUST_OBSERVER"), false);
  assert.equal(readiness.includes("secrets."), false);
  assert.equal(readiness.includes("uses: ./.github/workflows/browser-hardware.yml"), false);
});

test("matrix finalization retains the selected API tuple without inventing REST inputs", () => {
  assert.match(readiness, /resolveSelectedWorkflowArtifact/u);
  assert.match(readiness, /selected-workflow-record\.mjs/u);
  assert.match(readiness, /runId: Number\(process\.argv\[3\]\)/u);
  assert.match(readiness, /const allowedPaths = new Set/u);
  assert.match(readiness, /if \(!allowedPaths\.has\(run\.path\)\)/u);
  assert.match(readiness, /event: "workflow_dispatch"/u);
  assert.match(readiness, /status: "completed"/u);
  assert.equal(readiness.includes("bindSelectedWorkflowInputs"), false);
  assert.equal(readiness.includes("const relevantInputs ="), false);
  assert.match(
    readiness,
    /resolution: JSON\.parse\(readFileSync\(process\.argv\[3\], "utf8"\)\)/u,
  );
  assert.match(readiness, /create-browser-matrix-record\.mjs/u);
});

test("release readiness uses the shared laboratory verifier and an independently resolved package", () => {
  for (const binding of [
    "verifyLabReadinessForPromotion",
    "manifestBytes",
    "attempt: api.run_attempt",
    "ref: `refs/heads/${api.head_branch}`",
    "event: api.event",
    "status: api.status",
    "packageRunId: manifest.packageRunId",
    'packageResolution: JSON.parse(readFileSync("package-run.json", "utf8"))',
    "verified: true",
    "subjectSha256: sha256Hex(manifestBytes)",
    "expectedConfiguration: computeLabConfiguration",
    'repositoryRoot: resolve(process.cwd(), "../..")',
  ]) {
    assert.equal(readiness.includes(binding), true, `missing ${binding}`);
  }
  assert.match(
    readiness,
    /workflow-run REST response does not expose workflow_dispatch/u,
  );
  assert.match(readiness, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(readiness, /resolve-hardware-promotion\.mjs/u);
  assert.match(readiness, /--package-run-id "\$\{package_run_id\}"/u);
  assert.match(readiness, /packageArtifactId/u);
  assert.match(readiness, /packageArtifactDigest/u);
  assert.match(
    readiness,
    /actions\/artifacts\/\$\{package_artifact_id\}\/zip/u,
  );
  assert.match(
    readiness,
    /test "\$\(sha256sum package\.zip \| cut -d ' ' -f 1\)" = "\$\{package_expected#sha256:\}"/u,
  );
  assert.match(readiness, /browser-package-manifest\.json/u);
  assert.match(
    readiness,
    /signer-workflow milos-agathon\/forge3d-web\/\.github\/workflows\/browser-package\.yml/u,
  );
  assert.equal(
    workflow.includes("\n      packageRunId:\n        description:"),
    false,
  );
  assert.equal(readiness.includes("inputs.packageRunId"), false);
  assert.equal(readiness.includes("api.inputs"), false);
  assert.equal(readiness.includes("run.inputs"), false);
  assert.ok(
    readiness.indexOf("verifyLabReadinessForPromotion") <
      readiness.lastIndexOf("node scripts/merge-browser-evidence.mjs"),
  );
});

test("exact lab/evidence attestations, merger, negative controls, and fixed artifact are required", () => {
  assert.match(readiness, /name: browser-hardware-release-readiness/u);
  assert.match(readiness, /browser-lab-infrastructure-readiness\.json/u);
  assert.match(readiness, /browser-matrix-record-source\.json/u);
  assert.match(readiness, /merge-browser-evidence\.mjs/u);
  for (const negative of [
    "negative-prior-head.json",
    "negative-package.json",
    "negative-missing.json",
  ]) {
    assert.match(readiness, new RegExp(negative, "u"));
  }
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
