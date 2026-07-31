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

test("exact lab/evidence attestations, merger, negative controls, and fixed artifact are required", () => {
  assert.match(readiness, /name: browser-hardware-release-readiness/u);
  assert.match(readiness, /browser-lab-infrastructure-readiness\.json/u);
  assert.match(readiness, /browser-matrix-record-source\.json/u);
  assert.match(readiness, /selectedRun:/u);
  assert.match(readiness, /attempt: resolution\.run\.run_attempt/u);
  assert.match(readiness, /path: resolution\.run\.path/u);
  assert.match(readiness, /merge-browser-evidence\.mjs/u);
  for (const negative of [
    "negative-prior-head.json",
    "negative-package.json",
    "negative-package-run.json",
    "negative-missing.json",
    "negative-old-readiness-record.json",
    "negative-safari-substitution.json",
    "negative-safari-package-run.json",
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
