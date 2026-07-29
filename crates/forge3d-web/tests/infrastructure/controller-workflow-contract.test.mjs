import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repositoryRoot = resolve(packageRoot, "..", "..");
const workflow = readFileSync(
  join(repositoryRoot, ".github", "workflows", "browser-lab-controller.yml"),
  "utf8",
);
const observer = jobBlock(
  workflow,
  "observe-controller-package-trust",
  "package-controller",
);
const packager = jobBlock(workflow, "package-controller", null);

test("controller package is manual protected-main only", () => {
  assert.match(workflow, /workflow_dispatch:/u);
  for (const forbidden of ["pull_request:", "pull_request_target:", "push:", "workflow_call:"]) {
    assert.equal(workflow.includes(forbidden), false);
  }
  assert.match(observer, /if: github\.ref != 'refs\/heads\/main'\n        run: exit 1/u);
});

test("observer secret is isolated and packager verifies exact-ID handoff", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  assert.equal(packager.includes("TRUST_OBSERVER"), false);
  assert.equal(packager.includes("secrets."), false);
  assert.match(packager, /needs: observe-controller-package-trust/u);
  assert.match(packager, /verify-repository-trust-observation\.mjs/u);
  assert.equal(packager.includes("artifacts?name="), false);
});

test("controller is tested, versioned, retained, and GitHub-hosted attested", () => {
  assert.match(packager, /working-directory: source\/tools\/browser-lab-controller/u);
  assert.match(packager, /run: npm test/u);
  assert.match(packager, /browser-lab-controller-1\.0\.0\.tar\.gz/u);
  assert.match(packager, /create-package-manifest\.mjs/u);
  assert.match(packager, /retention-days: 90/u);
  assert.match(packager, /actions\/attest@[0-9a-f]{40}/u);
  assert.match(packager, /artifact-metadata: write/u);
});

function jobBlock(text, startId, nextId) {
  const start = text.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1);
  const end = nextId ? text.indexOf(`  ${nextId}:`, start + 1) : text.length;
  assert.notEqual(end, -1);
  return text.slice(start, end);
}
