import assert from "node:assert/strict";
import test from "node:test";

import { createHealthRecord } from "../src/controller-health-service.mjs";

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
