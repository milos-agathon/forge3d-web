import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, release } from "node:os";
import { join } from "node:path";

import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";
import { validateBrowserEvidence } from "../browser/evidence-validator.mjs";
import { runViewerBenchmark } from "../browser/viewer-benchmark";

test("validates complete evidence from the frozen real-GPU benchmark", async ({
  browser,
  page,
  webgpuAvailability,
}, testInfo) => {
  test.setTimeout(60_000);
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const interactionAssertions = await exerciseRequiredInteractions(page);
  const adapter = await readAdapterEvidence(page);
  const benchmark = await runViewerBenchmark(page, {
    browserZoom: 1,
    thermalState: "unavailable",
    thermalSignalProvenance: "browser API unavailable",
    lowPowerMode: "unavailable",
    lowPowerSignalProvenance: "browser API unavailable",
  });
  const frameCounters = await page.evaluate(() =>
    window.__forge3dInteractiveViewer.viewer.getDiagnostics(),
  );
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const wasmSha256 = createHash("sha256")
    .update(readFileSync(join(process.cwd(), "dist", "forge3d_web_bg.wasm")))
    .digest("hex");
  const record = {
    schemaVersion: 3,
    sourceRevision: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: join(process.cwd(), "..", ".."),
        encoding: "utf8",
      }).trim(),
      worktreeClean:
        execFileSync(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=all"],
          {
            cwd: join(process.cwd(), "..", ".."),
            encoding: "utf8",
          },
        ).trimEnd() === "",
    },
    artifact: {
      kind: "wasm-module",
      sha256: wasmSha256,
    },
    project: "source-chrome",
    lane: "required",
    browser: {
      name: "chromium",
      version: browser.version(),
      channel: "stable",
      userAgent,
    },
    os: {
      name: platform(),
      version: release(),
      build: release(),
    },
    architecture: arch(),
    deviceId: hostname(),
    headed: process.env.FORGE3D_HEADED === "1",
    secureContext: true,
    launchArguments: [
      "--enable-unsafe-webgpu",
      ...(process.platform === "win32" ? ["--use-angle=d3d11"] : []),
    ],
    adapter,
    runtimeResult: "PASS",
    frameCounters: {
      renderRequests: frameCounters.renderRequests,
      submittedFrames: frameCounters.submittedFrames,
      skippedFrames: frameCounters.skippedFrames,
    },
    interactionAssertions,
    normalizedErrorCodes: [],
    benchmark,
  };

  const evidencePath = testInfo.outputPath("browser-evidence.json");
  writeFileSync(evidencePath, JSON.stringify(record, null, 2));
  await testInfo.attach("forge3d-source-browser-evidence", {
    path: evidencePath,
    contentType: "application/json",
  });
  expect(
    validateBrowserEvidence(record, { requireReleaseArtifact: false }),
  ).toBe(record);
});

async function exerciseRequiredInteractions(
  page: import("@playwright/test").Page,
) {
  const before = await page.evaluate(async () => {
    const viewer = await window.__forge3dInteractiveViewer.create({
      resize: false,
    });
    return viewer.getView();
  });
  const canvas = page.locator("#viewer");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 160, box!.y + 160);
  await page.mouse.down();
  await page.mouse.move(box!.x + 205, box!.y + 135, { steps: 4 });
  await page.mouse.up();
  const afterMouse = await page.evaluate(() =>
    window.__forge3dInteractiveViewer.viewer.getView(),
  );
  await page.mouse.wheel(0, -120);
  const afterWheel = await page.evaluate(() =>
    window.__forge3dInteractiveViewer.viewer.getView(),
  );

  const afterTouch = await page.evaluate(() => {
    const fixture = window.__forge3dInteractiveViewer;
    const event = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 91,
        pointerType: "touch",
        clientX: x,
        clientY: y,
        isPrimary: true,
      });
    fixture.canvas.dispatchEvent(event("pointerdown", 110, 110));
    fixture.canvas.dispatchEvent(event("pointermove", 145, 90));
    fixture.canvas.dispatchEvent(event("pointerup", 145, 90));
    return fixture.viewer.getView();
  });

  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  return page.evaluate(
    ({ before, afterMouse, afterWheel, afterTouch }) => {
      const fixture = window.__forge3dInteractiveViewer;
      const viewer = fixture.viewer;
      const afterKeyboard = viewer.getView();
      viewer.resize({ width: 240, height: 180, devicePixelRatio: 2 });
      const resized =
        fixture.canvas.width === 480 && fixture.canvas.height === 360;
      viewer.dispose();
      const diagnostics = viewer.getDiagnostics();
      return {
        mouse: JSON.stringify(afterMouse) !== JSON.stringify(before),
        wheel: JSON.stringify(afterWheel) !== JSON.stringify(afterMouse),
        touch: JSON.stringify(afterTouch) !== JSON.stringify(afterWheel),
        keyboard:
          JSON.stringify(afterKeyboard) !== JSON.stringify(afterTouch),
        resize: resized,
        disposal:
          viewer.status === "disposed" &&
          diagnostics.activeRuntimes === 0 &&
          diagnostics.ownedListeners === 0,
      };
    },
    { before, afterMouse, afterWheel, afterTouch },
  );
}

async function readAdapterEvidence(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) {
      return {
        available: false,
        fallback: null,
        identity: null,
        limits: {},
      };
    }
    const info = adapter.info as GPUAdapterInfo & {
      isFallbackAdapter?: boolean;
    };
    const directFallback = (adapter as GPUAdapter & {
      isFallbackAdapter?: boolean;
    }).isFallbackAdapter;
    const fallback =
      typeof directFallback === "boolean"
        ? directFallback
        : typeof info.isFallbackAdapter === "boolean"
          ? info.isFallbackAdapter
          : null;
    const identity = [
      info.vendor,
      info.architecture,
      info.device,
      info.description,
    ]
      .filter(Boolean)
      .join(" / ");
    return {
      available: true,
      fallback,
      identity: identity || null,
      limits: {
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    };
  });
}

declare global {
  interface Window {
    __forge3dInteractiveViewer: any;
  }
}
