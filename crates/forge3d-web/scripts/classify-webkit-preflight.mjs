import { appendFileSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

const PROJECT = "webkit-preflight";
export const EXPECTED_WEBKIT_CAPABILITY_BOUNDARY =
  "webkit-preflight requires WebGPU but navigator.gpu is missing";

export function classifyWebKitPreflight({
  expectedReport,
  actualReport,
  rawOutcome,
}) {
  if (rawOutcome !== "success" && rawOutcome !== "failure") {
    throw new Error(
      "raw Playwright outcome must be exactly success or failure",
    );
  }
  validateProjectConfiguration(expectedReport, "expected");
  validateProjectConfiguration(actualReport, "actual");
  const expected = collectReportEntries(expectedReport, "listing");
  const actual = collectReportEntries(actualReport, "execution");
  if (
    expected.length !== actual.length ||
    expected.some((entry, index) => entry.key !== actual[index]?.key)
  ) {
    throw new Error(
      "actual Playwright report inventory does not match the expected suite",
    );
  }

  const passed = actual.filter((entry) => entry.outcome === "passed").length;
  const failed = actual.length - passed;
  validateStats(actualReport.stats, {
    expected: passed,
    skipped: 0,
    unexpected: failed,
    flaky: 0,
  });

  if (rawOutcome === "success") {
    if (failed !== 0 || passed !== expected.length) {
      throw new Error(
        "raw Playwright success disagrees with the structured report",
      );
    }
    return {
      classification: "ENGINE_PASS",
      enginePassEligible: true,
      expectedTests: expected.length,
      executedTests: actual.length,
      passedTests: passed,
      failedTests: failed,
    };
  }

  if (failed === 0) {
    throw new Error(
      "raw Playwright failure disagrees with the structured report",
    );
  }
  if (passed !== 0 || failed !== expected.length) {
    throw new Error(
      "NOT_PROVEN requires every expected WebKit test to fail at the capability boundary",
    );
  }
  return {
    classification: "NOT_PROVEN",
    enginePassEligible: false,
    expectedTests: expected.length,
    executedTests: actual.length,
    passedTests: passed,
    failedTests: failed,
  };
}

export function readPlaywrightJsonReport(path, label) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error(`${label} Playwright report path is required`);
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${label} Playwright report is missing`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} Playwright report is malformed`);
  }
}

export function writeWebKitClassification(result, {
  outputPath,
  summaryPath,
}) {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new Error("GITHUB_OUTPUT is required");
  }
  if (typeof summaryPath !== "string" || summaryPath.trim() === "") {
    throw new Error("GITHUB_STEP_SUMMARY is required");
  }
  const output = [
    `classification=${result.classification}`,
    `engine_pass_eligible=${String(result.enginePassEligible)}`,
    `expected_tests=${result.expectedTests}`,
    `executed_tests=${result.executedTests}`,
    `passed_tests=${result.passedTests}`,
    `failed_tests=${result.failedTests}`,
    "",
  ].join("\n");
  appendFileSync(outputPath, output, { encoding: "utf8" });

  const summary =
    result.classification === "ENGINE_PASS"
      ? [
          "## Playwright WebKit engine preflight: ENGINE_PASS",
          "",
          `All ${result.executedTests} expected tests passed.`,
          "",
          "The successful raw suite is eligible for the Playwright WebKit ENGINE_PASS artifact.",
          "",
        ]
      : [
          "## Playwright WebKit engine preflight: NOT_PROVEN",
          "",
          `All ${result.executedTests} expected tests executed; ${result.failedTests} failed only at the required missing-WebGPU capability boundary.`,
          "",
          "No Playwright WebKit ENGINE_PASS artifact is eligible.",
          "",
        ];
  appendFileSync(summaryPath, summary.join("\n"), {
    encoding: "utf8",
  });
}

function validateProjectConfiguration(report, label) {
  if (!isRecord(report)) {
    throw new Error(`${label} Playwright report must be an object`);
  }
  if (!Array.isArray(report.errors) || report.errors.length !== 0) {
    throw new Error(
      `${label} Playwright report contains top-level errors`,
    );
  }
  if (
    !isRecord(report.config) ||
    !Array.isArray(report.config.projects)
  ) {
    throw new Error(
      `${label} Playwright report is missing project configuration`,
    );
  }
  const projects = report.config.projects.filter(
    (project) =>
      isRecord(project) &&
      (project.id === PROJECT || project.name === PROJECT),
  );
  if (projects.length !== 1) {
    throw new Error(
      `${label} Playwright report must contain one ${PROJECT} project`,
    );
  }
  const project = projects[0];
  const metadata = isRecord(project) && isRecord(project.metadata)
    ? project.metadata.forge3dBrowser
    : undefined;
  if (
    !isRecord(project) ||
    project.id !== PROJECT ||
    project.name !== PROJECT ||
    !hasExpectedWebKitProjectMetadata(metadata)
  ) {
    throw new Error(
      `${label} Playwright report has inconsistent WebKit project metadata`,
    );
  }
}

function collectReportEntries(report, mode) {
  if (!Array.isArray(report.suites)) {
    throw new Error("Playwright report suites must be an array");
  }
  const entries = [];
  for (const suite of report.suites) {
    collectSuiteEntries(suite, mode, entries);
  }
  if (entries.length === 0) {
    throw new Error("Playwright report must contain at least one test");
  }
  entries.sort((left, right) => left.key.localeCompare(right.key));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].key === entries[index].key) {
      throw new Error("Playwright report contains duplicate test entries");
    }
  }
  if (mode === "listing") {
    validateStats(report.stats, {
      expected: 0,
      skipped: entries.length,
      unexpected: 0,
      flaky: 0,
    });
  }
  return entries;
}

function collectSuiteEntries(suite, mode, entries) {
  if (!isRecord(suite)) {
    throw new Error("Playwright report suite is malformed");
  }
  if (suite.suites !== undefined) {
    if (!Array.isArray(suite.suites)) {
      throw new Error("Playwright nested suites must be an array");
    }
    for (const child of suite.suites) {
      collectSuiteEntries(child, mode, entries);
    }
  }
  if (suite.specs !== undefined) {
    if (!Array.isArray(suite.specs)) {
      throw new Error("Playwright report specs must be an array");
    }
    for (const spec of suite.specs) {
      entries.push(collectSpecEntry(spec, mode));
    }
  }
}

function collectSpecEntry(spec, mode) {
  if (
    !isRecord(spec) ||
    typeof spec.id !== "string" ||
    spec.id === "" ||
    typeof spec.file !== "string" ||
    spec.file === "" ||
    typeof spec.title !== "string" ||
    spec.title === "" ||
    !Number.isInteger(spec.line) ||
    !Number.isInteger(spec.column) ||
    typeof spec.ok !== "boolean" ||
    !Array.isArray(spec.tests) ||
    spec.tests.length !== 1
  ) {
    throw new Error("Playwright report spec is malformed");
  }
  const test = spec.tests[0];
  if (
    !isRecord(test) ||
    test.projectId !== PROJECT ||
    test.projectName !== PROJECT ||
    test.expectedStatus !== "passed" ||
    !Array.isArray(test.results)
  ) {
    throw new Error("Playwright report test identity is malformed");
  }
  const key = JSON.stringify([
    spec.id,
    spec.file,
    spec.line,
    spec.column,
    spec.title,
    test.projectId,
  ]);
  if (mode === "listing") {
    if (
      spec.ok !== true ||
      test.status !== "skipped" ||
      test.results.length !== 0
    ) {
      throw new Error(
        "expected Playwright suite inventory is not a list report",
      );
    }
    return { key, outcome: "listed" };
  }
  if (test.results.length !== 1) {
    throw new Error(
      "actual Playwright report must contain one result per test",
    );
  }
  const result = test.results[0];
  if (!isRecord(result)) {
    throw new Error("Playwright test result is malformed");
  }
  if (
    spec.ok === true &&
    result.status === "passed" &&
    test.status === "expected"
  ) {
    if (collectErrorDiagnostics(result).length !== 0) {
      throw new Error(
        "passed Playwright result unexpectedly contains errors",
      );
    }
    return { key, outcome: "passed" };
  }
  if (
    spec.ok === false &&
    result.status === "failed" &&
    test.status === "unexpected"
  ) {
    validateCapabilityBoundaryResult(result);
    return { key, outcome: "failed" };
  }
  throw new Error(
    "actual Playwright report contains an incomplete or unsupported result",
  );
}

function validateCapabilityBoundaryResult(result) {
  if (result.retry !== 0) {
    throw new Error(
      "Playwright WebKit capability failure must be from retry zero",
    );
  }
  const diagnostics = collectErrorDiagnostics(result);
  if (
    diagnostics.length === 0 ||
    diagnostics.length > 2 ||
    !Array.isArray(result.errors) ||
    result.errors.length !== 1
  ) {
    throw new Error(
      "Playwright WebKit report contains unexpected failure diagnostics",
    );
  }
  const expectedPrefix = `Error: ${EXPECTED_WEBKIT_CAPABILITY_BOUNDARY}`;
  for (const diagnostic of diagnostics) {
    const firstLine = diagnostic.message.split(/\r?\n/u, 1)[0];
    const path = diagnostic.location.file.replaceAll("\\", "/");
    if (
      firstLine !== expectedPrefix ||
      !/(?:^|\/)tests\/browser\/webgpu-fixture\.ts$/u.test(path)
    ) {
      throw new Error(
        "Playwright WebKit report contains an unexpected failure",
      );
    }
  }
  validateCapabilityProbe(result.attachments);
}

function collectErrorDiagnostics(result) {
  const errors = [];
  if (result.error !== undefined) {
    errors.push(result.error);
  }
  if (result.errors !== undefined) {
    if (!Array.isArray(result.errors)) {
      throw new Error("Playwright result errors must be an array");
    }
    errors.push(...result.errors);
  }
  return errors.map((error) => {
    if (
      !isRecord(error) ||
      typeof error.message !== "string" ||
      error.message === "" ||
      !isRecord(error.location) ||
      typeof error.location.file !== "string" ||
      error.location.file === ""
    ) {
      throw new Error("Playwright result error is malformed");
    }
    return {
      message: error.message,
      location: error.location,
    };
  });
}

function validateCapabilityProbe(attachments) {
  if (!Array.isArray(attachments)) {
    throw new Error("Playwright WebKit result attachments are missing");
  }
  const probes = attachments.filter(
    (attachment) =>
      isRecord(attachment) &&
      attachment.name === "forge3d-webgpu-probe.json",
  );
  if (probes.length !== 1) {
    throw new Error(
      "Playwright WebKit result must contain one WebGPU probe attachment",
    );
  }
  const attachment = probes[0];
  if (
    attachment.contentType !== "application/json" ||
    typeof attachment.body !== "string" ||
    attachment.body === "" ||
    attachment.path !== undefined ||
    !isCanonicalBase64(attachment.body)
  ) {
    throw new Error(
      "Playwright WebKit WebGPU probe attachment is malformed",
    );
  }
  let probe;
  try {
    probe = JSON.parse(
      Buffer.from(attachment.body, "base64").toString("utf8"),
    );
  } catch {
    throw new Error(
      "Playwright WebKit WebGPU probe attachment is malformed",
    );
  }
  if (
    !isRecord(probe) ||
    !hasExpectedWebKitProjectMetadata(probe.project) ||
    probe.required !== true ||
    probe.secureContext !== true ||
    probe.hasNavigatorGpu !== false ||
    probe.adapterAvailable !== false
  ) {
    throw new Error(
      "Playwright WebKit WebGPU probe does not prove the required capability boundary",
    );
  }
}

function hasExpectedWebKitProjectMetadata(metadata) {
  return (
    isRecord(metadata) &&
    metadata.project === PROJECT &&
    metadata.browserName === "webkit" &&
    metadata.channel === "playwright" &&
    metadata.lane === "preflight" &&
    metadata.launchObservation === "project-configuration" &&
    metadata.webgpuRequired === true &&
    Array.isArray(metadata.launchArgs) &&
    metadata.launchArgs.length === 0
  );
}

function isCanonicalBase64(value) {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function validateStats(stats, expected) {
  if (!isRecord(stats)) {
    throw new Error("Playwright report stats are missing");
  }
  for (const [field, value] of Object.entries(expected)) {
    if (!Number.isInteger(stats[field]) || stats[field] !== value) {
      throw new Error(`Playwright report stats.${field} is inconsistent`);
    }
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function runCli() {
  const result = classifyWebKitPreflight({
    expectedReport: readPlaywrightJsonReport(
      process.env.FORGE3D_WEBKIT_EXPECTED_REPORT,
      "expected",
    ),
    actualReport: readPlaywrightJsonReport(
      process.env.FORGE3D_WEBKIT_ACTUAL_REPORT,
      "actual",
    ),
    rawOutcome: process.env.FORGE3D_WEBKIT_RAW_OUTCOME,
  });
  writeWebKitClassification(result, {
    outputPath: process.env.GITHUB_OUTPUT,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(
      `Playwright WebKit classification failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    process.exitCode = 1;
  }
}
