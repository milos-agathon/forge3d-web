import { createSign } from "node:crypto";
import { request as httpsRequest } from "node:https";

import { canonicalJson } from "./controller-signing.mjs";

export const BROKER_PROTOCOL_VERSION = "forge3d-browser-lab-broker/v1";
export const CLEANUP_PROTOCOL_VERSION = "forge3d-browser-lab-cleanup/v1";

export class ControllerBrokerClient {
  constructor({
    endpoint,
    hostId,
    signingKeyId,
    privateKey,
    tls,
    transport = postJson,
    deploymentTransport = getJson,
  }) {
    if (
      !/^https:\/\//u.test(endpoint ?? "") ||
      !/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(hostId ?? "")
    ) {
      throw new Error("controller broker endpoint or host identity is invalid");
    }
    this.endpoint = endpoint.replace(/\/$/u, "");
    this.hostId = hostId;
    this.signingKeyId = signingKeyId;
    this.privateKey = privateKey;
    this.tls = tls;
    this.transport = transport;
    this.deploymentTransport = deploymentTransport;
  }

  async issue(request) {
    const body = this.sign({
      protocolVersion: BROKER_PROTOCOL_VERSION,
      authorizationDigest: request.authorizationDigest,
      requestNonce: request.requestNonce,
      controller: this.controllerIdentity(),
    });
    const response = await this.transport(
      `${this.endpoint}/v1/jit-config`,
      body,
      this.tls,
    );
    if (
      response.protocolVersion !== BROKER_PROTOCOL_VERSION ||
      response.authorizationDigest !== request.authorizationDigest
    ) {
      throw new Error("broker JIT response binding is invalid");
    }
    return response;
  }

  async cleanup(request) {
    const body = this.sign({
      protocolVersion: CLEANUP_PROTOCOL_VERSION,
      authorizationDigest: request.authorizationDigest,
      requestNonce: request.requestNonce,
      controller: this.controllerIdentity(),
      reason: normalizeReason(request.reason),
      listenerStop: normalizeListenerStop(request.listenerStop),
      workRootWipe: null,
    });
    const response = await this.transport(
      `${this.endpoint}/v1/cleanup-runner`,
      body,
      this.tls,
    );
    if (
      response.authorizationDigest !== request.authorizationDigest
    ) {
      throw new Error("broker cleanup response binding is invalid");
    }
    return response;
  }

  async deployment() {
    const response = await this.deploymentTransport(
      `${this.endpoint}/v1/deployment`,
      this.tls,
    );
    if (
      response?.recordType !== "lab-service-deployment-provenance" ||
      response.service !== "broker" ||
      response.serviceIdentity !== "broker:forge3d-browser-lab"
    ) {
      throw new Error("broker deployment provenance response is invalid");
    }
    return response;
  }

  controllerIdentity() {
    return {
      assetId: this.hostId,
      identity: `controller:${this.hostId}`,
      signingKeyId: this.signingKeyId,
    };
  }

  sign(record) {
    const signer = createSign("SHA256");
    signer.update(canonicalJson(record));
    signer.end();
    return {
      ...record,
      signature: {
        algorithm: "SHA256withECDSA",
        signingKeyId: this.signingKeyId,
        value: signer
          .sign({ key: this.privateKey, dsaEncoding: "der" })
          .toString("base64url"),
      },
    };
  }
}

function normalizeReason(reason) {
  const values = {
    completed: "terminal",
    terminal: "terminal",
    controller_failure: "launch-failure",
    launch_failure: "launch-failure",
    start_timeout: "start-timeout",
    online_unassigned: "online-unassigned",
  };
  const normalized = values[reason];
  if (!normalized) throw new Error(`controller cleanup reason is unsupported: ${reason}`);
  return normalized;
}

function normalizeListenerStop(value) {
  if (
    value?.attempted !== true ||
    value.stopped !== true ||
    !Number.isInteger(value.processId) ||
    value.processId < 1 ||
    !Number.isFinite(Date.parse(value.observedAt))
  ) {
    return null;
  }
  return value;
}

function postJson(url, body, tls) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = httpsRequest(
      url,
      {
        method: "POST",
        key: tls.key,
        cert: tls.cert,
        ca: tls.ca,
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            request.destroy(new Error("broker response exceeds 64 KiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (response.statusCode !== 200) {
              throw new Error(`broker rejected request with HTTP ${response.statusCode}`);
            }
            resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
}

function getJson(url, tls) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        key: tls.key,
        cert: tls.cert,
        ca: tls.ca,
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        headers: {
          Accept: "application/json",
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            request.destroy(
              new Error("broker deployment response exceeds 64 KiB"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const value = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            if (response.statusCode !== 200) {
              throw new Error(
                `broker rejected deployment request with HTTP ${response.statusCode}`,
              );
            }
            resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}
