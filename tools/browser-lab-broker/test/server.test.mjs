import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveBrokerProvisioningMode,
  runWatchdogCycle,
} from "../src/server.mjs";

const brokerRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("production server verifies separately provisioned authorizations", () => {
  const source = readFileSync(join(brokerRoot, "src/server.mjs"), "utf8");
  const githubSource = readFileSync(
    join(brokerRoot, "src/github-client.mjs"),
    "utf8",
  );
  assert.match(source, /new FileAuthorizationVerifier\(/u);
  assert.equal(source.includes("GitHubAuthorizationVerifier"), false);
  assert.equal(`${source}\n${githubSource}`.includes("actions/artifacts"), false);
});

test("broker startup exposes only active or initial host-canary modes", () => {
  assert.equal(
    resolveBrokerProvisioningMode({
      matrix: { provisioningState: "active" },
      browserPolicy: { provisioningState: "active" },
    }),
    "active",
  );
  assert.equal(
    resolveBrokerProvisioningMode({
      matrix: { provisioningState: "active" },
      browserPolicy: { provisioningState: "pending-jit-canary" },
    }),
    "initial-host-canary",
  );
  for (const input of [
    {
      matrix: { provisioningState: "provisioning" },
      browserPolicy: { provisioningState: "pending-jit-canary" },
    },
    {
      matrix: { provisioningState: "active" },
      browserPolicy: { provisioningState: "unknown" },
    },
  ]) {
    assert.throws(
      () => resolveBrokerProvisioningMode(input),
      /checked hardware inventory is not active|browser policy state is invalid/u,
    );
  }
});

test("production watchdog uses the live controller reachability result", async () => {
  const calls = [];
  const record = {
    authorizationDigest: "a".repeat(64),
    state: "online_unassigned",
  };
  await runWatchdogCycle({
    ledger: { list: () => [record] },
    controllerReachability: {
      async isReachable(supplied) {
        assert.equal(supplied, record);
        return true;
      },
    },
    broker: {
      async watchdogTick(digest, options) {
        calls.push({ digest, options });
      },
    },
    auditLog: () => {
      throw new Error("healthy watchdog tick must not be rejected");
    },
  });
  assert.deepEqual(calls, [
    {
      digest: record.authorizationDigest,
      options: { controllerReachable: true },
    },
  ]);
});

test("production watchdog probes issued records before the runner is online", async () => {
  const calls = [];
  const record = {
    authorizationDigest: "b".repeat(64),
    state: "issued",
    cancellationResult: null,
  };
  await runWatchdogCycle({
    ledger: { list: () => [record] },
    controllerReachability: {
      async isReachable() {
        return false;
      },
    },
    broker: {
      async watchdogTick(digest, options) {
        calls.push({ digest, options });
      },
    },
    auditLog: () => {},
  });
  assert.deepEqual(calls, [
    {
      digest: record.authorizationDigest,
      options: { controllerReachable: false },
    },
  ]);
});

test("production watchdog keeps terminal and cancellation-pending records out of health probes", async () => {
  const calls = [];
  const records = [
    {
      authorizationDigest: "c".repeat(64),
      state: "deleted",
      cancellationResult: "cancelled",
    },
    {
      authorizationDigest: "d".repeat(64),
      state: "quarantined",
      cancellationResult: "pending",
    },
  ];
  await runWatchdogCycle({
    ledger: { list: () => records },
    controllerReachability: {
      async isReachable() {
        throw new Error("terminal record must not be probed");
      },
    },
    broker: {
      async watchdogTick(digest, options) {
        calls.push({ digest, options });
      },
    },
    auditLog: () => {},
  });
  assert.deepEqual(
    calls.sort((left, right) => left.digest.localeCompare(right.digest)),
    records.map((record) => ({
      digest: record.authorizationDigest,
      options: { controllerReachable: true },
    })),
  );
});

test("a slow record cannot suppress five-second work for other records", async () => {
  const records = [
    {
      authorizationDigest: "e".repeat(64),
      state: "issued",
      cancellationResult: null,
    },
    {
      authorizationDigest: "f".repeat(64),
      state: "issued",
      cancellationResult: null,
    },
  ];
  const inFlight = new Set();
  let releaseSlow;
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  let resolveFirstFast;
  const firstFast = new Promise((resolve) => {
    resolveFirstFast = resolve;
  });
  const calls = [];
  const options = {
    ledger: { list: () => records },
    controllerReachability: {
      async isReachable() {
        return true;
      },
    },
    broker: {
      async watchdogTick(digest) {
        calls.push(digest);
        if (digest === records[0].authorizationDigest) {
          await slowGate;
        } else if (
          calls.filter((candidate) => candidate === digest).length === 1
        ) {
          resolveFirstFast();
        }
      },
    },
    auditLog: () => {},
    inFlight,
  };

  const firstCycle = runWatchdogCycle(options);
  await firstFast;
  await new Promise((resolve) => setImmediate(resolve));
  await runWatchdogCycle(options);
  assert.deepEqual(calls, [
    records[0].authorizationDigest,
    records[1].authorizationDigest,
    records[1].authorizationDigest,
  ]);
  releaseSlow();
  await firstCycle;
});
