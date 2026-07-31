import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BrowserLabController } from "./controller.mjs";
import { ControllerBrokerClient } from "./broker-client.mjs";
import {
  ControllerGitHubActionsClient,
  ControllerGitHubTokenProvider,
} from "./github-actions-client.mjs";
import { BrokerLifecycleStore } from "./broker-lifecycle-store.mjs";
import { createControllerHealthServer } from "./controller-health-service.mjs";
import { startControllerPolling } from "./controller-daemon.mjs";
import { createProductionControllerDependencies } from "./production-dependencies.mjs";
import { loadInstalledControllerEvidence } from "./installation-evidence.mjs";

export function createInstalledControllerService({
  environment = process.env,
  platform = process.platform,
}) {
  const hostId = required(environment, "FORGE3D_CONTROLLER_ASSET_ID");
  const signingKeyId = required(
    environment,
    "FORGE3D_CONTROLLER_SIGNING_KEY_ID",
  );
  const signingKeyPath = required(
    environment,
    "FORGE3D_CONTROLLER_SIGNING_KEY_FILE",
  );
  const tokenProvider = new ControllerGitHubTokenProvider({
    appId: required(environment, "FORGE3D_CONTROLLER_GITHUB_APP_ID"),
    installationId: required(
      environment,
      "FORGE3D_CONTROLLER_GITHUB_INSTALLATION_ID",
    ),
    privateKeyPath: required(
      environment,
      "FORGE3D_CONTROLLER_GITHUB_PRIVATE_KEY_FILE",
    ),
    apiBase: environment.GITHUB_API_URL,
  });
  const github = new ControllerGitHubActionsClient({
    tokenProvider,
    apiBase: environment.GITHUB_API_URL,
    attestationCommand:
      environment.FORGE3D_CONTROLLER_GH_EXECUTABLE ?? "gh",
  });
  const controllerPrivateKey = readFileSync(signingKeyPath, "utf8");
  const broker = new ControllerBrokerClient({
    endpoint: required(environment, "FORGE3D_BROKER_ENDPOINT"),
    hostId,
    signingKeyId,
    privateKey: controllerPrivateKey,
    tls: {
      key: readFileSync(
        required(environment, "FORGE3D_BROKER_CLIENT_KEY_FILE"),
      ),
      cert: readFileSync(
        required(environment, "FORGE3D_BROKER_CLIENT_CERT_FILE"),
      ),
      ca: readFileSync(required(environment, "FORGE3D_BROKER_CA_FILE")),
    },
  });
  const receiptDirectory = required(
    environment,
    "FORGE3D_CONTROLLER_RECEIPT_DIR",
  );
  const inventoryHelperPath = required(
    environment,
    "FORGE3D_BROWSER_INVENTORY_HELPER",
  );
  const browserPolicyPath = required(
    environment,
    "FORGE3D_CONTROLLER_BROWSER_POLICY",
  );
  const sessionBridge =
    platform === "win32"
      ? {
          identity: "FORGE3D_CONTROLLER_WINDOWS_SESSION_BRIDGE",
          path: required(environment, "FORGE3D_CONTROLLER_WINDOWS_SESSION_BRIDGE"),
          packagePath: "services/windows-interactive-session-bridge.ps1",
          version: null,
        }
      : {
          identity: "FORGE3D_CONTROLLER_UNIX_SESSION_BRIDGE",
          path: required(environment, "FORGE3D_CONTROLLER_UNIX_SESSION_BRIDGE"),
          packagePath: "services/unix-interactive-session-bridge.mjs",
          version: null,
        };
  const requiredHelpers = [
    {
      identity: "FORGE3D_BROWSER_INVENTORY_HELPER",
      path: inventoryHelperPath,
      packagePath: null,
      version: null,
    },
    ...[
      ["FORGE3D_CONTROLLER_RUNNER_VERIFY_HELPER", null],
      ["FORGE3D_CONTROLLER_HOST_CLEANUP_HELPER", null],
      ["FORGE3D_UPDATE_CONTROL_HELPER", null],
      ["FORGE3D_DEVICE_CONTROL_HELPER", null],
      ["FORGE3D_CLOUDFLARED_EXECUTABLE", null],
      ["FORGE3D_CONTROLLER_GH_EXECUTABLE", null],
      ["FORGE3D_PLAYWRIGHT_MODULE", undefined],
      ["FORGE3D_GECKODRIVER_EXECUTABLE", undefined],
      ["FORGE3D_APPIUM_EXECUTABLE", undefined],
    ].map(([identity, version]) => ({
      identity,
      path: required(environment, identity),
      packagePath: null,
      version,
    })),
    sessionBridge,
  ];
  const installationEvidence = loadInstalledControllerEvidence({
    receiptPath: required(
      environment,
      "FORGE3D_CONTROLLER_INSTALLATION_RECEIPT",
    ),
    packageManifestPath: required(
      environment,
      "FORGE3D_CONTROLLER_PACKAGE_MANIFEST",
    ),
    hostId,
    inventoryHelperPath,
    servicePath: fileURLToPath(import.meta.url),
    requiredHelpers,
    requiredConfigurations: [
      {
        packagePath:
          "crates/forge3d-web/tests/infrastructure/browser-policy.json",
        path: browserPolicyPath,
      },
    ],
  });
  const browserPolicy = JSON.parse(readFileSync(browserPolicyPath, "utf8"));
  assertInstalledToolVersion(
    installationEvidence,
    "FORGE3D_PLAYWRIGHT_MODULE",
    browserPolicy.tools?.playwright,
  );
  assertInstalledToolVersion(
    installationEvidence,
    "FORGE3D_GECKODRIVER_EXECUTABLE",
    browserPolicy.tools?.geckodriver,
  );
  assertInstalledToolVersion(
    installationEvidence,
    "FORGE3D_APPIUM_EXECUTABLE",
    browserPolicy.tools?.appium,
  );
  const inventoryHelper = installationEvidence.installed.files.find(
    (file) =>
      file.role === "helper" &&
      file.identity === "FORGE3D_BROWSER_INVENTORY_HELPER",
  );
  const installedSessionBridge = installationEvidence.installed.files.find(
    (file) => file.role === "helper" && file.identity === sessionBridge.identity,
  );
  const lifecycleStore = new BrokerLifecycleStore({ hostId });
  const dependencies = createProductionControllerDependencies({
    hostId,
    github,
    broker,
    lifecycleStore,
    platform,
    runnerEnvironment: {
      ...environment,
      FORGE3D_BROWSER_INVENTORY_HELPER: inventoryHelper.path,
      FORGE3D_BROWSER_INVENTORY_HELPER_SHA256: inventoryHelper.sha256,
    },
    installationEvidence,
    configuration: {
      jobsRoot: required(environment, "FORGE3D_CONTROLLER_JOBS_ROOT"),
      runnerTemplate: required(
        environment,
        "FORGE3D_CONTROLLER_RUNNER_TEMPLATE",
      ),
      runnerVerifier: required(
        environment,
        "FORGE3D_CONTROLLER_RUNNER_VERIFY_HELPER",
      ),
      diagnosticsRoot: required(
        environment,
        "FORGE3D_CONTROLLER_DIAGNOSTICS_ROOT",
      ),
      receiptDirectory,
      signingKeyPath,
      signingKeyId,
      hostCleanupHelper: required(
        environment,
        "FORGE3D_CONTROLLER_HOST_CLEANUP_HELPER",
      ),
      lockPath: required(environment, "FORGE3D_CONTROLLER_LOCK_FILE"),
      quarantinePath: required(
        environment,
        "FORGE3D_CONTROLLER_QUARANTINE_FILE",
      ),
      windowsInteractiveSessionBridge:
        platform === "win32"
          ? sessionBridge.path
          : null,
      windowsInteractiveSessionBridgeSha256:
        platform === "win32"
          ? installedSessionBridge.sha256
          : null,
      unixInteractiveSessionBridge:
        platform === "darwin" || platform === "linux"
          ? sessionBridge.path
          : null,
      unixInteractiveSessionBridgeSha256:
        platform === "darwin" || platform === "linux"
          ? installedSessionBridge.sha256
          : null,
      interactiveSessionUser:
        platform === "darwin" || platform === "linux"
          ? required(
              environment,
              "FORGE3D_CONTROLLER_INTERACTIVE_USER",
            )
          : null,
    },
  });
  const controller = new BrowserLabController({
    hostId,
    platform,
    dependencies,
  });
  const health = createControllerHealthServer({
    assetId: hostId,
    receiptDirectory,
    lifecycleStore,
    tls: {
      key: readFileSync(
        required(environment, "FORGE3D_CONTROLLER_TLS_KEY_FILE"),
      ),
      cert: readFileSync(
        required(environment, "FORGE3D_CONTROLLER_TLS_CERT_FILE"),
      ),
      ca: readFileSync(required(environment, "FORGE3D_CONTROLLER_TLS_CA_FILE")),
    },
  });
  const poller = startControllerPolling({
    hostId,
    expectedHardwareLabel: required(
      environment,
      "FORGE3D_CONTROLLER_HARDWARE_LABEL",
    ),
    github,
    controller,
  });
  return {
    hostId,
    start() {
      const port = Number(
        environment.FORGE3D_CONTROLLER_HEALTH_PORT ?? "9443",
      );
      if (port !== 9443) {
        throw new Error("controller health port must remain 9443");
      }
      health.listen(port, "0.0.0.0");
    },
    async stop() {
      poller.stop();
      await new Promise((resolvePromise, reject) =>
        health.close((error) =>
          error ? reject(error) : resolvePromise(),
        ),
      );
    },
  };
}

function assertInstalledToolVersion(evidence, identity, expectedVersion) {
  const matches = evidence.installed.files.filter(
    (file) => file.role === "helper" && file.identity === identity,
  );
  if (
    typeof expectedVersion !== "string" ||
    matches.length !== 1 ||
    matches[0].version !== expectedVersion
  ) {
    throw new Error(`${identity} does not match the checked browser policy`);
  }
}

export function loadControllerEnvironmentFile(
  path,
  baseEnvironment = process.env,
) {
  const environment = { ...baseEnvironment };
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      separator < 1 ||
      !/^[A-Z][A-Z0-9_]+$/u.test(name) ||
      value === "" ||
      Object.hasOwn(environment, name)
    ) {
      throw new Error(`controller environment line is invalid: ${rawLine}`);
    }
    environment[name] = value;
  }
  return environment;
}

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const environmentFileIndex = process.argv.indexOf("--environment-file");
  const environment =
    environmentFileIndex === -1
      ? process.env
      : loadControllerEnvironmentFile(process.argv[environmentFileIndex + 1]);
  const service = createInstalledControllerService({ environment });
  service.start();
  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
