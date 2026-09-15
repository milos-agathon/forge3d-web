import assert from "node:assert/strict";
import test from "node:test";

import { CHR04_LANES, isChr04Lane } from "../../scripts/chr04-lanes.mjs";

test("CHR-04 registry is closed over exact Edge assets, platforms, and requirement modes", () => {
  assert.deepEqual(CHR04_LANES, {
    "edge-windows-intel12": { assetId: "FW-WIN-I12-01", platform: "win32", requirement: "required" },
    "edge-macos-m2": { assetId: "FW-MAC-M2-01", platform: "darwin", requirement: "required" },
    "edge-linux-intel12": { assetId: "FW-LNX-I12-01", platform: "linux", requirement: "conditional" },
    "edge-linux-rtx3070": { assetId: "FW-LNX-NV-01", platform: "linux", requirement: "conditional" },
  });
  assert.equal(isChr04Lane("edge-macos-m2"), true);
  assert.equal(isChr04Lane("edge-beta-macos-m2"), false);
  assert.equal(isChr04Lane("chrome-macos-m2"), false);
});
