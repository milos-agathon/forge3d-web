import assert from "node:assert/strict";
import test from "node:test";

import { startPinnedAppiumSession } from "../src/appium-session.mjs";

const matrix = {
  appium: {
    version: "3.0.2",
    drivers: { uiautomator2: "5.0.0", xcuitest: "10.0.0" },
    wdaSigningIdentity: "forge3d-non-personal-ci-signing",
  },
  devices: [
    {
      assetId: "FW-AND-QCOM-01",
      appiumId: "android-qualcomm-s23",
      platformName: "Android",
      automationName: "UiAutomator2",
      browserName: "Chrome",
    },
    {
      assetId: "FW-IOS-OLD-01",
      appiumId: "ios-iphone11",
      platformName: "iOS",
      automationName: "XCUITest",
      browserName: "Safari",
    },
  ],
};

test("pinned Android Appium opens exact HTTPS route without exposing serial", async () => {
  let request;
  const record = await startPinnedAppiumSession({
    matrix,
    assetId: "FW-AND-QCOM-01",
    routeUrl: "https://app.example/runs/1/2/abc/",
    resolvePrivateDeviceId: async () => "PRIVATE-ANDROID-SERIAL",
    probeDevice: async () => ({ connected: true, unlocked: true, trusted: true }),
    appiumClient: client((value) => {
      request = value;
    }),
  });
  assert.equal(request.capabilities["appium:udid"], "PRIVATE-ANDROID-SERIAL");
  assert.equal(request.driverVersion, "5.0.0");
  assert.equal(JSON.stringify(record).includes("PRIVATE-ANDROID-SERIAL"), false);
  assert.equal(record.browserName, "Chrome");
});

test("iOS requires dedicated signing and disconnected/trust-prompt states fail", async () => {
  await assert.rejects(() =>
    startPinnedAppiumSession({
      matrix,
      assetId: "FW-IOS-OLD-01",
      routeUrl: "https://app.example/runs/1/2/abc/",
      resolvePrivateDeviceId: async () => "PRIVATE-UDID",
      probeDevice: async () => ({ connected: true, unlocked: true, trusted: true }),
      appiumClient: client(),
    }),
  );
  await assert.rejects(
    () =>
      startPinnedAppiumSession({
        matrix,
        assetId: "FW-AND-QCOM-01",
        routeUrl: "https://app.example/runs/1/2/abc/",
        resolvePrivateDeviceId: async () => "PRIVATE-SERIAL",
        probeDevice: async () => ({
          connected: true,
          unlocked: false,
          trusted: false,
        }),
        appiumClient: client(),
      }),
    /disconnected, locked, or awaiting a trust prompt/u,
  );
});

function client(capture = () => undefined) {
  return {
    createSession: async (request) => {
      capture(request);
      return {
        navigate: async () => undefined,
        browserInfo: async () => ({ version: "current" }),
        delete: async () => undefined,
      };
    },
  };
}
