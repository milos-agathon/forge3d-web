import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repositoryRoot = resolve(packageRoot, "..", "..");
const workflow = readFileSync(
  join(repositoryRoot, ".github", "workflows", "prepare-browser-manual-evidence.yml"),
  "utf8",
).replace(/\r\n?/gu, "\n");
const observer = jobBlock(workflow, "observe-manual-intake-trust", "prepare-manual-intake");
const prepare = jobBlock(workflow, "prepare-manual-intake", null);

test("manual intake is protected-main dispatch with closed checklist and asset choices", () => {
  assert.match(workflow, /workflow_dispatch:/u);
  assert.equal(workflow.includes("pull_request:"), false);
  assert.equal(workflow.includes("\n  push:"), false);
  assert.match(observer, /if: github\.ref != 'refs\/heads\/main'\n        run: exit 1/u);
  for (const checklist of [
    "infrastructure-manual-canary",
    "mobile-multitouch",
    "safari-trackpad",
  ]) {
    assert.match(workflow, new RegExp(`- ${checklist}`, "u"));
  }
});

test("observer secret is isolated from independently approved intake writer", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  assert.match(prepare, /environment: forge3d-manual-evidence/u);
  assert.equal(prepare.includes("TRUST_OBSERVER"), false);
  assert.equal(prepare.includes("secrets."), false);
  assert.match(prepare, /verify-repository-trust-observation\.mjs/u);
});

test("intake resolves package hash, derives actor/challenge, attests, and writes one draft", () => {
  assert.match(prepare, /resolve-hardware-promotion\.mjs/u);
  assert.match(prepare, /EXPECTED_TESTER: \$\{\{ github\.actor \}\}/u);
  assert.match(prepare, /manual-evidence\.mjs/u);
  assert.match(prepare, /actions\/attest@[0-9a-f]{40}/u);
  assert.match(prepare, /gh release create/u);
  assert.match(prepare, /--draft/u);
  assert.match(prepare, /gh release upload "\$\{tag\}" intake-manifest\.json/u);
  assert.equal(prepare.includes("--clobber"), false);
  assert.match(prepare, /contents: write/u);
  assert.match(prepare, /artifact-metadata: write/u);
});

function jobBlock(text, startId, nextId) {
  const start = text.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1);
  const end = nextId ? text.indexOf(`  ${nextId}:`, start + 1) : text.length;
  assert.notEqual(end, -1);
  return text.slice(start, end);
}
