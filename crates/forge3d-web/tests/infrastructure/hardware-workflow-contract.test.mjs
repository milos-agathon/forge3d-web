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
  assert.match(workflow, /canaryMode:\n        description: [^\n]+\n        required: false\n        type: string/u);
  assert.equal(workflow.includes('          - ""'), false);
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
  assert.match(promotion, /verifyPackageManifestProvenance/u);
  assert.match(promotion, /packageRun: JSON\.parse\(readFileSync\("package-run\.json"/u);
  assert.match(promotion, /actions\/artifacts\/\$\{\{ steps\.package\.outputs\.package-artifact-id \}\}\/zip/u);
  assert.equal(promotion.includes("npm pack"), false);
  assert.equal(promotion.includes("npm run build"), false);
  assert.match(promotion, /--deny-self-hosted-runners/u);
  assert.match(promotion, /FORGE3D_VERIFIED_LAB_RUN_ID/u);
  assert.match(promotion, /FORGE3D_VERIFIED_LAB_MANIFEST_SHA256/u);
  assert.match(promotion, /manifestSha256/u);
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
  assert.equal(
    hardware.includes(
      "FORGE3D_CONTROLLER_JOB_ROOT: ${{ runner.temp }}/forge3d-controller-job",
    ),
    false,
  );
  assert.match(
    hardware,
    /printf 'FORGE3D_CONTROLLER_JOB_ROOT=%s\\n' "\$\{job_root\}" >> "\$\{GITHUB_ENV\}"/u,
  );
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
  assert.match(hardware, /npm --prefix consumer install --include=dev --no-save/u);
  assert.match(hardware, /create-run-nonce\.mjs/u);
  assert.match(hardware, /manage-browser-route\.mjs/u);
  assert.match(hardware, /probe-browser-fixture\.mjs/u);
  assert.match(hardware, /probe-mobile-device-routes\.mjs/u);
  assert.match(hardware, /mobile-device-route-readiness\.json/u);
  assert.match(hardware, /--origin-policy promotion\/https-origin-policy\.json/u);
  assert.match(hardware, /inputs\.lane == 'infrastructure-canary'/u);
  assert.match(hardware, /host_id == 'FW-MAC-M2-01'/u);
  assert.match(hardware, /browser-lane-runtime\.mjs/u);
  assert.match(hardware, /EXPECTED_REQUIRED: \$\{\{ inputs\.required \}\}/u);
  assert.match(hardware, /authorization\.required !== \(process\.env\.EXPECTED_REQUIRED === "true"\)/u);
  assert.match(hardware, /--required "\$\{\{ inputs\.required \}\}"/u);
  assert.match(hardware, /!process\.env\.GITHUB_ACTOR\?\.trim\(\)/u);
  assert.match(hardware, /createBrowserPageBinding/u);
  assert.doesNotMatch(hardware, /manualSession\.expectedTester/u);
  assert.match(hardware, /capture-host-gpu-evidence\.mjs/u);
  assert.match(hardware, /join-adapter-attestation\.mjs/u);
  assert.match(hardware, /evidence\/host-inventory\.json/u);
  assert.match(hardware, /capture-trackpad-inventory\.mjs/u);
  assert.match(hardware, /evidence\/trackpad-inventory\.json/u);
  assert.match(
    hardware,
    /inputs\.lane == 'infrastructure-canary' \|\|\n\s+inputs\.lane == 'safari-macos-m2' \|\|\n\s+inputs\.lane == 'manual-safari-trackpad'/u,
  );
  assert.match(hardware, /--matrix promotion\/hardware-matrix\.json/u);
  assert.match(hardware, /--trackpad-inventory/u);
  assert.match(hardware, /matrix-record-input\.json/u);
  assert.match(hardware, /hostInventory/u);
  assert.match(hardware, /evidence\/adapter-attestation\.json/u);
  assert.match(hardware, /resolve-host-runtime\.mjs/u);
  assert.match(hardware, /manage-browser-update-window\.mjs/u);
  assert.match(hardware, /if: always\(\)/u);
  assert.match(hardware, /cleanup-browser-hardware\.mjs/u);
  assert.match(hardware, /retention-days: 90/u);
});

test("Firefox Nightly stays optional and uses only validated typed probe outcomes", () => {
  for (const lane of ["firefox-nightly-linux-intel12", "firefox-nightly-linux-rtx3070"]) {
    assert.equal(workflow.split(`          - ${lane}`).length, 2);
  }
  assert.doesNotMatch(hardware, /npm --prefix promotion install|selenium-webdriver@4\.35\.0/u);
  assert.match(hardware, /materialize-selenium-harness\.mjs/u);
  assert.match(hardware, /selenium-harness/u);
  assert.match(hardware, /cp promotion\/firefox-viewer\.mjs promotion\/ffx03-lanes\.mjs/u);
  assert.match(hardware, /selenium-harness\/firefox-viewer\.mjs/u);
  assert.match(hardware, /FORGE3D_FIREFOX_ACCEPTANCE_MODULE/u);
  assert.match(hardware, /FORGE3D_SELENIUM_MODULE/u);
  const seleniumModuleGuard =
    'if [[ "${{ inputs.lane }}" == firefox-* ]]; then\n' +
    '            test -n "${FORGE3D_SELENIUM_MODULE:-}"\n' +
    '            test "${FORGE3D_SELENIUM_MODULE}" = "${FORGE3D_CONTROLLER_JOB_ROOT}/selenium-harness/node_modules/selenium-webdriver/index.js"\n' +
    "          else\n" +
    '            export FORGE3D_SELENIUM_MODULE="$(pwd)/consumer/node_modules/selenium-webdriver/index.js"\n' +
    "          fi";
  assert.notEqual(hardware.indexOf(seleniumModuleGuard), -1,
    "workflow must guard the promoted Selenium closure behind the Firefox lane check");
  assert.equal(
    hardware.split('FORGE3D_SELENIUM_MODULE="$(pwd)/consumer/node_modules/selenium-webdriver/index.js"').length,
    2,
    "consumer Selenium module must be exported only inside the non-Firefox else block",
  );
  assert.match(hardware, /"\$\{\{ inputs\.lane \}\}" == firefox-nightly-\*/u);
  assert.match(hardware, /outcome"\)" != "PROBE_PASS"/u);
  assert.match(automatedFinalizer, /validateFfx03ProbeOutcome/u);
  assert.match(automatedFinalizer, /outcome"\)" != "PROBE_PASS"/u);
  assert.match(automatedFinalizer, /find \.\.\/\.\.\/finalized-hardware-evidence -name adapter-attestation\.json/u);
});

test("manual finalizer verifies signed session and exact runner absence before attestation", () => {
  assert.match(finalizer, /if: >-\n      always\(\)/u);
  assert.match(finalizer, /finalize-manual-session\.mjs/u);
  assert.match(finalizer, /manual-session-finalizer\.json/u);
  assert.match(finalizer, /manualReceiptUrlTemplate/u);
  assert.match(finalizer, /BROWSER_LAB_MTLS_CERT/u);
  assert.match(finalizer, /signed-manual-session\.json/u);
  assert.match(
    finalizer,
    /find \.\.\/\.\.\/hardware-evidence -name host-inventory\.json/u,
  );
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
