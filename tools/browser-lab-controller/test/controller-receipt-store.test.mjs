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
      runAttempt: 2,
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

test("manual-session receipt is immutable and bound to the exact run attempt", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-controller-manual-"));
  const run = { id: 51, attempt: 3 };
  const signedRecord = {
    record: {
      workflow: ".github/workflows/browser-hardware.yml",
      run,
      hostId: "FW-MAC-M2-01",
    },
  };
  storeControllerReceipt({
    directory,
    run,
    recordType: "manual-session",
    signedRecord,
  });
  assert.deepEqual(
    loadControllerReceipt({
      directory,
      run,
      recordType: "manual-session",
    }),
    signedRecord,
  );
  assert.throws(() =>
    loadControllerReceipt({
      directory,
      run: { id: 51, attempt: 2 },
      recordType: "manual-session",
    }),
  );
});

test("deployment provenance receipt is separate and bound to the canary run", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "forge3d-controller-deployment-receipt-"),
  );
  const run = { id: 61, attempt: 4 };
  const signedRecord = {
    record: {
      recordType: "lab-service-deployment-provenance-receipt",
      runId: run.id,
      runAttempt: run.attempt,
      hostId: "FW-LNX-NV-01",
    },
  };
  storeControllerReceipt({
    directory,
    run,
    recordType: "deployment-provenance",
    signedRecord,
  });
  assert.deepEqual(
    loadControllerReceipt({
      directory,
      run,
      recordType: "deployment-provenance",
    }),
    signedRecord,
  );
  assert.throws(() =>
    loadControllerReceipt({
      directory,
      run: { ...run, attempt: 3 },
      recordType: "deployment-provenance",
    }),
  );
});
