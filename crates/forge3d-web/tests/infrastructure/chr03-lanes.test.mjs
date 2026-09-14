import assert from "node:assert/strict";
import test from "node:test";

import { CHR03_BETA_LANES, CHR03_LANES, CHR03_STABLE_LANES, isChr03Lane } from "../../scripts/chr03-lanes.mjs";

test("CHR-03 applicability is exact and preserves the Windows Chrome lane", () => {
  assert.deepEqual(Object.keys(CHR03_STABLE_LANES).sort(), [
    "chrome-linux-intel12", "chrome-linux-rtx3070", "chrome-macos-m2",
  ]);
  assert.deepEqual(Object.keys(CHR03_BETA_LANES).sort(), [
    "chrome-beta-linux-intel12", "chrome-beta-linux-rtx3070", "chrome-beta-macos-m2",
  ]);
  assert.equal(Object.keys(CHR03_LANES).length, 6);
  assert.equal(isChr03Lane("chrome-windows-intel12"), false);
  assert.equal(isChr03Lane("chrome-linux-intel12"), true);
  assert.equal(isChr03Lane("chrome-beta-linux-intel12"), true);
  assert.equal(Object.isFrozen(CHR03_STABLE_LANES), true);
  assert.equal(Object.isFrozen(CHR03_BETA_LANES), true);
  assert.equal(Object.isFrozen(CHR03_LANES), true);
});
