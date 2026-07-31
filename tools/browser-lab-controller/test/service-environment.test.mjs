import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadControllerEnvironmentFile,
} from "../src/controller-service.mjs";
import {
  createProductionControllerDependencies,
} from "../src/production-dependencies.mjs";
import { BrokerLifecycleStore } from "../src/broker-lifecycle-store.mjs";
import { serviceInstallationFixture } from "../../../crates/forge3d-web/tests/infrastructure/service-installation-fixture.mjs";

test("loaded service runtime controls cross the sanitized JIT boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-controller-env-"));
  const environmentFile = join(directory, "controller.env");
  try {
    writeFileSync(
      environmentFile,
      [
        "PATH=/opt/forge3d/bin:/usr/bin",
        "FORGE3D_BROWSER_INVENTORY_HELPER=/usr/local/libexec/inventory",
        "FORGE3D_UPDATE_CONTROL_HELPER=/usr/local/libexec/update-control",
        "FORGE3D_PLAYWRIGHT_MODULE=/opt/forge3d/playwright/index.mjs",
        "FORGE3D_APPIUM_EXECUTABLE=/opt/forge3d/bin/appium",
        "FORGE3D_DEVICE_CONTROL_HELPER=/usr/local/libexec/device-control",
        "FORGE3D_CLOUDFLARED_EXECUTABLE=/opt/forge3d/bin/cloudflared",
        "FORGE3D_CONTROLLER_GITHUB_PRIVATE_KEY_FILE=/secrets/controller.pem",
        "FORGE3D_BROKER_CLIENT_KEY_FILE=/secrets/broker.key",
        "",
      ].join("\n"),
    );
    const loaded = loadControllerEnvironmentFile(environmentFile, {});
    assert.throws(
      () =>
        createProductionControllerDependencies({
          hostId: "FW-LNX-I12-01",
          github: {},
          broker: {},
          platform: "linux",
          configuration: configuration(directory),
        }),
      /loaded service environment is required/u,
    );
    const dependencies = createProductionControllerDependencies({
      hostId: "FW-LNX-I12-01",
      github: {},
      broker: {},
      lifecycleStore: new BrokerLifecycleStore({
        hostId: "FW-LNX-I12-01",
      }),
      platform: "linux",
      runnerEnvironment: loaded,
      installationEvidence: serviceInstallationFixture({
        component: "controller",
        instanceId: "FW-LNX-I12-01",
      }),
      configuration: configuration(directory),
    });
    const runner = dependencies.runnerEnvironment();
    assert.equal(runner.PATH, "/opt/forge3d/bin:/usr/bin");
    assert.equal(
      runner.FORGE3D_BROWSER_INVENTORY_HELPER,
      "/usr/local/libexec/inventory",
    );
    assert.equal(
      runner.FORGE3D_UPDATE_CONTROL_HELPER,
      "/usr/local/libexec/update-control",
    );
    assert.equal(
      runner.FORGE3D_PLAYWRIGHT_MODULE,
      "/opt/forge3d/playwright/index.mjs",
    );
    assert.equal(
      runner.FORGE3D_APPIUM_EXECUTABLE,
      "/opt/forge3d/bin/appium",
    );
    assert.equal(
      runner.FORGE3D_DEVICE_CONTROL_HELPER,
      "/usr/local/libexec/device-control",
    );
    assert.equal(
      runner.FORGE3D_CLOUDFLARED_EXECUTABLE,
      "/opt/forge3d/bin/cloudflared",
    );
    assert.equal(
      Object.hasOwn(runner, "FORGE3D_CONTROLLER_GITHUB_PRIVATE_KEY_FILE"),
      false,
    );
    assert.equal(
      Object.hasOwn(runner, "FORGE3D_BROKER_CLIENT_KEY_FILE"),
      false,
    );

    const serviceSource = readFileSync(
      new URL("../src/controller-service.mjs", import.meta.url),
      "utf8",
    );
    assert.match(serviceSource, /runnerEnvironment:\s*\{\s*\.\.\.environment/u);
    assert.match(
      serviceSource,
      /FORGE3D_BROWSER_INVENTORY_HELPER_SHA256:\s*inventoryHelper\.sha256/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configuration(root) {
  return {
    jobsRoot: join(root, "jobs"),
    runnerTemplate: join(root, "runner-template"),
    runnerVerifier: join(root, "runner-verifier"),
    diagnosticsRoot: join(root, "diagnostics"),
    receiptDirectory: join(root, "receipts"),
    signingKeyPath: join(root, "signing.pem"),
    signingKeyId: "controller-fw-lnx-i12-01-p256-v1",
    hostCleanupHelper: join(root, "cleanup"),
    lockPath: join(root, "host.lock"),
    quarantinePath: join(root, "quarantine.json"),
    unixInteractiveSessionBridge: join(root, "unix-bridge.mjs"),
    unixInteractiveSessionBridgeSha256: "a".repeat(64),
    interactiveSessionUser: "forge3d-lab",
  };
}
