import { assertSafeLaunchArguments } from "./capture-host-inventory.mjs";
import { isLiveChromiumLaunchArgumentSource } from "./browser-launch-provenance.mjs";

const browserInventoryIds = {
  chrome: "chrome-stable",
  msedge: "edge-stable",
  safari: "safari-stable",
  firefox: "firefox-release",
};

export function validateBrowserRunProvenance({
  runtime,
  session,
  inventory,
  hostId,
  platform,
  browserPolicy,
}) {
  if (
    inventory?.schemaVersion !== 1 ||
    inventory.assetId !== hostId ||
    inventory.platform !== platform ||
    inventory.headed !== true ||
    inventory.session?.interactive !== true ||
    inventory.session?.locked !== false ||
    inventory.session?.remote !== false ||
    !nonEmpty(inventory.osBuild) ||
    !nonEmpty(inventory.displayServer) ||
    !nonEmpty(inventory.session.identifier) ||
    !nonEmpty(inventory.capturedAt)
  ) {
    throw new Error("live host inventory does not prove the authorized headed session");
  }
  if (
    !nonEmpty(session.browser?.version) ||
    session.browser.version === "unknown" ||
    !nonEmpty(session.driverVersion) ||
    session.driverVersion.startsWith("checked-") ||
    session.launchArgumentsObserved !== true ||
    !nonEmpty(session.launchArgumentSource) ||
    !validLaunchSource(runtime, session.launchArgumentSource, platform) ||
    !Array.isArray(session.effectiveLaunchArguments) ||
    session.effectiveLaunchArguments.some(
      (argument) => typeof argument !== "string",
    )
  ) {
    throw new Error("browser launch did not expose exact runtime provenance");
  }
  assertSafeLaunchArguments(
    session.effectiveLaunchArguments,
    browserPolicy,
  );
  validateBrowserVersion(runtime, session.browser, inventory);
  validateDriverVersion(runtime, session.driverVersion, inventory, browserPolicy);
  return {
    system: {
      platform: inventory.platform,
      osBuild: inventory.osBuild,
      displayServer: inventory.displayServer,
    },
    loginSession: { ...inventory.session },
    driver: {
      name: runtime.driver,
      version: session.driverVersion,
    },
    effectiveLaunchArguments: [...session.effectiveLaunchArguments],
    launchObservation: {
      observed: true,
      source: session.launchArgumentSource,
      browserProcessId: session.browserProcessId ?? null,
    },
    inventoryCapturedAt: inventory.capturedAt,
  };
}

function validateBrowserVersion(runtime, browser, inventory) {
  if (runtime.mobile) return;
  const inventoryId = browserInventoryIds[runtime.browser];
  const installed = inventory.browsers?.find(({ id }) => id === inventoryId);
  if (
    !installed ||
    installed.version !== browser.version ||
    !nonEmpty(installed.executable)
  ) {
    throw new Error("running browser version does not match live checked inventory");
  }
}

function validateDriverVersion(runtime, version, inventory, policy) {
  let expected;
  if (
    runtime.driver === "playwright-chrome" ||
    runtime.driver === "playwright-edge" ||
    runtime.driver === "infrastructure-canary"
  ) {
    expected = policy.tools.playwright;
  } else if (runtime.driver === "selenium-firefox") {
    expected = policy.tools.geckodriver;
  } else if (runtime.driver === "safaridriver") {
    expected = inventory.tools?.safaridriverVersion;
  } else if (runtime.driver === "appium-xcuitest") {
    expected = policy.tools.appiumXcuitest;
  } else if (runtime.driver === "appium-uiautomator2") {
    expected = policy.tools.appiumUiAutomator2;
  }
  const exact =
    runtime.driver === "selenium-firefox"
      ? String(version).match(/[0-9]+\.[0-9]+\.[0-9]+/gu)?.includes(expected)
      : version === expected;
  if (!nonEmpty(expected) || exact !== true) {
    throw new Error("running driver version does not match checked inventory");
  }
}

function validLaunchSource(runtime, source, platform) {
  if (
    runtime.driver === "playwright-chrome" ||
    runtime.driver === "playwright-edge" ||
    runtime.driver === "infrastructure-canary"
  ) {
    return isLiveChromiumLaunchArgumentSource(source, platform);
  }
  if (
    runtime.driver === "selenium-firefox" ||
    runtime.driver === "safaridriver"
  ) {
    return source === `${platform}-live-browser-process`;
  }
  return source === "appium-effective-session-capabilities";
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}
