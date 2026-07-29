import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadControllerReceipt,
  storeControllerReceipt,
} from "../src/controller-receipt-store.mjs";

test("controller receipt store binds immutable run and record identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-controller-receipt-"));
  const run = { id: 41, attempt: 2 };
  const signedRecord = {
    record: {
      recordType: "host-lab-canary",
      runId: 41,
      hostId: "FW-LNX-NV-01",
    },
  };
  storeControllerReceipt({
    directory,
    run,
    recordType: "host-lab-canary",
    signedRecord,
  });
  assert.deepEqual(
    loadControllerReceipt({
      directory,
      run,
      recordType: "host-lab-canary",
    }),
    signedRecord,
  );
  assert.throws(() =>
    storeControllerReceipt({
      directory,
      run,
      recordType: "host-lab-canary",
      signedRecord,
    }),
  );
  assert.throws(() =>
    storeControllerReceipt({
      directory,
      run: { id: 42, attempt: 2 },
      recordType: "host-lab-canary",
      signedRecord,
    }),
  );
});
