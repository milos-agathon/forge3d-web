import assert from "node:assert/strict";
import test from "node:test";

import { closePlaywright, openProductionSession } from "../../scripts/browser-session-runtime.mjs";

test("Playwright cleanup closes context before browser", async () => {
  const calls = [];
  await closePlaywright(
    { close: async () => calls.push("context") },
    { close: async () => calls.push("browser") },
  );
  assert.deepEqual(calls, ["context", "browser"]);
});

test("Playwright cleanup still closes browser when context close fails", async () => {
  const calls = [];
  await assert.rejects(() => closePlaywright(
    { close: async () => { calls.push("context"); throw new Error("context close failed"); } },
    { close: async () => calls.push("browser") },
  ), /context close failed/u);
  assert.deepEqual(calls, ["context", "browser"]);
});

test("Playwright cleanup retains both nested close failures", async () => {
  await assert.rejects(() => closePlaywright(
    { close: async () => { throw new Error("context"); } },
    { close: async () => { throw new Error("browser"); } },
  ), (error) => error instanceof AggregateError && error.errors.length === 2);
});

test("Firefox production session binds the pinned client, driver, binary, and closed lane", async () => {
  let opened;
  const session = { close: async () => ({ ok: true }) };
  const request = firefoxRequest();
  assert.equal(await openProductionSession(request, {
    acceptanceModulePath: "/opt/forge3d/firefox-viewer.mjs",
    seleniumModulePath: "/opt/forge3d/node_modules/selenium-webdriver/index.js",
    geckodriverPath: "/opt/forge3d/geckodriver",
    installedPackageVersion: () => "4.35.0",
    execVersion: () => "geckodriver 0.36.0 (fixture)",
    acceptance: {
      FFX03_SELENIUM_VERSION: "4.35.0",
      openSeleniumFirefoxSession: async (options) => { opened = options; return session; },
    },
    observeWebDriverLaunch: () => ({ observedExecutable: request.inventory.browsers[0].executable }),
  }), session);
  assert.deepEqual({
    lane: opened.lane, assetId: opened.assetId, platform: opened.platform,
    architecture: opened.architecture, required: opened.required,
    browser: opened.browser, geckodriverPath: opened.geckodriverPath,
    geckodriverVersion: opened.geckodriverVersion, temporaryRoot: opened.temporaryRoot,
  }, {
    lane: "firefox-macos-m2", assetId: "FW-MAC-M2-01", platform: "darwin",
    architecture: "arm64", required: true, browser: request.inventory.browsers[0],
    geckodriverPath: "/opt/forge3d/geckodriver", geckodriverVersion: "0.36.0",
    temporaryRoot: "/tmp/forge3d-firefox",
  });
});

test("Firefox production session rejects an unpinned Selenium client before launch", async () => {
  let launched = false;
  await assert.rejects(() => openProductionSession(firefoxRequest(), {
    acceptanceModulePath: "/opt/forge3d/firefox-viewer.mjs",
    seleniumModulePath: "/opt/forge3d/node_modules/selenium-webdriver/index.js",
    geckodriverPath: "/opt/forge3d/geckodriver",
    installedPackageVersion: () => "4.34.0",
    acceptance: { FFX03_SELENIUM_VERSION: "4.35.0",
      openSeleniumFirefoxSession: async () => { launched = true; } },
  }), /installed Selenium version/u);
  assert.equal(launched, false);
});

function firefoxRequest() {
  return {
    runtime: { driver: "selenium-firefox", channel: "release", required: true },
    lane: "firefox-macos-m2", assetId: "FW-MAC-M2-01", platform: "darwin",
    architecture: "arm64", routeUrl: "https://fixture.example/run/",
    browserPolicy: { tools: { selenium: "4.35.0" } },
    temporaryRoot: "/tmp/forge3d-firefox", processRegistryPath: "/tmp/forge3d-firefox/processes.json",
    inventory: { browsers: [{ id: "firefox-release", channel: "release",
      classification: "required", version: "147.0", executable: "/Applications/Firefox.app/Contents/MacOS/firefox" }] },
  };
}
