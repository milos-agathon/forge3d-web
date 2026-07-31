import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decodeBrokerLifecycleHeader } from "./broker-lifecycle-store.mjs";
import { loadControllerReceipt } from "./controller-receipt-store.mjs";

const BROKER_HEALTH_CLIENT_IDENTITY = "broker:forge3d-browser-lab";
const BROKER_LIFECYCLE_HEADER = "x-forge3d-broker-lifecycle";

export function createHealthRecord({
  assetId,
  controllerIdentity,
  controllerVersion = "1.0.0",
  state = "ok",
  observedAt = new Date(),
}) {
  if (
    !/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(assetId ?? "") ||
    controllerIdentity !== `controller:${assetId}` ||
    state !== "ok"
  ) {
    throw new Error("controller health identity/state is invalid");
  }
  return {
    schemaVersion: 1,
    assetId,
    controllerIdentity,
    controllerVersion,
    status: state,
    observedAt: new Date(observedAt).toISOString(),
  };
}

export function createControllerRequestHandler({
  assetId,
  receiptDirectory,
  lifecycleStore = null,
  deploymentProvenance = null,
  now = () => new Date(),
}) {
  return (request, response) => {
    const headers = {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
    if (!request.socket.authorized) {
      response.writeHead(401, headers);
      response.end('{"ok":false}\n');
      return;
    }
    const lifecycleHeader = request.headers?.[BROKER_LIFECYCLE_HEADER];
    if (lifecycleHeader !== undefined) {
      try {
        if (
          request.method !== "GET" ||
          request.url !== "/v1/health" ||
          typeof lifecycleHeader !== "string" ||
          request.socket.getPeerCertificate?.()?.subject?.CN !==
            BROKER_HEALTH_CLIENT_IDENTITY ||
          lifecycleStore === null
        ) {
          throw new Error("broker lifecycle health probe identity is invalid");
        }
        lifecycleStore.observe(
          decodeBrokerLifecycleHeader(lifecycleHeader),
        );
      } catch {
        response.writeHead(400, headers);
        response.end('{"ok":false}\n');
        return;
      }
    }
    if (request.method === "GET" && request.url === "/v1/health") {
      const record = createHealthRecord({
        assetId,
        controllerIdentity: `controller:${assetId}`,
        observedAt: now(),
      });
      response.writeHead(200, headers);
      response.end(`${JSON.stringify(record)}\n`);
      return;
    }
    if (request.method === "GET" && request.url === "/v1/deployment") {
      if (deploymentProvenance === null) {
        response.writeHead(404, headers);
        response.end('{"ok":false}\n');
        return;
      }
      response.writeHead(200, headers);
      response.end(`${JSON.stringify(deploymentProvenance)}\n`);
      return;
    }
    const match =
      request.method === "GET"
        ? /^\/v1\/receipts\/([1-9][0-9]*)\/([1-9][0-9]*)\/(host-lab-canary|manual-session|deployment-provenance)$/u.exec(
            request.url ?? "",
          )
        : null;
    if (match) {
      try {
        const receipt = loadControllerReceipt({
          directory: receiptDirectory,
          run: { id: Number(match[1]), attempt: Number(match[2]) },
          recordType: match[3],
        });
        if (receipt.record.hostId !== assetId) {
          throw new Error("controller receipt belongs to another host");
        }
        response.writeHead(200, headers);
        response.end(`${JSON.stringify(receipt)}\n`);
      } catch {
        response.writeHead(404, headers);
        response.end('{"ok":false}\n');
      }
      return;
    }
    response.writeHead(404, headers);
    response.end('{"ok":false}\n');
  };
}

export function createControllerHealthServer({
  assetId,
  receiptDirectory,
  lifecycleStore = null,
  deploymentProvenance = null,
  tls,
  now = () => new Date(),
}) {
  return createServer(
    {
      ...tls,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    createControllerRequestHandler({
      assetId,
      receiptDirectory,
      lifecycleStore,
      deploymentProvenance,
      now,
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const assetId = process.env.FORGE3D_CONTROLLER_ASSET_ID;
  const port = Number(process.env.FORGE3D_CONTROLLER_HEALTH_PORT ?? "9443");
  if (!Number.isInteger(port) || port !== 9443) {
    throw new Error("controller health port must be the checked mTLS port 9443");
  }
  const tls = {
    key: readFileSync(process.env.FORGE3D_CONTROLLER_TLS_KEY_FILE),
    cert: readFileSync(process.env.FORGE3D_CONTROLLER_TLS_CERT_FILE),
    ca: readFileSync(process.env.FORGE3D_CONTROLLER_TLS_CA_FILE),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  };
  const server = createControllerHealthServer({
    assetId,
    receiptDirectory: process.env.FORGE3D_CONTROLLER_RECEIPT_DIR,
    tls,
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ ok: true, assetId, port }));
  });
}
