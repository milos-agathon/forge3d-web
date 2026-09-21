import { execFileSync, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  markProcessStopped,
  registerProcess,
  stopChild,
} from "./browser-process-registry.mjs";
import {
  installedPackageVersion,
  observeAppiumLaunch,
  observeChromiumLaunch,
  observeWebDriverLaunch,
  resolveInstalledAppiumDriverVersion,
} from "./browser-launch-provenance.mjs";
import { WebDriverClient, WebDriverSession } from "./webdriver-client.mjs";
import { runBrandedHardwareAcceptance } from "./chrome-hardware-acceptance.mjs";
import { isChr03Lane } from "./chr03-lanes.mjs";
import { isChr04Lane } from "./chr04-lanes.mjs";
import { isFfx03Lane } from "./ffx03-lanes.mjs";
import { runSafariBrowserAcceptance } from "./safari-browser-acceptance.mjs";
import { runFirefoxLifecycleAcceptance } from "./firefox-lifecycle-acceptance.mjs";
import { projectSaf03Binding, validateSaf03SafariProof, validateSaf03TechnologyPreviewResult } from "./saf03-proof-validator.mjs";

const FFX03_SELENIUM_VERSION = "4.35.0";

export const SAFARI_HARDWARE_PAGE_TIMEOUT_BUDGET = Object.freeze({
  saf02Page: 110_000,
  // verifyBrowserRoute performs six sequential bounded fetches and four
  // sequential isolated-loader probes before adapter/viewer validation.
  routeFetches: 6 * 5_000,
  routeLoaderProbes: 4 * 15_000,
  adapterAttestation: 15_000,
  initialViewerAssertions: 15_000,
  // Covers WebDriver callback serialization and scheduling outside the page's
  // independently bounded stages; it is not available to extend a stage.
  webdriverTransportMargin: 10_000,
});
export const SAFARI_COMPOSED_SCRIPT_TIMEOUT_MS = Object.values(
  SAFARI_HARDWARE_PAGE_TIMEOUT_BUDGET,
).reduce((total, value) => total + value, 0);

export async function openProductionSession(request, dependencies = {}) {
  if (
    request.runtime.driver === "playwright-chrome" ||
    request.runtime.driver === "playwright-edge" ||
    request.runtime.driver === "infrastructure-canary"
  ) {
    return openPlaywrightSession(request);
  }
  if (request.runtime.driver === "safaridriver") {
    if (request.runtime.manual !== true && request.lane === "safari-macos-m2") {
      return openSafariSeleniumSession(request, dependencies);
    }
    return (dependencies.openLocalWebDriverSession ?? openLocalWebDriverSession)({
      ...request,
      command: request.browserPolicy.tools.safaridriverPath,
      args: ["--port", "4445"],
      port: 4445,
      capabilities: { browserName: "safari" },
      driverVersion: request.inventory.tools.safaridriverVersion,
    });
  }
  if (request.runtime.driver === "selenium-firefox") {
    if (!isFfx03Lane(request.lane)) throw new Error("unrecognized Firefox lane bypassed the FFX-03 contract");
    return openFirefoxSession(request, dependencies);
  }
  return openAppiumSession(request);
}

async function openFirefoxSession(request, dependencies) {
  const modulePath = dependencies.acceptanceModulePath ?? requiredAbsoluteEnvironment(
    "FORGE3D_FIREFOX_ACCEPTANCE_MODULE",
  );
  const seleniumModulePath = dependencies.seleniumModulePath ?? requiredAbsoluteEnvironment(
    "FORGE3D_SELENIUM_MODULE",
  );
  const installedVersion = (dependencies.installedPackageVersion ?? installedPackageVersion)(
    seleniumModulePath, ["selenium-webdriver"],
  );
  if (installedVersion !== request.browserPolicy.tools.selenium || installedVersion !== FFX03_SELENIUM_VERSION) {
    throw new Error("installed Selenium version does not match checked FFX-03 policy");
  }
  const acceptance = dependencies.acceptance ?? await import(pathToFileURL(modulePath).href);
  if (acceptance.FFX03_SELENIUM_VERSION !== installedVersion) {
    throw new Error("FFX-03 acceptance module uses a different Selenium client version");
  }
  const selected = request.inventory?.browsers?.find((browser) =>
    browser.id === (request.runtime.channel === "nightly" ? "firefox-nightly" : "firefox-release"));
  const geckodriverPath = dependencies.geckodriverPath ?? requiredAbsoluteEnvironment(
    "FORGE3D_GECKODRIVER_EXECUTABLE",
  );
  const driverVersion = (dependencies.execVersion ?? execVersion)(geckodriverPath, ["--version"])
    .match(/[0-9]+\.[0-9]+\.[0-9]+/u)?.[0];
  const opened = await acceptance.openSeleniumFirefoxSession({
    lane: request.lane,
    assetId: request.assetId,
    platform: request.platform,
    architecture: request.architecture,
    required: request.runtime.required,
    routeUrl: request.routeUrl,
    browser: selected,
    geckodriverPath,
    geckodriverVersion: driverVersion,
    temporaryRoot: request.temporaryRoot,
    processRegistryPath: request.processRegistryPath,
    registerProcess,
    markProcessStopped,
    observeLaunch: dependencies.observeWebDriverLaunch ?? observeWebDriverLaunch,
  });
  if (!opened.contract.required) return opened;
  const attachSession = dependencies.attachWebDriverSession ??
    ((driver) => attachWebDriverSession(driver, 4446));
  const runFfx04 = dependencies.runFirefoxLifecycleAcceptance ??
    runFirefoxLifecycleAcceptance;
  return {
    ...opened,
    runFirefoxLifecycle: async (payload) => runFfx04({
      session: await attachSession(opened.driver),
      browser: opened.browser,
      driver: { name: "selenium-firefox", version: opened.driverVersion },
      launchObservation: {
        observed: opened.launchArgumentsObserved,
        source: opened.launchArgumentSource,
        browserProcessId: opened.browserProcessId,
      },
      ...payload,
    }),
  };
}

async function openSafariSeleniumSession({ runtime, routeUrl, browserPolicy, inventory, processRegistryPath }, dependencies) {
  const modulePath = requiredAbsoluteEnvironment("FORGE3D_SAFARI_ACCEPTANCE_MODULE");
  const seleniumModule = requiredAbsoluteEnvironment("FORGE3D_SELENIUM_MODULE");
  const resolvePackageVersion = dependencies.installedPackageVersion ?? installedPackageVersion;
  const observeLaunch = dependencies.observeWebDriverLaunch ?? observeWebDriverLaunch;
  const clientVersion = resolvePackageVersion(seleniumModule, ["selenium-webdriver"]);
  if (clientVersion !== browserPolicy.tools.selenium || clientVersion !== "4.35.0") {
    throw new Error("installed Selenium client does not match the exact SAF-03 policy");
  }
  const acceptance = dependencies.acceptance ?? await import(pathToFileURL(modulePath).href);
  if (acceptance.SAF03_SELENIUM_VERSION !== clientVersion) {
    throw new Error("SAF-03 acceptance module does not use the checked Selenium client");
  }
  const stableInventory = inventory.browsers.find(({ id }) => id === "safari-stable");
  if (!stableInventory || stableInventory.channel !== "stable" || stableInventory.classification !== "required") {
    throw new Error("stable Safari inventory is missing from SAF-03 host");
  }
  const stable = await acceptance.openSeleniumSafariSession({
    routeUrl,
    safaridriverPath: browserPolicy.tools.safaridriverPath,
    safaridriverVersion: inventory.tools.safaridriverVersion,
    browserVersion: stableInventory.version,
  });
  let stableRegistered = false;
  let launch;
  try {
    registerProcess(processRegistryPath, runtime.driver, stable.driverPid);
    stableRegistered = true;
    launch = observeLaunch({ runtime, session: { capabilities: {} } });
  } catch (error) {
    try {
      await stable.close();
      if (stableRegistered) markProcessStopped(processRegistryPath, stable.driverPid);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "INFRA_ERROR SAFARIDRIVER_POST_OPEN_CLEANUP_UNPROVEN");
    }
    throw error;
  }
  return {
    browser: stable.browser,
    driverVersion: stable.driverVersion,
    ...launch,
    assertHealthy: async () => {
      const url = await stable.driver.getCurrentUrl().catch(() => {
        throw new Error("INFRA_ERROR BROWSER_SESSION_LOST");
      });
      if (url !== routeUrl && url !== routeUrl.replace(/index\.html$/u, "")) {
        throw new Error("INFRA_ERROR BROWSER_ROUTE_CHANGED");
      }
    },
    runPage: async (payload) => {
      await stable.driver.manage().setTimeouts({
        script: SAFARI_COMPOSED_SCRIPT_TIMEOUT_MS,
      });
      const neutral = await runSeleniumHardwarePage(stable.driver, payload);
      const attachSession = dependencies.attachWebDriverSession ?? ((driver) => attachWebDriverSession(driver, 4445));
      const runSaf04 = dependencies.runSafariBrowserAcceptance ?? runSafariBrowserAcceptance;
      const saf04Result = await runSaf04(
        await attachSession(stable.driver),
        payload,
        { hardwarePageResult: neutral },
      );
      const proof = await acceptance.runStableSafariAcceptance({
        session: stable,
        binding: payload.binding,
        route: payload.route,
        adapter: neutral.adapter,
        system: { osVersion: inventory.osVersion, osBuild: inventory.osBuild, architecture: inventory.architecture },
        benchmarkEnvironment: {
          browserZoom: 1,
          thermalState: "unavailable",
          thermalSignalProvenance: "browser API unavailable",
          lowPowerMode: "unavailable",
          lowPowerSignalProvenance: "browser API unavailable",
        },
      });
      validateSaf03SafariProof(proof, {
        lane: payload.binding.lane,
        assetId: payload.binding.assetId,
        platform: "darwin",
        commit: payload.binding.commit,
        packageSha256: payload.binding.packageSha256,
      });
      return {
        ...saf04Result,
        assertions: { supportAssertionsExecuted: true, passed: true },
        saf03Proof: proof,
      };
    },
    runTechnologyPreview: async ({ binding, route }) => {
      const closedBinding = projectSaf03Binding(binding);
      const installed = inventory.browsers.find(({ id }) => id === "safari-technology-preview");
      if (!installed) {
        const absent = { kind: "forge3d-saf03-stp-result-v1",
          binding: closedBinding,
          channel: "technology-preview", classification: "probe",
          required: false, replacesStable: false, clientVersion, executable: null, driverExecutable: null, version: null,
          driverVersion: null,
          browser: null, result: "ABSENT", warning: "Safari Technology Preview is not installed on the checked host",
          cleanup: { notStarted: true, sessionDeleted: null, driverStopped: null, processAbsent: true, ok: true },
          probe: null };
        return validateSaf03TechnologyPreviewResult(absent, inventory, closedBinding, route.applicationUrl);
      }
      if (inventory.tools.safariTechnologyPreviewDriverPath !== browserPolicy.tools.safariTechnologyPreviewDriverPath ||
          typeof inventory.tools.safariTechnologyPreviewDriverVersion !== "string") {
        return validateSaf03TechnologyPreviewResult({ kind: "forge3d-saf03-stp-result-v1", binding: closedBinding,
          channel: "technology-preview", classification: "probe", required: false, replacesStable: false,
          clientVersion, executable: installed.executable, driverExecutable: null, driverVersion: null,
          version: installed.version, browser: null, result: "PRODUCT_FAILURE",
          warning: "STP_PRODUCT_FAILURE bundle driver inventory does not match checked policy",
          cleanup: { notStarted: true, sessionDeleted: null, driverStopped: null, processAbsent: true, ok: true }, probe: null }, inventory, closedBinding, route.applicationUrl);
      }
      let preview;
      let cleanup;
      let result = "PASS";
      let warning = null;
      let probe = null;
      try {
        try {
          preview = await acceptance.openSeleniumSafariSession({
            routeUrl,
            safaridriverPath: inventory.tools.safariTechnologyPreviewDriverPath,
            safaridriverVersion: inventory.tools.safariTechnologyPreviewDriverVersion,
            browserVersion: installed.version,
            technologyPreview: true,
          });
          registerProcess(processRegistryPath, "safaridriver-stp", preview.driverPid);
        } catch (error) {
          if (error?.cleanup?.ok !== true) throw error;
          result = "PRODUCT_FAILURE";
          warning = `STP_PRODUCT_FAILURE ${error instanceof Error ? error.message : String(error)}`;
          cleanup = error.cleanup;
        }
        if (!preview) {
          const record = { kind: "forge3d-saf03-stp-result-v1", binding: closedBinding,
            channel: "technology-preview", classification: "probe", required: false, replacesStable: false,
            clientVersion, executable: installed.executable,
            driverExecutable: inventory.tools.safariTechnologyPreviewDriverPath,
            driverVersion: inventory.tools.safariTechnologyPreviewDriverVersion, version: installed.version,
            browser: null, result, warning, cleanup, probe: null };
          return validateSaf03TechnologyPreviewResult(record, inventory, closedBinding, route.applicationUrl);
        }
        try {
          probe = await acceptance.runSafariTechnologyPreviewProbe({ session: preview, binding, route });
        } catch (error) {
          if (!String(error instanceof Error ? error.message : error).startsWith("STP_PRODUCT_FAILURE ")) throw error;
          result = "PRODUCT_FAILURE";
          warning = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (preview) {
          cleanup = { notStarted: false, ...await preview.close() };
          markProcessStopped(processRegistryPath, preview.driverPid);
        }
      }
      const record = { kind: "forge3d-saf03-stp-result-v1",
        binding: closedBinding,
        channel: "technology-preview", classification: "probe",
        required: false, replacesStable: false, clientVersion, executable: installed.executable,
        driverExecutable: inventory.tools.safariTechnologyPreviewDriverPath,
        driverVersion: inventory.tools.safariTechnologyPreviewDriverVersion, version: installed.version,
        browser: preview?.browser ?? null, result, warning, cleanup, probe };
      return validateSaf03TechnologyPreviewResult(record, inventory, closedBinding, route.applicationUrl);
    },
    close: async () => {
      const cleanup = await stable.close();
      markProcessStopped(processRegistryPath, stable.driverPid);
      return cleanup;
    },
  };
}

async function runSeleniumHardwarePage(driver, payload) {
  const result = await driver.executeAsyncScript(`
    const payload = arguments[0];
    const done = arguments[arguments.length - 1];
    import(new URL("hardware-page-harness.js", window.location.href).href)
      .then((module) => module.runHardwarePage(payload))
      .then((value) => done({ ok: true, value }))
      .catch((error) => done({ ok: false, error: String(error && error.message || error) }));
  `, payload);
  if (result?.ok !== true) throw new Error(`BROWSER_PAGE_FAILED ${result?.error ?? "unknown"}`);
  return result.value;
}

async function attachWebDriverSession(driver, port) {
  const sessionId = (await driver.getSession()).getId();
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("INFRA_ERROR WEBDRIVER_SESSION_STATE_INVALID");
  }
  return new WebDriverSession(
    new WebDriverClient(`http://127.0.0.1:${port}`),
    sessionId,
    {},
  );
}

async function openPlaywrightSession({ runtime, routeUrl, browserPolicy }) {
  const modulePath = requiredAbsoluteEnvironment(
    "FORGE3D_PLAYWRIGHT_MODULE",
  );
  const playwright = await import(pathToFileURL(modulePath).href);
  const driverVersion = installedPackageVersion(modulePath, [
    "playwright",
    "playwright-core",
  ]);
  if (driverVersion !== browserPolicy.tools.playwright) {
    throw new Error("installed Playwright version does not match checked policy");
  }
  const browser = await playwright.chromium.launch({
    channel: runtime.browser,
    headless: false,
    args: [],
  });
  let context;
  try {
    const launch = await observeChromiumLaunch(browser);
    context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    await page.goto(routeUrl, { waitUntil: "networkidle" });
    return {
      browser: {
        name: runtime.browser === "chrome-beta" ? "chrome" : runtime.browser,
        channel: runtime.browser === "chrome-beta" ? "beta" : "stable",
        version: browser.version(),
      },
      driverVersion,
      ...launch,
      runPage: (payload) => (
        (["chrome", "chrome-beta"].includes(runtime.browser) && isChr03Lane(payload.binding?.lane)) ||
        (runtime.browser === "msedge" && isChr04Lane(payload.binding?.lane))
      )
        ? runBrandedHardwareAcceptance(page, payload)
        : runPlaywrightPage(page, payload),
      assertHealthy: createPlaywrightHealthObserver({ browser, page, routeUrl }),
      close: () => closePlaywright(context, browser),
    };
  } catch (error) {
    await closePlaywright(context, browser).catch(() => undefined);
    throw error;
  }
}

export async function closePlaywright(context, browser) {
  let contextError = null;
  try {
    await context?.close();
  } catch (error) {
    contextError = error;
  }
  try {
    await browser.close();
  } catch (browserError) {
    if (contextError !== null) throw new AggregateError([contextError, browserError], "Playwright context and browser close failed");
    throw browserError;
  }
  if (contextError !== null) throw contextError;
}

export function createPlaywrightHealthObserver({
  browser,
  page,
  routeUrl,
  timeoutMs = 5_000,
}) {
  const expectedUrl = normalizedFixtureUrl(routeUrl);
  return async () => {
    if (!browser.isConnected() || page.isClosed()) {
      throw new Error("INFRA_ERROR PLAYWRIGHT_CAPTURE_PAGE_UNAVAILABLE");
    }
    let observedUrl;
    let timer;
    try {
      observedUrl = await Promise.race([
        page.evaluate(() => document.URL),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("probe timeout")),
            timeoutMs,
          );
        }),
      ]);
    } catch {
      throw new Error("INFRA_ERROR PLAYWRIGHT_CAPTURE_PAGE_PROBE_FAILED");
    } finally {
      clearTimeout(timer);
    }
    if (normalizedFixtureUrl(observedUrl) !== expectedUrl) {
      throw new Error("INFRA_ERROR PLAYWRIGHT_CAPTURE_PAGE_NAVIGATED");
    }
  };
}

function normalizedFixtureUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INFRA_ERROR PLAYWRIGHT_CAPTURE_PAGE_URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("INFRA_ERROR PLAYWRIGHT_CAPTURE_PAGE_URL_INVALID");
  }
  const pathname = url.pathname.endsWith("/index.html")
    ? url.pathname.slice(0, -"index.html".length)
    : url.pathname;
  return `${url.origin}${pathname}`;
}

async function openLocalWebDriverSession({
  runtime,
  routeUrl,
  command,
  args,
  port,
  capabilities,
  driverVersion,
  processRegistryPath,
}) {
  const child = spawn(command, args, {
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  registerProcess(processRegistryPath, runtime.driver, child.pid);
  try {
    const client = new WebDriverClient(`http://127.0.0.1:${port}`);
    await client.waitUntilReady();
    const session = await client.createSession(capabilities);
    await session.navigate(routeUrl);
    const launch = observeWebDriverLaunch({ runtime, session });
    const browser = {
      name: runtime.browser,
      channel: runtime.browser === "firefox" ? "release" : "stable",
      version: String(
        session.capabilities.browserVersion ??
          session.capabilities.version ??
          "unknown",
      ),
    };
    return {
      browser,
      driverVersion,
      ...launch,
      assertHealthy: async () => {
        if (child.exitCode !== null) {
          throw new Error("INFRA_ERROR DRIVER_EXITED");
        }
        const currentUrl = await session.currentUrl().catch(() => {
          throw new Error("INFRA_ERROR BROWSER_SESSION_LOST");
        });
        if (currentUrl !== routeUrl) {
          throw new Error("INFRA_ERROR BROWSER_ROUTE_CHANGED");
        }
      },
      runPage: (payload) => session.runHardwarePage(payload),
      ...(runtime.driver === "selenium-firefox"
        ? {
            runFirefoxLifecycle: (payload) => runFirefoxLifecycleAcceptance({
              session,
              browser,
              driver: { name: runtime.driver, version: driverVersion },
              launchObservation: {
                observed: launch.launchArgumentsObserved,
                source: launch.launchArgumentSource,
                browserProcessId: launch.browserProcessId,
              },
              ...payload,
            }),
          }
        : {}),
      close: async () => {
        await session.delete().catch(() => undefined);
        await stopChild(child);
        markProcessStopped(processRegistryPath, child.pid);
      },
    };
  } catch (error) {
    await stopChild(child);
    markProcessStopped(processRegistryPath, child.pid);
    throw error;
  }
}

async function openAppiumSession({
  runtime,
  assetId,
  routeUrl,
  browserPolicy,
  deviceMatrix,
  appiumSessionModule,
  processRegistryPath,
}) {
  if (!isAbsolute(appiumSessionModule ?? "")) {
    throw new Error("Appium runtime module must be an absolute packaged path");
  }
  const executable = requiredAbsoluteEnvironment("FORGE3D_APPIUM_EXECUTABLE");
  const version = execVersion(executable, ["--version"]);
  if (version.split(/\s+/u)[0] !== browserPolicy.tools.appium) {
    throw new Error("installed Appium version does not match checked policy");
  }
  const appiumDriverName =
    runtime.driver === "appium-xcuitest" ? "xcuitest" : "uiautomator2";
  let installedDrivers;
  try {
    installedDrivers = JSON.parse(execFileSync(
      executable,
      ["driver", "list", "--installed", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ));
  } catch {
    throw new Error("INFRA_ERROR APPIUM_DRIVER_INVENTORY_FAILED");
  }
  const installedDriverVersion = resolveInstalledAppiumDriverVersion(
    installedDrivers,
    appiumDriverName,
  );
  const expectedDriverVersion =
    runtime.driver === "appium-xcuitest"
      ? browserPolicy.tools.appiumXcuitest
      : browserPolicy.tools.appiumUiAutomator2;
  if (installedDriverVersion !== expectedDriverVersion) {
    throw new Error("installed Appium driver does not match checked policy");
  }
  const child = spawn(
    executable,
    ["--port", "4723", "--base-path", "/wd/hub"],
    { shell: false, stdio: ["ignore", "ignore", "ignore"] },
  );
  registerProcess(processRegistryPath, "appium", child.pid);
  const client = new WebDriverClient("http://127.0.0.1:4723/wd/hub");
  let session;
  try {
    await client.waitUntilReady();
    const helper = requiredAbsoluteEnvironment(
      "FORGE3D_DEVICE_CONTROL_HELPER",
    );
    const { startPinnedAppiumSession } = await import(
      pathToFileURL(appiumSessionModule).href
    );
    const record = await startPinnedAppiumSession({
      matrix: deviceMatrix,
      assetId,
      routeUrl,
      resolvePrivateDeviceId: async (appiumId) =>
        invokeDeviceHelper(helper, "resolve", assetId, appiumId).privateDeviceId,
      probeDevice: async (privateDeviceId) =>
        invokeDeviceHelper(helper, "probe", assetId, privateDeviceId),
      appiumClient: {
        createSession: async ({ capabilities }) => {
          session = await client.createSession(capabilities);
          return session;
        },
      },
      signingMaterial:
        runtime.driver === "appium-xcuitest"
          ? {
              identity: deviceMatrix.appium.wdaSigningIdentity,
              teamId: requiredEnvironment("FORGE3D_WDA_SIGNING_TEAM_ID"),
              bundleId: requiredEnvironment("FORGE3D_WDA_BUNDLE_ID"),
            }
          : null,
    });
    const launch = observeAppiumLaunch({ runtime, session });
    if (record.driverVersion !== installedDriverVersion) {
      throw new Error("Appium session driver differs from installed driver");
    }
    return {
      browser: {
        name: record.browserName.toLowerCase(),
        channel: "stable",
        version: record.browserVersion,
      },
      driverVersion: installedDriverVersion,
      ...launch,
      appium: {
        serverVersion: version.split(/\s+/u)[0],
        driverName: appiumDriverName,
        driverVersion: installedDriverVersion,
      },
      device: projectRuntimeDeviceObservation(record),
      ...appiumRouteInterface(record, session),
      assertHealthy: async () => {
        if (child.exitCode !== null) {
          throw new Error("INFRA_ERROR APPIUM_SERVER_EXITED");
        }
        await record.assertHealthy();
      },
      runPage: (payload) => session.runHardwarePage(payload),
      close: async () => {
        await session.delete().catch(() => undefined);
        await stopChild(child);
        markProcessStopped(processRegistryPath, child.pid);
      },
    };
  } catch (error) {
    await session?.delete().catch(() => undefined);
    await stopChild(child);
    markProcessStopped(processRegistryPath, child.pid);
    throw error;
  }
}

export function projectRuntimeDeviceObservation(record) {
  return {
    assetId: record.assetId,
    model: record.model,
    platformName: record.platformName,
    osVersion: record.osVersion,
    accessory: record.accessory,
  };
}

export function appiumRouteInterface(record, session) {
  return {
    mobileDevice: record,
    runRouteProbe: (payload) => session.runRouteProbe(payload),
  };
}

async function runPlaywrightPage(page, payload) {
  return page.evaluate(async (value) => {
    const module = await import(
      new URL("hardware-page-harness.js", window.location.href).href
    );
    return module.runHardwarePage(value);
  }, payload);
}

function invokeDeviceHelper(helper, operation, assetId, value) {
  let stdout;
  try {
    stdout = execFileSync(
      helper,
      [operation, "--asset-id", assetId, "--value", value],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new Error(`INFRA_ERROR DEVICE_HELPER_${operation.toUpperCase()}_FAILED`);
  }
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`INFRA_ERROR DEVICE_HELPER_${operation.toUpperCase()}_INVALID`);
  }
  if (
    result.schemaVersion !== 1 ||
    result.operation !== operation ||
    result.assetId !== assetId
  ) {
    throw new Error("protected device-control helper returned an invalid receipt");
  }
  return result;
}

function execVersion(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("INFRA_ERROR VERSION_PROBE_FAILED");
  }
}

function requiredAbsoluteEnvironment(name) {
  const value = requiredEnvironment(name);
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
