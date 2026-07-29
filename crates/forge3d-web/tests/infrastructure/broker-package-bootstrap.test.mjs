import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBrokerPackageBootstrap } from "../../scripts/resolve-broker-package-bootstrap.mjs";

const infrastructureRoot = dirname(fileURLToPath(import.meta.url));
const checkedPolicy = JSON.parse(
  readFileSync(join(infrastructureRoot, "repository-trust-policy.json"), "utf8"),
);

test("pending bootstrap skips automatic protected-main packaging", () => {
  assert.deepEqual(
    resolveBrokerPackageBootstrap(checkedPolicy, { eventName: "push" }),
    {
      packageEnabled: false,
      reason: "repository trust bootstrap is pending",
    },
  );
});

test("pending bootstrap rejects manual packaging", () => {
  assert.throws(
    () =>
      resolveBrokerPackageBootstrap(checkedPolicy, {
        eventName: "workflow_dispatch",
      }),
    /requires active repository trust/u,
  );
});

test("active bootstrap enables automatic and manual packaging", () => {
  const activePolicy = {
    ...checkedPolicy,
    bootstrapState: "active",
    trustEpochSha: "a".repeat(40),
  };
  for (const eventName of ["push", "workflow_dispatch"]) {
    assert.equal(
      resolveBrokerPackageBootstrap(activePolicy, { eventName }).packageEnabled,
      true,
    );
  }
});

for (const [name, policy] of [
  [
    "pending bootstrap with an epoch",
    { ...checkedPolicy, trustEpochSha: "a".repeat(40) },
  ],
  [
    "active bootstrap without an epoch",
    { ...checkedPolicy, bootstrapState: "active" },
  ],
  [
    "unknown bootstrap state",
    { ...checkedPolicy, bootstrapState: "unknown" },
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => resolveBrokerPackageBootstrap(policy, { eventName: "push" }),
      /inconsistent bootstrap state/u,
    );
  });
}

test("every bootstrap state rejects an untrusted trigger", () => {
  for (const policy of [
    checkedPolicy,
    {
      ...checkedPolicy,
      bootstrapState: "active",
      trustEpochSha: "a".repeat(40),
    },
  ]) {
    assert.throws(
      () =>
        resolveBrokerPackageBootstrap(policy, {
          eventName: "pull_request",
        }),
      /unsupported broker package event/u,
    );
  }
});
