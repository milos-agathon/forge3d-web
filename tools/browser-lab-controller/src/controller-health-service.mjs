import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadControllerReceipt } from "./controller-receipt-store.mjs";

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
    const match =
      request.method === "GET"
        ? /^\/v1\/receipts\/([1-9][0-9]*)\/([1-9][0-9]*)\/host-lab-canary$/u.exec(
            request.url ?? "",
          )
        : null;
    if (match) {
      try {
        const receipt = loadControllerReceipt({
          directory: receiptDirectory,
          run: { id: Number(match[1]), attempt: Number(match[2]) },
          recordType: "host-lab-canary",
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
  const server = createServer(
    tls,
    createControllerRequestHandler({
      assetId,
      receiptDirectory: process.env.FORGE3D_CONTROLLER_RECEIPT_DIR,
    }),
  );
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ ok: true, assetId, port }));
  });
}
