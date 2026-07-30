import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePackageBootstrap } from "../../scripts/resolve-package-bootstrap.mjs";

const infrastructureRoot = dirname(fileURLToPath(import.meta.url));
const checkedPolicy = JSON.parse(
  readFileSync(join(infrastructureRoot, "repository-trust-policy.json"), "utf8"),
);
const pendingPolicy = {
  ...checkedPolicy,
  bootstrapState: "pending-protection-canary",
  trustEpochSha: null,
};
const activePolicy = {
  ...checkedPolicy,
  bootstrapState: "active",
  trustEpochSha: "a".repeat(40),
};

test("pending bootstrap skips automatic protected-main packaging", () => {
  assert.deepEqual(
    resolvePackageBootstrap(pendingPolicy, { eventName: "push" }),
    {
      packageEnabled: false,
      reason: "repository trust bootstrap is pending",
    },
  );
});

test("pending bootstrap rejects manual packaging", () => {
  assert.throws(
    () =>
      resolvePackageBootstrap(pendingPolicy, {
        eventName: "workflow_dispatch",
      }),
    /requires active repository trust/u,
  );
});

test("active bootstrap enables automatic and manual packaging", () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    assert.equal(
      resolvePackageBootstrap(activePolicy, { eventName }).packageEnabled,
      true,
    );
  }
});

for (const [name, policy] of [
  [
    "pending bootstrap with an epoch",
    { ...pendingPolicy, trustEpochSha: "a".repeat(40) },
  ],
  [
    "active bootstrap without an epoch",
    { ...activePolicy, trustEpochSha: null },
  ],
  [
    "unknown bootstrap state",
    { ...pendingPolicy, bootstrapState: "unknown" },
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => resolvePackageBootstrap(policy, { eventName: "push" }),
      /inconsistent bootstrap state/u,
    );
  });
}

test("every bootstrap state rejects an untrusted trigger", () => {
  for (const policy of [pendingPolicy, activePolicy]) {
    assert.throws(
      () =>
        resolvePackageBootstrap(policy, {
          eventName: "pull_request",
        }),
      /unsupported package event/u,
    );
  }
});
