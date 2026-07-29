import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repositoryRoot = resolve(packageRoot, "..", "..");
const workflow = readFileSync(
  join(repositoryRoot, ".github", "workflows", "browser-lab-broker.yml"),
  "utf8",
).replace(/\r\n/gu, "\n");
const bootstrapGate = jobBlock(
  workflow,
  "broker-package-bootstrap",
  "observe-broker-package-trust",
);
const observer = jobBlock(
  workflow,
  "observe-broker-package-trust",
  "package-broker",
);
const packager = jobBlock(workflow, "package-broker", null);

test("pending repository trust gates privileged packaging without credentials", () => {
  assert.match(bootstrapGate, /runs-on: ubuntu-latest/u);
  assert.match(bootstrapGate, /contents: read/u);
  assert.match(bootstrapGate, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(
    bootstrapGate,
    /node scripts\/resolve-broker-package-bootstrap\.mjs/u,
  );
  assert.equal(bootstrapGate.includes("environment:"), false);
  assert.equal(bootstrapGate.includes("secrets."), false);
  assert.match(observer, /needs: broker-package-bootstrap/u);
  assert.match(
    observer,
    /if: needs\.broker-package-bootstrap\.outputs\.package_enabled == 'true'/u,
  );
});

test("observer exposes only the exact four non-secret handoff outputs", () => {
  const outputs = observer
    .split(/\r?\n/u)
    .filter((line) => /^ {6}observation_[a-z0-9_]+:/u.test(line))
    .map((line) => line.trim().split(":", 1)[0])
    .sort();
  assert.deepEqual(outputs, [
    "observation_artifact_digest",
    "observation_artifact_id",
    "observation_artifact_name",
    "observation_content_sha256",
  ]);
  assert.match(
    observer,
    /observation_artifact_id: \$\{\{ steps\.upload-observation\.outputs\.artifact-id \}\}/u,
  );
  assert.match(
    observer,
    /observation_artifact_digest: \$\{\{ steps\.upload-observation\.outputs\.artifact-digest \}\}/u,
  );
  assert.match(
    observer,
    /observation_artifact_name: \$\{\{ steps\.emit-observation\.outputs\.artifact-name \}\}/u,
  );
  assert.match(
    observer,
    /observation_content_sha256: \$\{\{ steps\.emit-observation\.outputs\.content-sha256 \}\}/u,
  );
  for (const forbidden of ["PRIVATE_KEY", "observer-token.outputs.token", "artifact-url"]) {
    const outputSection = observer.slice(
      observer.indexOf("    outputs:"),
      observer.indexOf("\n\n    steps:"),
    );
    assert.equal(outputSection.includes(forbidden), false);
  }
});

test("only the GitHub-hosted observer job can reference observer credentials", () => {
  assert.match(observer, /runs-on: ubuntu-latest/u);
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  assert.equal(packager.includes("TRUST_OBSERVER"), false);
  assert.equal(packager.includes("secrets."), false);
  assert.match(packager, /environment: forge3d-browser-lab/u);
  assert.match(packager, /needs: observe-broker-package-trust/u);
});

test("observer upload is immutable, exact-name, error-on-missing, and attested", () => {
  assert.match(
    observer,
    /if: always\(\) && steps\.observer-token\.outputs\.token != ''/u,
  );
  assert.match(observer, /id: upload-observation/u);
  assert.match(
    observer,
    /name: \$\{\{ steps\.emit-observation\.outputs\.artifact-name \}\}/u,
  );
  assert.match(observer, /if-no-files-found: error/u);
  assert.match(observer, /overwrite: false/u);
  assert.match(observer, /artifact-metadata: write/u);
  assert.match(observer, /actions\/attest@[0-9a-f]{40}/u);
});

test("packager consumes all four values only through needs and uses exact-ID verifier", () => {
  for (const [environmentName, outputName] of [
    ["OBSERVATION_ARTIFACT_ID", "observation_artifact_id"],
    ["OBSERVATION_ARTIFACT_NAME", "observation_artifact_name"],
    ["OBSERVATION_ARTIFACT_DIGEST", "observation_artifact_digest"],
    ["OBSERVATION_CONTENT_SHA256", "observation_content_sha256"],
  ]) {
    assert.match(
      packager,
      new RegExp(
        `${environmentName}: \\$\\{\\{ needs\\.observe-broker-package-trust\\.outputs\\.${outputName} \\}\\}`,
        "u",
      ),
    );
  }
  assert.match(packager, /verify-repository-trust-observation\.mjs/u);
  assert.equal(packager.includes("artifacts?name="), false);
  assert.equal(packager.includes("/actions/artifacts?"), false);
  assert.match(packager, /artifact-metadata: write/u);
  assert.match(packager, /actions\/attest@[0-9a-f]{40}/u);
});

test("packager includes the checked controller health endpoint configuration", () => {
  assert.match(
    packager,
    /cp crates\/forge3d-web\/tests\/infrastructure\/controller-health-endpoints\.json broker-package\/config\//u,
  );
});

function jobBlock(text, startId, nextId) {
  const start = text.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1, `missing job ${startId}`);
  const end = nextId ? text.indexOf(`  ${nextId}:`, start + 1) : text.length;
  assert.notEqual(end, -1, `missing next job ${nextId}`);
  return text.slice(start, end);
}
