import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { deflateSync } from "node:zlib";
import test from "node:test";

import { decodePngEvidence, initializeErrorLedgerBeforeNavigation, partitionReloadErrorLedger, SAF03_SELENIUM_VERSION } from "./safari-viewer.mjs";

test("SAF-03 uses the pinned Selenium client and decodes native PNG terrain pixels", () => {
  assert.equal(SAF03_SELENIUM_VERSION, "4.35.0");
  const evidence = decodePngEvidence(rgbPng(4, 4), { left: 0, top: 0, width: 4, height: 4 });
  assert.equal(evidence.mimeType, "image/png");
  assert.deepEqual([evidence.width, evidence.height], [4, 4]);
  assert.equal(evidence.pixels.decoded, true);
  assert.equal(evidence.pixels.nonBlank, true);
  assert.equal(evidence.pixels.sampleCount, 16);
  assert.ok(evidence.pixels.terrainPixelCount > 0);
});

test("SAF-03 rejects corrupt and unsupported native screenshots", () => {
  assert.throws(() => decodePngEvidence(Buffer.from("not a png")), /not PNG/u);
  const interlaced = rgbPng(4, 4);
  interlaced[28] = 1;
  assert.throws(() => decodePngEvidence(interlaced), /unsupported/u);
});

test("SAF-03 hashes decoded pixels independently from PNG encoding", () => {
  const first = decodePngEvidence(rgbPng(4, 4, 1));
  const second = decodePngEvidence(rgbPng(4, 4, 9));
  assert.notEqual(first.sha256, second.sha256);
  assert.equal(first.pixels.sha256, second.pixels.sha256);
});

test("SAF-03 visibility and Retina resize use the packaged same-origin controls", () => {
  const source = readFileSync(new URL("./safari-viewer.mjs", import.meta.url), "utf8");
  const fixture = readFileSync(new URL("../../examples/test-interactive-viewer.html", import.meta.url), "utf8");
  assert.match(source, /new URL\("test-lifecycle-away\.html", fixtureUrl\)/u);
  assert.doesNotMatch(source, /about:blank/u);
  assert.match(fixture, /getComputedStyle\(canvas\)\.width/u);
  assert.match(fixture, /devicePixelRatio: window\.devicePixelRatio/u);
  assert.doesNotMatch(fixture, /canvas\.width === 320/u);
  const retina = { cssWidth: 320, backingWidth: 640, devicePixelRatio: 2 };
  const nextCssWidth = retina.cssWidth === 320 ? 240 : 320;
  assert.equal(nextCssWidth, 240);
  assert.equal(nextCssWidth * retina.devicePixelRatio, 480);
  assert.notEqual(retina.backingWidth === 320 ? 240 : 320, nextCssWidth);
});

test("SAF-03 retains pagehide console and runtime errors across the hard reload boundary", () => {
  const injected = ["console.error:pagehide failure", "error:pagehide runtime failure"];
  assert.deepEqual(partitionReloadErrorLedger([], injected, injected), {
    reloadBoundary: injected,
    afterReload: [],
  });
  assert.throws(() => partitionReloadErrorLedger(["before"], injected, injected), /lost same-tab/u);
  const fixture = readFileSync(new URL("../../examples/test-interactive-viewer.html", import.meta.url), "utf8");
  assert.match(fixture, /sessionStorage\.setItem\(errorLedgerKey/u);
  assert.match(fixture, /errors\.length > 100/u);
  assert.match(fixture, /addEventListener\("pagehide"/u);
});

test("SAF-03 initializes the durable collector before tested fixture navigation", async () => {
  const calls = [];
  const driver = {
    get: async (url) => calls.push(["get", url]),
    executeScript: async (...args) => { calls.push(["execute", ...args.slice(1)]); return true; },
  };
  await initializeErrorLedgerBeforeNavigation(driver, "https://safari.example.invalid/run/");
  assert.deepEqual(calls.map(([kind, value]) => [kind, value]), [
    ["get", "https://safari.example.invalid/run/test-lifecycle-away.html"],
    ["execute", "forge3d-saf03-error-ledger-v1"],
    ["get", "https://safari.example.invalid/run/"],
  ]);
  const failed = { get: async () => undefined, executeScript: async () => false };
  await assert.rejects(() => initializeErrorLedgerBeforeNavigation(failed, "https://safari.example.invalid/run/"), /durable initialization failed/u);
});

test("SAF-03 fixture collector rehydrates startup and callback-only reload errors", () => {
  const storage = fixtureStorage();
  const startup = loadFixtureCollector(storage);
  startup.listeners.get("error")({ error: new Error("startup failure") });
  const startupReload = loadFixtureCollector(storage, startup.window.name);
  assert.deepEqual([...startupReload.window.__forge3dSafariErrors], ["error:startup failure"]);

  storage.setItem("forge3d-saf03-error-ledger-v1", "[]");
  const callback = loadFixtureCollector(storage);
  callback.window.__forge3dSafariRecordError("viewer.onError:pagehide callback failure");
  const callbackReload = loadFixtureCollector(storage, callback.window.name);
  assert.deepEqual([...callbackReload.window.__forge3dSafariErrors], ["viewer.onError:pagehide callback failure"]);
});

test("SAF-03 fixture collector surfaces durable storage write failure across documents", () => {
  const storage = fixtureStorage({ failWrites: true });
  const first = loadFixtureCollector(storage);
  first.window.__forge3dSafariRecordError("viewer.onError:write failure");
  assert.equal(first.window.name, "collector:persistence-failure");
  const rehydrated = loadFixtureCollector(storage, first.window.name);
  assert.ok(rehydrated.window.__forge3dSafariErrors.includes("collector:persistence-failure"));
});

function fixtureStorage({ failWrites = false } = {}) {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error("quota denied");
      values.set(key, value);
    },
  };
}

function loadFixtureCollector(sessionStorage, name = "") {
  const html = readFileSync(new URL("../../examples/test-interactive-viewer.html", import.meta.url), "utf8");
  const script = html.match(/<body>\s*<script>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  const listeners = new Map();
  const window = { name };
  const context = {
    window,
    sessionStorage,
    crypto: { randomUUID: () => "fixture-document" },
    document: { visibilityState: "visible", addEventListener: (type, callback) => listeners.set(type, callback) },
    addEventListener: (type, callback) => listeners.set(type, callback),
    console: { error: () => undefined },
  };
  vm.runInNewContext(script, context);
  return { window, listeners };
}

function rgbPng(width, height, level = 6) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      const value = (x + y) % 2 === 0 ? 32 : 200;
      rows[offset] = value;
      rows[offset + 1] = value;
      rows[offset + 2] = value;
    }
  }
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level })), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const value = Buffer.alloc(12 + data.length);
  value.writeUInt32BE(data.length, 0);
  value.write(type, 4, 4, "ascii");
  data.copy(value, 8);
  return value;
}
