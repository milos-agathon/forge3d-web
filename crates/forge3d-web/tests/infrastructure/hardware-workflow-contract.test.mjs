import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repositoryRoot = resolve(packageRoot, "..", "..");
const workflow = readFileSync(
  join(repositoryRoot, ".github", "workflows", "browser-hardware.yml"),
  "utf8",
).replace(/\r\n/gu, "\n");
const observer = jobBlock(workflow, "observe-hardware-trust", "promote-hardware");
const promotion = jobBlock(workflow, "promote-hardware", "authorize-runner");
const authorization = jobBlock(workflow, "authorize-runner", "hardware");
const hardware = jobBlock(workflow, "hardware", "finalize-hardware-evidence");
const automatedFinalizer = jobBlock(
  workflow,
  "finalize-hardware-evidence",
  "finalize-manual-session",
);
const finalizer = jobBlock(workflow, "finalize-manual-session", null);

test("hardware workflow is manual-only with closed inputs and protected main guard", () => {
  assert.match(workflow, /workflow_dispatch:/u);
  for (const forbidden of ["pull_request:", "pull_request_target:", "\n  push:", "workflow_call:"]) {
    assert.equal(workflow.includes(forbidden), false);
  }
  assert.match(observer, /if: github\.ref != 'refs\/heads\/main'\n        run: exit 1/u);
  for (const input of [
    "lane",
    "assetId",
    "required",
    "trusted_sha",
    "packageRunId",
    "labReadinessRunId",
    "canaryMode",
    "intakeReleaseId",
  ]) {
    assert.match(workflow, new RegExp(`      ${input}:`, "u"));
  }
});

test("only observer and hosted finalizers receive trust secrets", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  for (const block of [promotion, authorization, hardware]) {
    assert.equal(block.includes("TRUST_OBSERVER"), false);
  }
  for (const block of [promotion, authorization]) {
    assert.equal(block.includes("secrets."), false);
  }
  assert.match(
    hardware,
    /secrets\[needs\.promote-hardware\.outputs\.tunnel_secret_name\]/u,
  );
  assert.match(automatedFinalizer, /runs-on: ubuntu-latest/u);
  assert.match(automatedFinalizer, /environment: forge3d-trust-observer/u);
  assert.match(automatedFinalizer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  assert.match(automatedFinalizer, /secrets\.BROWSER_LAB_MTLS_CERT/u);
  assert.match(finalizer, /environment: forge3d-trust-observer/u);
  assert.match(finalizer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  assert.match(finalizer, /runs-on: ubuntu-latest/u);
  for (const name of [
    "observation_artifact_id",
    "observation_artifact_name",
    "observation_artifact_digest",
    "observation_content_sha256",
  ]) {
    assert.match(
      promotion,
      new RegExp(`needs\\.observe-hardware-trust\\.outputs\\.${name}`, "u"),
    );
  }
  assert.match(promotion, /verify-repository-trust-observation\.mjs/u);
});

test("promotion validates exact base SHA/package and never rebuilds it", () => {
  assert.match(promotion, /repository: milos-agathon\/forge3d-web/u);
  assert.match(promotion, /ref: \$\{\{ inputs\.trusted_sha \}\}/u);
  assert.match(promotion, /fetch-depth: 0/u);
  assert.match(promotion, /git merge-base --is-ancestor/u);
  assert.match(promotion, /resolve-hardware-promotion\.mjs/u);
  assert.match(promotion, /actions\/artifacts\/\$\{\{ steps\.package\.outputs\.package-artifact-id \}\}\/zip/u);
  assert.equal(promotion.includes("npm pack"), false);
  assert.equal(promotion.includes("npm run build"), false);
  assert.match(promotion, /--deny-self-hosted-runners/u);
});

test("authorization polls exactly one queued job and attests a ten-minute record", () => {
  assert.match(authorization, /authorize-hardware-runner\.mjs/u);
  assert.match(
    authorization,
    /name: runner-authorization-\$\{\{ needs\.promote-hardware\.outputs\.runner_nonce \}\}/u,
  );
  assert.match(authorization, /actions\/attest@[0-9a-f]{40}/u);
  assert.match(authorization, /artifact-metadata: write/u);
  assert.equal(authorization.includes("environment:"), false);
});

test("hardware routes only on three derived labels, serializes by host, and has read-only token", () => {
  assert.match(
    hardware,
    /runs-on:\n      - forge3d-web\n      - \$\{\{ needs\.promote-hardware\.outputs\.hardware_label \}\}\n      - \$\{\{ needs\.promote-hardware\.outputs\.nonce_label \}\}/u,
  );
  assert.match(
    hardware,
    /group: forge3d-browser-host-\$\{\{ needs\.promote-hardware\.outputs\.host_id \}\}/u,
  );
  assert.match(hardware, /cancel-in-progress: false/u);
  assert.match(hardware, /environment: forge3d-browser-lab/u);
  assert.match(
    hardware,
    /timeout-minutes: \$\{\{ \(contains\(inputs\.lane, 'manual-'\) \|\| inputs\.canaryMode == 'manual'\) && 45 \|\| 30 \}\}/u,
  );
  assert.match(hardware, /actions: read/u);
  assert.match(hardware, /attestations: read/u);
  assert.match(hardware, /contents: read/u);
  for (const forbidden of [
    "contents: write",
    "id-token: write",
    "actions/checkout@",
    "config.sh",
    "config.cmd",
    "registration-token",
  ]) {
    assert.equal(hardware.includes(forbidden), false);
  }
});

test("hardware executes only verified promoted artifacts and always cleans up", () => {
  assert.match(hardware, /--deny-self-hosted-runners/u);
  assert.match(hardware, /runner-authorization-\$\{process\.env\.EXPECTED_NONCE\}/u);
  assert.match(hardware, /authorization does not match the executing hardware job/u);
  assert.match(hardware, /test ! -d \.git/u);
  assert.match(hardware, /npm --prefix consumer install --no-save/u);
  assert.match(hardware, /create-run-nonce\.mjs/u);
  assert.match(hardware, /manage-browser-route\.mjs/u);
  assert.match(hardware, /probe-browser-fixture\.mjs/u);
  assert.match(hardware, /browser-lane-runtime\.mjs/u);
  assert.match(hardware, /capture-host-gpu-evidence\.mjs/u);
  assert.match(hardware, /join-adapter-attestation\.mjs/u);
  assert.match(hardware, /evidence\/host-inventory\.json/u);
  assert.match(hardware, /evidence\/adapter-attestation\.json/u);
  assert.match(hardware, /resolve-host-runtime\.mjs/u);
  assert.match(hardware, /manage-browser-update-window\.mjs/u);
  assert.match(hardware, /if: always\(\)/u);
  assert.match(hardware, /cleanup-browser-hardware\.mjs/u);
  assert.match(hardware, /retention-days: 90/u);
});

test("manual finalizer verifies signed session and exact runner absence before attestation", () => {
  assert.match(finalizer, /if: >-\n      always\(\)/u);
  assert.match(finalizer, /finalize-manual-session\.mjs/u);
  assert.match(finalizer, /manual-session-finalizer\.json/u);
  assert.match(finalizer, /manualReceiptUrlTemplate/u);
  assert.match(finalizer, /BROWSER_LAB_MTLS_CERT/u);
  assert.match(finalizer, /signed-manual-session\.json/u);
  assert.match(finalizer, /TRUST_OBSERVER_TOKEN: \$\{\{ steps\.observer-token\.outputs\.token \}\}/u);
  assert.equal(finalizer.includes("GITHUB_TOKEN:"), false);
  assert.match(finalizer, /if: failure\(\)/u);
  assert.match(finalizer, /if: success\(\)\n        uses: actions\/attest@[0-9a-f]{40}/u);
  for (const permission of [
    "actions: read",
    "artifact-metadata: write",
    "attestations: write",
    "contents: read",
    "id-token: write",
  ]) {
    assert.match(finalizer, new RegExp(permission, "u"));
  }
  assert.equal(finalizer.includes("contents: write"), false);
});

test("automated evidence is copied by exact artifact ID and GitHub-hosted attested", () => {
  assert.match(automatedFinalizer, /runs-on: ubuntu-latest/u);
  assert.match(automatedFinalizer, /needs\.hardware\.outputs\.evidence_artifact_id/u);
  assert.match(automatedFinalizer, /finalized-browser-hardware-/u);
  assert.match(automatedFinalizer, /actions\/attest@[0-9a-f]{40}/u);
  assert.match(automatedFinalizer, /retention-days: 90/u);
  assert.match(automatedFinalizer, /finalize-host-lab-canary\.mjs/u);
  assert.match(automatedFinalizer, /signed-controller-receipt\.json/u);
  assert.match(automatedFinalizer, /--retry 60 --retry-delay 5/u);
  assert.match(
    automatedFinalizer,
    /hosted-adapter-attestation-verification\.json/u,
  );
});

function jobBlock(text, startId, nextId) {
  const start = text.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1, `missing ${startId}`);
  const end = nextId ? text.indexOf(`  ${nextId}:`, start + 1) : text.length;
  assert.notEqual(end, -1, `missing ${nextId}`);
  return text.slice(start, end);
}
