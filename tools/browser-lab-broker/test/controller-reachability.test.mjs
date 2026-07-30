import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ControllerReachabilityMonitor,
  validateConfiguration,
} from "../src/controller-reachability.mjs";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const infrastructureRoot = resolve(
  repositoryRoot,
  "crates/forge3d-web/tests/infrastructure",
);
const matrix = readJson("hardware-matrix.json");
const configuration = readJson("controller-health-endpoints.json");
const record = {
  authorizationDigest: "a".repeat(64),
  hostAssetId: "FW-LNX-NV-01",
  controllerIdentity: "controller:FW-LNX-NV-01",
  runnerId: 7,
  runnerName: `FW-LNX-NV-01-${"ab".repeat(16)}`,
  state: "online_unassigned",
  onlineAt: "2026-07-29T10:00:00.000Z",
  assignmentDeadline: "2026-07-29T10:01:30.000Z",
  everBusy: false,
  lastRunnerObservation: {
    id: 7,
    name: `FW-LNX-NV-01-${"ab".repeat(16)}`,
    status: "online",
    busy: false,
    observedAt: "2026-07-29T10:01:30.000Z",
  },
  lastJobObservation: {
    id: 11,
    status: "queued",
    conclusion: null,
    observedAt: "2026-07-29T10:01:30.000Z",
  },
};

test("accepts only exact checked mTLS controller health targets", () => {
  assert.doesNotThrow(() => validateConfiguration(configuration, matrix));
  const insecure = structuredClone(configuration);
  insecure.controllers[0].url = insecure.controllers[0].url.replace(
    "https:",
    "http:",
  );
  assert.throws(
    () => validateConfiguration(insecure, matrix),
    /exact checked mTLS target/u,
  );
  const mismatched = structuredClone(configuration);
  mismatched.controllers[0].identity = "controller:FW-LNX-NV-01";
  assert.throws(
    () => validateConfiguration(mismatched, matrix),
    /exact checked mTLS target/u,
  );
});

test("valid exact-identity health responses keep the controller reachable", async () => {
  const probes = [];
  const monitor = new ControllerReachabilityMonitor({
    matrix,
    configuration,
    tls: {},
    probe: async (request) => {
      probes.push(request);
      return healthyResponse();
    },
    now: () => new Date("2026-07-29T10:01:31.000Z"),
  });
  assert.equal(await monitor.isReachable(record), true);
  assert.equal(await monitor.isReachable(record), true);
  const lifecycle = JSON.parse(
    Buffer.from(probes[0].lifecycleHeader, "base64url").toString("utf8"),
  );
  assert.equal(lifecycle.assignmentDeadline, record.assignmentDeadline);
  assert.equal(lifecycle.lastRunnerObservation.busy, false);
  assert.equal(lifecycle.lastJobObservation.id, 11);
  assert.equal(lifecycle.publishedAt, "2026-07-29T10:01:31.000Z");
});

test("watchdog sees unreachable only after consecutive failed health proofs", async () => {
  const responses = [
    new Error("network unavailable"),
    {
      ...healthyResponse(),
      controllerIdentity: "controller:FW-LNX-I12-01",
    },
    new Error("network still unavailable"),
  ];
  const monitor = new ControllerReachabilityMonitor({
    matrix,
    configuration,
    tls: {},
    probe: async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  });
  assert.equal(await monitor.isReachable(record), true);
  assert.equal(await monitor.isReachable(record), true);
  assert.equal(await monitor.isReachable(record), false);
});

test("a healthy response resets accumulated reachability failures", async () => {
  const responses = [
    new Error("first failure"),
    new Error("second failure"),
    healthyResponse(),
    new Error("new first failure"),
  ];
  const monitor = new ControllerReachabilityMonitor({
    matrix,
    configuration,
    tls: {},
    probe: async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  });
  for (let index = 0; index < 4; index += 1) {
    assert.equal(await monitor.isReachable(record), true);
  }
});

function healthyResponse() {
  return {
    schemaVersion: 1,
    assetId: record.hostAssetId,
    controllerIdentity: record.controllerIdentity,
    status: "ok",
  };
}

function readJson(name) {
  return JSON.parse(readFileSync(resolve(infrastructureRoot, name), "utf8"));
}
