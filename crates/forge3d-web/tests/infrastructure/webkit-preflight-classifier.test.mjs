import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_WEBKIT_CAPABILITY_BOUNDARY,
  classifyWebKitPreflight,
  writeWebKitClassification,
} from "../../scripts/classify-webkit-preflight.mjs";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const project = {
  id: "webkit-preflight",
  name: "webkit-preflight",
  metadata: {
    forge3dBrowser: {
      project: "webkit-preflight",
      browserName: "webkit",
      channel: "playwright",
      lane: "preflight",
      launchObservation: "project-configuration",
      webgpuRequired: true,
      launchArgs: [],
    },
  },
};
const expectedTests = [
  {
    id: "id-a",
    file: "a.spec.ts",
    line: 1,
    column: 1,
    title: "first test",
  },
  {
    id: "id-b",
    file: "b.spec.ts",
    line: 2,
    column: 1,
    title: "second test",
  },
];

test("raw success and a complete passing report are ENGINE_PASS eligible", () => {
  const result = classifyWebKitPreflight({
    expectedReport: listReport(),
    actualReport: executionReport(["passed", "passed"]),
    rawOutcome: "success",
  });
  assert.deepEqual(result, {
    classification: "ENGINE_PASS",
    enginePassEligible: true,
    expectedTests: 2,
    executedTests: 2,
    passedTests: 2,
    failedTests: 0,
  });
});

test("only exact missing-WebGPU failures classify as NOT_PROVEN", () => {
  const result = classifyWebKitPreflight({
    expectedReport: listReport(),
    actualReport: executionReport(["capability", "capability"]),
    rawOutcome: "failure",
  });
  assert.deepEqual(result, {
    classification: "NOT_PROVEN",
    enginePassEligible: false,
    expectedTests: 2,
    executedTests: 2,
    passedTests: 0,
    failedTests: 2,
  });
});

test("a partial pass plus a capability failure cannot classify as NOT_PROVEN", () => {
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: executionReport(["passed", "capability"]),
        rawOutcome: "failure",
      }),
    /requires every expected WebKit test to fail/u,
  );
});

test("zero, fewer, extra, duplicate, or incomplete tests fail closed", () => {
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport([]),
        actualReport: executionReport([]),
        rawOutcome: "failure",
      }),
    /at least one test/u,
  );
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: executionReport(["capability"], expectedTests.slice(0, 1)),
        rawOutcome: "failure",
      }),
    /inventory does not match/u,
  );
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: executionReport(
          ["capability", "capability", "capability"],
          [
            ...expectedTests,
            {
              id: "id-c",
              file: "c.spec.ts",
              line: 3,
              column: 1,
              title: "extra test",
            },
          ],
        ),
        rawOutcome: "failure",
      }),
    /inventory does not match/u,
  );
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport([
          expectedTests[0],
          expectedTests[0],
        ]),
        actualReport: executionReport(
          ["capability", "capability"],
          [expectedTests[0], expectedTests[0]],
        ),
        rawOutcome: "failure",
      }),
    /duplicate test entries/u,
  );
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: executionReport(["capability", "skipped"]),
        rawOutcome: "failure",
      }),
    /one result per test/u,
  );
});

test("unexpected or mixed failures fail closed", () => {
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: executionReport(["capability", "unexpected"]),
        rawOutcome: "failure",
      }),
    /unexpected failure/u,
  );
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: executionReport(["capability", "mixed"]),
        rawOutcome: "failure",
      }),
    /unexpected failure/u,
  );
});

test("retries and non-fixture error locations fail closed", () => {
  const retried = executionReport(["capability", "capability"]);
  firstResult(retried).retry = 1;
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: retried,
        rawOutcome: "failure",
      }),
    /retry zero/u,
  );

  const wrongLocation = executionReport(["capability", "capability"]);
  firstResult(wrongLocation).error.location.file =
    "/repo/tests/playwright/terrain.spec.ts";
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: wrongLocation,
        rawOutcome: "failure",
      }),
    /unexpected failure/u,
  );
});

test("missing, duplicate, or malformed WebGPU probe attachments fail closed", () => {
  const missing = executionReport(["capability", "capability"]);
  firstResult(missing).attachments = [];
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: missing,
        rawOutcome: "failure",
      }),
    /one WebGPU probe attachment/u,
  );

  const duplicate = executionReport(["capability", "capability"]);
  const duplicateResult = firstResult(duplicate);
  duplicateResult.attachments.push(
    structuredClone(duplicateResult.attachments[0]),
  );
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: duplicate,
        rawOutcome: "failure",
      }),
    /one WebGPU probe attachment/u,
  );

  const malformed = executionReport(["capability", "capability"]);
  firstResult(malformed).attachments[0].body = "not-base64";
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: malformed,
        rawOutcome: "failure",
      }),
    /probe attachment is malformed/u,
  );
});

test("a WebGPU probe with the wrong capability facts fails closed", () => {
  const wrongProbe = executionReport(["capability", "capability"]);
  const attachment = firstResult(wrongProbe).attachments[0];
  const probe = JSON.parse(
    Buffer.from(attachment.body, "base64").toString("utf8"),
  );
  probe.hasNavigatorGpu = true;
  attachment.body = Buffer.from(JSON.stringify(probe), "utf8").toString(
    "base64",
  );
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: wrongProbe,
        rawOutcome: "failure",
      }),
    /does not prove the required capability boundary/u,
  );
});

test("report stats disagreement fails closed", () => {
  const mismatched = executionReport(["capability", "capability"]);
  mismatched.stats.unexpected = 1;
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: mismatched,
        rawOutcome: "failure",
      }),
    /stats\.unexpected is inconsistent/u,
  );
});

test("raw outcome and report disagreement fails closed", () => {
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: executionReport(["passed", "capability"]),
        rawOutcome: "success",
      }),
    /success disagrees/u,
  );
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: executionReport(["passed", "passed"]),
        rawOutcome: "failure",
      }),
    /failure disagrees/u,
  );
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: executionReport(["passed", "passed"]),
        rawOutcome: "cancelled",
      }),
    /exactly success or failure/u,
  );
});

test("malformed reports, top-level errors, and project drift fail closed", () => {
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: {},
        actualReport: executionReport(["passed", "passed"]),
        rawOutcome: "success",
      }),
    /top-level errors|project configuration/u,
  );
  const withTopLevelError = executionReport(["passed", "passed"]);
  withTopLevelError.errors.push({ message: "global failure" });
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: withTopLevelError,
        rawOutcome: "success",
      }),
    /top-level errors/u,
  );
  const flagged = executionReport(["passed", "passed"]);
  flagged.config.projects[0].metadata.forge3dBrowser.launchArgs.push(
    "--enable-unsafe-webgpu",
  );
  assert.throws(
    () =>
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: flagged,
        rawOutcome: "success",
      }),
    /inconsistent WebKit project metadata/u,
  );
});

test("classification outputs and summaries contain only bounded results", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-webkit-classifier-"));
  try {
    const output = join(directory, "output");
    const summary = join(directory, "summary");
    writeWebKitClassification(
      classifyWebKitPreflight({
        expectedReport: listReport(),
        actualReport: executionReport(["capability", "capability"]),
        rawOutcome: "failure",
      }),
      { outputPath: output, summaryPath: summary },
    );
    assert.equal(
      readFileSync(output, "utf8"),
      [
        "classification=NOT_PROVEN",
        "engine_pass_eligible=false",
        "expected_tests=2",
        "executed_tests=2",
        "passed_tests=0",
        "failed_tests=2",
        "",
      ].join("\n"),
    );
    assert.match(readFileSync(summary, "utf8"), /NOT_PROVEN/u);
    assert.doesNotMatch(
      readFileSync(summary, "utf8"),
      /--enable-unsafe-webgpu|stack|secret/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every Playwright spec uses the automatic shared WebGPU guard", () => {
  const directory = join(packageRoot, "tests", "playwright");
  const specs = readdirSync(directory)
    .filter((name) => name.endsWith(".spec.ts"))
    .sort();
  assert.equal(specs.length, 12);
  for (const name of specs) {
    const text = readFileSync(join(directory, name), "utf8");
    assert.equal(
      text.includes('from "@playwright/test"'),
      false,
      `${name} bypasses the shared WebGPU fixture`,
    );
    assert.equal(
      text.includes('from "../browser/webgpu-fixture"'),
      true,
      `${name} does not use the automatic shared WebGPU guard`,
    );
  }
});

function listReport(tests = expectedTests) {
  return report(
    tests,
    tests.map(() => "listed"),
  );
}

function executionReport(outcomes, tests = expectedTests) {
  return report(tests, outcomes);
}

function report(tests, outcomes) {
  const listing = outcomes.every((outcome) => outcome === "listed");
  const passed = outcomes.filter((outcome) => outcome === "passed").length;
  const failed = outcomes.filter(
    (outcome) =>
      outcome === "capability" ||
      outcome === "unexpected" ||
      outcome === "mixed",
  ).length;
  const skipped = outcomes.filter(
    (outcome) => outcome === "listed" || outcome === "skipped",
  ).length;
  return {
    config: { projects: [structuredClone(project)] },
    suites: tests.map((entry, index) => ({
      title: entry.file,
      file: entry.file,
      specs: [
        {
          ...entry,
          ok: outcomes[index] === "passed" || listing,
          tests: [testResult(outcomes[index])],
        },
      ],
    })),
    errors: [],
    stats: {
      expected: passed,
      skipped,
      unexpected: failed,
      flaky: 0,
    },
  };
}

function testResult(outcome) {
  const base = {
    expectedStatus: "passed",
    projectId: "webkit-preflight",
    projectName: "webkit-preflight",
  };
  if (outcome === "listed") {
    return { ...base, results: [], status: "skipped" };
  }
  if (outcome === "passed") {
    return {
      ...base,
      results: [{ status: "passed", retry: 0, errors: [] }],
      status: "expected",
    };
  }
  if (outcome === "skipped") {
    return { ...base, results: [], status: "skipped" };
  }
  const expectedError = {
    location: {
      file: "/repo/crates/forge3d-web/tests/browser/webgpu-fixture.ts",
      column: 9,
      line: 120,
    },
    message: `Error: ${EXPECTED_WEBKIT_CAPABILITY_BOUNDARY}\n\nExpected: true\nReceived: false`,
    stack: `Error: ${EXPECTED_WEBKIT_CAPABILITY_BOUNDARY}`,
  };
  const unexpectedError = {
    location: {
      file: "/repo/crates/forge3d-web/tests/browser/webgpu-fixture.ts",
      column: 9,
      line: 120,
    },
    message: "renderer crashed unexpectedly",
    stack: "Error: renderer crashed unexpectedly",
  };
  const errors =
    outcome === "capability"
      ? [expectedError]
      : outcome === "mixed"
        ? [expectedError, unexpectedError]
        : [unexpectedError];
  return {
    ...base,
    results: [
      {
        status: "failed",
        retry: 0,
        error: structuredClone(errors[0]),
        errors,
        attachments: [probeAttachment()],
      },
    ],
    status: "unexpected",
  };
}

function probeAttachment() {
  const probe = {
    project: structuredClone(project.metadata.forge3dBrowser),
    projectPolicyRequired: true,
    ambientRequired: true,
    required: true,
    hasNavigatorGpu: false,
    adapterAvailable: false,
    secureContext: true,
    userAgent: "fixture user agent",
  };
  return {
    name: "forge3d-webgpu-probe.json",
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(probe), "utf8").toString("base64"),
  };
}

function firstResult(report) {
  return report.suites[0].specs[0].tests[0].results[0];
}
