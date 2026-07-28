import { request } from "node:https";

const HEALTH_PATH = "/v1/health";
const MAX_RESPONSE_BYTES = 4 * 1024;

export class ControllerReachabilityMonitor {
  constructor({
    matrix,
    configuration,
    tls,
    probe = probeControllerHealth,
  }) {
    this.configuration = validateConfiguration(configuration, matrix);
    this.endpoints = new Map(
      this.configuration.controllers.map((controller) => [
        controller.assetId,
        controller,
      ]),
    );
    this.tls = tls;
    this.probe = probe;
    this.consecutiveFailures = new Map();
  }

  async isReachable(record) {
    const endpoint = this.endpoints.get(record.hostAssetId);
    if (
      !endpoint ||
      endpoint.identity !== record.controllerIdentity
    ) {
      throw new Error("ledger controller identity has no checked health endpoint");
    }
    let healthy = false;
    try {
      const response = await this.probe({
        url: endpoint.url,
        tls: this.tls,
        timeoutMs: this.configuration.timeoutMs,
      });
      healthy =
        response?.schemaVersion === 1 &&
        response.assetId === endpoint.assetId &&
        response.controllerIdentity === endpoint.identity &&
        response.status === "ok";
    } catch {
      healthy = false;
    }
    if (healthy) {
      this.consecutiveFailures.delete(endpoint.assetId);
      return true;
    }
    const failures =
      (this.consecutiveFailures.get(endpoint.assetId) ?? 0) + 1;
    this.consecutiveFailures.set(endpoint.assetId, failures);
    return failures < this.configuration.unreachableThreshold;
  }
}

export function validateConfiguration(configuration, matrix) {
  if (
    configuration?.schemaVersion !== 1 ||
    !Number.isInteger(configuration.timeoutMs) ||
    configuration.timeoutMs < 250 ||
    configuration.timeoutMs > 5_000 ||
    !Number.isInteger(configuration.unreachableThreshold) ||
    configuration.unreachableThreshold < 2 ||
    configuration.unreachableThreshold > 12 ||
    !Array.isArray(configuration.controllers)
  ) {
    throw new Error("controller health configuration is invalid");
  }
  const expected = new Map(
    matrix.hosts.map((host) => [
      host.assetId,
      host.controller.identity,
    ]),
  );
  if (configuration.controllers.length !== expected.size) {
    throw new Error("controller health configuration must cover every fixed host");
  }
  const seenIds = new Set();
  const seenUrls = new Set();
  for (const controller of configuration.controllers) {
    let url;
    try {
      url = new URL(controller.url);
    } catch {
      throw new Error("controller health endpoint URL is invalid");
    }
    if (
      seenIds.has(controller.assetId) ||
      seenUrls.has(url.href) ||
      expected.get(controller.assetId) !== controller.identity ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port !== "9443" ||
      url.pathname !== HEALTH_PATH
    ) {
      throw new Error("controller health endpoint is not an exact checked mTLS target");
    }
    seenIds.add(controller.assetId);
    seenUrls.add(url.href);
  }
  for (const assetId of expected.keys()) {
    if (!seenIds.has(assetId)) {
      throw new Error("controller health configuration is missing a fixed host");
    }
  }
  return structuredClone(configuration);
}

export function probeControllerHealth({ url, tls, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const healthRequest = request(
      url,
      {
        method: "GET",
        key: tls.key,
        cert: tls.cert,
        ca: tls.ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        agent: false,
        headers: { accept: "application/json" },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(
              new Error("controller health response exceeds 4 KiB"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("aborted", () => {
          reject(new Error("controller health response was aborted"));
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `controller health endpoint returned ${response.statusCode}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("controller health response is not JSON"));
          }
        });
      },
    );
    healthRequest.setTimeout(timeoutMs, () => {
      healthRequest.destroy(new Error("controller health probe timed out"));
    });
    healthRequest.on("error", reject);
    healthRequest.end();
  });
}
