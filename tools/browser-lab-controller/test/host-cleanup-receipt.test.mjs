import assert from "node:assert/strict";
import test from "node:test";

import { validateHostCleanupReceipt } from "../src/production-dependencies.mjs";

const hostId = "FW-WIN-NV-01";
const request = {
  restoreUpdates: true,
  stopBrowser: true,
  stopDrivers: true,
  stopAppium: true,
  stopTunnels: true,
};
const receipt = {
  schemaVersion: 1,
  hostId,
  cleanupComplete: true,
  results: {
    updatesRestored: true,
    browserStopped: true,
    driversStopped: true,
    appiumStopped: true,
    tunnelsStopped: true,
  },
};

test("cleanup receipt requires explicit closure of every requested capability", () => {
  assert.equal(validateHostCleanupReceipt(receipt, { hostId, request }), receipt);
  for (const candidate of [
    { ...receipt, results: undefined },
    { ...receipt, results: {} },
    { ...receipt, results: { ...receipt.results, appiumStopped: false } },
    {
      ...receipt,
      results: Object.fromEntries(
        Object.entries(receipt.results).filter(([key]) => key !== "driversStopped"),
      ),
    },
    { ...receipt, results: { ...receipt.results, unreviewedCleanup: true } },
  ]) {
    assert.throws(
      () =>
        validateHostCleanupReceipt(candidate, { hostId, request }),
      /did not prove cleanup/u,
    );
  }
});

test("cleanup receipt rejects incomplete requests and unrelated hosts", () => {
  assert.throws(
    () =>
      validateHostCleanupReceipt(receipt, {
        hostId,
        request: { ...request, stopTunnels: false },
      }),
    /did not prove cleanup/u,
  );
  assert.throws(
    () =>
      validateHostCleanupReceipt(receipt, {
        hostId: "FW-WIN-NV-02",
        request,
      }),
    /did not prove cleanup/u,
  );
});
