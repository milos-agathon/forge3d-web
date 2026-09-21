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
import {
  validateFfx03HardwareProof,
  validateFfx03ProbeOutcome,
} from "./ffx03-hardware-proof-validator.mjs";
import { FFX03_STABLE_LANES, isFfx03Lane, resolveFfx03Lane } from "./ffx03-lanes.mjs";
import { validateSaf03SafariProof } from "./saf03-proof-validator.mjs";
import { isSaf03Lane } from "./saf03-lanes.mjs";
import { validateSaf02Conformance } from "./saf02-conformance-validator.mjs";
import { validateSaf04HardwareProof } from "./saf04-hardware-proof-validator.mjs";
import { validateFfx04LifecycleProof } from "./ffx04-lifecycle-proof-validator.mjs";
import { isFfx04Lane } from "./ffx04-lanes.mjs";

const CHR03_REQUIRED_LANES = new Set(Object.keys(CHR03_STABLE_LANES));
const CHR04_REQUIRED_LANES = new Set(Object.keys(CHR04_LANES));
const FFX03_REQUIRED_LANES = new Set(Object.keys(FFX03_STABLE_LANES));

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
  ["firefox-nightly-linux-intel12", ["selenium-firefox", "firefox"]],
  ["firefox-nightly-linux-rtx3070", ["selenium-firefox", "firefox"]],
]);

export function resolveLaneRuntime({ lane, assetId, platform, architecture = platform === "darwin" ? "arm64" : "x64", required }) {
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
    const firefox = isFfx03Lane(lane)
      ? resolveFfx03Lane({ lane, assetId, platform, architecture, required }) : null;
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
      ...(firefox ? { channel: firefox.channel, required: firefox.required,
        experimental: firefox.experimental, architecture, lane } : {}),
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
  architecture = null,
  required = null,
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
  architecture ??= inventory?.architecture ?? (platform === "darwin" ? "arm64" : "x64");
  if (isFfx03Lane(lane) && typeof required !== "boolean") {
    throw new Error("FFX-03 runtime requires the authorized required boolean");
  }
  const runtime = resolveLaneRuntime({ lane, assetId, platform, architecture,
    required: isFfx03Lane(lane) ? required : undefined });
  const manualLifecycle = runtime.manual || mediaChallenge !== null;
  if (
    manualLifecycle &&
    (typeof binding.expectedTester !== "string" ||
      binding.expectedTester.trim() === "")
  ) {
    throw new Error("product manual binding requires the authenticated tester");
  }
  const session = await dependencies.openSession({
    lane,
    runtime,
    assetId,
    platform,
    architecture,
    routeUrl: route.applicationUrl,
    browserPolicy,
    inventory,
    deviceMatrix,
    appiumSessionModule,
    processRegistryPath,
    temporaryRoot: processRegistryPath ? dirname(processRegistryPath) : null,
  });
  let pageResult;
  let captureWindow = null;
  let sessionClosed = false;
  let primaryError = null;
  try {
    const provenance = validateBrowserRunProvenance({
      runtime,
      session,
      inventory,
      hostId,
      platform,
      browserPolicy,
    });
    if (runtime.experimental) {
      pageResult = await session.runPage({
        lane, binding: closedPageBinding(binding), route,
        effectiveLaunchArguments: session.effectiveLaunchArguments,
        supportAssertions: true,
      });
      sessionClosed = true;
      const cleanup = await session.close();
      const probe = createFfx03ProbeRecord({ lane, assetId, platform, architecture,
        binding, route, session, provenance, pageResult, cleanup });
      validateFfx03ProbeOutcome(probe, { lane, assetId, platform, architecture,
        commit: binding.commit, packageSha256: binding.packageSha256 });
      writeJson(outputPath, probe);
      return probe;
    }
    const record = await executeLaneContract({
      lane,
      driver: runtime.driver,
      binding,
      adapterSmoke: async () => {
        pageResult = await session.runPage({
          lane,
          binding: {
            ...(isChr03Lane(lane) || isChr04Lane(lane) || isFfx03Lane(lane) || isSaf03Lane(lane)
              ? { lane: binding.lane }
              : {}),
            runId: binding.runId,
            jobId: binding.jobId,
            assetId: binding.assetId,
            ...(lane === "safari-macos-m2" ? { hostId } : {}),
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
        if (isFfx04Lane(lane)) {
          if (typeof session.runFirefoxLifecycle !== "function") {
            throw new Error("FFX04_LIFECYCLE_RUNNER_UNAVAILABLE");
          }
          pageResult.ffx04Proof = await session.runFirefoxLifecycle({
            lane,
            assetId,
            platform,
            binding,
            route,
          });
        }
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
        if (lane === "safari-macos-m2") {
          validateSaf02Conformance(pageResult.saf02Proof, {
            lane, assetId, hostId, runId: binding.runId, jobId: binding.jobId,
            commit: binding.commit, packageSha256: binding.packageSha256,
            applicationUrl: route.applicationUrl, assetUrl: route.assetUrl,
            browser: session.browser, system: provenance.system, adapter: pageResult.adapter,
            effectiveLaunchArguments: provenance.effectiveLaunchArguments,
          });
        }
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
        if (lane === "safari-macos-m2") {
          validateSaf04HardwareProof(pageResult.saf04Proof, {
            lane, assetId, commit: binding.commit, packageSha256: binding.packageSha256,
          });
        }
        if (isFfx04Lane(lane)) {
          validateFfx04LifecycleProof(pageResult.ffx04Proof, {
            lane,
            runId: binding.runId,
            jobId: binding.jobId,
            assetId,
            platform,
            commit: binding.commit,
            packageSha256: binding.packageSha256,
            browser: session.browser,
            driver: provenance.driver,
            applicationUrl: route.applicationUrl,
          });
        }
        if (lane === "safari-macos-m2") {
          validateSaf03SafariProof(pageResult.saf03Proof, {
            lane,
            assetId,
            platform,
            commit: binding.commit,
            packageSha256: binding.packageSha256,
          });
        }
        return pageResult.assertions;
      },
      cleanup: async () => ({ ok: true }),
    });
    const safariTechnologyPreview = lane === "safari-macos-m2"
      ? await session.runTechnologyPreview({ lane, binding, route })
      : null;
    const evidence = {
      ...record,
      browser: session.browser,
      route,
      routeReadiness: pageResult.routeReadiness,
      chr03Proof: pageResult.chr03Proof ?? null,
      chr04Proof: pageResult.chr04Proof ?? null,
      ffx03Proof: null,
      saf03Proof: pageResult.saf03Proof ?? null,
      safariTechnologyPreview,
      saf02Proof: pageResult.saf02Proof ?? null,
      saf04Proof: pageResult.saf04Proof ?? null,
      ffx04Proof: pageResult.ffx04Proof ?? null,
      headed: true,
      driver: provenance.driver,
      system: provenance.system,
      session: provenance.loginSession,
      effectiveLaunchArguments: provenance.effectiveLaunchArguments,
      launchObservation: provenance.launchObservation,
      inventoryCapturedAt: provenance.inventoryCapturedAt,
    };
    if (FFX03_REQUIRED_LANES.has(lane)) {
      sessionClosed = true;
      const cleanup = await session.close();
      evidence.ffx03Proof = createFfx03StableProof({ lane, assetId, platform,
        architecture, binding, session, provenance, pageResult, cleanup });
      validateFfx03HardwareProof(evidence.ffx03Proof, {
        lane, assetId, platform, architecture, commit: binding.commit,
        packageSha256: binding.packageSha256,
      });
    }
    writeJson(outputPath, evidence);
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
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!sessionClosed) {
      try {
        await session.close();
      } catch (cleanupError) {
        if (primaryError) throw new AggregateError([primaryError, cleanupError],
          "browser lane failed and session cleanup also failed");
        throw cleanupError;
      }
    }
  }
}

function closedPageBinding(binding) {
  return { lane: binding.lane, runId: binding.runId, jobId: binding.jobId,
    assetId: binding.assetId, commit: binding.commit, packageSha256: binding.packageSha256 };
}

function createFfx03StableProof({ lane, assetId, platform, architecture, binding,
  session, provenance, pageResult, cleanup }) {
  return {
    schemaVersion: 1, kind: "forge3d-ffx03-firefox-hardware-proof-v1",
    classification: "required", required: true, experimental: false,
    binding: { lane, assetId, platform, architecture, channel: "release",
      commit: binding.commit, packageSha256: binding.packageSha256 },
    browser: session.browser,
    driver: { name: "selenium-firefox", version: session.driverVersion,
      executable: session.driverExecutable, clientName: "selenium-webdriver",
      clientVersion: session.clientVersion },
    system: { platform, architecture, osBuild: provenance.system.osBuild },
    launch: { observed: true, source: session.launchArgumentSource,
      browserProcessId: session.browserProcessId, executable: session.observedExecutable,
      arguments: session.effectiveLaunchArguments },
    configuration: pageResult.configuration,
    adapter: pageResult.adapter,
    workload: pageResult.ffx03Workload,
    errors: [], cleanup,
  };
}

function createFfx03ProbeRecord({ lane, assetId, platform, architecture, binding,
  route, session, provenance, pageResult, cleanup }) {
  const outcome = pageResult.probeOutcome;
  return {
    schemaVersion: 1, kind: "forge3d-ffx03-firefox-nightly-probe-v1",
    classification: "probe", required: false, experimental: true, outcome,
    binding: { lane, assetId, platform, architecture, channel: "nightly",
      commit: binding.commit, packageSha256: binding.packageSha256 },
    browser: session.browser,
    driver: { name: "selenium-firefox", version: session.driverVersion,
      executable: session.driverExecutable, clientName: "selenium-webdriver",
      clientVersion: session.clientVersion },
    system: { platform, architecture, osBuild: provenance.system.osBuild },
    launch: { observed: true, source: session.launchArgumentSource,
      browserProcessId: session.browserProcessId, executable: session.observedExecutable,
      arguments: session.effectiveLaunchArguments },
    configuration: pageResult.configuration,
    route: route.applicationUrl,
    adapter: outcome === "PROBE_PASS" ? pageResult.adapter : null,
    diagnostic: outcome === "PROBE_PASS" ? null : pageResult.diagnostic,
    cleanup,
  };
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
    required: args.has("--required") ? parseRequired(args.get("--required")) : null,
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

function parseRequired(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("--required must be true or false");
}
