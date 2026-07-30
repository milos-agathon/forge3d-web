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
import {
  resolveSourceBenchmarkEvidenceMode,
} from "../browser/playwright-project-metadata";
import { collectPlaywrightLaunchDiagnostics } from "../browser/playwright-launch-diagnostics";
import { validateBrowserEvidence } from "../browser/evidence-validator.mjs";
import { runViewerBenchmark } from "../browser/viewer-benchmark";
import {
  runViewerInteractionObservation,
} from "../browser/viewer-interaction-observation.mjs";

test("validates complete evidence from the frozen real-GPU benchmark", async ({
  browser,
  page,
  webgpuAvailability,
}, testInfo) => {
  test.setTimeout(60_000);
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const project = webgpuAvailability.project;
  const evidenceMode = resolveSourceBenchmarkEvidenceMode(
    project,
    process.env.FORGE3D_SOURCE_BENCHMARK_MODE,
  );
  const launch = await collectPlaywrightLaunchDiagnostics(
    browser,
    project,
  );
  const configuredLaunchArguments = [...launch.configuredArguments];
  const effectiveLaunchArguments = [...launch.effectiveArguments];
  const launchDiagnostics = {
    project: project.project,
    declaredBrowser: project.browserName,
    declaredChannel: project.channel,
    declaredLane: project.lane,
    declaredEngine: launch.declaredEngine,
    actualEngine: launch.actualEngine,
    provenance: launch.provenance,
    configuredLaunchArguments,
    effectiveLaunchArguments,
    launchArgumentsObserved: launch.observed,
    launchArgumentSource: launch.observationSource,
    preferenceMode: launch.preferenceMode,
    firefoxUserPrefs: launch.firefoxUserPrefs,
    supportLevel: launch.supportLevel,
    flagPresence: launch.flagPresence,
    configuredLaunchFlagsPresent:
      launch.configuredLaunchFlagsPresent,
    effectiveLaunchFlagsPresent:
      launch.effectiveLaunchFlagsPresent,
    configuredArgumentsObserved:
      launch.configuredArgumentsObserved,
    preflightIdentityConsistent:
      launch.preflightIdentityConsistent,
  };
  await testInfo.attach("forge3d-source-launch-diagnostics.json", {
    body: JSON.stringify(launchDiagnostics, null, 2),
    contentType: "application/json",
  });
  expect(launchDiagnostics.actualEngine).toBe(
    launchDiagnostics.declaredEngine,
  );
  if (launchDiagnostics.declaredEngine === "chromium") {
    expect(launchDiagnostics.launchArgumentsObserved).toBe(true);
    expect(launchDiagnostics.provenance).toBe("live-browser");
  } else {
    expect(launchDiagnostics.launchArgumentsObserved).toBe(false);
    expect(launchDiagnostics.provenance).toBe(
      "project-configuration",
    );
    expect(launchDiagnostics.effectiveLaunchArguments).toEqual([]);
  }
  expect(launchDiagnostics.configuredArgumentsObserved).toBe(true);
  expect(
    launchDiagnostics.preflightIdentityConsistent,
    "source evidence with WebGPU-enabling flags must identify chromium-preflight",
  ).toBe(true);
  const adapter = await readAdapterEvidence(page);
  if (evidenceMode === "required") {
    expect(
      adapter.fallback,
      "required source benchmark must use a non-fallback adapter",
    ).toBe(false);
  }
  const interactionObservation =
    await runViewerInteractionObservation(page, {
      disposeViewer: true,
    });
  await testInfo.attach("forge3d-viewer-interaction-observation.json", {
    body: JSON.stringify(interactionObservation, null, 2),
    contentType: "application/json",
  });
  const interactionAssertions = await exerciseRequiredInteractions(page);
  const benchmark =
    evidenceMode === "required"
      ? await runViewerBenchmark(page, {
          browserZoom: 1,
          thermalState: "unavailable",
          thermalSignalProvenance: "browser API unavailable",
          lowPowerMode: "unavailable",
          lowPowerSignalProvenance: "browser API unavailable",
        })
      : null;
  const firefoxEvidenceLabels =
    project.project === "firefox-preflight" ||
    project.project === "firefox-nightly-experimental"
      ? {
          supportLevel: project.supportLevel!,
          browserPreference: {
            mode: project.preferenceMode!,
            overrides: { ...project.firefoxUserPrefs },
          },
        }
      : {};
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
    project: project.project,
    lane: evidenceMode,
    ...firefoxEvidenceLabels,
    browser: {
      name: project.browserName,
      version: browser.version(),
      channel: project.channel,
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
    secureContext: webgpuAvailability.secureContext,
    launchArguments: effectiveLaunchArguments,
    adapter,
    runtimeResult: evidenceMode === "required" ? "PASS" : "PROBE",
    frameCounters: {
      renderRequests: frameCounters.renderRequests,
      submittedFrames: frameCounters.submittedFrames,
      skippedFrames: frameCounters.skippedFrames,
    },
    interactionAssertions,
    normalizedErrorCodes:
      interactionObservation.normalizedErrorCodes,
    benchmark,
  };

  const evidencePath = testInfo.outputPath("browser-evidence.json");
  writeFileSync(evidencePath, JSON.stringify(record, null, 2));
  await testInfo.attach("forge3d-source-browser-evidence", {
    path: evidencePath,
    contentType: "application/json",
  });
  expect(
    validateBrowserEvidence(record, {
      requireBenchmark: evidenceMode === "required",
      requireReleaseArtifact: false,
    }),
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
