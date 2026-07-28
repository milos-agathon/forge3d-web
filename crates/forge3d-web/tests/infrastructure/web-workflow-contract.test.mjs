import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyWorkflowActionPins,
  verifyWorkflowText,
} from "../../scripts/verify-workflow-action-pins.mjs";
import { verifyWebWorkflowContract } from "../../scripts/verify-web-workflow-contract.mjs";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repositoryRoot = resolve(packageRoot, "..", "..");
const workflowPath = join(repositoryRoot, ".github", "workflows", "web.yml");
const workflowText = readFileSync(workflowPath, "utf8").replace(/\r\n/gu, "\n");
const lock = JSON.parse(
  readFileSync(
    join(packageRoot, "tests", "infrastructure", "workflow-actions-lock.json"),
    "utf8",
  ),
);
const lockedActions = new Map(
  lock.actions.map((entry) => [
    entry.path ? `${entry.repository}/${entry.path}` : entry.repository,
    entry,
  ]),
);

test("web workflow exposes exactly the two immutable required checks", () => {
  const contract = verifyWebWorkflowContract();
  assert.deepEqual(contract.triggers, ["pull_request", "push"]);
  assert.deepEqual(
    contract.jobs.map((job) => job.name).sort(),
    [
      "Web Runtime / Browser Preflight",
      "Web Runtime / Build And Contract Tests",
    ],
  );
});

test("web workflow keeps privileged triggers and self-hosted routing out", () => {
  for (const forbidden of [
    "workflow_dispatch",
    "workflow_call",
    "schedule",
    "repository_dispatch",
  ]) {
    assert.equal(workflowText.includes(`  ${forbidden}:`), false);
  }
  assert.equal(workflowText.includes("self-hosted"), false);
  assert.equal(workflowText.includes("forge3d-trust-observer"), false);
  assert.equal(workflowText.includes("forge3d-browser-lab"), false);
});

test("web workflow verifier rejects renamed, duplicate, missing, and self-hosted checks", () => {
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace(
          "Web Runtime / Browser Preflight",
          "Browser Preflight",
        ),
      ),
    /display name must remain immutable/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace(
          "Web Runtime / Browser Preflight",
          "Web Runtime / Build And Contract Tests",
        ),
      ),
    /display name must remain immutable|duplicate job display name/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace("  pull_request:\n    branches: [main]\n", ""),
      ),
    /triggers must be exactly/u,
  );
  assert.throws(
    () =>
      verifyWebWorkflowContract(
        workflowText.replace("runs-on: windows-latest", "runs-on: self-hosted"),
      ),
    /GitHub-hosted/u,
  );
});

test("every external action is immutable and lockfile reviewed", () => {
  const result = verifyWorkflowActionPins();
  assert.ok(result.checkedFiles.includes(".github/workflows/web.yml"));
  assert.ok(result.references.length >= 4);
});

test("action verifier rejects movable, local, unreviewed, and container references", () => {
  assert.throws(
    () => verifyWorkflowText("steps:\n  - uses: actions/checkout@v4\n", "fixture.yml", lockedActions),
    /full lowercase commit SHA/u,
  );
  assert.throws(
    () => verifyWorkflowText("steps:\n  - uses: ./unsafe\n", "fixture.yml", lockedActions),
    /local and docker/u,
  );
  assert.throws(
    () =>
      verifyWorkflowText(
        "steps:\n  - uses: example/unknown@0123456789abcdef0123456789abcdef01234567\n",
        "fixture.yml",
        lockedActions,
      ),
    /not reviewed/u,
  );
  assert.throws(
    () => verifyWorkflowText("jobs:\n  one:\n    container: node:20\n", "fixture.yml", lockedActions),
    /literal sha256 digest/u,
  );
  assert.throws(
    () =>
      verifyWorkflowText(
        "jobs:\n  one:\n    services:\n      redis:\n        image: ${{ inputs.redis_image }}\n",
        "fixture.yml",
        lockedActions,
      ),
    /literal sha256 digest/u,
  );
  assert.throws(
    () =>
      verifyWorkflowText(
        [
          "service: &service",
          "  image: redis:latest",
          "jobs:",
          "  one:",
          "    services:",
          "      redis: *service",
          "",
        ].join("\n"),
        "fixture.yml",
        lockedActions,
      ),
    /YAML aliases are forbidden/u,
  );
});

test("action verifier structurally accepts only digest-pinned job and service images", () => {
  const digest = "a".repeat(64);
  assert.doesNotThrow(() =>
    verifyWorkflowText(
      [
        "jobs:",
        "  one:",
        "    container:",
        `      image: ghcr.io/example/build@sha256:${digest}`,
        "    services:",
        "      redis:",
        `        image: redis@sha256:${digest}`,
        "",
      ].join("\n"),
      "fixture.yml",
      lockedActions,
    ),
  );
});
