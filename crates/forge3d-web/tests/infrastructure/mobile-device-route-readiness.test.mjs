import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  probeAttachedMobileRoutes,
} from "../../scripts/probe-mobile-device-routes.mjs";
import { WebDriverClient } from "../../scripts/webdriver-client.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";
import { exactHostInventory } from "./host-inventory-fixture.mjs";

const hardwareMatrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const deviceMatrix = JSON.parse(
  readFileSync(new URL("../device/device-matrix.json", import.meta.url), "utf8"),
);
const httpsOriginPolicy = JSON.parse(
  readFileSync(new URL("./https-origin-policy.json", import.meta.url), "utf8"),
);
const schema = JSON.parse(
  readFileSync(
    new URL("./mobile-device-route-readiness.schema.json", import.meta.url),
    "utf8",
  ),
);
const hostId = "FW-MAC-M2-01";
const packageSha256 = "b".repeat(64);
const binding = {
  lane: "infrastructure-canary",
  runId: 10,
  jobId: 11,
  assetId: hostId,
  commit: "a".repeat(40),
  packageSha256,
};
const route = {
  schemaVersion: 1,
  applicationHost: "mac-m2.webgpu-ci.forge3d.dev",
  assetHost: "assets-mac-m2.webgpu-ci.forge3d.dev",
  basePath: `/runs/10/11/${"c".repeat(32)}/`,
  applicationUrl:
    `https://mac-m2.webgpu-ci.forge3d.dev/runs/10/11/${"c".repeat(32)}/`,
  assetUrl:
    `https://assets-mac-m2.webgpu-ci.forge3d.dev/runs/10/11/${"c".repeat(32)}/`,
  expectedPackageSha256: packageSha256,
};

test("six physical Appium devices prove the exact nonce-bound browser route", async () => {
  const opened = [];
  const closed = [];
  let tick = 0;
  const result = await probeAttachedMobileRoutes({
    hostId,
    binding,
    route,
    browserPolicy: {},
    httpsOriginPolicy,
    hardwareMatrix,
    deviceMatrix,
    inventory: exactHostInventory(hardwareMatrix, hostId),
    appiumSessionModule: "/package/appium-session.mjs",
    processRegistryPath: "/job/browser-processes.json",
    dependencies: {
      now: () => new Date(Date.UTC(2026, 6, 29, 10, 0, tick++)),
      openSession: async (request) => {
        const device = deviceMatrix.devices.find(
          (candidate) => candidate.assetId === request.assetId,
        );
        opened.push(request.assetId);
        const driverVersion =
          device.automationName === "XCUITest"
            ? deviceMatrix.appium.drivers.xcuitest
            : deviceMatrix.appium.drivers.uiautomator2;
        return {
          browser: { version: "current" },
          mobileDevice: {
            ...device,
            appiumVersion: deviceMatrix.appium.version,
            driverVersion,
            browserVersion: "current",
            platformVersion: "current-patched",
            routeUrl: route.applicationUrl,
            connected: true,
            unlocked: true,
            trusted: true,
            acceptInsecureCerts: false,
          },
          runRouteProbe: async () => completeReadiness(),
          close: async () => closed.push(request.assetId),
        };
      },
    },
  });
  assert.equal(result.supportClaim, false);
  assert.equal(result.probes.length, 6);
  assert.deepEqual(opened.sort(), deviceMatrix.devices.map(({ assetId }) => assetId).sort());
  assert.deepEqual(closed.sort(), opened.sort());
  assert.doesNotThrow(() => assertJsonSchema(result, schema));
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("declarations, incomplete device closure, and incomplete browser proof fail closed", async () => {
  await assert.rejects(
    () =>
      probeAttachedMobileRoutes({
        hostId,
        binding,
        route: {
          ...route,
          basePath: "/runs/10/11/caller-declared/",
          applicationUrl:
            "https://mac-m2.webgpu-ci.forge3d.dev/runs/10/11/caller-declared/",
          assetUrl:
            "https://assets-mac-m2.webgpu-ci.forge3d.dev/runs/10/11/caller-declared/",
        },
        httpsOriginPolicy,
        hardwareMatrix,
        deviceMatrix,
        inventory: exactHostInventory(hardwareMatrix, hostId),
        dependencies: {},
      }),
    /closure is invalid/u,
  );
  await assert.rejects(
    () =>
      probeAttachedMobileRoutes({
        hostId,
        binding,
        route: {
          ...route,
          applicationHost: "caller-selected.webgpu-ci.forge3d.dev",
          applicationUrl:
            `https://caller-selected.webgpu-ci.forge3d.dev${route.basePath}`,
        },
        httpsOriginPolicy,
        hardwareMatrix,
        deviceMatrix,
        inventory: exactHostInventory(hardwareMatrix, hostId),
        dependencies: {},
      }),
    /closure is invalid/u,
  );
  await assert.rejects(
    () =>
      probeAttachedMobileRoutes({
        hostId,
        binding,
        route: {
          ...route,
          applicationHost: route.assetHost,
          assetHost: route.applicationHost,
          applicationUrl: route.assetUrl,
          assetUrl: route.applicationUrl,
        },
        httpsOriginPolicy,
        hardwareMatrix,
        deviceMatrix,
        inventory: exactHostInventory(hardwareMatrix, hostId),
        dependencies: {},
      }),
    /closure is invalid/u,
  );
  await assert.rejects(
    () =>
      probeAttachedMobileRoutes({
        hostId,
        binding,
        route,
        browserPolicy: {},
        httpsOriginPolicy,
        hardwareMatrix,
        deviceMatrix: {
          ...deviceMatrix,
          devices: deviceMatrix.devices.slice(1),
        },
        inventory: exactHostInventory(hardwareMatrix, hostId),
        dependencies: {},
      }),
    /closure is invalid/u,
  );
  await assert.rejects(
    () =>
      probeAttachedMobileRoutes({
        hostId,
        binding,
        route,
        browserPolicy: {},
        httpsOriginPolicy,
        hardwareMatrix,
        deviceMatrix,
        inventory: exactHostInventory(hardwareMatrix, hostId),
        appiumSessionModule: "/package/appium-session.mjs",
        processRegistryPath: "/job/browser-processes.json",
        dependencies: {
          now: () => new Date("2026-07-29T10:00:00.000Z"),
          openSession: async ({ assetId }) => {
            const device = deviceMatrix.devices.find(
              (candidate) => candidate.assetId === assetId,
            );
            return {
              browser: { version: "current" },
              mobileDevice: {
                ...device,
                appiumVersion: deviceMatrix.appium.version,
                driverVersion:
                  device.automationName === "XCUITest" ? "10.0.0" : "5.0.0",
                browserVersion: "current",
                platformVersion: "current-patched",
                routeUrl: route.applicationUrl,
                connected: true,
                unlocked: true,
                trusted: true,
                acceptInsecureCerts: false,
              },
              runRouteProbe: async () => ({
                ...completeReadiness(),
                trustedHttps: false,
              }),
              close: async () => undefined,
            };
          },
        },
      }),
    /physical browser route readiness is incomplete/u,
  );
});

test("WebDriver executes route verification inside the navigated physical browser", async () => {
  const requests = [];
  const client = new WebDriverClient("http://127.0.0.1:4723/wd/hub", async (
    url,
    init,
  ) => {
    requests.push({ url, init });
    if (url.endsWith("/session")) {
      return response({ value: { sessionId: "physical", capabilities: {} } });
    }
    return response({ value: { ok: true, value: completeReadiness() } });
  });
  const session = await client.createSession({ browserName: "Safari" });
  const result = await session.runRouteProbe({ route, expectedPackageSha256: packageSha256 });
  assert.equal(result.trustedHttps, true);
  const execution = JSON.parse(requests[1].init.body);
  assert.match(execution.script, /verifyBrowserRoute/u);
  assert.deepEqual(execution.args, [{ route, expectedPackageSha256: packageSha256 }]);
  assert.match(requests[1].url, /\/session\/physical\/execute\/async$/u);
});

function completeReadiness() {
  return {
    secureContext: true,
    trustedHttps: true,
    applicationCertificateTrusted: true,
    assetCertificateTrusted: true,
    packageSha256Matched: true,
    wasmMimePassed: true,
    corsAllowPassed: true,
    corsDenyPassed: true,
    rangePassed: true,
    wrongMimeRejected: true,
    publicLoaderAllowedWasmPassed: true,
    wrongMimeErrorCode: "WASM_LOAD_FAILED",
    corsDenyWasmErrorCode: "WASM_LOAD_FAILED",
    corsWrongOriginWasmErrorCode: "WASM_LOAD_FAILED",
  };
}

function response(body) {
  return {
    ok: true,
    json: async () => body,
  };
}
