import { isChr04Lane } from "./chr04-lanes.mjs";
import { runEdgeBrowserAcceptance } from "./edge-browser-acceptance.mjs";

export async function runBrandedHardwareAcceptance(page, payload) {
  const proofKey = isChr04Lane(payload.binding?.lane) ? "chr04Proof" : "chr03Proof";
  const pageErrors = [];
  const onPageError = (error) => pageErrors.push(`${error.name}: ${error.message}`);
  const onConsole = (message) => {
    if (/GPUValidationError|validation error/iu.test(message.text())) pageErrors.push(message.text());
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  try {
    await page.evaluate(async () => {
      const fixture = window.__forge3dInteractiveViewer;
      window.__forge3dHardwareErrors = [];
      const onError = (error) => window.__forge3dHardwareErrors.push(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      window.__forge3dHardwareOnError = onError;
      const viewer = await fixture.create({ resize: true, controls: { keyboard: true }, onError });
      const canvas = fixture.canvas;
      window.__forge3dHardware = { captures: [], releases: [] };
      canvas.addEventListener("gotpointercapture", (event) => window.__forge3dHardware.captures.push(event.pointerId));
      canvas.addEventListener("lostpointercapture", (event) => window.__forge3dHardware.releases.push(event.pointerId));
      for (let attempt = 0; attempt < 120 && viewer.getDiagnostics().submittedFrames === 0; attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    const canvas = page.locator("#viewer");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("CHR-03 canvas has no layout box");
    const view = () => page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getView());
    const changed = (left, right) => JSON.stringify(left) !== JSON.stringify(right);

    const initial = await view();
    await page.mouse.move(box.x + 150, box.y + 150);
    await page.mouse.down({ button: "left" });
    const pointerDown = await page.evaluate(() => ({
      diagnostics: window.__forge3dInteractiveViewer.viewer.getDiagnostics(),
      captures: [...window.__forge3dHardware.captures],
    }));
    await page.mouse.move(box.x + box.width + 40, box.y - 20, { steps: 4 });
    const outside = await page.evaluate(() => ({
      view: window.__forge3dInteractiveViewer.viewer.getView(),
      captures: [...window.__forge3dHardware.captures],
    }));
    const outsideView = outside.view;
    await page.mouse.up({ button: "left" });
    const pointerUp = await page.evaluate(() => ({
      diagnostics: window.__forge3dInteractiveViewer.viewer.getDiagnostics(),
      releases: [...window.__forge3dHardware.releases],
    }));
    const afterOrbit = outsideView;

    await page.mouse.move(box.x + 150, box.y + 150);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + 190, box.y + 175, { steps: 4 });
    await page.mouse.up({ button: "right" });
    const afterPan = await view();
    await page.mouse.wheel(0, -120);
    const afterWheel = await view();

    await canvas.focus();
    const keyboard = {};
    let before = await view();
    await page.keyboard.press("ArrowRight");
    let after = await view();
    keyboard.orbit = { key: "ArrowRight", changed: changed(before, after) };
    before = after;
    await page.keyboard.press("Shift+ArrowRight");
    after = await view();
    keyboard.pan = { key: "Shift+ArrowRight", changed: changed(before, after) };
    before = after;
    await page.keyboard.press("Equal");
    after = await view();
    keyboard.zoomIn = { key: "Equal", changed: changed(before, after) };
    before = after;
    await page.keyboard.press("Minus");
    after = await view();
    keyboard.zoomOut = { key: "Minus", changed: changed(before, after) };
    before = after;
    await page.keyboard.press("Home");
    after = await view();
    keyboard.reset = { key: "Home", changed: changed(before, after) };

    const autoResize = await page.evaluate(async () => {
      const fixture = window.__forge3dInteractiveViewer;
      const viewer = fixture.viewer;
      const before = { width: fixture.canvas.width, height: fixture.canvas.height, submitted: viewer.getDiagnostics().submittedFrames };
      const observerActive = viewer.getDiagnostics().activeObservers > 0;
      fixture.canvas.style.width = "280px";
      fixture.canvas.style.height = "240px";
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const diagnostics = viewer.getDiagnostics();
        if ((fixture.canvas.width !== before.width || fixture.canvas.height !== before.height) && diagnostics.submittedFrames > before.submitted) break;
      }
      const diagnostics = viewer.getDiagnostics();
      return {
        observerActive,
        dimensionsChanged: fixture.canvas.width !== before.width || fixture.canvas.height !== before.height,
        submittedFrame: diagnostics.submittedFrames > before.submitted,
      };
    });
    const visibility = await exerciseActualVisibility(page, 30);
    const systemInfo = await captureSanitizedSystemInfo(page);
    const pointerId = outside.captures[0] ?? pointerDown.captures[0] ?? null;
    const driver = {
      orbitChanged: changed(initial, afterOrbit),
      panChanged: changed(afterOrbit, afterPan),
      wheelChanged: changed(afterPan, afterWheel),
      pointerCapture: {
        pointerId,
        capturedPointerId: pointerDown.captures.at(-1) ?? null,
        releasedPointerId: pointerUp.releases.at(-1) ?? null,
        captured: Number.isInteger(pointerId) && pointerDown.diagnostics.activePointers === 1,
        outsideMoveChanged: changed(initial, outsideView),
        released: Number.isInteger(pointerId) && pointerUp.releases.includes(pointerId),
        activePointersAfter: pointerUp.diagnostics.activePointers,
      },
      keyboard,
      autoResize,
    };
    const result = await page.evaluate(async (value) => {
      const module = await import(new URL("hardware-page-harness.js", window.location.href).href);
      return module.runHardwarePage(value);
    }, {
      ...payload,
      hardware: { driver, visibility, systemInfo, observedErrors: [] },
    });
    if (proofKey === "chr04Proof") {
      result.chr04Proof.edgeAcceptance = await runEdgeBrowserAcceptance({
        browser: page.context().browser(),
        page,
        fixtureUrl: page.url(),
      });
    }
    await page.waitForTimeout(50);
    const viewerErrors = await page.evaluate(() => [...(window.__forge3dHardwareErrors ?? [])]);
    result[proofKey].errors = [...new Set([...result[proofKey].errors, ...viewerErrors, ...pageErrors])];
    return result;
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
  }
}

export const runChromeHardwareAcceptance = runBrandedHardwareAcceptance;

async function exerciseActualVisibility(page, cycleCount) {
  const cover = await page.context().newPage();
  const cycles = [];
  try {
    await cover.goto("about:blank");
    await page.bringToFront();
    await waitForVisibility(page, "visible");
    for (let index = 0; index < cycleCount; index += 1) {
      await page.evaluate(() => {
        const viewer = window.__forge3dInteractiveViewer.viewer;
        const view = viewer.getView();
        viewer.setView({ ...view, yawDegrees: view.yawDegrees + 0.01 });
      });
      await cover.bringToFront();
      await waitForVisibility(page, "hidden");
      const hiddenBaseline = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getDiagnostics());
      await cover.waitForTimeout(50);
      const hidden = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getDiagnostics());
      await page.bringToFront();
      await waitForVisibility(page, "visible");
      let after;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        after = await page.evaluate(() => window.__forge3dInteractiveViewer.viewer.getDiagnostics());
        if (after.submittedFrames > hidden.submittedFrames) break;
      }
      cycles.push({
        cycle: index + 1,
        hiddenPendingFrameCancelled:
          hidden.pendingAnimationFrame === false &&
          hidden.submittedFrames === hiddenBaseline.submittedFrames &&
          hidden.skippedFrames === hiddenBaseline.skippedFrames,
        visibleFrame:
          after.submittedFrames === hidden.submittedFrames + 1 &&
          after.skippedFrames === hidden.skippedFrames
            ? "submitted"
            : "skipped",
      });
    }
    return {
      actualDocumentVisibilityTransitions: true,
      visibilityStateSource: "actual-document",
      cycleCount,
      cycles,
      final: { visibilityState: await page.evaluate(() => document.visibilityState) },
    };
  } finally {
    await cover.close();
    if (!page.isClosed()) await page.bringToFront();
  }
}

async function waitForVisibility(page, expected) {
  await page.waitForFunction((value) => document.visibilityState === value, expected, { timeout: 10_000 });
}

export async function captureSanitizedSystemInfo(page) {
  let session;
  try {
    const browser = page.context().browser();
    if (!browser) throw new Error("Playwright browser handle unavailable");
    session = await browser.newBrowserCDPSession();
    const info = await session.send("SystemInfo.getInfo");
    return {
      available: true,
      diagnosticOnly: true,
      value: {
        devices: (info.gpu?.devices ?? []).map((device) => ({
          vendorId: device.vendorId ?? null,
          deviceId: device.deviceId ?? null,
          driverVendor: device.driverVendor ?? null,
          driverVersion: device.driverVersion ?? null,
        })),
        featureStatus: info.gpu?.featureStatus ?? {},
      },
      unavailableReason: null,
    };
  } catch (error) {
    return {
      available: false,
      diagnosticOnly: true,
      value: null,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await session?.detach().catch(() => undefined);
  }
}
