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
import { WebDriverClient } from "./webdriver-client.mjs";

export async function openProductionSession(request) {
  if (
    request.runtime.driver === "playwright-chrome" ||
    request.runtime.driver === "playwright-edge" ||
    request.runtime.driver === "infrastructure-canary"
  ) {
    return openPlaywrightSession(request);
  }
  if (request.runtime.driver === "safaridriver") {
    return openLocalWebDriverSession({
      ...request,
      command: request.browserPolicy.tools.safaridriverPath,
      args: ["--port", "4445"],
      port: 4445,
      capabilities: { browserName: "safari" },
      driverVersion: execVersion(
        request.browserPolicy.tools.safaridriverPath,
        ["--version"],
      ),
    });
  }
  if (request.runtime.driver === "selenium-firefox") {
    const command = requiredAbsoluteEnvironment(
      "FORGE3D_GECKODRIVER_EXECUTABLE",
    );
    return openLocalWebDriverSession({
      ...request,
      command,
      args: ["--port", "4446"],
      port: 4446,
      capabilities: {
        browserName: "firefox",
        "moz:firefoxOptions": { args: [] },
      },
      driverVersion: execVersion(command, ["--version"]),
    });
  }
  return openAppiumSession(request);
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
  try {
    const launch = await observeChromiumLaunch(browser);
    const page = await browser.newPage();
    await page.goto(routeUrl, { waitUntil: "networkidle" });
    return {
      browser: {
        name: runtime.browser,
        channel: "stable",
        version: browser.version(),
      },
      driverVersion,
      ...launch,
      runPage: (payload) => runPlaywrightPage(page, payload),
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
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
    stdio: ["ignore", "ignore", "inherit"],
  });
  registerProcess(processRegistryPath, runtime.driver, child.pid);
  try {
    const client = new WebDriverClient(`http://127.0.0.1:${port}`);
    await client.waitUntilReady();
    const session = await client.createSession(capabilities);
    await session.navigate(routeUrl);
    const launch = observeWebDriverLaunch({ runtime, session });
    return {
      browser: {
        name: runtime.browser,
        channel: runtime.browser === "firefox" ? "release" : "stable",
        version: String(
          session.capabilities.browserVersion ??
            session.capabilities.version ??
            "unknown",
        ),
      },
      driverVersion,
      ...launch,
      runPage: (payload) => session.runHardwarePage(payload),
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
  const installedDriverVersion = resolveInstalledAppiumDriverVersion(
    JSON.parse(
      execFileSync(
        executable,
        ["driver", "list", "--installed", "--json"],
        { encoding: "utf8" },
      ),
    ),
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
    { shell: false, stdio: ["ignore", "ignore", "inherit"] },
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
      mobileDevice: record,
      ...launch,
      runPage: (payload) => session.runHardwarePage(payload),
      runRouteProbe: (payload) => session.runRouteProbe(payload),
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

async function runPlaywrightPage(page, payload) {
  return page.evaluate(async (value) => {
    const module = await import(
      new URL("hardware-page-harness.js", window.location.href).href
    );
    return module.runHardwarePage(value);
  }, payload);
}

function invokeDeviceHelper(helper, operation, assetId, value) {
  const result = JSON.parse(
    execFileSync(
      helper,
      [operation, "--asset-id", assetId, "--value", value],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
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
  return execFileSync(command, args, { encoding: "utf8" }).trim();
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
