import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openProductionSession } from "./browser-session-runtime.mjs";
import { validateBrowserRunProvenance } from "./browser-run-provenance.mjs";
import { hasMeasuredLumaPresentation } from "./join-adapter-attestation.mjs";
import { validateChr03HardwareProofContract as validateChr03HardwareProof } from "./chr03-hardware-proof-validator.mjs";
import { CHR03_STABLE_LANES, isChr03Lane } from "./chr03-lanes.mjs";
import { validateChr04EdgeEvidence } from "./chr04-hardware-proof-validator.mjs";
import { CHR04_LANES, isChr04Lane } from "./chr04-lanes.mjs";

const CHR03_REQUIRED_LANES = new Set(Object.keys(CHR03_STABLE_LANES));
const CHR04_REQUIRED_LANES = new Set(Object.keys(CHR04_LANES));

const DESKTOP_LANES = new Map([
  ["chrome-macos-m2", ["playwright-chrome", "chrome"]],
  ["chrome-beta-macos-m2", ["playwright-chrome", "chrome-beta"]],
  ["chrome-windows-intel12", ["playwright-chrome", "chrome"]],
  ["chrome-linux-intel12", ["playwright-chrome", "chrome"]],
  ["chrome-beta-linux-intel12", ["playwright-chrome", "chrome-beta"]],
  ["chrome-linux-rtx3070", ["playwright-chrome", "chrome"]],
  ["chrome-beta-linux-rtx3070", ["playwright-chrome", "chrome-beta"]],
  ["edge-macos-m2", ["playwright-edge", "msedge"]],
  ["edge-windows-intel12", ["playwright-edge", "msedge"]],
  ["edge-linux-intel12", ["playwright-edge", "msedge"]],
  ["edge-linux-rtx3070", ["playwright-edge", "msedge"]],
  ["safari-macos-m2", ["safaridriver", "safari"]],
  ["manual-safari-trackpad", ["safaridriver", "safari"]],
  ["firefox-macos-m2", ["selenium-firefox", "firefox"]],
  ["firefox-windows-intel12", ["selenium-firefox", "firefox"]],
]);

export function resolveLaneRuntime({ lane, assetId, platform }) {
  if (lane === "infrastructure-canary") {
    return {
      driver: "infrastructure-canary",
      browser: "chrome",
      supportAssertions: false,
      manual: false,
      mobile: false,
    };
  }
  const desktop = DESKTOP_LANES.get(lane);
  if (desktop) {
    if (isChr04Lane(lane) &&
        (CHR04_LANES[lane].assetId !== assetId || CHR04_LANES[lane].platform !== platform)) {
      throw new Error("CHR-04 lane does not match its exact hardware asset and platform");
    }
    return {
      driver: desktop[0],
      browser: desktop[1],
      supportAssertions: !lane.startsWith("manual-"),
      manual: lane.startsWith("manual-"),
      mobile: false,
    };
  }
  if (
    lane === "mobile-usb-controller" ||
    lane === "manual-mobile-multitouch"
  ) {
    if (!/^FW-(?:AND|IOS|IPAD)-/u.test(assetId ?? "")) {
      throw new Error("mobile lanes require a fixed physical device asset");
    }
    return {
      driver: assetId.startsWith("FW-AND-")
        ? "appium-uiautomator2"
        : "appium-xcuitest",
      browser: assetId.startsWith("FW-AND-") ? "chrome" : "safari",
      supportAssertions: lane !== "manual-mobile-multitouch",
      manual: lane === "manual-mobile-multitouch",
      mobile: true,
    };
  }
  throw new Error(`lane has no checked runtime: ${lane} on ${platform}`);
}

export function createBrowserPageBinding({
  authorization,
  packageSha256,
  actor,
}) {
  const expectedTester = actor?.trim();
  if (authorization.manualSession && !expectedTester) {
    throw new Error("manual workflow actor is missing");
  }
  return {
    lane: authorization.lane,
    runId: authorization.run.id,
    jobId: authorization.queuedHardwareJob.id,
    assetId: authorization.assetId,
    commit: authorization.trustedSha,
    packageSha256,
    ...(authorization.manualSession ? { expectedTester } : {}),
  };
}

export async function executeHardwareBrowserLane({
  lane,
  assetId,
  hostId,
  platform,
  binding,
  route,
  browserPolicy,
  deviceMatrix,
  inventory,
  mediaChallenge = null,
  appiumSessionModule = null,
  outputPath,
  manualSessionInputPath = null,
  watermarkPath = null,
  manualSessionReadinessPath = null,
  controllerCaptureWindowPath = null,
  trackpadInventory = null,
  processRegistryPath = null,
  dependencies = productionDependencies(),
}) {
  const runtime = resolveLaneRuntime({ lane, assetId, platform });
  const manualLifecycle = runtime.manual || mediaChallenge !== null;
  if (
    manualLifecycle &&
    (typeof binding.expectedTester !== "string" ||
      binding.expectedTester.trim() === "")
  ) {
    throw new Error("product manual binding requires the authenticated tester");
  }
  const session = await dependencies.openSession({
    runtime,
    assetId,
    routeUrl: route.applicationUrl,
    browserPolicy,
    deviceMatrix,
    appiumSessionModule,
    processRegistryPath,
  });
  let pageResult;
  let captureWindow = null;
  try {
    const provenance = validateBrowserRunProvenance({
      runtime,
      session,
      inventory,
      hostId,
      platform,
      browserPolicy,
    });
    const record = await executeLaneContract({
      lane,
      driver: runtime.driver,
      binding,
      adapterSmoke: async () => {
        pageResult = await session.runPage({
          lane,
          binding: {
            ...(isChr03Lane(lane) || isChr04Lane(lane) ? { lane: binding.lane } : {}),
            runId: binding.runId,
            jobId: binding.jobId,
            assetId: binding.assetId,
            commit: binding.commit,
            packageSha256: binding.packageSha256,
            ...(isChr04Lane(lane) ? { platform } : {}),
          },
          route,
          effectiveLaunchArguments: session.effectiveLaunchArguments,
          supportAssertions: runtime.supportAssertions,
          mediaChallenge,
          sessionContext: manualLifecycle ? {
            assetId,
            hostId,
            packageSha256: binding.packageSha256,
            expectedTester: binding.expectedTester,
            browser: session.browser,
            system: { os: provenance.system.platform, build: provenance.system.osBuild },
            trackpad: lane === "manual-safari-trackpad" ? trackpadInventory : null,
          } : null,
        });
        if (manualLifecycle) {
          if (pageResult.watermark?.visible !== true ||
              !Object.values(pageResult.routeReadiness ?? {}).every((value) => value === true)) {
            throw new Error("manual fixture, route, and watermark are not ready");
          }
          await dependencies.announceManualReadiness({ path: manualSessionReadinessPath, readiness: {
            schemaVersion: 1,
            binding: { runId: binding.runId, jobId: binding.jobId, assetId: binding.assetId },
            mediaChallenge,
            browser: session.browser,
            deviceAssetId: session.device?.assetId ?? null,
            route,
            fixtureReady: true, browserReady: true, deviceReady: true,
            routeReady: true, watermarkVisible: true,
          }});
          captureWindow = await dependencies.waitForControllerWindow({ path: controllerCaptureWindowPath, binding });
          await dependencies.waitUntil(new Date(captureWindow.endedAt), session.assertHealthy);
        }
        return pageResult.adapter;
      },
      assertions: async () => {
        if (CHR03_REQUIRED_LANES.has(lane)) {
          validateChr03HardwareProof(pageResult.chr03Proof, {
            lane,
            assetId,
            commit: binding.commit,
            packageSha256: binding.packageSha256,
          });
        }
        if (CHR04_REQUIRED_LANES.has(lane)) {
          validateChr04EdgeEvidence({
            proof: pageResult.chr04Proof,
            expectedBinding: { lane, assetId, platform, commit: binding.commit, packageSha256: binding.packageSha256 },
            browser: session.browser,
            driver: provenance.driver,
            system: provenance.system,
            effectiveLaunchArguments: provenance.effectiveLaunchArguments,
            adapter: pageResult.adapter,
            browserPolicy,
          });
        }
        return pageResult.assertions;
      },
      cleanup: async () => ({ ok: true }),
    });
    writeJson(outputPath, {
      ...record,
      browser: session.browser,
      route,
      routeReadiness: pageResult.routeReadiness,
      chr03Proof: pageResult.chr03Proof ?? null,
      chr04Proof: pageResult.chr04Proof ?? null,
      headed: true,
      driver: provenance.driver,
      system: provenance.system,
      session: provenance.loginSession,
      effectiveLaunchArguments: provenance.effectiveLaunchArguments,
      launchObservation: provenance.launchObservation,
      inventoryCapturedAt: provenance.inventoryCapturedAt,
    });
    if (manualLifecycle) {
      if (!manualSessionInputPath || !watermarkPath) {
        throw new Error("manual lane requires session-input and watermark outputs");
      }
      if (
        pageResult.watermark?.visible !== true ||
        pageResult.watermark.mediaChallenge !== mediaChallenge
      ) {
        throw new Error("manual media challenge is not visibly watermarked");
      }
      writeJson(watermarkPath, pageResult.watermark);
      writeJson(manualSessionInputPath, {
        schemaVersion: 1,
        binding,
        route,
        browser: session.browser,
        driver: {
          name: runtime.driver,
          version: session.driverVersion,
        },
        appium: session.appium ?? null,
        device: session.device ?? null,
        inventoryCapturedAt: provenance.inventoryCapturedAt,
        system: provenance.system,
        loginSession: provenance.loginSession,
        effectiveLaunchArguments: provenance.effectiveLaunchArguments,
        launchObservation: provenance.launchObservation,
        watermark: pageResult.watermark,
      });
    }
    return record;
  } finally {
    await session.close();
  }
}

async function executeLaneContract({
  lane,
  driver,
  binding,
  adapterSmoke,
  assertions,
  cleanup,
}) {
  if (!binding || binding.lane !== lane) {
    throw new Error("browser-neutral harness binding does not match its lane");
  }
  let primaryError = null;
  try {
    const adapter = await adapterSmoke();
    if (
      !adapter.deviceCreated ||
      !adapter.surfacePresented ||
      adapter.secureContext !== true ||
      !hasMeasuredLumaPresentation(adapter) ||
      adapter.isFallbackAdapter !== false
    ) {
      throw new Error("adapter smoke did not prove required hardware presentation");
    }
    const assertionResult =
      driver === "infrastructure-canary"
        ? { supportAssertionsExecuted: false, passed: true }
        : await assertions();
    if (!assertionResult.passed) {
      throw new Error("browser-owned assertion payload failed");
    }
    return {
      schemaVersion: 1,
      ...binding,
      driver,
      adapter,
      assertions: assertionResult,
      result: "PASS",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const result = await cleanup().catch((error) => ({
      ok: false,
      error: error.message,
    }));
    if (result.ok !== true && primaryError === null) {
      throw new Error(`hardware harness cleanup failed: ${result.error}`);
    }
  }
}

function productionDependencies() {
  return {
    announceManualReadiness: async ({ path, readiness }) => {
      if (!path) throw new Error("manual readiness output path is required");
      writeFileSync(path, `${JSON.stringify(readiness)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    },
    waitForControllerWindow: async ({ path, binding }) => {
      if (!path) throw new Error("controller capture-window path is required");
      const deadline = Date.now() + 10 * 60 * 1000;
      while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      if (!existsSync(path)) throw new Error("controller capture window is missing");
      const window = JSON.parse(readFileSync(path, "utf8"));
      const started = Date.parse(window.startedAt), ended = Date.parse(window.endedAt);
      if (window.schemaVersion !== 1 || window.binding?.runId !== binding.runId ||
          window.binding?.jobId !== binding.jobId || window.binding?.assetId !== binding.assetId ||
          !Number.isFinite(started) || ended - started !== 20 * 60 * 1000) {
        throw new Error("controller capture window is invalid or replayed");
      }
      return window;
    },
    waitUntil: async (end, assertHealthy) => {
      if (typeof assertHealthy !== "function") throw new Error("INFRA_ERROR SESSION_HEALTH_OBSERVER_MISSING");
      while (Date.now() < end.getTime()) {
        await assertHealthy();
        const delay = Math.min(1000, end.getTime() - Date.now());
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      await assertHealthy();
    },
    openSession: openProductionSession,
  };
}

function writeJson(path, value) {
  if (!path) throw new Error("output path is required");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    result.set(key, value);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  await executeHardwareBrowserLane({
    lane: args.get("--lane"),
    assetId: args.get("--asset-id"),
    hostId: args.get("--host-id"),
    platform: args.get("--platform") ?? process.platform,
    binding: JSON.parse(readFileSync(args.get("--binding"), "utf8")),
    route: JSON.parse(readFileSync(args.get("--route"), "utf8")),
    browserPolicy: JSON.parse(
      readFileSync(args.get("--browser-policy"), "utf8"),
    ),
    deviceMatrix: JSON.parse(
      readFileSync(args.get("--device-matrix"), "utf8"),
    ),
    inventory: JSON.parse(readFileSync(args.get("--inventory"), "utf8")),
    mediaChallenge: args.get("--media-challenge") ?? null,
    appiumSessionModule: args.get("--appium-session-module") ?? null,
    outputPath: args.get("--output"),
    manualSessionInputPath: args.get("--manual-session-input") ?? null,
    watermarkPath: args.get("--watermark") ?? null,
    manualSessionReadinessPath: args.get("--manual-session-readiness") ?? null,
    controllerCaptureWindowPath: args.get("--controller-capture-window") ?? null,
    trackpadInventory: args.get("--trackpad-inventory")
      ? JSON.parse(readFileSync(args.get("--trackpad-inventory"), "utf8")) : null,
    processRegistryPath: args.get("--process-registry") ?? null,
  });
}
