import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-json.mjs";
import { openProductionSession } from "./browser-session-runtime.mjs";

const REQUIRED_ROUTE_ASSERTIONS = [
  "secureContext",
  "trustedHttps",
  "applicationCertificateTrusted",
  "assetCertificateTrusted",
  "packageSha256Matched",
  "wasmMimePassed",
  "corsAllowPassed",
  "corsDenyPassed",
  "rangePassed",
  "wrongMimeRejected",
  "publicLoaderAllowedWasmPassed",
];

export async function probeAttachedMobileRoutes({
  hostId,
  binding,
  route,
  browserPolicy,
  httpsOriginPolicy,
  hardwareMatrix,
  deviceMatrix,
  inventory,
  appiumSessionModule,
  processRegistryPath,
  dependencies = {
    now: () => new Date(),
    openSession: openProductionSession,
  },
}) {
  const devices = validateProbeClosure({
    hostId,
    binding,
    route,
    hardwareMatrix,
    deviceMatrix,
    inventory,
    httpsOriginPolicy,
  });
  const startedAt = dependencies.now().toISOString();
  const probes = [];
  for (const device of devices) {
    const runtime = {
      driver:
        device.automationName === "XCUITest"
          ? "appium-xcuitest"
          : "appium-uiautomator2",
      browser: device.browserName.toLowerCase(),
      supportAssertions: false,
      manual: false,
      mobile: true,
    };
    const session = await dependencies.openSession({
      runtime,
      assetId: device.assetId,
      routeUrl: route.applicationUrl,
      browserPolicy,
      deviceMatrix,
      appiumSessionModule,
      processRegistryPath,
    });
    try {
      const routeReadiness = await session.runRouteProbe({
        route,
        expectedPackageSha256: binding.packageSha256,
      });
      assertRouteReadiness(routeReadiness);
      const observedAt = dependencies.now().toISOString();
      const mobile = session.mobileDevice;
      if (
        mobile?.assetId !== device.assetId ||
        mobile.appiumId !== device.appiumId ||
        mobile.platformName !== device.platformName ||
        mobile.automationName !== device.automationName ||
        mobile.browserName !== device.browserName ||
        typeof mobile.platformVersion !== "string" ||
        mobile.platformVersion.length < 1 ||
        mobile.appiumVersion !== deviceMatrix.appium.version ||
        mobile.driverVersion !==
          deviceMatrix.appium.drivers[
            device.automationName === "XCUITest" ? "xcuitest" : "uiautomator2"
          ] ||
        mobile.routeUrl !== route.applicationUrl ||
        mobile.connected !== true ||
        mobile.unlocked !== true ||
        mobile.trusted !== true ||
        mobile.acceptInsecureCerts !== false ||
        session.browser?.version !== mobile.browserVersion
      ) {
        throw new Error(`Appium route identity is invalid: ${device.assetId}`);
      }
      probes.push({
        hostId,
        assetId: mobile.assetId,
        appiumId: mobile.appiumId,
        platformName: mobile.platformName,
        automationName: mobile.automationName,
        browserName: mobile.browserName,
        browserVersion: mobile.browserVersion,
        platformVersion: mobile.platformVersion,
        appiumVersion: mobile.appiumVersion,
        driverVersion: mobile.driverVersion,
        connected: true,
        unlocked: true,
        trusted: true,
        acceptInsecureCerts: false,
        routeUrl: mobile.routeUrl,
        routeReadiness,
        observedAt,
      });
    } finally {
      await session.close();
    }
  }
  return {
    schemaVersion: 1,
    recordType: "mobile-device-route-readiness",
    supportClaim: false,
    hostId,
    binding: {
      runId: binding.runId,
      jobId: binding.jobId,
      assetId: binding.assetId,
      commit: binding.commit,
      packageSha256: binding.packageSha256,
    },
    route,
    probes,
    startedAt,
    completedAt: dependencies.now().toISOString(),
  };
}

function validateProbeClosure({
  hostId,
  binding,
  route,
  hardwareMatrix,
  deviceMatrix,
  inventory,
  httpsOriginPolicy,
}) {
  const host = hardwareMatrix?.hosts?.find((entry) => entry.assetId === hostId);
  const attached = (hardwareMatrix?.assets ?? [])
    .filter((asset) => asset.hostAssetId === hostId && asset.appiumId !== null)
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const devices = [...(deviceMatrix?.devices ?? [])].sort((left, right) =>
    left.assetId.localeCompare(right.assetId),
  );
  const inventoryDevices = (inventory?.attachedAssets ?? [])
    .filter((asset) => asset.appiumId !== null)
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const checkedOrigin = httpsOriginPolicy?.hosts?.find(
    (candidate) => candidate.hostAssetId === hostId,
  );
  const expectedBasePath = new RegExp(
    `^/runs/${binding?.runId}/${binding?.jobId}/[0-9a-f]{32}/$`,
    "u",
  );
  if (
    hostId !== "FW-MAC-M2-01" ||
    deviceMatrix?.hostAssetId !== hostId ||
    host?.assetId !== hostId ||
    inventory?.assetId !== hostId ||
    binding?.assetId !== hostId ||
    !Number.isInteger(binding?.runId) ||
    !Number.isInteger(binding?.jobId) ||
    !/^[0-9a-f]{40}$/u.test(binding?.commit ?? "") ||
    !/^[0-9a-f]{64}$/u.test(binding?.packageSha256 ?? "") ||
    !expectedBasePath.test(route?.basePath ?? "") ||
    route.applicationUrl !== `https://${route.applicationHost}${route.basePath}` ||
    route.assetUrl !== `https://${route.assetHost}${route.basePath}` ||
    route.applicationHost === route.assetHost ||
    route.applicationHost !== checkedOrigin?.applicationHost ||
    route.assetHost !== checkedOrigin?.assetHost ||
    route.expectedPackageSha256 !== binding.packageSha256 ||
    attached.length !== 6 ||
    devices.length !== attached.length ||
    inventoryDevices.length !== attached.length ||
    new Set(devices.map((device) => device.assetId)).size !== devices.length ||
    new Set(devices.map((device) => device.appiumId)).size !== devices.length
  ) {
    throw new Error("mobile Appium route probe closure is invalid");
  }
  for (let index = 0; index < attached.length; index += 1) {
    const expected = attached[index];
    const device = devices[index];
    const observed = inventoryDevices[index];
    if (
      !host.attachedAssetIds.includes(expected.assetId) ||
      device.assetId !== expected.assetId ||
      device.appiumId !== expected.appiumId ||
      observed.assetId !== expected.assetId ||
      observed.appiumId !== expected.appiumId
    ) {
      throw new Error("mobile Appium asset/inventory resolution is not exact");
    }
  }
  return devices;
}

export function assertRouteReadiness(readiness) {
  if (
    REQUIRED_ROUTE_ASSERTIONS.some((name) => readiness?.[name] !== true) ||
    readiness?.wrongMimeErrorCode !== "WASM_LOAD_FAILED" ||
    readiness?.corsDenyWasmErrorCode !== "WASM_LOAD_FAILED" ||
    readiness?.corsWrongOriginWasmErrorCode !== "WASM_LOAD_FAILED"
  ) {
    throw new Error("physical browser route readiness is incomplete");
  }
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
  const required = (name) => {
    const value = args.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const readJson = (name) => JSON.parse(readFileSync(required(name), "utf8"));
  const result = await probeAttachedMobileRoutes({
    hostId: required("--host-id"),
    binding: readJson("--binding"),
    route: readJson("--route"),
    browserPolicy: readJson("--browser-policy"),
    httpsOriginPolicy: readJson("--origin-policy"),
    hardwareMatrix: readJson("--hardware-matrix"),
    deviceMatrix: readJson("--device-matrix"),
    inventory: readJson("--inventory"),
    appiumSessionModule: required("--appium-session-module"),
    processRegistryPath: required("--process-registry"),
  });
  writeFileSync(required("--output"), `${canonicalJson(result)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, probes: result.probes.length }));
}
