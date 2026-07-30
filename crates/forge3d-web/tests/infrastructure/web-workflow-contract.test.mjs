import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyWorkflowActionPins,
  verifyWorkflowText,
} from "../../scripts/verify-workflow-action-pins.mjs";
import { verifyWebWorkflowContract } from "../../scripts/verify-web-workflow-contract.mjs";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repositoryRoot = resolve(packageRoot, "..", "..");
const workflowPath = join(repositoryRoot, ".github", "workflows", "web.yml");
const workflowText = readFileSync(workflowPath, "utf8").replace(/\r\n/gu, "\n");
const lock = JSON.parse(
  readFileSync(
    join(packageRoot, "tests", "infrastructure", "workflow-actions-lock.json"),
    "utf8",
  ),
);
const lockedActions = new Map(
  lock.actions.map((entry) => [
    entry.path ? `${entry.repository}/${entry.path}` : entry.repository,
    entry,
  ]),
);

function verifyHostedChromiumPreflightContract(text) {
  const browserCommands = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\bnpm run test:browser:chromium\b/u.test(line));
  assert.deepEqual(
    browserCommands,
    [
      'npm run test:browser:chromium -- --grep "reports browser WebGPU diagnostics"',
      "run: npm run test:browser:chromium",
    ],
    "hosted source-browser commands must explicitly select the bundled Chromium preflight",
  );
  assert.equal(
    browserCommands.some((line) => /\bnpm run test:browser(?:\s|$)/u.test(line)),
    false,
    "hosted source-browser commands must not use the ambiguous default script",
  );
  for (const expected of [
    "Bundled Playwright Chromium",
    "flagged preflight",
    "ENGINE_PASS-only",
    "not branded Chrome or Edge support evidence",
  ]) {
    assert.ok(
      text.includes(expected),
      `hosted source-browser workflow must describe ${expected}`,
    );
  }
  assert.equal(
    text
      .split(/\r?\n/u)
      .some(
        (line) =>
          /\b(?:Chrome|Edge)\b/u.test(line) &&
          /--(?:enable-unsafe-webgpu|use-angle)/u.test(line),
      ),
    false,
    "hosted workflow must not describe branded Chrome or Edge as using preflight flags",
  );
}

function verifyHostedExactTarballProbeContract(text) {
  const step = text.match(
    /      - name: Test clean installed tarball in bundled Chromium preflight\n[\s\S]*?(?=\n      - name:)/u,
  )?.[0];
  assert.ok(
    step,
    "hosted exact-tarball probe must be an explicitly named bundled Chromium preflight",
  );
  for (const expected of [
    "FORGE3D_BROWSER_CHANNEL: bundled",
    "FORGE3D_EVIDENCE_DIR: test-results/browser-gate",
    "FORGE3D_PACKAGE_GATE_MODE: probe",
    "run: npm run test:package-consumer",
  ]) {
    assert.ok(
      step.includes(expected),
      `hosted exact-tarball probe must include ${expected}`,
    );
  }
}

test("web workflow exposes exactly the two immutable required checks", () => {
  const contract = verifyWebWorkflowContract();
  assert.deepEqual(contract.triggers, ["pull_request", "push"]);
  assert.deepEqual(
    contract.requiredChecks.map((job) => job.name).sort(),
    [
      "Web Runtime / Browser Preflight",
      "Web Runtime / Build And Contract Tests",
    ],
  );
  assert.deepEqual(
    contract.nonBlockingChecks.map((job) => job.name),
    ["Web Runtime / Playwright WebKit Engine Preflight"],
  );
});

test("web workflow keeps privileged triggers and self-hosted routing out", () => {
  for (const forbidden of [
    "workflow_dispatch",
    "workflow_call",
    "schedule",
    "repository_dispatch",
  ]) {
    assert.equal(workflowText.includes(`  ${forbidden}:`), false);
  }
  assert.equal(workflowText.includes("self-hosted"), false);
  assert.equal(workflowText.includes("forge3d-trust-observer"), false);
  assert.equal(workflowText.includes("forge3d-browser-lab"), false);
});

test("hosted source-browser workflow is explicit ENGINE_PASS-only Chromium preflight", () => {
  verifyHostedChromiumPreflightContract(workflowText);
});

test("hosted source-browser workflow rejects generic invocation and flagged Chrome wording", () => {
  assert.throws(
    () =>
      verifyHostedChromiumPreflightContract(
        workflowText.replaceAll(
          "npm run test:browser:chromium",
          "npm run test:browser",
        ),
      ),
    /explicitly select the bundled Chromium preflight|ambiguous default script/u,
  );
  assert.throws(
    () =>
      verifyHostedChromiumPreflightContract(
        workflowText.replace(
          "Bundled Playwright Chromium is a flagged preflight",
          "Branded Chrome uses --enable-unsafe-webgpu in a flagged preflight",
        ),
      ),
    /Bundled Playwright Chromium|branded Chrome or Edge as using preflight flags/u,
  );
});

test("Playwright WebKit engine preflight is the only non-blocking web job", () => {
  const contract = verifyWebWorkflowContract();
  assert.deepEqual(
    contract.jobs.map(({ id, continueOnError }) => [
      id,
      continueOnError === true,
    ]),
    [
      ["build-and-contract", false],
      ["browser-preflight", false],
      ["webkit-engine-preflight", true],
    ],
  );
});

test("Playwright WebKit engine preflight rejects blocking or wrong-host execution", () => {
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace("    continue-on-error: true\n", ""),
      ),
    /continue-on-error: true/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace(
          "    runs-on: macos-latest\n    continue-on-error: true",
          "    runs-on: windows-latest\n    continue-on-error: true",
        ),
      ),
    /must run on macos-latest/u,
  );
});

test("Playwright WebKit engine preflight rejects the wrong project or engine wording", () => {
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace(
          "run: npm run test:browser:webkit",
          "run: npm run test:browser:chromium",
        ),
      ),
    /test:browser:webkit/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replaceAll("Playwright WebKit", "WebKit"),
      ),
    /display name must remain immutable|Playwright WebKit/u,
  );
});

test("Playwright WebKit engine preflight rejects Chromium flags and support claims", () => {
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace(
          "        run: npm run test:browser:webkit",
          "        run: npm run test:browser:webkit -- --enable-unsafe-webgpu",
        ),
      ),
    /test:browser:webkit|Chromium launch flags/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace(
          "      - name: Run Playwright WebKit engine preflight",
          "      - name: Run Playwright WebKit engine preflight for Safari BRANDED_PASS",
        ),
      ),
    /Safari or branded evidence/u,
  );
});

test("Playwright WebKit ENGINE_PASS artifact uploads only after success", () => {
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace("        if: success()\n", ""),
      ),
    /if: success\(\)/u,
  );
});

test("hosted exact-tarball probe explicitly selects bundled Chromium", () => {
  verifyHostedExactTarballProbeContract(workflowText);
});

test("hosted exact-tarball probe rejects an implicit or branded channel", () => {
  assert.throws(
    () =>
      verifyHostedExactTarballProbeContract(
        workflowText.replace("          FORGE3D_BROWSER_CHANNEL: bundled\n", ""),
      ),
    /FORGE3D_BROWSER_CHANNEL: bundled/u,
  );
  assert.throws(
    () =>
      verifyHostedExactTarballProbeContract(
        workflowText.replace(
          "FORGE3D_BROWSER_CHANNEL: bundled",
          "FORGE3D_BROWSER_CHANNEL: chrome",
        ),
      ),
    /FORGE3D_BROWSER_CHANNEL: bundled/u,
  );
});

test("web workflow verifier rejects renamed, duplicate, missing, and self-hosted checks", () => {
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace(
          "Web Runtime / Browser Preflight",
          "Browser Preflight",
        ),
      ),
    /display name must remain immutable/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace(
          "Web Runtime / Browser Preflight",
          "Web Runtime / Build And Contract Tests",
        ),
      ),
    /display name must remain immutable|duplicate job display name/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace("  pull_request:\n    branches: [main]\n", ""),
      ),
    /triggers must be exactly/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace("runs-on: windows-latest", "runs-on: self-hosted"),
      ),
    /GitHub-hosted/u,
  );
});

test("every external action is immutable and lockfile reviewed", () => {
  const result = verifyWorkflowActionPins();
  assert.ok(result.checkedFiles.includes(".github/workflows/web.yml"));
  assert.ok(result.references.length >= 4);
});

test("action verifier rejects movable, local, unreviewed, and container references", () => {
  assert.throws(
    () => verifyWorkflowText("steps:\n  - uses: actions/checkout@v4\n", "fixture.yml", lockedActions),
    /full lowercase commit SHA/u,
  );
  assert.throws(
    () => verifyWorkflowText("steps:\n  - uses: ./unsafe\n", "fixture.yml", lockedActions),
    /local and docker/u,
  );
  assert.throws(
    () =>
      verifyWorkflowText(
        "steps:\n  - uses: example/unknown@0123456789abcdef0123456789abcdef01234567\n",
        "fixture.yml",
        lockedActions,
      ),
    /not reviewed/u,
  );
  assert.throws(
    () => verifyWorkflowText("jobs:\n  one:\n    container: node:20\n", "fixture.yml", lockedActions),
    /literal sha256 digest/u,
  );
  assert.throws(
    () =>
      verifyWorkflowText(
        "jobs:\n  one:\n    services:\n      redis:\n        image: ${{ inputs.redis_image }}\n",
        "fixture.yml",
        lockedActions,
      ),
    /literal sha256 digest/u,
  );
  assert.throws(
    () =>
      verifyWorkflowText(
        [
          "service: &service",
          "  image: redis:latest",
          "jobs:",
          "  one:",
          "    services:",
          "      redis: *service",
          "",
        ].join("\n"),
        "fixture.yml",
        lockedActions,
      ),
    /YAML aliases are forbidden/u,
  );
});

test("action verifier structurally accepts only digest-pinned job and service images", () => {
  const digest = "a".repeat(64);
  assert.doesNotThrow(() =>
    verifyWorkflowText(
      [
        "jobs:",
        "  one:",
        "    container:",
        `      image: ghcr.io/example/build@sha256:${digest}`,
        "    services:",
        "      redis:",
        `        image: redis@sha256:${digest}`,
        "",
      ].join("\n"),
      "fixture.yml",
      lockedActions,
    ),
  );
});
