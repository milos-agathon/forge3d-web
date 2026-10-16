import assert from "node:assert/strict";
import test from "node:test";

import { assertFfx03BrowserVersion, FFX03_LANES, resolveFfx03Lane } from "../../scripts/ffx03-lanes.mjs";

test("FFX-03 registry closes stable and Nightly lane identities", () => {
  assert.deepEqual(Object.keys(FFX03_LANES).sort(), [
    "firefox-macos-m2", "firefox-nightly-linux-intel12",
    "firefox-nightly-linux-rtx3070", "firefox-windows-intel12",
  ]);
  assert.equal(resolveFfx03Lane({ lane: "firefox-macos-m2", assetId: "FW-MAC-M2-01",
    platform: "darwin", architecture: "arm64", required: true }).minimumMajor, 147);
});

for (const request of [
  { lane: "firefox-macos-m2", assetId: "FW-MAC-M2-01", platform: "darwin", architecture: "x64", required: true },
  { lane: "firefox-nightly-linux-intel12", assetId: "FW-LNX-I12-01", platform: "linux", architecture: "x64", required: true },
  { lane: "firefox-release-linux-intel12", assetId: "FW-LNX-I12-01", platform: "linux", architecture: "x64", required: true },
]) test(`rejects mismatched lane ${JSON.stringify(request)}`, () => {
  assert.throws(() => resolveFfx03Lane(request));
});

test("Firefox versions use channel-specific release and Nightly syntax", () => {
  assert.equal(assertFfx03BrowserVersion("147.0.1", FFX03_LANES["firefox-macos-m2"]), "147.0.1");
  assert.throws(() => assertFfx03BrowserVersion("147.0a1", FFX03_LANES["firefox-macos-m2"]), /release version syntax/u);
  assert.equal(assertFfx03BrowserVersion("148.0a1", FFX03_LANES["firefox-nightly-linux-intel12"]), "148.0a1");
  assert.throws(() => assertFfx03BrowserVersion("148.0", FFX03_LANES["firefox-nightly-linux-intel12"]), /nightly version syntax/u);
});
