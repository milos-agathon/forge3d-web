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
import { loadControllerDeploymentProvenance } from "./deployment-provenance.mjs";
import { startControllerPolling } from "./controller-daemon.mjs";
import { createProductionControllerDependencies } from "./production-dependencies.mjs";

export function createInstalledControllerService({
  environment = process.env,
  platform = process.platform,
}) {
  const hostId = required(environment, "FORGE3D_CONTROLLER_ASSET_ID");
  const deploymentProvenance = loadControllerDeploymentProvenance({
    packageManifestPath: required(
      environment,
      "FORGE3D_CONTROLLER_PACKAGE_MANIFEST_FILE",
    ),
    installationReceiptPath: required(
      environment,
      "FORGE3D_CONTROLLER_INSTALLATION_RECEIPT_FILE",
    ),
    packageRoot: required(
      environment,
      "FORGE3D_CONTROLLER_PACKAGE_ROOT",
    ),
    hostId,
  });
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
  const lifecycleStore = new BrokerLifecycleStore({ hostId });
  const dependencies = createProductionControllerDependencies({
    hostId,
    github,
    broker,
    controllerDeployment: deploymentProvenance,
    lifecycleStore,
    platform,
    runnerEnvironment: environment,
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
          ? required(
              environment,
              "FORGE3D_CONTROLLER_WINDOWS_SESSION_BRIDGE",
            )
          : null,
      windowsInteractiveSessionBridgeSha256:
        platform === "win32"
          ? required(
              environment,
              "FORGE3D_CONTROLLER_WINDOWS_SESSION_BRIDGE_SHA256",
            )
          : null,
      unixInteractiveSessionBridge:
        platform === "darwin" || platform === "linux"
          ? required(
              environment,
              "FORGE3D_CONTROLLER_UNIX_SESSION_BRIDGE",
            )
          : null,
      unixInteractiveSessionBridgeSha256:
        platform === "darwin" || platform === "linux"
          ? required(
              environment,
              "FORGE3D_CONTROLLER_UNIX_SESSION_BRIDGE_SHA256",
            )
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
    deploymentProvenance,
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
    deploymentProvenance,
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
  throw new Error("controller service must start through src/bootstrap.mjs");
}
