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

function workflowStep(text, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return text.match(
    new RegExp(
      `      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - name:|$)`,
      "u",
    ),
  )?.[0];
}

function workflowJob(text, jobId) {
  const marker = `  ${jobId}:\n`;
  const start = text.indexOf(marker);
  if (start === -1) {
    return undefined;
  }
  const remainderStart = start + marker.length;
  const remainder = text.slice(remainderStart);
  const nextJob = remainder.search(/^  [A-Za-z0-9_-]+:\s*$/mu);
  return nextJob === -1
    ? text.slice(start)
    : text.slice(start, remainderStart + nextJob);
}

function verifyHostedEnginePreflightContract(text) {
  const browserPreflight = workflowJob(text, "browser-preflight");
  assert.ok(browserPreflight, "hosted workflow must define browser-preflight");
  assert.equal(
    browserPreflight.includes("$env:"),
    false,
    "macOS browser-preflight must not use PowerShell $env: syntax",
  );
  for (const expected of [
    'echo "FORGE3D_WEBGPU_REQUIRED=$FORGE3D_WEBGPU_REQUIRED"',
    'echo "FORGE3D_SOURCE_BENCHMARK_MODE=$FORGE3D_SOURCE_BENCHMARK_MODE"',
  ]) {
    assert.ok(
      browserPreflight.includes(expected),
      `macOS browser-preflight diagnostics must include ${expected}`,
    );
  }

  const browserCommands = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\bnpm run test:browser(?:\b|:)/u.test(line));
  assert.deepEqual(
    browserCommands,
    [
      'npm run test:browser:chromium -- --grep "reports browser WebGPU diagnostics"',
      "run: npm run test:browser:chromium",
      'npm run test:browser:firefox-preflight -- --grep "reports browser WebGPU diagnostics"',
      "run: npm run test:browser:firefox-preflight",
    ],
    "hosted source-browser commands must explicitly select the bundled Chromium and Firefox preflights",
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

  const install = workflowStep(
    text,
    "Install bundled Chromium and Firefox for engine preflights",
  );
  assert.ok(install, "hosted workflow must install both bundled engines");
  assert.match(install, /\n        run: npx playwright install chromium firefox\n/u);

  const firefoxDiagnostics = workflowStep(
    text,
    "Print bundled Firefox preflight diagnostics with default preferences",
  );
  assert.ok(
    firefoxDiagnostics,
    "hosted workflow must run explicit default-preference Firefox diagnostics",
  );
  const firefoxRun = workflowStep(
    text,
    "Run bundled Firefox preflight with default preferences (ENGINE_PASS only)",
  );
  assert.ok(
    firefoxRun,
    "hosted workflow must run the unfiltered default-preference Firefox preflight",
  );
  for (const [name, step] of [
    ["diagnostics", firefoxDiagnostics],
    ["full", firefoxRun],
  ]) {
    for (const expected of [
      'FORGE3D_HEADED: "1"',
      'FORGE3D_WEBGPU_REQUIRED: "1"',
      "FORGE3D_SOURCE_BENCHMARK_MODE: probe",
    ]) {
      assert.ok(
        step.includes(expected),
        `Firefox ${name} step must include ${expected}`,
      );
    }
  }
  assert.match(
    firefoxDiagnostics,
    /npm run test:browser:firefox-preflight -- --grep "reports browser WebGPU diagnostics"/u,
  );
  assert.match(
    firefoxRun,
    /\n        run: npm run test:browser:firefox-preflight\n/u,
  );
  for (const expected of [
    "Bundled Playwright Firefox",
    "default preferences",
    "ENGINE_PASS-only",
    "not branded Firefox, physical-browser, or exact-tarball support evidence",
  ]) {
    assert.ok(
      firefoxDiagnostics.includes(expected),
      `hosted Firefox diagnostics must describe ${expected}`,
    );
  }
  assert.equal(
    /dom\.webgpu\.enabled|firefoxUserPrefs|about:config|--pref(?:erence)?\b/u.test(
      `${firefoxDiagnostics}\n${firefoxRun}`,
    ),
    false,
    "default-preference Firefox preflight must not carry a preference override",
  );

  const firefoxUploadName =
    "Upload Firefox preflight ENGINE_PASS default-preferences evidence";
  const firefoxUpload = workflowStep(text, firefoxUploadName);
  assert.ok(
    firefoxUpload,
    "hosted workflow must upload separately labelled Firefox evidence",
  );
  for (const expected of [
    "name: forge3d-web-firefox-preflight-ENGINE_PASS-default-preferences",
    "path: crates/forge3d-web/test-results/**/browser-evidence.json",
    "if-no-files-found: error",
    "retention-days: 30",
  ]) {
    assert.ok(
      firefoxUpload.includes(expected),
      `hosted Firefox evidence upload must include ${expected}`,
    );
  }
  const firefoxRunIndex = text.indexOf(
    "      - name: Run bundled Firefox preflight with default preferences (ENGINE_PASS only)",
  );
  const firefoxUploadIndex = text.indexOf(`      - name: ${firefoxUploadName}`);
  const interveningStep = text.indexOf("\n      - name:", firefoxRunIndex + 1);
  assert.equal(
    interveningStep,
    firefoxUploadIndex - 1,
    "Firefox evidence must upload immediately after the full Firefox run",
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
    contract.jobs.map((job) => job.name).sort(),
    [
      "Web Runtime / Browser Preflight",
      "Web Runtime / Build And Contract Tests",
    ],
  );
});

test("web workflow pins the package job to Windows and source-browser preflight to macOS 15", () => {
  const contract = verifyWebWorkflowContract();
  assert.deepEqual(
    Object.fromEntries(contract.jobs.map((job) => [job.id, job.runsOn])),
    {
      "build-and-contract": "windows-latest",
      "browser-preflight": "macos-15",
    },
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

test("hosted source-browser workflow keeps Chromium and Firefox engine preflights explicit", () => {
  verifyHostedEnginePreflightContract(workflowText);
});

test("hosted source-browser workflow rejects generic invocation and flagged Chrome wording", () => {
  assert.throws(
    () =>
      verifyHostedEnginePreflightContract(
        workflowText.replaceAll(
          "npm run test:browser:chromium",
          "npm run test:browser",
        ),
      ),
    /explicitly select the bundled Chromium and Firefox preflights|ambiguous default script/u,
  );
  assert.throws(
    () =>
      verifyHostedEnginePreflightContract(
        workflowText.replace(
          "Bundled Playwright Chromium is a flagged preflight",
          "Branded Chrome uses --enable-unsafe-webgpu in a flagged preflight",
        ),
      ),
    /Bundled Playwright Chromium|branded Chrome or Edge as using preflight flags/u,
  );
});

test("macOS source-browser diagnostics reject stale PowerShell environment syntax", () => {
  const browserPreflight = workflowJob(workflowText, "browser-preflight");
  assert.ok(browserPreflight);
  assert.throws(
    () =>
      verifyHostedEnginePreflightContract(
        workflowText.replace(
          browserPreflight,
          browserPreflight.replace(
            "$FORGE3D_WEBGPU_REQUIRED",
            "$env:FORGE3D_WEBGPU_REQUIRED",
          ),
        ),
      ),
    /must not use PowerShell \$env: syntax/u,
  );
});

test("hosted Firefox preflight rejects generic commands, preference overrides, and merged evidence", () => {
  assert.throws(
    () =>
      verifyHostedEnginePreflightContract(
        workflowText.replaceAll(
          "npm run test:browser:firefox-preflight",
          "npm run test:browser",
        ),
      ),
    /explicitly select the bundled Chromium and Firefox preflights|ambiguous default script/u,
  );
  assert.throws(
    () =>
      verifyHostedEnginePreflightContract(
        workflowText.replace(
          '          echo "Bundled Playwright Firefox runs with default preferences and can produce ENGINE_PASS-only evidence"',
          '          echo "Bundled Playwright Firefox sets dom.webgpu.enabled=true and can produce ENGINE_PASS-only evidence"',
        ),
      ),
    /default-preference Firefox preflight must not carry a preference override/u,
  );
  assert.throws(
    () =>
      verifyHostedEnginePreflightContract(
        workflowText.replace(
          "name: forge3d-web-firefox-preflight-ENGINE_PASS-default-preferences",
          "name: forge3d-web-source-browser-evidence",
        ),
      ),
    /separately labelled Firefox evidence|forge3d-web-firefox-preflight-ENGINE_PASS-default-preferences/u,
  );
  const firefoxDiagnostics = workflowStep(
    workflowText,
    "Print bundled Firefox preflight diagnostics with default preferences",
  );
  const firefoxRun = workflowStep(
    workflowText,
    "Run bundled Firefox preflight with default preferences (ENGINE_PASS only)",
  );
  assert.ok(firefoxDiagnostics);
  assert.ok(firefoxRun);
  for (const [name, step] of [
    ["diagnostics", firefoxDiagnostics],
    ["full", firefoxRun],
  ]) {
    assert.throws(
      () =>
        verifyHostedEnginePreflightContract(
          workflowText.replace(
            step,
            step.replace('          FORGE3D_HEADED: "1"\n', ""),
          ),
        ),
      new RegExp(`Firefox ${name} step must include FORGE3D_HEADED: "1"`, "u"),
    );
  }
  assert.throws(
    () =>
      verifyHostedEnginePreflightContract(
        workflowText.replace(
          firefoxRun,
          firefoxRun.replace(
            "          FORGE3D_SOURCE_BENCHMARK_MODE: probe\n",
            "",
          ),
        ),
      ),
    /Firefox full step must include FORGE3D_SOURCE_BENCHMARK_MODE: probe/u,
  );
  assert.throws(
    () =>
      verifyHostedEnginePreflightContract(
        workflowText.replace(
          "      - name: Upload Firefox preflight ENGINE_PASS default-preferences evidence",
          [
            "      - name: Intervening Firefox evidence mutation",
            "        run: echo mutation",
            "",
            "      - name: Upload Firefox preflight ENGINE_PASS default-preferences evidence",
          ].join("\n"),
        ),
      ),
    /Firefox evidence must upload immediately after the full Firefox run/u,
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

test("web workflow verifier rejects renamed, duplicate, missing, and runner mutations", () => {
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
    /build-and-contract runner must remain windows-latest/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace("runs-on: macos-15", "runs-on: windows-latest"),
      ),
    /browser-preflight runner must remain macos-15/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace("runs-on: macos-15", "runs-on: self-hosted"),
      ),
    /browser-preflight runner must remain macos-15/u,
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
