import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveBenchmarkTiming,
  validateBrowserEvidence,
} from "./evidence-validator.mjs";

test("validates a complete record and recomputes index-569 p95/FPS", () => {
  const record = makeRecord();
  assert.equal(validateBrowserEvidence(record), record);

  const sorted = [...record.benchmark.rafIntervalsMs].sort((a, b) => a - b);
  assert.equal(record.benchmark.p95RafIntervalMs, sorted[569]);
  assert.equal(
    record.benchmark.framesPerSecond,
    (600 * 1000) / record.benchmark.measuredDurationMs,
  );
});

test("keeps optional Firefox classification fields backward-compatible", () => {
  const record = makeRecord();
  assert.equal("supportLevel" in record, false);
  assert.equal("browserPreference" in record, false);
  assert.equal(validateBrowserEvidence(record), record);
});

test("rejects null browser preference override scalars", () => {
  const record = makeRecord();
  record.supportLevel = "NOT_PROVEN";
  record.browserPreference = {
    mode: "override",
    overrides: {
      "dom.webgpu.enabled": null,
    },
  };
  assert.throws(
    () => validateBrowserEvidence(record),
    /expected type string\|number\|boolean/,
  );
});

for (const project of [
  "firefox-preflight",
  "firefox-nightly-experimental",
]) {
  test(`validates exact ${project} source-browser classification`, () => {
    const record = makeFirefoxRecord(project);
    assert.equal(validateFirefoxRecord(record), record);
  });
}

for (const [name, project, mutate] of [
  [
    "missing preflight support level",
    "firefox-preflight",
    (record) => {
      delete record.supportLevel;
    },
  ],
  [
    "missing preflight preference label",
    "firefox-preflight",
    (record) => {
      delete record.browserPreference;
    },
  ],
  [
    "preflight branded support level",
    "firefox-preflight",
    (record) => {
      record.supportLevel = "BRANDED_PASS";
    },
  ],
  [
    "preflight exact-tarball artifact",
    "firefox-preflight",
    (record) => {
      record.artifact.kind = "npm-tarball";
    },
  ],
  [
    "preflight PASS result",
    "firefox-preflight",
    (record) => {
      record.runtimeResult = "PASS";
    },
  ],
  [
    "preflight override mode",
    "firefox-preflight",
    (record) => {
      record.browserPreference.mode = "override";
    },
  ],
  [
    "preflight preference override",
    "firefox-preflight",
    (record) => {
      record.browserPreference.overrides["dom.webgpu.enabled"] = true;
    },
  ],
  [
    "experimental engine support level",
    "firefox-nightly-experimental",
    (record) => {
      record.supportLevel = "ENGINE_PASS";
    },
  ],
  [
    "experimental exact-tarball artifact",
    "firefox-nightly-experimental",
    (record) => {
      record.artifact.kind = "npm-tarball";
    },
  ],
  [
    "experimental PASS result",
    "firefox-nightly-experimental",
    (record) => {
      record.runtimeResult = "PASS";
    },
  ],
  [
    "experimental default mode",
    "firefox-nightly-experimental",
    (record) => {
      record.browserPreference.mode = "default";
    },
  ],
  [
    "experimental missing WebGPU override",
    "firefox-nightly-experimental",
    (record) => {
      record.browserPreference.overrides = {};
    },
  ],
  [
    "experimental false WebGPU override",
    "firefox-nightly-experimental",
    (record) => {
      record.browserPreference.overrides["dom.webgpu.enabled"] = false;
    },
  ],
  [
    "experimental extra preference override",
    "firefox-nightly-experimental",
    (record) => {
      record.browserPreference.overrides["some.other.preference"] = true;
    },
  ],
  [
    "Firefox project with Chromium identity",
    "firefox-preflight",
    (record) => {
      record.browser.name = "chromium";
    },
  ],
  [
    "Firefox project with branded channel",
    "firefox-preflight",
    (record) => {
      record.browser.channel = "firefox";
    },
  ],
  [
    "Firefox project with required lane",
    "firefox-preflight",
    (record) => {
      record.lane = "required";
    },
  ],
]) {
  test(`rejects ${name}`, () => {
    const record = makeFirefoxRecord(project);
    mutate(record);
    assert.throws(
      () => validateFirefoxRecord(record),
      /Firefox source-browser evidence classification is missing or inconsistent/,
    );
  });
}

test("retains a 500-ms stall in duration and raw intervals", () => {
  const record = makeRecord({ stallIndex: 300 });
  assert.equal(record.benchmark.rafIntervalsMs[300], 500);
  assert.ok(
    Math.abs(
      record.benchmark.measuredDurationMs -
        (record.benchmark.rafTimestampsMs[600] -
          record.benchmark.rafTimestampsMs[0]),
    ) < 0.000001,
  );
  assert.ok(
    record.benchmark.measuredDurationMs > 10_400,
    "duration must retain the raw stall",
  );
  assert.ok(record.benchmark.framesPerSecond < 60);
  assert.equal(validateBrowserEvidence(record), record);
});

for (const [name, mutate, message] of [
  [
    "skipped frame",
    (record) => {
      record.benchmark.skippedFramesAfter = 1;
      record.benchmark.skippedFramesDelta = 1;
    },
    /constant 0/,
  ],
  [
    "dropped trace sample",
    (record) => {
      record.benchmark.traceSamplesApplied = 599;
    },
    /constant 600/,
  ],
  [
    "background transition",
    (record) => {
      record.benchmark.visibilityChangeCount = 1;
    },
    /visibility changed/,
  ],
  [
    "known thermal throttle",
    (record) => {
      record.benchmark.thermalStateAfter = "serious";
    },
    /thermal throttling/,
  ],
  [
    "known low-power mode",
    (record) => {
      record.benchmark.lowPowerModeBefore = true;
    },
    /low-power mode/,
  ],
]) {
  test(`fails closed for ${name}`, () => {
    const record = makeRecord();
    mutate(record);
    assert.throws(() => validateBrowserEvidence(record), message);
  });
}

test("rejects supplied derived values that disagree with raw timing", () => {
  const record = makeRecord();
  record.benchmark.rafIntervalsMs[569] += 0.01;
  assert.throws(
    () => validateBrowserEvidence(record),
    /does not match raw timing/,
  );
});

test("PASS evidence rejects observed viewer or validation errors", () => {
  const record = makeRecord();
  record.normalizedErrorCodes = ["INTERNAL_ERROR"];
  assert.throws(
    () => validateBrowserEvidence(record),
    /observed error-free interaction run/,
  );
});

test("probe evidence may omit benchmark but cannot satisfy a required lane", () => {
  const record = makeRecord();
  record.runtimeResult = "PROBE";
  record.adapter.available = false;
  record.normalizedErrorCodes = ["INTERNAL_ERROR"];
  record.benchmark = null;
  assert.equal(
    validateBrowserEvidence(record, { requireBenchmark: false }),
    record,
  );
  assert.throws(
    () => validateBrowserEvidence(record),
    /runtimeResult PASS/,
  );
});

for (const runtimeResult of ["PROBE", "FAIL", "INFRA_ERROR"]) {
  test(`required evidence rejects ${runtimeResult} even with benchmark data`, () => {
    const record = makeRecord();
    record.runtimeResult = runtimeResult;
    assert.throws(
      () => validateBrowserEvidence(record),
      /runtimeResult PASS/,
    );
  });
}

test("required evidence rejects a fallback adapter", () => {
  const record = makeRecord();
  record.adapter.fallback = true;
  assert.throws(
    () => validateBrowserEvidence(record),
    /non-fallback adapter/,
  );
});

test("required release evidence rejects a source WASM digest", () => {
  const record = makeRecord();
  record.artifact.kind = "wasm-module";
  assert.throws(
    () => validateBrowserEvidence(record),
    /exact npm tarball/,
  );
  assert.equal(
    validateBrowserEvidence(record, { requireReleaseArtifact: false }),
    record,
  );
});

test("required release evidence rejects a dirty source revision", () => {
  const record = makeRecord();
  record.sourceRevision.worktreeClean = false;
  assert.throws(
    () => validateBrowserEvidence(record),
    /clean exact-HEAD worktree/,
  );
  assert.equal(
    validateBrowserEvidence(record, { requireReleaseArtifact: false }),
    record,
  );
});

for (const interaction of [
  "mouse",
  "wheel",
  "touch",
  "keyboard",
  "resize",
  "disposal",
]) {
  test(`PASS evidence requires the ${interaction} interaction`, () => {
    const missing = makeRecord();
    delete missing.interactionAssertions[interaction];
    assert.throws(
      () => validateBrowserEvidence(missing),
      new RegExp(`${interaction}.*required property|requires successful`),
    );

    const failed = makeRecord();
    failed.interactionAssertions[interaction] = false;
    assert.throws(
      () => validateBrowserEvidence(failed),
      /requires successful/,
    );
  });
}

function makeFirefoxRecord(project) {
  const record = makeRecord();
  record.artifact.kind = "wasm-module";
  record.project = project;
  record.lane = "probe";
  record.browser.name = "firefox";
  record.browser.channel = "playwright";
  record.runtimeResult = "PROBE";
  record.benchmark = null;

  if (project === "firefox-preflight") {
    record.supportLevel = "ENGINE_PASS";
    record.browserPreference = {
      mode: "default",
      overrides: {},
    };
  } else {
    record.supportLevel = "NOT_PROVEN";
    record.browserPreference = {
      mode: "override",
      overrides: {
        "dom.webgpu.enabled": true,
      },
    };
  }
  return record;
}

function validateFirefoxRecord(record) {
  return validateBrowserEvidence(record, {
    requireBenchmark: false,
    requireReleaseArtifact: false,
  });
}

function makeRecord({ stallIndex } = {}) {
  const intervals = Array.from({ length: 600 }, () => 1000 / 60);
  if (stallIndex !== undefined) {
    intervals[stallIndex] = 500;
  }
  const timestamps = [10_000];
  for (const interval of intervals) {
    timestamps.push(timestamps.at(-1) + interval);
  }
  const derived = deriveBenchmarkTiming(timestamps, 600);

  return {
    schemaVersion: 3,
    sourceRevision: {
      commit: "0123456789abcdef0123456789abcdef01234567",
      worktreeClean: true,
    },
    artifact: {
      kind: "npm-tarball",
      sha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    project: "shared-project",
    lane: "required",
    browser: {
      name: "browser",
      version: "1.0",
      channel: "stable",
      userAgent: "synthetic user agent",
    },
    os: { name: "SyntheticOS", version: "1", build: "1A" },
    architecture: "x86_64",
    deviceId: "synthetic-device",
    headed: true,
    secureContext: true,
    launchArguments: [],
    adapter: {
      available: true,
      fallback: false,
      identity: null,
      limits: {
        maxTextureDimension2D: 8192,
        maxBufferSize: 268435456,
      },
    },
    runtimeResult: "PASS",
    frameCounters: {
      renderRequests: 600,
      submittedFrames: 600,
      skippedFrames: 0,
    },
    interactionAssertions: {
      mouse: true,
      wheel: true,
      touch: true,
      keyboard: true,
      resize: true,
      disposal: true,
    },
    normalizedErrorCodes: [],
    benchmark: {
      id: "forge3d-viewer-benchmark-v1",
      manifestSha256:
        "17493b8dc4ca3f1c43b7dc9ffbe50400d0980de20d6bb3c6a564f457eb4c6a4f",
      terrainSha256:
        "f7ac944a3dc3736384f1082bec5f850b45d88c36ca675e9c543d945d8741e5c6",
      traceSha256:
        "bcef9611960ee1b0f25be529d416135ca65ec2d0571049eca1b282e6e9ad905d",
      canvasCssWidth: 320,
      canvasCssHeight: 320,
      backingWidth: 640,
      backingHeight: 640,
      devicePixelRatio: 2,
      browserZoomBefore: 1,
      browserZoomAfter: 1,
      viewportScaleBefore: 1,
      viewportScaleAfter: 1,
      traceVersion: 1,
      visibilityStateBefore: "visible",
      visibilityStateAfter: "visible",
      documentHasFocusBefore: true,
      documentHasFocusAfter: true,
      visibilityChangeCount: 0,
      windowBlurCount: 0,
      thermalStateBefore: "unavailable",
      thermalStateAfter: "unavailable",
      thermalSignalProvenance: "browser API unavailable",
      lowPowerModeBefore: "unavailable",
      lowPowerModeAfter: "unavailable",
      lowPowerSignalProvenance: "browser API unavailable",
      warmupSamples: 120,
      measurementSamples: 600,
      rafTimestampsMs: timestamps,
      rafIntervalsMs: derived.rafIntervalsMs,
      traceSamplesApplied: 600,
      catchUpSamples: 0,
      submittedFramesBefore: 100,
      submittedFramesAfter: 700,
      submittedFramesDelta: 600,
      skippedFramesBefore: 0,
      skippedFramesAfter: 0,
      skippedFramesDelta: 0,
      measuredDurationMs: derived.measuredDurationMs,
      framesPerSecond: derived.framesPerSecond,
      p95RafIntervalMs: derived.p95RafIntervalMs,
    },
  };
}
