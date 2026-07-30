import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertJsonSchema } from "./json-schema-validator.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
export const browserEvidenceSchema = JSON.parse(
  readFileSync(join(directory, "browser-evidence.schema.json"), "utf8"),
);

const EPSILON = 0.000001;
const REQUIRED_INTERACTIONS = [
  "mouse",
  "wheel",
  "touch",
  "keyboard",
  "resize",
  "disposal",
];
const FIREFOX_SOURCE_CLASSIFICATIONS = {
  "firefox-preflight": {
    supportLevel: "ENGINE_PASS",
    preferenceMode: "default",
    preferenceOverrides: {},
  },
  "firefox-nightly-experimental": {
    supportLevel: "NOT_PROVEN",
    preferenceMode: "override",
    preferenceOverrides: { "dom.webgpu.enabled": true },
  },
};

export function validateBrowserEvidence(
  record,
  {
    requireBenchmark = true,
    requireReleaseArtifact = requireBenchmark,
  } = {},
) {
  assertJsonSchema(record, browserEvidenceSchema);
  validateFirefoxSourceClassification(record);

  if (requireReleaseArtifact && record.artifact.kind !== "npm-tarball") {
    throw new Error(
      "required release evidence must identify an exact npm tarball",
    );
  }
  if (requireReleaseArtifact && !record.sourceRevision.worktreeClean) {
    throw new Error(
      "required release evidence must come from a clean exact-HEAD worktree",
    );
  }
  if (requireBenchmark && record.runtimeResult !== "PASS") {
    throw new Error("required release evidence must have runtimeResult PASS");
  }
  if (requireBenchmark && record.benchmark === null) {
    throw new Error("release evidence requires a benchmark object");
  }
  if (requireBenchmark && record.adapter.fallback !== false) {
    throw new Error("required release evidence must use a non-fallback adapter");
  }
  if (record.runtimeResult === "PASS" && !record.secureContext) {
    throw new Error("PASS evidence requires a secure context");
  }
  if (record.runtimeResult === "PASS" && !record.adapter.available) {
    throw new Error("PASS evidence requires an available WebGPU adapter");
  }
  if (record.runtimeResult === "PASS" && record.adapter.fallback !== false) {
    throw new Error("PASS evidence requires a non-fallback adapter");
  }
  if (
    record.runtimeResult === "PASS" &&
    REQUIRED_INTERACTIONS.some(
      (name) => record.interactionAssertions[name] !== true,
    )
  ) {
    throw new Error(
      "PASS evidence requires successful mouse, wheel, touch, keyboard, resize, and disposal assertions",
    );
  }

  if (record.benchmark !== null) {
    validateBenchmark(record.benchmark);
  }
  return record;
}

function validateFirefoxSourceClassification(record) {
  if (!Object.hasOwn(FIREFOX_SOURCE_CLASSIFICATIONS, record.project)) return;
  const expected = FIREFOX_SOURCE_CLASSIFICATIONS[record.project];

  if (
    record.artifact.kind !== "wasm-module" ||
    record.runtimeResult !== "PROBE" ||
    record.browser.name !== "firefox" ||
    record.browser.channel !== "playwright" ||
    record.lane !== "probe" ||
    record.supportLevel !== expected.supportLevel ||
    record.browserPreference?.mode !== expected.preferenceMode ||
    !sameScalarRecord(
      record.browserPreference?.overrides,
      expected.preferenceOverrides,
    )
  ) {
    throw new Error(
      `${record.project} Firefox source-browser evidence classification is missing or inconsistent`,
    );
  }
}

function sameScalarRecord(candidate, expected) {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return false;
  }
  const candidateKeys = Object.keys(candidate);
  const expectedKeys = Object.keys(expected);
  return (
    candidateKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => candidate[key] === expected[key])
  );
}

export function deriveBenchmarkTiming(
  rafTimestampsMs,
  submittedFramesDelta,
) {
  if (!Array.isArray(rafTimestampsMs) || rafTimestampsMs.length !== 601) {
    throw new Error("benchmark requires exactly 601 RAF timestamps");
  }
  const intervals = [];
  for (let index = 1; index < rafTimestampsMs.length; index += 1) {
    const previous = rafTimestampsMs[index - 1];
    const current = rafTimestampsMs[index];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) {
      throw new Error("RAF timestamps must be finite");
    }
    const interval = current - previous;
    if (interval < 0) {
      throw new Error("RAF timestamps must be monotonic");
    }
    intervals.push(interval);
  }

  const measuredDurationMs =
    rafTimestampsMs[rafTimestampsMs.length - 1] - rafTimestampsMs[0];
  if (!(measuredDurationMs > 0)) {
    throw new Error("measured benchmark duration must be positive");
  }
  const sorted = [...intervals].sort((left, right) => left - right);
  const p95Index = Math.ceil(0.95 * sorted.length) - 1;

  return {
    rafIntervalsMs: intervals,
    measuredDurationMs,
    framesPerSecond:
      (submittedFramesDelta * 1000) / measuredDurationMs,
    p95RafIntervalMs: sorted[p95Index],
  };
}

function validateBenchmark(benchmark) {
  const derived = deriveBenchmarkTiming(
    benchmark.rafTimestampsMs,
    benchmark.submittedFramesDelta,
  );

  benchmark.rafIntervalsMs.forEach((supplied, index) => {
    assertClose(
      supplied,
      derived.rafIntervalsMs[index],
      `rafIntervalsMs[${index}]`,
    );
  });
  assertClose(
    benchmark.measuredDurationMs,
    derived.measuredDurationMs,
    "measuredDurationMs",
  );
  assertClose(
    benchmark.framesPerSecond,
    derived.framesPerSecond,
    "framesPerSecond",
  );
  assertClose(
    benchmark.p95RafIntervalMs,
    derived.p95RafIntervalMs,
    "p95RafIntervalMs",
  );

  assertEqual(
    benchmark.submittedFramesAfter - benchmark.submittedFramesBefore,
    benchmark.submittedFramesDelta,
    "submitted frame delta",
  );
  assertEqual(
    benchmark.skippedFramesAfter - benchmark.skippedFramesBefore,
    benchmark.skippedFramesDelta,
    "skipped frame delta",
  );

  const invalidConditions = [
    [benchmark.visibilityStateBefore !== "visible", "page was hidden before benchmark"],
    [benchmark.visibilityStateAfter !== "visible", "page was hidden after benchmark"],
    [!benchmark.documentHasFocusBefore, "document lacked focus before benchmark"],
    [!benchmark.documentHasFocusAfter, "document lacked focus after benchmark"],
    [benchmark.visibilityChangeCount !== 0, "visibility changed during benchmark"],
    [benchmark.windowBlurCount !== 0, "window blurred during benchmark"],
    [benchmark.browserZoomBefore !== 1, "browser zoom was not 1 before benchmark"],
    [benchmark.browserZoomAfter !== 1, "browser zoom was not 1 after benchmark"],
    [benchmark.viewportScaleBefore !== 1, "viewport scale was not 1 before benchmark"],
    [benchmark.viewportScaleAfter !== 1, "viewport scale was not 1 after benchmark"],
  ];
  for (const [invalid, message] of invalidConditions) {
    if (invalid) {
      throw new Error(message);
    }
  }

  const thermal = [benchmark.thermalStateBefore, benchmark.thermalStateAfter];
  if (thermal.includes("serious") || thermal.includes("critical")) {
    throw new Error("known thermal throttling is INFRA_ERROR and must be rerun");
  }
  const lowPower = [
    benchmark.lowPowerModeBefore,
    benchmark.lowPowerModeAfter,
  ];
  if (lowPower.includes(true)) {
    throw new Error("known low-power mode is INFRA_ERROR and must be rerun");
  }
}

function assertClose(actual, expected, name) {
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(expected) ||
    Math.abs(actual - expected) > EPSILON
  ) {
    throw new Error(
      `${name} does not match raw timing: expected ${expected}, got ${actual}`,
    );
  }
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`);
  }
}
