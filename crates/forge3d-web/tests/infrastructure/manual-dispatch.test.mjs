import assert from "node:assert/strict";
import test from "node:test";

import { parseManualSubmissionDispatch } from "../../scripts/prepare-manual-submission.mjs";

const valid = {
  intakeReleaseId: "10",
  mediaAssetIds: "[20,21]",
  manualSessionRunId: "30",
  hardwareJobId: "40",
  stepResults: '{"A":"pass","B":"fail"}',
};

test("manual submission accepts only numeric IDs and canonical scalar JSON", () => {
  assert.deepEqual(parseManualSubmissionDispatch(valid), {
    intakeReleaseId: 10,
    mediaAssetIds: [20, 21],
    manualSessionRunId: 30,
    hardwareJobId: 40,
    stepResults: { A: "pass", B: "fail" },
  });
});

test("paths, noncanonical JSON, duplicate IDs, and arbitrary identity fields fail", () => {
  for (const input of [
    { ...valid, intakeReleaseId: "/tmp/intake.json" },
    { ...valid, mediaAssetIds: "[20, 20]" },
    { ...valid, mediaAssetIds: "[20, 21 ]" },
    { ...valid, stepResults: '{"B":"fail","A":"pass"}' },
  ]) {
    assert.throws(() => parseManualSubmissionDispatch(input));
  }
  assert.equal(Object.hasOwn(valid, "username"), false);
  assert.equal(Object.hasOwn(valid, "digest"), false);
});
