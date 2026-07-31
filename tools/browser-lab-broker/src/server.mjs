import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { fileURLToPath } from "node:url";

import { FileAuthorizationVerifier } from "./authorization-verifier.mjs";
import { BrowserLabBroker } from "./broker.mjs";
import { ControllerReachabilityMonitor } from "./controller-reachability.mjs";
import { loadBrokerDeploymentProvenance } from "./deployment-provenance.mjs";
import {
  GitHubAppTokenProvider,
  GitHubRepositoryClient,
} from "./github-client.mjs";
import { JsonFileLedger } from "./ledger.mjs";

export function createBrokerServer({
  broker,
  tls,
  deploymentProvenance = null,
}) {
  return createServer(
    {
      key: tls.key,
      cert: tls.cert,
      ca: tls.ca,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    createBrokerRequestHandler({
      broker,
      deploymentProvenance,
    }),
  );
}

export function createBrokerRequestHandler({
  broker,
  deploymentProvenance = null,
  auditLog = audit,
}) {
  return async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      const deploymentRequest =
        request.method === "GET" && request.url === "/v1/deployment";
      const brokerRequest =
        request.method === "POST" &&
        ["/v1/jit-config", "/v1/cleanup-runner"].includes(request.url);
      if (!deploymentRequest && !brokerRequest) {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (!request.socket.authorized) {
        throw new Error("mTLS client certificate is not authorized");
      }
      const mtlsIdentity = request.socket.getPeerCertificate()?.subject?.CN;
      if (
        !/^controller:FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(
          mtlsIdentity ?? "",
        )
      ) {
        throw new Error(
          "mTLS certificate CN is not a checked controller identity",
        );
      }
      if (deploymentRequest) {
        if (deploymentProvenance === null) {
          throw new Error("broker deployment provenance is unavailable");
        }
        auditLog({
          operation: "deployment",
          controllerIdentity: mtlsIdentity,
          resultState: "observed",
        });
        response.writeHead(200);
        response.end(JSON.stringify(deploymentProvenance));
        return;
      }
      const body = JSON.parse(await readRequestBody(request));
      const result =
        request.url === "/v1/jit-config"
          ? await broker.issueJitConfig(body, { mtlsIdentity })
          : await broker.cleanupRunner(body, { mtlsIdentity });
      auditLog({
        operation: request.url.slice(4),
        authorizationDigest: body.authorizationDigest,
        controllerIdentity: mtlsIdentity,
        resultState: result.state ?? "issued",
      });
      response.writeHead(200);
      response.end(JSON.stringify(result));
    } catch (error) {
      auditLog({
        operation: request.url,
        resultState: "rejected",
        error: String(error.message ?? error),
      });
      response.writeHead(400);
      response.end(JSON.stringify({ error: "request_rejected" }));
    }
  };
}

export async function runWatchdogCycle({
  broker,
  ledger,
  controllerReachability,
  auditLog = audit,
  inFlight = new Set(),
}) {
  await Promise.all(
    ledger.list().map(async (record) => {
      if (inFlight.has(record.authorizationDigest)) return;
      inFlight.add(record.authorizationDigest);
      try {
        const controllerReachable =
          controllerProbeNotRequired(record)
            ? true
            : await controllerReachability.isReachable(record);
        await broker.watchdogTick(record.authorizationDigest, {
          controllerReachable,
        });
      } catch (error) {
        auditLog({
          operation: "watchdog",
          authorizationDigest: record.authorizationDigest,
          resultState: "rejected",
          error: String(error.message ?? error),
        });
      } finally {
        inFlight.delete(record.authorizationDigest);
      }
    }),
  );
}

export function resolveBrokerProvisioningMode({ matrix, browserPolicy }) {
  if (matrix.provisioningState !== "active") {
    throw new Error("checked hardware inventory is not active");
  }
  if (browserPolicy.provisioningState === "active") {
    return "active";
  }
  if (browserPolicy.provisioningState === "pending-jit-canary") {
    return "initial-host-canary";
  }
  throw new Error("browser policy state is invalid");
}

function controllerProbeNotRequired(record) {
  return ["deleted", "already_absent", "quarantined"].includes(record.state);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw new Error("broker request exceeds 32 KiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function audit(value) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
}

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadInstalledBrokerDeploymentProvenance(
  environment = process.env,
) {
  return loadBrokerDeploymentProvenance({
    packageManifestPath: requiredValue(
      environment,
      "BROKER_PACKAGE_MANIFEST_PATH",
    ),
    installationReceiptPath: requiredValue(
      environment,
      "BROKER_INSTALLATION_RECEIPT_PATH",
    ),
  });
}

function requiredValue(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function startInstalledBrokerService(environment = process.env) {
  const required = (name) => requiredEnvironment(name, environment);
  const deploymentProvenance =
    loadInstalledBrokerDeploymentProvenance(environment);
  const matrix = loadJson(required("BROKER_HARDWARE_MATRIX"));
  const browserPolicy = loadJson(required("BROKER_BROWSER_POLICY"));
  const repositoryTrustPolicy = loadJson(
    required("BROKER_REPOSITORY_TRUST_POLICY"),
  );
  loadJson(required("BROKER_WORKFLOW_ACTIONS_LOCK"));
  const provisioningMode = resolveBrokerProvisioningMode({
    matrix,
    browserPolicy,
  });
  const tokenProvider = new GitHubAppTokenProvider({
    appId: required("BROKER_GITHUB_APP_ID"),
    installationId: required("BROKER_GITHUB_INSTALLATION_ID"),
    privateKeyPath: required("BROKER_GITHUB_PRIVATE_KEY_PATH"),
    apiBase: environment.GITHUB_API_URL,
  });
  const github = new GitHubRepositoryClient({
    tokenProvider,
    apiBase: environment.GITHUB_API_URL,
  });
  const ledger = new JsonFileLedger(required("BROKER_LEDGER_PATH"));
  const authorizationVerifier = new FileAuthorizationVerifier({
    directory: required("BROKER_AUTHORIZATION_DIRECTORY"),
    github,
    repositoryTrustPolicy,
  });
  const controllerReachability = new ControllerReachabilityMonitor({
    matrix,
    configuration: loadJson(
      required("BROKER_CONTROLLER_HEALTH_ENDPOINTS"),
    ),
    tls: {
      key: readFileSync(
        required("BROKER_CONTROLLER_HEALTH_CLIENT_KEY_PATH"),
      ),
      cert: readFileSync(
        required("BROKER_CONTROLLER_HEALTH_CLIENT_CERT_PATH"),
      ),
      ca: readFileSync(
        required("BROKER_CONTROLLER_HEALTH_CA_PATH"),
      ),
    },
  });
  const broker = new BrowserLabBroker({
    matrix,
    browserPolicy,
    ledger,
    authorizationVerifier,
    github,
    provisioningMode,
  });
  const server = createBrokerServer({
    broker,
    deploymentProvenance,
    tls: {
      key: readFileSync(required("BROKER_TLS_KEY_PATH")),
      cert: readFileSync(required("BROKER_TLS_CERT_PATH")),
      ca: readFileSync(required("BROKER_TLS_CA_PATH")),
    },
  });
  const watchdogInFlight = new Set();
  const interval = setInterval(() => {
    void runWatchdogCycle({
      broker,
      ledger,
      controllerReachability,
      inFlight: watchdogInFlight,
    }).catch((error) => {
      audit({
        operation: "watchdog-cycle",
        resultState: "rejected",
        error: String(error.message ?? error),
      });
    });
  }, 5_000);
  interval.unref();
  server.listen(
    Number(environment.BROKER_PORT ?? "8443"),
    environment.BROKER_HOST ?? "127.0.0.1",
  );
  return { interval, server };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  throw new Error("broker service must start through src/bootstrap.mjs");
}
