import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repositoryRoot = resolve(packageRoot, "..", "..");
const workflow = readFileSync(
  join(repositoryRoot, ".github", "workflows", "browser-package.yml"),
  "utf8",
).replace(/\r\n/gu, "\n");
const bootstrapGate = jobBlock(
  workflow,
  "browser-package-bootstrap",
  "observe-package-trust",
);
const observer = jobBlock(
  workflow,
  "observe-package-trust",
  "build-trusted-browser-package",
);
const builder = jobBlock(workflow, "build-trusted-browser-package", null);

test("browser package runs only for protected-main push or manual dispatch", () => {
  assert.match(workflow, /push:\n    branches: \[main\]/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.equal(workflow.includes("pull_request:"), false);
  assert.equal(workflow.includes("pull_request_target:"), false);
  assert.equal(workflow.includes("workflow_call:"), false);
  assert.match(
    observer,
    /if: github\.ref != 'refs\/heads\/main'\n        run: exit 1/u,
  );
});

test("pending repository trust gates privileged packaging without credentials", () => {
  assert.match(bootstrapGate, /runs-on: ubuntu-latest/u);
  assert.match(bootstrapGate, /contents: read/u);
  assert.match(bootstrapGate, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(
    bootstrapGate,
    /node scripts\/resolve-package-bootstrap\.mjs/u,
  );
  assert.equal(bootstrapGate.includes("environment:"), false);
  assert.equal(bootstrapGate.includes("secrets."), false);
  assert.match(observer, /needs: browser-package-bootstrap/u);
  assert.match(
    observer,
    /if: needs\.browser-package-bootstrap\.outputs\.package_enabled == 'true'/u,
  );
});

test("only observer receives the trust environment and four-output handoff", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  assert.equal(builder.includes("environment:"), false);
  assert.equal(builder.includes("TRUST_OBSERVER"), false);
  assert.equal(builder.includes("secrets."), false);
  for (const name of [
    "observation_artifact_id",
    "observation_artifact_name",
    "observation_artifact_digest",
    "observation_content_sha256",
  ]) {
    assert.match(
      builder,
      new RegExp(`needs\\.observe-package-trust\\.outputs\\.${name}`, "u"),
    );
  }
});

test("builder verifies exact-ID observation before target checkout or execution", () => {
  const verifyIndex = builder.indexOf(
    "node scripts/verify-repository-trust-observation.mjs",
  );
  const targetCheckoutIndex = builder.indexOf("ref: ${{ github.sha }}");
  const packageIndex = builder.indexOf("npm run test:package-consumer");
  assert.ok(verifyIndex > 0);
  assert.ok(targetCheckoutIndex > verifyIndex);
  assert.ok(packageIndex > targetCheckoutIndex);
  assert.equal(builder.includes("artifacts?name="), false);
  assert.match(builder, /path: validation/u);
  assert.match(builder, /persist-credentials: false/u);
});

test("builder creates one tarball consumer artifact with 90-day retention", () => {
  assert.equal(
    builder.match(/npm run test:package-consumer/gu)?.length,
    1,
  );
  assert.match(builder, /assemble-browser-package-artifact\.mjs/u);
  assert.match(builder, /name: browser-package-\$\{\{ github\.sha \}\}/u);
  assert.match(builder, /retention-days: 90/u);
  assert.match(builder, /if-no-files-found: error/u);
  assert.match(builder, /overwrite: false/u);
  assert.match(builder, /actions\/attest@[0-9a-f]{40}/u);
});

test("observer and builder use least privilege without writes to repository contents", () => {
  assert.match(observer, /checks: read/u);
  assert.match(observer, /artifact-metadata: write/u);
  assert.match(builder, /actions: read/u);
  assert.match(builder, /contents: read/u);
  assert.match(builder, /id-token: write/u);
  assert.match(builder, /attestations: write/u);
  assert.match(builder, /artifact-metadata: write/u);
  assert.equal(builder.includes("contents: write"), false);
});

function jobBlock(text, startId, nextId) {
  const start = text.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1, `missing job ${startId}`);
  const end = nextId ? text.indexOf(`  ${nextId}:`, start + 1) : text.length;
  assert.notEqual(end, -1, `missing next job ${nextId}`);
  return text.slice(start, end);
}
