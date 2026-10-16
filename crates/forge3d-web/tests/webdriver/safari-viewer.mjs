import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";

import webdriver from "selenium-webdriver";
import safari from "selenium-webdriver/safari.js";

const { Builder, Button, By, Key, until } = webdriver;
const { Options, ServiceBuilder } = safari;

export const SAF03_SELENIUM_VERSION = "4.35.0";
const VIEW_TOLERANCE = 1e-9;
const ERROR_LEDGER_KEY = "forge3d-saf03-error-ledger-v1";
const ERROR_LEDGER_FAILURE = "collector:persistence-failure";

export async function openSeleniumSafariSession({
  routeUrl,
  safaridriverPath,
  safaridriverVersion,
  browserVersion,
  technologyPreview = false,
  port = technologyPreview ? 4447 : 4445,
}) {
  const baselineDriverPids = matchingDriverPids(safaridriverPath, port);
  const service = new ServiceBuilder(safaridriverPath).setPort(port).build();
  let driver;
  let driverPid;
  try {
    const serviceUrl = await service.start();
    driverPid = await waitForNewDriverPid(safaridriverPath, port, baselineDriverPids);
    const options = new Options();
    if (technologyPreview) options.setTechnologyPreview(true);
    driver = await new Builder()
      .forBrowser("safari")
      .setSafariOptions(options)
      .usingServer(serviceUrl)
      .build();
    const capabilities = await driver.getCapabilities();
    const observedVersion = String(capabilities.getBrowserVersion() ?? capabilities.get("version") ?? "");
    if (observedVersion !== browserVersion) {
      throw new Error("Safari Selenium session version does not match checked inventory");
    }
    await initializeErrorLedgerBeforeNavigation(driver, routeUrl);
    return {
      driver,
      browser: {
        name: "safari",
        channel: technologyPreview ? "technology-preview" : "stable",
        version: observedVersion,
      },
      driverVersion: safaridriverVersion,
      driverPid,
      clientVersion: SAF03_SELENIUM_VERSION,
      async close() {
        let sessionDeleted = false;
        let driverStopped = false;
        let processAbsent = false;
        try {
          await driver.quit();
          sessionDeleted = true;
        } finally {
          await service.kill();
          driverStopped = true;
          processAbsent = await waitForNoNewDriverProcess(safaridriverPath, port, baselineDriverPids);
        }
        const cleanup = { sessionDeleted, driverStopped, processAbsent, ok: sessionDeleted && driverStopped && processAbsent };
        if (!cleanup.ok) throw new Error("INFRA_ERROR SAFARIDRIVER_CLEANUP_UNPROVEN");
        return cleanup;
      },
    };
  } catch (error) {
    let sessionDeleted = null;
    if (driver) sessionDeleted = await driver.quit().then(() => true, () => false);
    const driverStopped = await service.kill().then(() => true, () => false);
    const processAbsent = await waitForNoNewDriverProcess(safaridriverPath, port, baselineDriverPids).catch(() => false);
    const cleanup = { notStarted: false, sessionDeleted, driverStopped, processAbsent,
      ok: driverStopped && processAbsent && sessionDeleted !== false };
    if (!cleanup.ok) throw new Error("INFRA_ERROR SAFARIDRIVER_CLEANUP_UNPROVEN", { cause: error });
    const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error });
    failure.cleanup = cleanup;
    throw failure;
  }
}

export async function runStableSafariAcceptance({
  session,
  binding,
  route,
  adapter,
  system,
  benchmarkEnvironment,
}) {
  const { driver } = session;
  const errors = [];
  await initializeViewer(driver);
  const initial = await snapshot(driver);
  const canvas = await driver.findElement(By.id("viewer"));

  const orbit = await nativeAction(driver, "orbit", async () => {
    await driver.actions({ async: true })
      .move({ origin: canvas, x: 0, y: 0 })
      .press(Button.LEFT)
      .move({ origin: canvas, x: 70, y: 35, duration: 250 })
      .release(Button.LEFT)
      .perform();
  });
  const pan = await nativeAction(driver, "pan", async () => {
    await driver.actions({ async: true })
      .move({ origin: canvas, x: 0, y: 0 })
      .press(Button.RIGHT)
      .move({ origin: canvas, x: 45, y: 25, duration: 250 })
      .release(Button.RIGHT)
      .perform();
  });
  const wheelZoom = await nativeAction(driver, "wheelZoom", async () => {
    await driver.actions({ async: true })
      .scroll(0, 0, 0, -160, canvas)
      .perform();
  });
  const resetBefore = await snapshot(driver);
  await canvas.click();
  await canvas.sendKeys(Key.HOME);
  const resetAfter = await waitForFreshSnapshot(driver, resetBefore.submittedFrames);
  const reset = {
    action: "reset", native: true, key: "Home", before: resetBefore, after: resetAfter,
    initialView: initial.view, tolerance: VIEW_TOLERANCE,
    matchedInitial: viewsClose(resetAfter.view, initial.view, VIEW_TOLERANCE),
  };

  const resizeBefore = await readSizes(driver);
  const resizeBeforeSnapshot = await snapshot(driver);
  const resizeFrames = resizeBeforeSnapshot.submittedFrames;
  await driver.findElement(By.id("resize")).click();
  const resizeSnapshot = await waitForFreshSnapshot(driver, resizeFrames);
  const resizeAfter = await readSizes(driver);
  const resize = {
    action: "resize", native: true, fixtureControl: "#resize",
    cssBefore: resizeBefore.css, cssAfter: resizeAfter.css,
    backingBefore: resizeBefore.backing, backingAfter: resizeAfter.backing,
    submittedFrameFresh: resizeSnapshot.submittedFrames > resizeFrames,
    pixelsBefore: resizeBeforeSnapshot.pixels,
    pixelsAfter: resizeSnapshot.pixels,
  };

  const box = await canvas.getRect();
  const nativeBytes = Buffer.from(await driver.takeScreenshot(), "base64");
  const viewport = await driver.executeScript("return { width: window.innerWidth, height: window.innerHeight }");
  const screenshotWidth = nativeBytes.readUInt32BE(16);
  const screenshotHeight = nativeBytes.readUInt32BE(20);
  const nativeScreenshot = decodePngEvidence(nativeBytes, {
    left: box.x * screenshotWidth / viewport.width,
    top: box.y * screenshotHeight / viewport.height,
    width: box.width * screenshotWidth / viewport.width,
    height: box.height * screenshotHeight / viewport.height,
  });
  const viewerScreenshot = await viewerScreenshotEvidence(driver);
  const visibilityCover = await openVisibilityCover(driver, route.applicationUrl);
  const lifecycleState = await viewerState(driver);
  const lifecycleBaseline = {
    documentIdentity: lifecycleState.lifecycle.documentIdentity,
    viewerIdentity: lifecycleState.lifecycle.viewerIdentity,
    lastEventSequence: lifecycleState.lifecycle.events.at(-1)?.sequence ?? 0,
    ownership: ownership(lifecycleState.diagnostics),
  };
  const visibilityCycles = await runVisibilityCycles(driver, visibilityCover);
  const bfcacheCycles = await runBfcacheCycles(driver, route.applicationUrl, new URL("test-lifecycle-away.html", route.applicationUrl).href);
  const beforeReloadErrors = await capturedErrors(driver);
  const hardReload = await runHardReloadControl(driver);
  const boundaryLedger = await capturedErrors(driver);
  const benchmark = await runBenchmark(driver, route.applicationUrl, benchmarkEnvironment);
  await driver.executeScript("window.__forge3dInteractiveViewer.dispose()");
  const disposal = ownership((await viewerState(driver)).diagnostics);
  const finalLedger = await capturedErrors(driver);
  const { reloadBoundary: reloadBoundaryErrors, afterReload: afterReloadErrors } =
    partitionReloadErrorLedger(beforeReloadErrors, boundaryLedger, finalLedger);
  errors.push(...beforeReloadErrors, ...reloadBoundaryErrors, ...afterReloadErrors);

  return {
    schemaVersion: 1,
    kind: "forge3d-saf03-safari-acceptance-v1",
    binding: {
      lane: binding.lane, assetId: binding.assetId, platform: "darwin",
      commit: binding.commit, packageSha256: binding.packageSha256,
    },
    browser: session.browser,
    driver: {
      name: "safaridriver", version: session.driverVersion,
      executable: "/usr/bin/safaridriver", clientName: "selenium-webdriver",
      clientVersion: SAF03_SELENIUM_VERSION,
    },
    system: { platform: "darwin", osVersion: system.osVersion, osBuild: system.osBuild, architecture: system.architecture },
    secureContext: await driver.executeScript("return window.isSecureContext === true"),
    adapter,
    actions: { orbit, pan, wheelZoom, reset, resize },
    screenshots: { native: nativeScreenshot, viewer: viewerScreenshot },
    lifecycleBaseline,
    visibilityCycles,
    bfcacheCycles,
    hardReload,
    disposal,
    benchmark,
    errorObservations: { beforeReload: beforeReloadErrors, reloadBoundary: reloadBoundaryErrors, afterReload: afterReloadErrors },
    errors,
  };
}

export function partitionReloadErrorLedger(beforeReload, boundaryLedger, finalLedger) {
  for (const [label, values] of [["before reload", beforeReload], ["reload boundary", boundaryLedger], ["after reload", finalLedger]]) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string") || values.length > 100) {
      throw new Error(`SAF-03 ${label} error ledger is malformed or unbounded`);
    }
  }
  const hasPrefix = (values, prefix) => prefix.every((value, index) => values[index] === value);
  if (!hasPrefix(boundaryLedger, beforeReload) || !hasPrefix(finalLedger, boundaryLedger)) {
    throw new Error("SAF-03 reload error ledger lost same-tab boundary observations");
  }
  return {
    reloadBoundary: boundaryLedger.slice(beforeReload.length),
    afterReload: finalLedger.slice(boundaryLedger.length),
  };
}

export async function runSafariTechnologyPreviewProbe({ session, binding, route }) {
  try {
    await initializeViewer(session.driver);
    const screenshot = await viewerScreenshotEvidence(session.driver);
    const state = await viewerState(session.driver);
    if (state.diagnostics.submittedFrames < 1 || screenshot.pixels.nonBlank !== true) {
      throw new Error("viewer did not render decoded terrain pixels");
    }
    if (!Array.isArray(state.errors) || state.errors.length !== 0) {
      throw new Error(`viewer reported errors: ${(state.errors ?? []).join(" | ")}`);
    }
    return {
      schemaVersion: 1,
      binding: { lane: binding.lane, assetId: binding.assetId, commit: binding.commit, packageSha256: binding.packageSha256 },
      route: route.applicationUrl,
      submittedFrames: state.diagnostics.submittedFrames,
      screenshot,
      errors: state.errors,
    };
  } catch (error) {
    throw new Error(`STP_PRODUCT_FAILURE ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function initializeViewer(driver) {
  await driver.wait(until.elementLocated(By.id("viewer")), 15_000);
  await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const fixture = window.__forge3dInteractiveViewer;
      const viewer = await fixture.create({ resize: true, controls: { keyboard: true }, onError: (error) => {
        if (typeof window.__forge3dSafariRecordError !== "function") throw new Error("SAF-03 error collector is unavailable");
        window.__forge3dSafariRecordError("viewer.onError:" + String(error && error.message || error));
      }});
      const lifecycle = window.__forge3dSafariLifecycle;
      lifecycle.viewerIdentity ??= crypto.randomUUID();
      for (let attempt = 0; attempt < 120 && viewer.getDiagnostics().submittedFrames === 0; attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      done({ ok: viewer.status === "ready" });
    })().catch((error) => done({ ok: false, error: String(error && error.message || error) }));
  `);
  const ready = await driver.executeScript("return window.__forge3dInteractiveViewer.viewer?.status");
  if (ready !== "ready") throw new Error("stable Safari viewer did not become ready");
}

async function nativeAction(driver, action, perform) {
  const before = await snapshot(driver);
  await perform();
  const after = await waitForFreshSnapshot(driver, before.submittedFrames);
  return { action, native: true, before, after, changed: !viewsClose(before.view, after.view, VIEW_TOLERANCE) };
}

async function openVisibilityCover(driver, fixtureUrl) {
  const awayUrl = new URL("test-lifecycle-away.html", fixtureUrl);
  if (awayUrl.origin !== new URL(fixtureUrl).origin) throw new Error("visibility cover must be same-origin");
  const viewerHandle = await driver.getWindowHandle();
  await driver.switchTo().newWindow("tab");
  const coverHandle = await driver.getWindowHandle();
  await driver.get(awayUrl.href);
  if (new URL(await driver.getCurrentUrl()).origin !== awayUrl.origin) throw new Error("visibility cover navigated off origin");
  await driver.switchTo().window(viewerHandle);
  return { viewerHandle, coverHandle, awayUrl: awayUrl.href };
}

async function runVisibilityCycles(driver, { viewerHandle, coverHandle }) {
  const cycles = [];
  for (let cycle = 1; cycle <= 30; cycle += 1) {
    const stateBefore = await viewerState(driver);
    const eventCount = stateBefore.lifecycle.events.length;
    await driver.switchTo().window(coverHandle);
    await driver.sleep(100);
    await driver.switchTo().window(viewerHandle);
    await driver.wait(async () => (await lifecycle(driver)).events.length >= eventCount + 2, 10_000);
    const events = (await lifecycle(driver)).events.slice(eventCount);
    const visibilityEvents = events.filter((event) => event.type === "visibilitychange");
    if (visibilityEvents.length !== 2 || visibilityEvents[0].state !== "hidden" || visibilityEvents[1].state !== "visible") {
      throw new Error(`visibility cycle ${cycle} did not emit exactly one ordered hidden/visible pair`);
    }
    const [hiddenEvent, visibleEvent] = visibilityEvents;
    const after = await invalidateAndSnapshot(driver, stateBefore.diagnostics.submittedFrames, cycle);
    const afterState = await viewerState(driver);
    cycles.push(cycleRecord(cycle, stateBefore, after, afterState, { hiddenEvent, visibleEvent }));
  }
  return cycles;
}

async function runBfcacheCycles(driver, fixtureUrl, awayUrl) {
  const cycles = [];
  for (let cycle = 1; cycle <= 30; cycle += 1) {
    const before = await viewerState(driver);
    const eventCount = before.lifecycle.events.length;
    await driver.get(awayUrl);
    await driver.navigate().back();
    await driver.wait(async () => Boolean(await driver.executeScript("return window.__forge3dInteractiveViewer?.viewer")), 15_000);
    const restored = await viewerState(driver);
    if (new URL(await driver.getCurrentUrl()).href !== new URL(fixtureUrl).href) throw new Error("BFCache returned to the wrong fixture URL");
    const events = restored.lifecycle.events.slice(eventCount).filter((event) => event.type === "pagehide" || event.type === "pageshow");
    const after = await invalidateAndSnapshot(driver, before.diagnostics.submittedFrames, 100 + cycle);
    const afterState = await viewerState(driver);
    cycles.push(cycleRecord(cycle, before, after, afterState, { events }));
  }
  return cycles;
}

async function runHardReloadControl(driver) {
  const previous = await viewerState(driver);
  await driver.navigate().refresh();
  await initializeViewer(driver);
  const current = await viewerState(driver);
  const pageshow = current.lifecycle.events.find((event) => event.type === "pageshow");
  const fresh = await waitForFreshSnapshot(driver, -1);
  return {
    pageshowPersisted: pageshow?.persisted ?? null,
    previousDocumentIdentity: previous.lifecycle.documentIdentity,
    documentIdentity: current.lifecycle.documentIdentity,
    previousViewerIdentity: previous.lifecycle.viewerIdentity,
    viewerIdentity: current.lifecycle.viewerIdentity,
    submittedFrameFresh: fresh.submittedFrames > 0,
    ownership: ownership(current.diagnostics),
    pixels: fresh.pixels,
  };
}

async function runBenchmark(driver, fixtureUrl, environment) {
  const result = await driver.executeAsyncScript(`
    const input = arguments[0];
    const done = arguments[arguments.length - 1];
    import(new URL("viewer-benchmark-browser.js", input.fixtureUrl).href)
      .then((module) => module.runViewerBenchmarkInBrowser({
        includeSchedulingEvidence: true,
        environment: input.environment,
        assetUrls: {
          manifest: new URL("tests/browser/benchmark/benchmark-manifest-v1.json", input.fixtureUrl).href,
          terrain: new URL("tests/browser/benchmark/benchmark-terrain-v1.f32le", input.fixtureUrl).href,
          trace: new URL("tests/browser/benchmark/benchmark-trace-v1.json", input.fixtureUrl).href
        }
      }))
      .then(done)
      .catch((error) => done({ __error: String(error && error.message || error) }));
  `, { fixtureUrl, environment });
  if (result?.__error) throw new Error(result.__error);
  return result;
}

async function readSizes(driver) {
  return driver.executeScript(`
    const canvas = window.__forge3dInteractiveViewer.canvas;
    const box = canvas.getBoundingClientRect();
    return { css: { width: box.width, height: box.height }, backing: { width: canvas.width, height: canvas.height } };
  `);
}

async function viewerState(driver) {
  return driver.executeScript(`
    const fixture = window.__forge3dInteractiveViewer;
    return {
      diagnostics: fixture.viewer.getDiagnostics(),
      view: fixture.viewer.getView(),
      lifecycle: structuredClone(window.__forge3dSafariLifecycle),
      errors: [...(window.__forge3dSafariErrors ?? [])]
    };
  `);
}

async function capturedErrors(driver) {
  return driver.executeScript("return [...(window.__forge3dSafariErrors ?? [])]");
}

export async function initializeErrorLedgerBeforeNavigation(driver, routeUrl) {
  const bootstrapUrl = new URL("test-lifecycle-away.html", routeUrl).href;
  await driver.get(bootstrapUrl);
  const initialized = await driver.executeScript(`
    const key = arguments[0];
    const failureMarker = arguments[1];
    try {
      sessionStorage.setItem(key, "[]");
      if (sessionStorage.getItem(key) !== "[]") return false;
      if (window.name === failureMarker) window.name = "";
      return true;
    } catch {
      try { window.name = failureMarker; } catch {}
      return false;
    }
  `, ERROR_LEDGER_KEY, ERROR_LEDGER_FAILURE);
  if (initialized !== true) throw new Error("SAF-03 error collector durable initialization failed");
  await driver.get(routeUrl);
}

async function lifecycle(driver) {
  return driver.executeScript("return structuredClone(window.__forge3dSafariLifecycle)");
}

async function invalidateAndSnapshot(driver, frames, salt) {
  await driver.executeScript(`
    const viewer = window.__forge3dInteractiveViewer.viewer;
    const view = viewer.getView();
    viewer.setView({ ...view, yawDegrees: view.yawDegrees + arguments[0] * 0.00001 });
  `, salt);
  return waitForFreshSnapshot(driver, frames);
}

async function waitForFreshSnapshot(driver, frames) {
  await driver.wait(async () => {
    const count = await driver.executeScript("return window.__forge3dInteractiveViewer.viewer.getDiagnostics().submittedFrames");
    return count > frames;
  }, 15_000);
  return snapshot(driver);
}

async function snapshot(driver) {
  const state = await viewerState(driver);
  return { view: state.view, submittedFrames: state.diagnostics.submittedFrames, pixels: (await viewerScreenshotEvidence(driver)).pixels };
}

async function viewerScreenshotEvidence(driver) {
  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const blob = await window.__forge3dInteractiveViewer.viewer.screenshot();
      const bytes = await blob.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const decodedDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((value) => value.toString(16).padStart(2, "0")).join("");
      const stride = Math.max(1, Math.floor((bitmap.width * bitmap.height) / 4096));
      let minimum = 1, maximum = 0, samples = 0, terrain = 0;
      for (let pixel = 0; pixel < bitmap.width * bitmap.height; pixel += stride) {
        const offset = pixel * 4;
        const luma = (data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722) / 255;
        minimum = Math.min(minimum, luma); maximum = Math.max(maximum, luma); samples += 1;
        if (data[offset + 3] > 0 && luma > 0.03 && luma < 0.97) terrain += 1;
      }
      done({ mimeType: blob.type, byteLength: bytes.byteLength, sha256: digest, width: bitmap.width, height: bitmap.height,
        pixels: { decoded: true, nonBlank: maximum - minimum >= 0.01, sampleCount: samples, terrainPixelCount: terrain,
          lumaMinimum: minimum, lumaMaximum: maximum, sha256: decodedDigest } });
    })().catch((error) => done({ __error: String(error && error.message || error) }));
  `);
  if (result.__error) throw new Error(result.__error);
  return result;
}

function cycleRecord(cycle, before, after, afterState, events) {
  return {
    cycle,
    documentIdentityBefore: before.lifecycle.documentIdentity,
    documentIdentityAfter: afterState.lifecycle.documentIdentity,
    viewerIdentityBefore: before.lifecycle.viewerIdentity,
    viewerIdentityAfter: afterState.lifecycle.viewerIdentity,
    ...events,
    submittedFramesBefore: before.diagnostics.submittedFrames,
    submittedFramesAfter: after.submittedFrames,
    submittedFrameFresh: after.submittedFrames > before.diagnostics.submittedFrames,
    ownership: ownership(afterState.diagnostics),
    pixels: after.pixels,
  };
}

function ownership(diagnostics) {
  return {
    activeRuntimes: diagnostics.activeRuntimes,
    ownedListeners: diagnostics.ownedListeners,
    activeObservers: diagnostics.activeObservers,
    activePointers: diagnostics.activePointers,
    pendingAnimationFrame: diagnostics.pendingAnimationFrame,
    ownedAnimationFrameCount: diagnostics.ownedAnimationFrameCount,
  };
}

function viewsClose(left, right, tolerance) {
  const a = [...left.target, left.distance, left.yawDegrees, left.pitchDegrees, left.fovYDegrees, left.near, left.far];
  const b = [...right.target, right.distance, right.yawDegrees, right.pitchDegrees, right.fovYDegrees, right.near, right.far];
  return a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
}

export function decodePngEvidence(bytes, crop = null) {
  const decoded = decodePng(bytes);
  const left = Math.max(0, Math.floor(crop?.left ?? 0));
  const top = Math.max(0, Math.floor(crop?.top ?? 0));
  const right = Math.min(decoded.width, Math.ceil(left + (crop?.width ?? decoded.width)));
  const bottom = Math.min(decoded.height, Math.ceil(top + (crop?.height ?? decoded.height)));
  let minimum = 1, maximum = 0, samples = 0, terrain = 0;
  const decodedCrop = Buffer.alloc(Math.max(0, right - left) * Math.max(0, bottom - top) * 4);
  let cropOffset = 0;
  const area = Math.max(1, (right - left) * (bottom - top));
  const stride = Math.max(1, Math.floor(area / 4096));
  let sampled = 0;
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const rawOffset = (y * decoded.width + x) * 4;
    decoded.pixels.copy(decodedCrop, cropOffset, rawOffset, rawOffset + 4);
    cropOffset += 4;
    if (sampled++ % stride !== 0) continue;
    const offset = rawOffset;
    const luma = (decoded.pixels[offset] * 0.2126 + decoded.pixels[offset + 1] * 0.7152 + decoded.pixels[offset + 2] * 0.0722) / 255;
    minimum = Math.min(minimum, luma); maximum = Math.max(maximum, luma); samples += 1;
    if (decoded.pixels[offset + 3] > 0 && luma > 0.03 && luma < 0.97) terrain += 1;
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const decodedSha256 = createHash("sha256").update(decodedCrop).digest("hex");
  return { mimeType: "image/png", byteLength: bytes.length, sha256, width: decoded.width, height: decoded.height,
    pixels: { decoded: true, nonBlank: maximum - minimum >= 0.01, sampleCount: samples, terrainPixelCount: terrain,
      lumaMinimum: minimum, lumaMaximum: maximum, sha256: decodedSha256 } };
}

function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("native screenshot is not PNG");
  let offset = 8, width, height, colorType, bitDepth, interlace;
  const data = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length); offset += 12 + length;
    if (type === "IHDR") { width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); bitDepth = chunk[8]; colorType = chunk[9]; interlace = chunk[12]; }
    if (type === "IDAT") data.push(chunk);
    if (type === "IEND") break;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) throw new Error("native screenshot PNG format is unsupported");
  const channels = colorType === 6 ? 4 : 3; const rowBytes = width * channels; const raw = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(width * height * 4); let cursor = 0; let previous = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++]; const row = Buffer.from(raw.subarray(cursor, cursor + rowBytes)); cursor += rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= channels ? row[x - channels] : 0; const up = previous[x]; const upperLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 255;
      else if (filter === 2) row[x] = (row[x] + up) & 255;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upperLeft)) & 255;
      else if (filter !== 0) throw new Error("native screenshot PNG filter is unsupported");
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels; const target = (y * width + x) * 4;
      pixels[target] = row[source]; pixels[target + 1] = row[source + 1]; pixels[target + 2] = row[source + 2]; pixels[target + 3] = channels === 4 ? row[source + 3] : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}

function paeth(a, b, c) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }

function matchingDriverPids(executable, port) {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const portPattern = new RegExp(`(?:--port(?:=|\\s+))${port}(?:\\s|$)`, "u");
  return new Set(output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    return match && match[2].includes(executable) && portPattern.test(match[2]) ? [Number(match[1])] : [];
  }));
}

async function waitForNoNewDriverProcess(executable, port, baseline) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = matchingDriverPids(executable, port);
    if ([...current].every((pid) => baseline.has(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForNewDriverPid(executable, port, baseline) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const created = [...matchingDriverPids(executable, port)].filter((pid) => !baseline.has(pid));
    if (created.length === 1) return created[0];
    if (created.length > 1) throw new Error("multiple unregistered SafariDriver processes observed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("SafariDriver process identity was not observed");
}
