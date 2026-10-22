import assert from "node:assert/strict";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, "..", "..");
const workflowPath = join(repositoryRoot, ".github", "workflows", "web.yml");

const requiredJobs = new Map([
  [
    "build-and-contract",
    {
      name: "Web Runtime / Build And Contract Tests",
      needs: null,
      runsOn: "windows-latest",
    },
  ],
  [
    "browser-preflight",
    {
      name: "Web Runtime / Browser Preflight",
      needs: "[build-and-contract, chromium-preflight, firefox-preflight]",
      runsOn: "ubuntu-latest",
    },
  ],
]);

const shardJobs = new Map(["chromium", "firefox"].map((engine) => [
  `${engine}-preflight`,
  { name: `Web Runtime / ${engine[0].toUpperCase()}${engine.slice(1)} Preflight (\${{ matrix.shard }}/4)`,
    needs: "build-and-contract", runsOn: "macos-15" },
]));

const nonBlockingJobs = new Map([
  [
    "webkit-engine-preflight",
    {
      name: "Web Runtime / Playwright WebKit Engine Preflight",
      needs: "build-and-contract",
      runsOn: "macos-latest",
    },
  ],
]);

export function verifyWebWorkflowContract(
  text = readFileSync(workflowPath, "utf8"),
) {
  const parsed = parseWorkflowStructure(text);
  const triggerNames = [...parsed.triggers.keys()].sort();
  if (
    triggerNames.length !== 2 ||
    triggerNames[0] !== "pull_request" ||
    triggerNames[1] !== "push"
  ) {
    throw new Error(
      `web workflow triggers must be exactly pull_request and push, got ${triggerNames.join(", ")}`,
    );
  }
  for (const trigger of triggerNames) {
    const branches = parsed.triggers.get(trigger).branches;
    if (branches.length !== 1 || branches[0] !== "main") {
      throw new Error(`${trigger} must target only main`);
    }
  }

  const expectedJobCount = requiredJobs.size + shardJobs.size + nonBlockingJobs.size;
  if (parsed.jobs.size !== expectedJobCount) {
    throw new Error(
      `web workflow must contain exactly ${expectedJobCount} jobs`,
    );
  }
  const displayNames = new Set();
  for (const [jobId, expected] of [
    ...requiredJobs,
    ...shardJobs,
    ...nonBlockingJobs,
  ]) {
    const job = parsed.jobs.get(jobId);
    if (!job) {
      throw new Error(`web workflow is missing required job ${jobId}`);
    }
    if (job.name !== expected.name) {
      throw new Error(
        `${jobId} display name must remain immutable: ${expected.name}`,
      );
    }
    if (displayNames.has(job.name)) {
      throw new Error(`duplicate job display name: ${job.name}`);
    }
    displayNames.add(job.name);
    if (job.runsOn !== expected.runsOn) {
      throw new Error(
        `${jobId} runner must remain ${expected.runsOn}, got ${job.runsOn ?? "absent"}`,
      );
    }
    if ((job.needs ?? null) !== expected.needs) {
      throw new Error(
        `${jobId} needs must be ${expected.needs ?? "absent"}`,
      );
    }
    const expectedNonBlocking = nonBlockingJobs.has(jobId);
    if ((job.continueOnError === true) !== expectedNonBlocking) {
      throw new Error(
        expectedNonBlocking
          ? `${jobId} must set continue-on-error: true`
          : `${jobId} is an immutable required check and cannot continue on error`,
      );
    }
  }

  verifyShardedBrowserPreflight(text);
  verifyPlaywrightWebKitEnginePreflight(text);
  const jobs = [...parsed.jobs].map(([id, job]) => ({ id, ...job }));
  return {
    triggers: triggerNames,
    jobs,
    requiredChecks: jobs.filter((job) => requiredJobs.has(job.id)),
    nonBlockingChecks: jobs.filter(
      (job) => job.continueOnError === true,
    ),
  };
}

function verifyShardedBrowserPreflight(text) {
  const { jobs } = parse(text);
  const gate = jobs["browser-preflight"];
  assert.equal(gate.if, "always()", "aggregate gate must always run");
  const resultStep = gate.steps.find((step) => step.name === "Require every browser shard and package build to succeed");
  assert.equal(resultStep?.env?.FORGE3D_PREFLIGHT_RESULTS, "${{ toJSON(needs) }}", "aggregate gate must inspect all dependency results");
  assert.equal(resultStep?.run, "node crates/forge3d-web/scripts/verify-browser-preflight-results.mjs", "aggregate gate must fail closed");
  assert.equal(resultStep.if, undefined, "aggregate result check cannot be skipped");
  assert.equal(resultStep["continue-on-error"], undefined, "aggregate result check cannot continue on error");
  const build = jobs["build-and-contract"];
  const upload = build.steps.find((step) => step.name === "Upload shared browser package build");
  assert.equal(upload?.with?.name, "forge3d-web-browser-build-${{ github.sha }}", "shared build must bind to this commit");
  assert.equal(upload?.with?.["if-no-files-found"], "error", "shared build upload must fail if absent");
  assert.deepEqual(upload?.with?.path.trim().split(/\r?\n/u), [
    "pkg", "dist", "assets", "types", "examples/vite/dist", "src-ts/codec-catalog.ts",
    "docs/label-case-contract.json", "LICENSE", "LICENSE-APACHE",
  ].map((path) => `crates/forge3d-web/${path}`), "shared build must include all generated browser inputs");
  const buildIndex = build.steps.findIndex((step) => step.name === "Build browser package");
  assert.equal(build.steps.indexOf(upload), buildIndex + 1, "capture canonical build before consumer scripts mutate outputs");
  for (const engine of ["chromium", "firefox"]) {
    const job = jobs[`${engine}-preflight`];
    assert.deepEqual(job.strategy, { "fail-fast": false, matrix: { shard: [1, 2, 3, 4] } }, "every engine must run all four shards without fail-fast");
    assert.equal(job.if, undefined, "engine matrix cannot be conditionally skipped");
    const script = engine === "chromium" ? "chromium" : "firefox-preflight";
    const run = job.steps.find((step) => step.id === `${engine}-preflight`);
    assert.equal(run?.run, `npm run test:browser:${script} -- --shard=\${{ matrix.shard }}/4 --workers=1`, "engine shard command must be complete and unfiltered");
    assert.equal(run.if, undefined, "full shard run cannot be conditionally skipped");
    assert.equal(run["continue-on-error"], undefined, "engine shard cannot continue on error");
    assert.equal(run.env.FORGE3D_WEBGPU_REQUIRED, "1");
    assert.equal(run.env.FORGE3D_SOURCE_BENCHMARK_MODE, "probe");
    assert.equal(run.env.FORGE3D_W20_STARTUP_RETRY, engine === "chromium" ? "1" : undefined, "W20 retry must remain Chromium-only");
    const evidenceName = engine === "chromium" ? "forge3d-web-source-browser-evidence" : "forge3d-web-firefox-preflight-ENGINE_PASS-default-preferences";
    const evidence = job.steps.find((step) => step.with?.name === `${evidenceName}-\${{ matrix.shard }}`);
    assert.equal(evidence?.with?.path, "crates/forge3d-web/test-results/**/browser-evidence.json", "shards must retain browser evidence");
    const aggregate = gate.steps.find((step) => step.with?.name === evidenceName);
    assert.equal(aggregate?.with?.["if-no-files-found"], "error", "aggregate requires each engine's evidence");
    assert.equal(aggregate?.with?.path, `\${{ runner.temp }}/${engine}-evidence`);
    const collect = gate.steps.find((step) => step.with?.pattern === `${evidenceName}-*`);
    assert.equal(collect?.with?.path, aggregate.with.path, "aggregate must collect every evidence shard");
    assert.equal(collect?.with?.["merge-multiple"], true);
  }
  for (const id of ["chromium-preflight", "firefox-preflight", "webkit-engine-preflight"]) {
    const steps = jobs[id].steps;
    const download = steps.find((step) => step.name === "Download shared browser package build");
    assert.equal(download?.with?.name, upload.with.name, "every engine must reuse this run's package build");
    assert.equal(download?.with?.path, "crates/forge3d-web", "build must restore at package root");
    assert.equal(steps.some((step) => /npm run build|rust-toolchain/u.test(`${step.run ?? ""} ${step.uses ?? ""}`)), false, "browser jobs must not rebuild the shared package");
  }
}

function verifyPlaywrightWebKitEnginePreflight(text) {
  const block = workflowJobBlock(text, "webkit-engine-preflight");
  for (const expected of [
    "name: Web Runtime / Playwright WebKit Engine Preflight",
    "name: Install Playwright WebKit engine",
    "run: npx playwright install webkit",
    "name: Capture expected Playwright WebKit suite inventory",
    "PLAYWRIGHT_JSON_OUTPUT_FILE: ${{ runner.temp }}/forge3d-web-webkit-preflight-expected.json",
    "run: npx playwright test --list --project=webkit-preflight --reporter=json",
    "name: Run Playwright WebKit engine preflight",
    "id: webkit-tests",
    'FORGE3D_WEBGPU_REQUIRED: "1"',
    "FORGE3D_SOURCE_BENCHMARK_MODE: probe",
    "PLAYWRIGHT_JSON_OUTPUT_FILE: test-results/webkit-preflight-actual.json",
    "run: npm run test:browser:webkit -- --reporter=json",
    "name: Classify Playwright WebKit engine preflight",
    "id: classify-webkit",
    "FORGE3D_WEBKIT_EXPECTED_REPORT: ${{ runner.temp }}/forge3d-web-webkit-preflight-expected.json",
    "FORGE3D_WEBKIT_ACTUAL_REPORT: test-results/webkit-preflight-actual.json",
    "FORGE3D_WEBKIT_RAW_OUTCOME: ${{ steps.webkit-tests.outcome }}",
    "run: npm run classify:browser:webkit",
  ]) {
    if (!block.includes(expected)) {
      throw new Error(
        `Playwright WebKit engine preflight must include ${expected}`,
      );
    }
  }
  const browserCommands = block
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\bnpm run test:browser(?:\b|:)/u.test(line));
  if (
    browserCommands.length !== 1 ||
    browserCommands[0] !==
      "run: npm run test:browser:webkit -- --reporter=json,line"
  ) {
    throw new Error(
      "Playwright WebKit engine preflight must select only test:browser:webkit",
    );
  }
  if (block.includes("PLAYWRIGHT_JSON_OUTPUT_NAME")) {
    throw new Error(
      "Playwright 1.56 JSON reports must use PLAYWRIGHT_JSON_OUTPUT_FILE",
    );
  }
  if (
    /--(?:enable-unsafe-webgpu|ignore-gpu-blocklist|enable-vulkan|use-vulkan|use-angle)(?:[=\s]|$)/u.test(
      block,
    )
  ) {
    throw new Error(
      "Playwright WebKit engine preflight cannot use Chromium launch flags",
    );
  }
  if (/\b(?:Safari|BRANDED_PASS|branded)\b/iu.test(block)) {
    throw new Error(
      "Playwright WebKit engine preflight cannot claim Safari or branded evidence",
    );
  }

  const inventoryStep = workflowStepBlock(
    block,
    "Capture expected Playwright WebKit suite inventory",
  );
  const inventoryCommands = inventoryStep
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.includes("npx playwright test "));
  if (
    inventoryCommands.length !== 1 ||
    inventoryCommands[0] !==
      "run: npx playwright test --list --project=webkit-preflight --reporter=json"
  ) {
    throw new Error(
      "Playwright WebKit expected inventory command must be complete and unfiltered",
    );
  }

  const testStep = workflowStepBlock(
    block,
    "Run Playwright WebKit engine preflight",
  );
  for (const expected of [
    "id: webkit-tests",
    "continue-on-error: true",
    "PLAYWRIGHT_JSON_OUTPUT_FILE: test-results/webkit-preflight-actual.json",
    "run: npm run test:browser:webkit -- --reporter=json",
  ]) {
    if (!testStep.includes(expected)) {
      throw new Error(
        `raw Playwright WebKit test step must include ${expected}`,
      );
    }
  }
  const classifierStep = workflowStepBlock(
    block,
    "Classify Playwright WebKit engine preflight",
  );
  for (const expected of [
    "id: classify-webkit",
    "if: always()",
    "FORGE3D_WEBKIT_EXPECTED_REPORT: ${{ runner.temp }}/forge3d-web-webkit-preflight-expected.json",
    "FORGE3D_WEBKIT_ACTUAL_REPORT: test-results/webkit-preflight-actual.json",
    "FORGE3D_WEBKIT_RAW_OUTCOME: ${{ steps.webkit-tests.outcome }}",
    "run: npm run classify:browser:webkit",
  ]) {
    if (!classifierStep.includes(expected)) {
      throw new Error(
        `Playwright WebKit classifier step must include ${expected}`,
      );
    }
  }
  if (classifierStep.includes("continue-on-error: true")) {
    throw new Error(
      "Playwright WebKit classifier step cannot continue on error",
    );
  }

  const uploadStep = workflowStepBlock(
    block,
    "Upload successful Playwright WebKit ENGINE_PASS evidence",
  );
  for (const expected of [
    "if: steps.webkit-tests.outcome == 'success' && steps.classify-webkit.outcome == 'success' && steps.classify-webkit.outputs.engine_pass_eligible == 'true' && steps.classify-webkit.outputs.classification == 'ENGINE_PASS'",
    "uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "name: forge3d-web-playwright-webkit-ENGINE_PASS",
    "path: crates/forge3d-web/test-results",
    "if-no-files-found: error",
  ]) {
    if (!uploadStep.includes(expected)) {
      throw new Error(
        `successful Playwright WebKit ENGINE_PASS upload must include ${expected}`,
      );
    }
  }
  if (uploadStep.includes("if: success()")) {
    throw new Error(
      "Playwright WebKit ENGINE_PASS upload must bind to raw test success",
    );
  }
  const artifactUploads =
    block.match(/\buses: actions\/upload-artifact@/gu) ?? [];
  if (artifactUploads.length !== 1 || /\bNOT_PROVEN\b/u.test(uploadStep)) {
    throw new Error(
      "Playwright WebKit may upload only the raw-success-gated ENGINE_PASS artifact",
    );
  }
}

export function parseWorkflowStructure(text) {
  const topLevel = new Set();
  const triggers = new Map();
  const jobs = new Map();
  let section = null;
  let currentTrigger = null;
  let currentJob = null;

  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    if (rawLine.includes("\t")) {
      throw new Error(`web workflow line ${index + 1} contains a tab`);
    }
    const content = rawLine.replace(/\s+#.*$/u, "").trimEnd();
    if (content.trim() === "" || content.trimStart().startsWith("#")) {
      continue;
    }
    const indent = content.length - content.trimStart().length;
    const trimmed = content.trim();

    if (indent === 0) {
      const key = mappingKey(trimmed, index);
      if (topLevel.has(key)) {
        throw new Error(`duplicate top-level workflow key: ${key}`);
      }
      topLevel.add(key);
      section = key;
      currentTrigger = null;
      currentJob = null;
      continue;
    }

    if (section === "on") {
      if (indent === 2) {
        const key = mappingKey(trimmed, index);
        if (triggers.has(key)) {
          throw new Error(`duplicate workflow trigger: ${key}`);
        }
        triggers.set(key, { branches: [] });
        currentTrigger = key;
      } else if (indent === 4 && currentTrigger) {
        const match = trimmed.match(/^branches:\s*(.+)$/u);
        if (match) {
          triggers.get(currentTrigger).branches = parseInlineArray(match[1]);
        }
      }
      continue;
    }

    if (section === "jobs") {
      if (indent === 2) {
        const key = mappingKey(trimmed, index);
        if (jobs.has(key)) {
          throw new Error(`duplicate workflow job id: ${key}`);
        }
        jobs.set(key, {
          name: null,
          runsOn: null,
          needs: null,
          continueOnError: null,
        });
        currentJob = key;
      } else if (indent === 4 && currentJob) {
        const match = trimmed.match(
          /^(name|runs-on|needs|continue-on-error):\s*(.+)$/u,
        );
        if (match) {
          const property = {
            name: "name",
            "runs-on": "runsOn",
            needs: "needs",
            "continue-on-error": "continueOnError",
          }[match[1]];
          if (jobs.get(currentJob)[property] !== null) {
            throw new Error(`duplicate ${match[1]} in job ${currentJob}`);
          }
          const value = unquote(match[2].trim());
          if (match[1] === "continue-on-error") {
            if (value !== "true" && value !== "false") {
              throw new Error(
                `continue-on-error in job ${currentJob} must be a literal boolean`,
              );
            }
            jobs.get(currentJob)[property] = value === "true";
          } else {
            jobs.get(currentJob)[property] = value;
          }
        }
      }
    }
  }
  return { triggers, jobs };
}

function workflowJobBlock(text, jobId) {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start < 0) {
    throw new Error(`web workflow is missing required job ${jobId}`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function workflowStepBlock(jobBlock, stepName) {
  const lines = jobBlock.split(/\r?\n/u);
  const start = lines.findIndex(
    (line) => line === `      - name: ${stepName}`,
  );
  if (start < 0) {
    throw new Error(`workflow job is missing step ${stepName}`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("      - name:")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function mappingKey(value, index) {
  const match = value.match(/^([A-Za-z0-9_-]+):(?:\s.*)?$/u);
  if (!match) {
    throw new Error(`expected YAML mapping key at line ${index + 1}`);
  }
  return match[1];
}

function parseInlineArray(value) {
  const match = value.match(/^\[(.*)\]$/u);
  if (!match) {
    throw new Error("branch filters must use an explicit inline array");
  }
  return match[1]
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

function unquote(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ ok: true, ...verifyWebWorkflowContract() }, null, 2));
}
