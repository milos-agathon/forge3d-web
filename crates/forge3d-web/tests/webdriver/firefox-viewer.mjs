import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync, readFileSync, realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import webdriver from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

let laneModule;
try {
  laneModule = await import("../../scripts/ffx03-lanes.mjs");
} catch {
  laneModule = await import("./ffx03-lanes.mjs");
}
const { assertFfx03BrowserVersion, resolveFfx03Lane } = laneModule;

const { Builder, Button, By, Key, until } = webdriver;
const { Options, ServiceBuilder } = firefox;

export const FFX03_SELENIUM_VERSION = "4.35.0";
const LONG_SCRIPT_TIMEOUT_MS = 120_000;
const PROFILE_READ_LIMIT = 2 * 1024 * 1024;

export async function openSeleniumFirefoxSession({
  lane, assetId, platform, architecture, required,
  routeUrl, browser, geckodriverPath, geckodriverVersion,
  temporaryRoot, processRegistryPath = null,
  registerProcess = () => undefined,
  markProcessStopped = () => undefined,
  observeLaunch,
}) {
  const contract = resolveFfx03Lane({ lane, assetId, platform, architecture, required });
  validateBrowserInventory(browser, contract);
  if (!isAbsolute(geckodriverPath) || geckodriverVersion !== "0.36.0") {
    throw new Error("FFX-03 requires the absolute checked geckodriver 0.36.0 executable");
  }
  if (!isAbsolute(temporaryRoot)) throw new Error("FFX-03 temporary root must be absolute");

  const port = 4446;
  const baseline = matchingProcesses(geckodriverPath, port, platform);
  const service = new ServiceBuilder(geckodriverPath)
    .setPort(port)
    .setEnvironment({ ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot })
    .build();
  const options = new Options().setBinary(browser.executable);
  if (contract.channel === "nightly") options.setPreference("dom.webgpu.enabled", true);
  let driver;
  let driverPid = null;
  let firefoxPid = null;
  try {
    const server = await service.start();
    driverPid = await waitForNewProcess(geckodriverPath, port, baseline, platform);
    registerProcess(processRegistryPath, "geckodriver", driverPid);
    driver = await new Builder()
      .disableEnvironmentOverrides()
      .forBrowser("firefox")
      .setFirefoxOptions(options)
      .usingServer(server)
      .build();
    await driver.manage().setTimeouts({
      implicit: 0, pageLoad: LONG_SCRIPT_TIMEOUT_MS, script: LONG_SCRIPT_TIMEOUT_MS,
    });
    const capabilities = await driver.getCapabilities();
    const plainCapabilities = Object.fromEntries(capabilities.entries());
    const observedBrowser = {
      name: String(capabilities.get("browserName") ?? ""),
      channel: contract.channel,
      version: String(capabilities.getBrowserVersion() ?? capabilities.get("version") ?? ""),
    };
    assertFfx03BrowserVersion(observedBrowser.version, contract);
    if (observedBrowser.name.toLowerCase() !== "firefox" ||
        observedBrowser.version !== browser.version ||
        String(capabilities.get("platformName") ?? "").toLowerCase() !== expectedPlatformName(platform) ||
        String(capabilities.get("moz:geckodriverVersion") ?? "") !== geckodriverVersion) {
      throw new Error("FFX-03 returned capabilities do not match checked browser, driver, or platform inventory");
    }
    firefoxPid = Number(capabilities.get("moz:processID"));
    if (!Number.isInteger(firefoxPid) || firefoxPid < 1) {
      throw new Error("FFX-03 Firefox capability omitted moz:processID");
    }
    const profilePath = confinedProfilePath(capabilities.get("moz:profile"), temporaryRoot);
    const preferencesBefore = observeWebGpuPreferences(profilePath);
    assertPreferenceContract(preferencesBefore, contract);
    const launch = observeLaunch({
      runtime: { driver: "selenium-firefox", browser: "firefox" },
      session: { capabilities: plainCapabilities }, platform,
    });
    const observedExecutable = resolve(launch.observedExecutable ?? "");
    const checkedExecutable = resolve(browser.executable);
    if ((platform === "win32" ? observedExecutable.toLowerCase() : observedExecutable) !==
        (platform === "win32" ? checkedExecutable.toLowerCase() : checkedExecutable)) {
      throw new Error("FFX-03 observed Firefox executable does not match checked inventory");
    }
    await driver.get(routeUrl);
    return {
      driver,
      browser: observedBrowser,
      driverVersion: geckodriverVersion,
      driverExecutable: geckodriverPath,
      browserExecutable: browser.executable,
      clientVersion: FFX03_SELENIUM_VERSION,
      capabilities: plainCapabilities,
      profilePath,
      firefoxPid,
      driverPid,
      contract,
      launch,
      ...launch,
      configurationBefore: configurationEvidence(contract, profilePath, preferencesBefore),
      async runPage(payload) {
        const result = contract.required
          ? await runStableFirefoxAcceptance({ driver, payload })
          : await runNightlyFirefoxProbe({ driver, payload });
        const preferencesAfter = observeWebGpuPreferences(profilePath);
        assertPreferenceContract(preferencesAfter, contract);
        result.configuration = {
          ...configurationEvidence(contract, profilePath, preferencesBefore),
          afterWorkload: preferencesAfter,
        };
        return result;
      },
      async assertHealthy() {
        if (new URL(await driver.getCurrentUrl()).href !== new URL(routeUrl).href) {
          throw new Error("INFRA_ERROR BROWSER_ROUTE_CHANGED");
        }
      },
      async close() {
        return cleanupFirefox({ driver, service, driverPid, firefoxPid, baseline,
          geckodriverPath, port, platform, processRegistryPath, markProcessStopped });
      },
    };
  } catch (error) {
    const cleanup = await cleanupFirefox({ driver, service, driverPid, firefoxPid, baseline,
      geckodriverPath, port, platform, processRegistryPath, markProcessStopped }).catch(() => null);
    if (cleanup?.ok !== true) {
      throw new AggregateError([error, new Error("INFRA_ERROR FIREFOX_CLEANUP_UNPROVEN")],
        "Firefox setup failed and cleanup was not proven");
    }
    error.cleanup = cleanup;
    throw error;
  }
}

export async function runStableFirefoxAcceptance({ driver, payload }) {
  const observedErrors = [];
  await installErrorCollectors(driver);
  const preflight = await executeHardwarePreflight(driver, payload);
  await initializeInteractionViewer(driver);
  const canvas = await driver.findElement(By.id("viewer"));
  const orbit = await nativeAction(driver, async () => driver.actions({ async: true })
    .move({ origin: canvas, x: 0, y: 0 }).press(Button.LEFT)
    .move({ origin: canvas, x: 70, y: 35, duration: 200 }).release(Button.LEFT).perform());
  const pan = await nativeAction(driver, async () => driver.actions({ async: true })
    .move({ origin: canvas, x: 0, y: 0 }).press(Button.RIGHT)
    .move({ origin: canvas, x: 45, y: 25, duration: 200 }).release(Button.RIGHT).perform());
  const wheel = await nativeAction(driver, async () => driver.actions({ async: true })
    .scroll(0, 0, 0, -160, canvas).perform());
  const pointerCapture = await pointerCaptureAction(driver, canvas);
  const keyboard = await keyboardActions(driver, canvas);
  const autoResize = await resizeAction(driver);
  const visibility = await actualVisibilityTransition(driver);
  await driver.executeScript("window.__forge3dInteractiveViewer.dispose()");
  const hardware = {
    driver: {
      orbitChanged: orbit.changed,
      panChanged: pan.changed,
      wheelChanged: wheel.changed,
      pointerCapture,
      keyboard,
      autoResize,
    },
    visibility,
    systemInfo: { available: false, diagnosticOnly: true, value: null,
      unavailableReason: "Firefox WebDriver exposes no Chromium SystemInfo domain" },
    observedErrors,
  };
  assertInteractiveObservations(hardware);
  const result = await executeHardwarePage(driver, { ...payload, preflight, hardware });
  const browserErrors = await driver.executeScript("return [...(window.__forge3dHardwareErrors ?? [])]");
  result.ffx03Workload.errors = [...new Set([...result.ffx03Workload.errors, ...browserErrors])];
  if (!Object.values(result.ffx03Workload.behaviors).every((passed) => passed === true)) {
    throw new Error("Firefox interactive acceptance failed its browser product assertions");
  }
  if (result.ffx03Workload.errors.length !== 0) {
    throw new Error("Firefox page workload reported browser errors");
  }
  return result;
}

export async function runNightlyFirefoxProbe({ driver, payload }) {
  try {
    const result = await runStableFirefoxAcceptance({ driver, payload });
    return { ...result, probeOutcome: "PROBE_PASS" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/WEBGPU_UNAVAILABLE|ATTESTATION_UNAVAILABLE|adapter|device|surface/iu.test(message)) {
      return {
        probeOutcome: "UNAVAILABLE",
        diagnostic: message,
      };
    }
    if (/Firefox interaction viewer failed|Firefox did not observe|Firefox interactive acceptance failed|Firefox page workload reported|browser-neutral installed-package assertions failed|required branded browser lane|terrain source did not submit|viewer screenshot|lifecycle cycle|browser-owned assertion|workload behavior evidence is incomplete/iu.test(message)) {
      return { probeOutcome: "PRODUCT_FAILURE", diagnostic: message };
    }
    throw error;
  }
}

function assertInteractiveObservations(hardware) {
  if (hardware.driver.orbitChanged !== true || hardware.driver.panChanged !== true ||
      hardware.driver.wheelChanged !== true || hardware.driver.pointerCapture?.captured !== true ||
      hardware.driver.pointerCapture?.released !== true ||
      hardware.driver.pointerCapture?.outsideMoveChanged !== true ||
      hardware.driver.pointerCapture?.activePointersAfter !== 0 ||
      Object.values(hardware.driver.keyboard).length !== 5 ||
      !Object.values(hardware.driver.keyboard).every((event) => event.changed === true) ||
      Object.values(hardware.driver.autoResize).length !== 3 ||
      !Object.values(hardware.driver.autoResize).every(Boolean) ||
      hardware.visibility.actualDocumentVisibilityTransitions !== true) {
    throw new Error("Firefox interactive acceptance failed its browser product assertions");
  }
}

async function initializeInteractionViewer(driver) {
  await driver.wait(until.elementLocated(By.id("viewer")), 15_000);
  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const fixture = window.__forge3dInteractiveViewer;
      const viewer = await fixture.create({ resize: true, controls: { keyboard: true },
        onError: window.__forge3dHardwareOnError });
      window.__forge3dFirefoxPointer = { got: [], lost: [] };
      fixture.canvas.addEventListener("gotpointercapture", (event) => window.__forge3dFirefoxPointer.got.push(event.pointerId));
      fixture.canvas.addEventListener("lostpointercapture", (event) => window.__forge3dFirefoxPointer.lost.push(event.pointerId));
      for (let i = 0; i < 120 && viewer.getDiagnostics().submittedFrames < 1; i += 1)
        await new Promise((resolve) => requestAnimationFrame(resolve));
      done({ ready: viewer.status === "ready" });
    })().catch((error) => done({ error: String(error && error.message || error) }));
  `);
  if (result?.ready !== true) throw new Error(`Firefox interaction viewer failed: ${result?.error ?? "not ready"}`);
}

async function installErrorCollectors(driver) {
  await driver.executeScript(`
    window.__forge3dHardwareErrors = [];
    window.__forge3dHardwareOnError = (error) => window.__forge3dHardwareErrors.push(String(error && error.message || error));
    window.addEventListener("error", (event) => window.__forge3dHardwareErrors.push(String(event.error?.message ?? event.message)));
    window.addEventListener("unhandledrejection", (event) => window.__forge3dHardwareErrors.push(String(event.reason?.message ?? event.reason)));
    window.__forge3dFirefoxVisibility = [];
    document.addEventListener("visibilitychange", () => window.__forge3dFirefoxVisibility.push({
      state: document.visibilityState,
      diagnostics: window.__forge3dInteractiveViewer.viewer?.getDiagnostics() ?? null,
    }));
  `);
}

async function executeHardwarePage(driver, payload) {
  const result = await driver.executeAsyncScript(`
    const payload = arguments[0], done = arguments[arguments.length - 1];
    import(new URL("hardware-page-harness.js", location.href).href)
      .then((module) => module.runHardwarePage(payload))
      .then((value) => done({ ok: true, value }))
      .catch((error) => done({ ok: false, error: String(error && error.message || error) }));
  `, payload);
  if (result?.ok !== true) throw new Error(result?.error ?? "INFRA_ERROR FIREFOX_PAGE_FAILED");
  return result.value;
}

async function executeHardwarePreflight(driver, payload) {
  const result = await driver.executeAsyncScript(`
    const payload = arguments[0], done = arguments[arguments.length - 1];
    import(new URL("hardware-page-harness.js", location.href).href)
      .then((module) => module.runHardwarePreflight(payload))
      .then((value) => done({ ok: true, value }))
      .catch((error) => done({ ok: false, error: String(error && error.message || error) }));
  `, { binding: payload.binding, route: payload.route,
    effectiveLaunchArguments: payload.effectiveLaunchArguments, supportAssertions: true });
  if (result?.ok !== true) throw new Error(result?.error ?? "INFRA_ERROR FIREFOX_PREFLIGHT_FAILED");
  return result.value;
}

async function nativeAction(driver, perform) {
  const before = await snapshot(driver);
  await perform();
  const after = await waitForFreshSnapshot(driver, before.submittedFrames);
  return { before, after, changed: changedView(before.view, after.view) };
}

export async function pointerCaptureAction(driver, canvas) {
  const before = await snapshot(driver);
  await driver.executeScript(`window.__forge3dFirefoxPointer = { got: [], lost: [] }`);
  const rect = await canvas.getRect();
  await driver.actions({ async: true }).move({ origin: canvas, x: 0, y: 0 })
    .press(Button.LEFT).move({ x: Math.ceil(rect.x + rect.width + 40), y: Math.max(0, Math.floor(rect.y - 20)),
      origin: "viewport", duration: 200 }).perform();
  const held = await driver.executeScript(`return { view: window.__forge3dInteractiveViewer.viewer.getView(),
    diagnostics: window.__forge3dInteractiveViewer.viewer.getDiagnostics(),
    got: [...window.__forge3dFirefoxPointer.got] }`);
  await driver.actions({ async: true }).release(Button.LEFT).perform();
  const released = await driver.executeScript(`return { diagnostics: window.__forge3dInteractiveViewer.viewer.getDiagnostics(),
    lost: [...window.__forge3dFirefoxPointer.lost] }`);
  const pointerId = held.got.at(-1) ?? null;
  return { pointerId, capturedPointerId: pointerId, releasedPointerId: released.lost.at(-1) ?? null,
    captured: Number.isInteger(pointerId) && held.diagnostics.activePointers === 1,
    outsideMoveChanged: changedView(before.view, held.view),
    released: Number.isInteger(pointerId) && released.lost.includes(pointerId),
    activePointersAfter: released.diagnostics.activePointers };
}

export async function keyboardActions(driver, canvas) {
  await canvas.click();
  const actions = [
    ["orbit", Key.ARROW_RIGHT, "ArrowRight"], ["pan", Key.chord(Key.SHIFT, Key.ARROW_RIGHT), "Shift+ArrowRight"],
    ["zoomIn", Key.EQUALS, "Equal"], ["zoomOut", "-", "Minus"], ["reset", Key.HOME, "Home"],
  ];
  const result = {};
  for (const [name, input, key] of actions) {
    const before = await snapshot(driver); await canvas.sendKeys(input);
    const after = await waitForFreshSnapshot(driver, before.submittedFrames);
    result[name] = { key, changed: changedView(before.view, after.view) };
  }
  return result;
}

async function resizeAction(driver) {
  return driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => { const fixture = window.__forge3dInteractiveViewer, viewer = fixture.viewer;
      const before = { w: fixture.canvas.width, h: fixture.canvas.height, f: viewer.getDiagnostics().submittedFrames };
      const observerActive = viewer.getDiagnostics().activeObservers > 0;
      fixture.canvas.style.width = "280px"; fixture.canvas.style.height = "240px";
      for (let i = 0; i < 120; i += 1) { await new Promise((r) => requestAnimationFrame(r));
        if (viewer.getDiagnostics().submittedFrames > before.f && (fixture.canvas.width !== before.w || fixture.canvas.height !== before.h)) break; }
      const after = viewer.getDiagnostics();
      done({ observerActive, dimensionsChanged: fixture.canvas.width !== before.w || fixture.canvas.height !== before.h,
        submittedFrame: after.submittedFrames > before.f }); })().catch((error) => done({ error: String(error) }));
  `);
}

async function actualVisibilityTransition(driver) {
  const viewerHandle = await driver.getWindowHandle();
  await driver.switchTo().newWindow("tab");
  const coverHandle = await driver.getWindowHandle();
  try {
    await driver.get("about:blank");
    await driver.switchTo().window(viewerHandle);
    const before = await snapshot(driver);
    await driver.switchTo().window(coverHandle);
    await driver.sleep(100);
    await driver.switchTo().window(viewerHandle);
    const after = await waitForFreshSnapshot(driver, before.submittedFrames);
    const events = await driver.executeScript("return [...(window.__forge3dFirefoxVisibility ?? [])]");
    const transitions = events.filter((event) => event.state === "hidden" || event.state === "visible");
    const hidden = transitions.at(-2), visible = transitions.at(-1);
    if (hidden?.state !== "hidden" || visible?.state !== "visible" ||
        hidden.diagnostics?.pendingAnimationFrame !== false ||
        hidden.diagnostics?.ownedAnimationFrameCount !== 0 ||
        visible.diagnostics?.submittedFrames !== hidden.diagnostics?.submittedFrames ||
        visible.diagnostics?.skippedFrames !== hidden.diagnostics?.skippedFrames ||
        after.submittedFrames !== before.submittedFrames + 1 ||
        after.skippedFrames !== before.skippedFrames ||
        after.ownedListeners !== before.ownedListeners ||
        after.activeObservers !== before.activeObservers ||
        after.activeRuntimes !== before.activeRuntimes) {
      throw new Error("Firefox did not observe one ordered hidden/visible transition and one fresh resumed frame");
    }
    return { actualDocumentVisibilityTransitions: true, visibilityStateSource: "actual-document", cycleCount: 1,
      cycles: [{ cycle: 1, hiddenPendingFrameCancelled: true, visibleFrame: "submitted" }],
      final: { visibilityState: await driver.executeScript("return document.visibilityState") }, events };
  } finally {
    await driver.switchTo().window(coverHandle); await driver.close();
    await driver.switchTo().window(viewerHandle);
  }
}

async function snapshot(driver) {
  return driver.executeScript("const v=window.__forge3dInteractiveViewer.viewer; return {view:v.getView(), ...v.getDiagnostics()}");
}

async function waitForFreshSnapshot(driver, before) {
  await driver.wait(async () => (await snapshot(driver)).submittedFrames > before, 10_000);
  return snapshot(driver);
}

function changedView(left, right) { return JSON.stringify(left) !== JSON.stringify(right); }

export function observeWebGpuPreferences(profilePath) {
  const observed = {};
  for (const name of ["user.js", "prefs.js"]) {
    const path = resolve(profilePath, name);
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PROFILE_READ_LIMIT ||
        relative(realpathSync(profilePath), realpathSync(path)).startsWith("..")) {
      throw new Error("Firefox profile preference source is unsafe");
    }
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      if (!line.includes("dom.webgpu.")) continue;
      const match = line.match(/^user_pref\("(dom\.webgpu\.[A-Za-z0-9._-]+)",\s*(true|false|-?[0-9]+|"(?:[^"\\]|\\.)*")\);$/u);
      if (!match) throw new Error("Firefox profile contains a malformed relevant preference");
      const value = match[2] === "true" ? true : match[2] === "false" ? false
        : match[2].startsWith('"') ? JSON.parse(match[2]) : Number(match[2]);
      if (Object.hasOwn(observed, match[1]) && observed[match[1]] !== value) {
        throw new Error("Firefox profile contains conflicting WebGPU preferences");
      }
      observed[match[1]] = value;
    }
  }
  return observed;
}

function assertPreferenceContract(preferences, contract) {
  const keys = Object.keys(preferences).sort();
  if (contract.channel === "release" && keys.length !== 0) {
    throw new Error("stable Firefox must use default WebGPU configuration without user overrides");
  }
  if (contract.channel === "nightly" &&
      (keys.length !== 1 || keys[0] !== "dom.webgpu.enabled" || preferences[keys[0]] !== true)) {
    throw new Error("Firefox Nightly requires exactly dom.webgpu.enabled=true and no unsafe WebGPU overrides");
  }
}

function configurationEvidence(contract, profilePath, observed) {
  return { source: "geckodriver-generated-profile-observation", freshProfile: true,
    profilePathSha256: createHash("sha256").update(profilePath).digest("hex"),
    requestedOverrides: contract.channel === "nightly" ? { "dom.webgpu.enabled": true } : {},
    observedWebGpuUserOverrides: observed };
}

function confinedProfilePath(value, temporaryRoot) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("Firefox moz:profile is not an absolute generated profile");
  const root = realpathSync(temporaryRoot), profile = realpathSync(value);
  if (profile === root || relative(root, profile).startsWith("..")) throw new Error("Firefox profile escaped the job temporary root");
  if (!lstatSync(profile).isDirectory() || lstatSync(profile).isSymbolicLink()) throw new Error("Firefox profile is not a regular generated directory");
  return profile;
}

function validateBrowserInventory(browser, contract) {
  if (!browser || browser.id !== `firefox-${contract.channel}` || browser.channel !== contract.channel ||
      browser.classification !== contract.classification || !isAbsolute(browser.executable)) {
    throw new Error("FFX-03 selected Firefox inventory does not match the closed lane channel");
  }
  assertFfx03BrowserVersion(browser.version, contract);
}

function expectedPlatformName(platform) { return platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux"; }

export async function cleanupFirefox({ driver, service, driverPid, firefoxPid, baseline, geckodriverPath, port,
  platform, processRegistryPath, markProcessStopped,
  waitForNoNewProcessFn = waitForNoNewProcess, waitForPidAbsentFn = waitForPidAbsent }) {
  let sessionDeleted = driver ? false : null;
  let driverStopped = false;
  let driverAbsent = false;
  let browserAbsent = firefoxPid === null;
  const errors = [];
  if (driver) try { await driver.quit(); sessionDeleted = true; } catch (error) { errors.push(error); }
  try { await service.kill(); driverStopped = true; } catch (error) { errors.push(error); }
  try {
    driverAbsent = await waitForNoNewProcessFn(geckodriverPath, port, baseline, platform);
  } catch (error) { errors.push(error); }
  try {
    browserAbsent = firefoxPid === null ? true : await waitForPidAbsentFn(firefoxPid);
  } catch (error) { errors.push(error); }
  const cleanup = { sessionDeleted, driverStopped, driverAbsent, browserAbsent,
    ok: sessionDeleted !== false && driverStopped && driverAbsent && browserAbsent };
  if (!cleanup.ok || errors.length) throw new AggregateError(errors.length ? errors : [new Error("cleanup state incomplete")],
    "INFRA_ERROR FIREFOX_CLEANUP_UNPROVEN");
  if (driverPid) markProcessStopped(processRegistryPath, driverPid);
  return cleanup;
}

export function matchingProcesses(executable, port, platform, execute = execFileSync) {
  if (platform === "win32") {
    const output = execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8" });
    let parsed;
    try { parsed = JSON.parse(output); } catch { throw new Error("process inspection returned malformed Windows JSON"); }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (!rows.every((row) => row && typeof row === "object" && !Array.isArray(row) &&
      typeof row.ProcessId === "number" && Number.isInteger(row.ProcessId) && row.ProcessId >= 0 &&
      (row.CommandLine === null || typeof row.CommandLine === "string"))) {
      throw new Error("process inspection returned malformed Windows rows");
    }
    return new Set(rows.filter((row) => row.ProcessId > 0 && String(row.CommandLine ?? "").includes(executable) &&
      String(row.CommandLine).includes(String(port))).map((row) => Number(row.ProcessId)));
  }
  const output = execute("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const rows = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!rows.every((line) => /^[1-9][0-9]*\s+.+$/u.test(line))) {
    throw new Error("process inspection returned malformed process rows");
  }
  return new Set(rows.filter((line) => line.includes(executable) && line.includes(String(port)))
    .map((line) => Number(line.match(/^([1-9][0-9]*)\s/u)[1])));
}

export async function waitForNewProcess(executable, port, baseline, platform,
  { inspect = matchingProcesses, attempts = 100, delay = defaultDelay } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const match = [...inspect(executable, port, platform)].find((pid) => !baseline.has(pid));
    if (match) return match;
    await delay();
  }
  throw new Error("geckodriver live process was not observed");
}

export async function waitForNoNewProcess(executable, port, baseline, platform,
  { inspect = matchingProcesses, attempts = 100, delay = defaultDelay } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ([...inspect(executable, port, platform)].every((pid) => baseline.has(pid))) return true;
    await delay();
  }
  return false;
}

export async function waitForPidAbsent(pid,
  { inspect = (candidate) => process.kill(candidate, 0), attempts = 100, delay = defaultDelay } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { inspect(pid); } catch (error) { if (error?.code === "ESRCH") return true; throw error; }
    await delay();
  }
  return false;
}

function defaultDelay() { return new Promise((resolvePromise) => setTimeout(resolvePromise, 50)); }
