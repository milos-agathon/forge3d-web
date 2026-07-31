import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeLifecycleHeader } from "../../browser-lab-broker/src/controller-reachability.mjs";
import { BrokerLifecycleStore } from "../src/broker-lifecycle-store.mjs";
import {
  createControllerRequestHandler,
  createHealthRecord,
} from "../src/controller-health-service.mjs";
import { storeControllerReceipt } from "../src/controller-receipt-store.mjs";

test("controller health record exposes only public identity and version", () => {
  const record = createHealthRecord({
    assetId: "FW-MAC-M2-01",
    controllerIdentity: "controller:FW-MAC-M2-01",
    observedAt: new Date("2026-07-29T10:00:00.000Z"),
  });
  assert.deepEqual(Object.keys(record), [
    "schemaVersion",
    "assetId",
    "controllerIdentity",
    "controllerVersion",
    "status",
    "observedAt",
  ]);
  assert.equal(JSON.stringify(record).includes("serial"), false);
  assert.throws(
    () =>
      createHealthRecord({
        assetId: "FW-MAC-M2-01",
        controllerIdentity: "controller:FW-LNX-NV-01",
      }),
    /identity\/state/u,
  );
});

test("broker mTLS health probe delivers the exact assignment lifecycle", () => {
  const hostId = "FW-LNX-NV-01";
  const runnerName = `${hostId}-${"ab".repeat(16)}`;
  const lifecycleStore = new BrokerLifecycleStore({ hostId });
  const handler = createControllerRequestHandler({
    assetId: hostId,
    receiptDirectory: "/unused",
    lifecycleStore,
    now: () => new Date("2026-07-29T10:01:31.000Z"),
  });
  const record = {
    authorizationDigest: "a".repeat(64),
    hostAssetId: hostId,
    runnerId: 7,
    runnerName,
    state: "online_unassigned",
    onlineAt: "2026-07-29T10:00:00.000Z",
    assignmentDeadline: "2026-07-29T10:01:30.000Z",
    everBusy: false,
    lastRunnerObservation: {
      id: 7,
      name: runnerName,
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
  const response = fakeResponse();
  handler(
    {
      method: "GET",
      url: "/v1/health",
      headers: {
        "x-forge3d-broker-lifecycle": encodeLifecycleHeader(
          record,
          new Date("2026-07-29T10:01:31.000Z"),
        ),
      },
      socket: {
        authorized: true,
        getPeerCertificate: () => ({
          subject: { CN: "broker:forge3d-browser-lab" },
        }),
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  const observed = lifecycleStore.get({
    authorizationDigest: record.authorizationDigest,
    runnerId: record.runnerId,
    runnerName,
  });
  assert.equal(observed.assignmentDeadline, record.assignmentDeadline);
  assert.equal(observed.lastRunnerObservation.busy, false);
  assert.equal(observed.lastJobObservation.status, "queued");
});

test("lifecycle headers from any non-broker mTLS identity fail closed", () => {
  const hostId = "FW-LNX-NV-01";
  const lifecycleStore = new BrokerLifecycleStore({ hostId });
  const handler = createControllerRequestHandler({
    assetId: hostId,
    receiptDirectory: "/unused",
    lifecycleStore,
  });
  const response = fakeResponse();
  handler(
    {
      method: "GET",
      url: "/v1/health",
      headers: { "x-forge3d-broker-lifecycle": "YWJjZA" },
      socket: {
        authorized: true,
        getPeerCertificate: () => ({
          subject: { CN: "observer:forge3d-trust" },
        }),
      },
    },
    response,
  );
  assert.equal(response.statusCode, 400);
});

test("mTLS deployment endpoint is additive to the unchanged health payload", () => {
  const hostId = "FW-LNX-NV-01";
  const deploymentProvenance = {
    recordType: "lab-service-deployment-provenance",
    service: "controller",
  };
  const handler = createControllerRequestHandler({
    assetId: hostId,
    receiptDirectory: "/unused",
    deploymentProvenance,
    now: () => new Date("2026-07-29T10:01:31.000Z"),
  });
  const request = {
    method: "GET",
    url: "/v1/deployment",
    headers: {},
    socket: { authorized: true },
  };
  const deploymentResponse = fakeResponse();
  handler(request, deploymentResponse);
  assert.equal(deploymentResponse.statusCode, 200);
  assert.deepEqual(
    JSON.parse(deploymentResponse.body),
    deploymentProvenance,
  );

  const healthResponse = fakeResponse();
  handler({ ...request, url: "/v1/health" }, healthResponse);
  assert.deepEqual(Object.keys(JSON.parse(healthResponse.body)), [
    "schemaVersion",
    "assetId",
    "controllerIdentity",
    "controllerVersion",
    "status",
    "observedAt",
  ]);
});

test("mTLS receipt endpoint serves separate signed deployment provenance", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "forge3d-controller-deployment-health-"),
  );
  const run = { id: 71, attempt: 2 };
  const signedRecord = {
    record: {
      recordType: "lab-service-deployment-provenance-receipt",
      runId: run.id,
      runAttempt: run.attempt,
      hostId: "FW-LNX-NV-01",
    },
  };
  try {
    storeControllerReceipt({
      directory,
      run,
      recordType: "deployment-provenance",
      signedRecord,
    });
    const handler = createControllerRequestHandler({
      assetId: "FW-LNX-NV-01",
      receiptDirectory: directory,
    });
    const response = fakeResponse();
    handler(
      {
        method: "GET",
        url: `/v1/receipts/${run.id}/${run.attempt}/deployment-provenance`,
        headers: {},
        socket: { authorized: true },
      },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), signedRecord);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeResponse() {
  return {
    statusCode: null,
    body: "",
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(value) {
      this.body += value ?? "";
    },
  };
}
