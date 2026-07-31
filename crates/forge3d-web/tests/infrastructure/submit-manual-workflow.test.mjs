import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const workflow = readFileSync(
  join(root, ".github/workflows/submit-browser-manual-evidence.yml"),
  "utf8",
);
const observer = block(
  "observe-manual-submission-trust",
  "submit-manual-evidence",
);
const submit = block("submit-manual-evidence", null);

test("manual submission exposes only closed scalar record selectors", () => {
  for (const input of [
    "intakeReleaseId",
    "mediaAssetIds",
    "manualSessionRunId",
    "hardwareJobId",
    "step_results",
  ]) {
    assert.match(workflow, new RegExp(`      ${input}:`, "u"));
  }
  for (const forbidden of [
    "path:",
    "username:",
    "digest:",
    "pull_request:",
    "workflow_call:",
  ]) {
    assert.equal(workflow.slice(0, workflow.indexOf("permissions:")).includes(forbidden), false);
  }
});

test("observer secret is isolated from independently approved submission", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  assert.match(submit, /environment: forge3d-manual-evidence/u);
  assert.equal(submit.includes("TRUST_OBSERVER"), false);
  assert.equal(submit.includes("secrets."), false);
  for (const output of [
    "observation_artifact_id",
    "observation_artifact_name",
    "observation_artifact_digest",
    "observation_content_sha256",
  ]) {
    assert.match(submit, new RegExp(`needs\\.observe-manual-submission-trust\\.outputs\\.${output}`, "u"));
  }
});

test("submission resolves numeric assets, controller session, actors, approvals, and attested bundle", () => {
  assert.match(submit, /prepare-manual-submission\.mjs/u);
  assert.match(submit, /validate-manual-evidence\.mjs/u);
  assert.match(submit, /resolve-implementation-actors\.mjs/u);
  assert.equal(submit.includes("--previous-tag"), false);
  assert.equal(submit.includes("releases-api.json"), false);
  assert.match(submit, /actions\/runs\/\$\{GITHUB_RUN_ID\}\/approvals/u);
  assert.match(submit, /releases\/assets\/\$\{asset_id\}/u);
  assert.match(submit, /--deny-self-hosted-runners/u);
  assert.match(submit, /retention-days: 90/u);
  assert.match(submit, /actions\/attest@[0-9a-f]{40}/u);
  assert.equal(submit.includes("contents: write"), false);
});

function block(startId, nextId) {
  const start = workflow.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1);
  const end = nextId ? workflow.indexOf(`  ${nextId}:`, start + 1) : workflow.length;
  assert.notEqual(end, -1);
  return workflow.slice(start, end);
}
