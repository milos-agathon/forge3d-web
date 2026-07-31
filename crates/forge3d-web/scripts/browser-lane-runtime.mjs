import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openProductionSession } from "./browser-session-runtime.mjs";
import { validateBrowserRunProvenance } from "./browser-run-provenance.mjs";
import { hasMeasuredLumaPresentation } from "./join-adapter-attestation.mjs";

const DESKTOP_LANES = new Map([
  ["chrome-macos-m2", ["playwright-chrome", "chrome"]],
  ["chrome-windows-intel12", ["playwright-chrome", "chrome"]],
  ["chrome-linux-intel12", ["playwright-chrome", "chrome"]],
  ["chrome-linux-rtx3070", ["playwright-chrome", "chrome"]],
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
  processRegistryPath = null,
  dependencies = productionDependencies(),
}) {
  const runtime = resolveLaneRuntime({ lane, assetId, platform });
  const manualSession = runtime.manual || mediaChallenge !== null;
  const session = await dependencies.openSession({
    runtime,
    assetId,
    routeUrl: route.applicationUrl,
    browserPolicy,
    deviceMatrix,
    appiumSessionModule,
    processRegistryPath,
  });
  const provenance = validateBrowserRunProvenance({
    runtime,
    session,
    inventory,
    hostId,
    platform,
    browserPolicy,
  });
  let pageResult;
  let startedAt = null;
  let endedAt = null;
  try {
    const record = await executeLaneContract({
      lane,
      driver: runtime.driver,
      binding,
      adapterSmoke: async () => {
        pageResult = await session.runPage({
          binding: {
            runId: binding.runId,
            jobId: binding.jobId,
            assetId: binding.assetId,
            commit: binding.commit,
            packageSha256: binding.packageSha256,
          },
          route,
          effectiveLaunchArguments: session.effectiveLaunchArguments,
          supportAssertions: runtime.supportAssertions,
          mediaChallenge,
        });
        if (manualSession) {
          startedAt = dependencies.now().toISOString();
          const end = new Date(
            new Date(startedAt).getTime() + 20 * 60 * 1000,
          );
          await dependencies.waitUntil(end);
          endedAt = end.toISOString();
        }
        return pageResult.adapter;
      },
      assertions: async () => pageResult.assertions,
      cleanup: async () => ({ ok: true }),
    });
    writeJson(outputPath, {
      ...record,
      browser: session.browser,
      route,
      routeReadiness: pageResult.routeReadiness,
      headed: true,
      driver: provenance.driver,
      system: provenance.system,
      session: provenance.loginSession,
      effectiveLaunchArguments: provenance.effectiveLaunchArguments,
      launchObservation: provenance.launchObservation,
      inventoryCapturedAt: provenance.inventoryCapturedAt,
    });
    if (manualSession) {
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
        system: provenance.system,
        loginSession: provenance.loginSession,
        effectiveLaunchArguments: provenance.effectiveLaunchArguments,
        launchObservation: provenance.launchObservation,
        startedAt,
        endedAt,
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
    now: () => new Date(),
    waitUntil: async (end) => {
      const delay = end.getTime() - Date.now();
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
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
    processRegistryPath: args.get("--process-registry") ?? null,
  });
}
