export async function startPinnedAppiumSession({
  matrix,
  assetId,
  routeUrl,
  resolvePrivateDeviceId,
  probeDevice,
  appiumClient,
  signingMaterial = null,
}) {
  const device = matrix.devices.find((candidate) => candidate.assetId === assetId);
  if (!device || !/^https:\/\//u.test(routeUrl ?? "")) {
    throw new Error("Appium asset or run-specific HTTPS route is invalid");
  }
  const privateDeviceId = await resolvePrivateDeviceId(device.appiumId);
  if (typeof privateDeviceId !== "string" || privateDeviceId.length < 1) {
    throw new Error("protected inventory did not resolve the Appium device");
  }
  const state = await probeDevice(privateDeviceId);
  if (
    state.connected !== true ||
    state.unlocked !== true ||
    state.trusted !== true
  ) {
    throw new Error("device is disconnected, locked, or awaiting a trust prompt");
  }
  const capabilities = {
    platformName: device.platformName,
    browserName: device.browserName,
    "appium:automationName": device.automationName,
    "appium:udid": privateDeviceId,
    "appium:noReset": false,
    "appium:newCommandTimeout": 1_500,
  };
  if (device.automationName === "XCUITest") {
    if (
      signingMaterial?.identity !== matrix.appium.wdaSigningIdentity ||
      !signingMaterial.teamId ||
      !signingMaterial.bundleId
    ) {
      throw new Error("dedicated non-personal WebDriverAgent signing is unavailable");
    }
    Object.assign(capabilities, {
      "appium:xcodeSigningId": signingMaterial.identity,
      "appium:xcodeOrgId": signingMaterial.teamId,
      "appium:updatedWDABundleId": signingMaterial.bundleId,
    });
  }
  const session = await appiumClient.createSession({
    serverVersion: matrix.appium.version,
    driverName: device.automationName.toLowerCase(),
    driverVersion:
      device.automationName === "XCUITest"
        ? matrix.appium.drivers.xcuitest
        : matrix.appium.drivers.uiautomator2,
    capabilities,
  });
  try {
    await session.navigate(routeUrl);
    const browser = await session.browserInfo();
    return {
      assetId: device.assetId,
      appiumId: device.appiumId,
      platformName: device.platformName,
      automationName: device.automationName,
      browserName: device.browserName,
      appiumVersion: matrix.appium.version,
      driverVersion:
        device.automationName === "XCUITest"
          ? matrix.appium.drivers.xcuitest
          : matrix.appium.drivers.uiautomator2,
      browserVersion: browser.version,
      routeUrl,
      connected: true,
      unlocked: true,
      trusted: true,
    };
  } catch (error) {
    await session.delete().catch(() => undefined);
    throw error;
  }
}
