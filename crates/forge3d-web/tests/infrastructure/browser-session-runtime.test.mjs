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
  const session = { contract: { required: true }, driver: {}, close: async () => ({ ok: true }) };
  const request = firefoxRequest();
  const result = await openProductionSession(request, {
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
  });
  assert.equal(result.driver, session.driver);
  assert.equal(result.close, session.close);
  assert.equal(typeof result.runFirefoxLifecycle, "function");
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

test("required Firefox session attaches FFX-04 lifecycle to the same Selenium session", async () => {
  const rawDriver = { marker: "selenium-firefox-driver" };
  const attached = { marker: "attached-webdriver-session" };
  const opened = {
    contract: { required: true },
    driver: rawDriver,
    browser: { name: "firefox", channel: "release", version: "147.0" },
    driverVersion: "0.36.0",
    launchArgumentsObserved: true,
    launchArgumentSource: "windows-live-browser-process",
    browserProcessId: 4242,
    close: async () => ({ ok: true }),
  };
  const calls = [];
  const session = await openProductionSession(firefoxRequest(), {
    acceptanceModulePath: "/opt/forge3d/firefox-viewer.mjs",
    seleniumModulePath: "/opt/forge3d/node_modules/selenium-webdriver/index.js",
    geckodriverPath: "/opt/forge3d/geckodriver",
    installedPackageVersion: () => "4.35.0",
    execVersion: () => "geckodriver 0.36.0 (fixture)",
    acceptance: {
      FFX03_SELENIUM_VERSION: "4.35.0",
      openSeleniumFirefoxSession: async () => opened,
    },
    attachWebDriverSession: async (driver) => {
      assert.equal(driver, rawDriver);
      return attached;
    },
    runFirefoxLifecycleAcceptance: async (options) => {
      calls.push(options);
      return { ffx04Proof: { kind: "forge3d-ffx04-lifecycle-proof-v1" } };
    },
    observeWebDriverLaunch: () => ({}),
  });
  assert.equal(session.driver, rawDriver);
  assert.equal(typeof session.runFirefoxLifecycle, "function");
  const result = await session.runFirefoxLifecycle({ binding: { lane: "firefox-macos-m2" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session, attached);
  assert.equal(calls[0].browser, opened.browser);
  assert.deepEqual(calls[0].driver, { name: "selenium-firefox", version: "0.36.0" });
  assert.deepEqual(calls[0].launchObservation, {
    observed: true,
    source: "windows-live-browser-process",
    browserProcessId: 4242,
  });
  assert.deepEqual(calls[0].binding, { lane: "firefox-macos-m2" });
  assert.equal(result.ffx04Proof.kind, "forge3d-ffx04-lifecycle-proof-v1");
});

test("Nightly Firefox probe session is returned without FFX-04 lifecycle attachment", async () => {
  const opened = {
    contract: { required: false },
    driver: {},
    close: async () => ({ ok: true }),
  };
  const request = {
    ...firefoxRequest(),
    runtime: { driver: "selenium-firefox", channel: "nightly", required: false },
    lane: "firefox-nightly-linux-intel12",
    assetId: "FW-LNX-I12-01",
    platform: "linux",
    architecture: "x64",
    inventory: { browsers: [{ id: "firefox-nightly", channel: "nightly",
      classification: "probe", version: "144.0a1", executable: "/opt/firefox-nightly/firefox" }] },
  };
  const session = await openProductionSession(request, {
    acceptanceModulePath: "/opt/forge3d/firefox-viewer.mjs",
    seleniumModulePath: "/opt/forge3d/node_modules/selenium-webdriver/index.js",
    geckodriverPath: "/opt/forge3d/geckodriver",
    installedPackageVersion: () => "4.35.0",
    execVersion: () => "geckodriver 0.36.0 (fixture)",
    acceptance: {
      FFX03_SELENIUM_VERSION: "4.35.0",
      openSeleniumFirefoxSession: async () => opened,
    },
    attachWebDriverSession: async () => assert.fail("Nightly must not attach a second session"),
    runFirefoxLifecycleAcceptance: async () => assert.fail("Nightly must not run FFX-04"),
    observeWebDriverLaunch: () => ({}),
  });
  assert.equal(session, opened);
  assert.equal(session.runFirefoxLifecycle, undefined);
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
