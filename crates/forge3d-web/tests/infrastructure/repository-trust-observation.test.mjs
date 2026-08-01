import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalJson, sha256Hex } from "../../scripts/canonical-json.mjs";
import { createRepositoryTrustObservation } from "../../scripts/emit-repository-trust-observation.mjs";
import {
  createPublisherProof,
  validateOutputTuple,
  verifyObservationArtifact,
  verifyRepositoryTrustObservation,
} from "../../scripts/verify-repository-trust-observation.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const now = new Date("2026-07-28T12:00:00.000Z");
const policy = makePolicy();
const actionsLock = { schemaVersion: 1, reviewedAt: "2026-07-28", actions: [] };
const expected = {
  operation: "package-broker",
  consumers: [
    { job: "package-broker", environment: "forge3d-browser-lab" },
  ],
  runId: 123,
  runAttempt: 2,
  targetSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  workflowPath: ".github/workflows/browser-lab-broker.yml",
  workflowSha: "cccccccccccccccccccccccccccccccccccccccc",
};

test("emits and verifies a canonical, exact-consumer observation", () => {
  const bytes = makeObservationBytes();
  const observation = verifyRepositoryTrustObservation({
    bytes,
    expected,
    policy,
    actionsLock,
    now: new Date(now.getTime() + 60_000),
  });
  assert.equal(observation.operation, "package-broker");
  assert.equal(observation.consumers.length, 1);
  assert.equal(Object.hasOwn(observation, "repositorySettings"), false);
  assert.equal(observation.liveResponses.length, 9);
  assertJsonSchema(
    observation,
    JSON.parse(
      readFileSync(
        new URL("./repository-trust-observation.schema.json", import.meta.url),
        "utf8",
      ),
    ),
  );
});

for (const [name, mutate, expectedError] of [
  [
    "wrong operation",
    (value) => {
      value.operation = "publish-release";
    },
    /operation mismatch/u,
  ],
  [
    "wrong run attempt",
    (value) => {
      value.run.attempt = 1;
    },
    /run attempt mismatch/u,
  ],
  [
    "wrong target",
    (value) => {
      value.targetSha = "dddddddddddddddddddddddddddddddddddddddd";
    },
    /target SHA mismatch/u,
  ],
  [
    "wrong consumer",
    (value) => {
      value.consumers[0].job = "other";
    },
    /consumer set does not exactly match/u,
  ],
  [
    "extra consumer",
    (value) => {
      value.consumers.push({ job: "other", environment: "none" });
    },
    /consumer set does not exactly match/u,
  ],
  [
    "expired validity",
    (value) => {
      value.expiresAt = "2026-07-28T12:31:00.001Z";
    },
    /at most 30 minutes/u,
  ],
  [
    "policy digest",
    (value) => {
      value.policySha256 = "0".repeat(64);
    },
    /policy digest mismatch/u,
  ],
  [
    "stale required-check SHA",
    (value) => {
      value.requiredChecks[0].headSha = "e".repeat(40);
    },
    /required check result is invalid/u,
  ],
  [
    "wrong required-check app id",
    (value) => {
      value.requiredChecks[0].app.id = 1;
    },
    /expected constant 15368|required check result is invalid/u,
  ],
  [
    "wrong required-check app slug",
    (value) => {
      value.requiredChecks[0].app.slug = "lookalike-actions";
    },
    /expected constant "github-actions"|required check result is invalid/u,
  ],
  [
    "duplicate required-check id",
    (value) => {
      value.requiredChecks[1].id = value.requiredChecks[0].id;
    },
    /required checks do not match policy/u,
  ],
  [
    "missing check-runs live response",
    (value) => {
      value.liveResponses = value.liveResponses.filter(
        (response) => response.name !== "checkRuns",
      );
    },
    /fewer than 9 items|bind every live trust response/u,
  ],
]) {
  test(`rejects observation with ${name}`, () => {
    const value = JSON.parse(makeObservationBytes().toString("utf8"));
    mutate(value);
    assert.throws(
      () =>
        verifyRepositoryTrustObservation({
          bytes: Buffer.from(canonicalJson(value)),
          expected,
          policy,
          actionsLock,
          now: new Date(now.getTime() + 60_000),
        }),
      expectedError,
    );
  });
}

test("release observations bind immutable semantics and the exact live response", () => {
  const releaseExpected = { ...expected, operation: "publish-web-release" };
  const observation = verifyRepositoryTrustObservation({
    bytes: makeObservationBytes({ operation: releaseExpected.operation }),
    expected: releaseExpected,
    policy,
    actionsLock,
    now: new Date(now.getTime() + 60_000),
  });
  assert.deepEqual(observation.repositorySettings, {
    immutableReleases: { enabled: true, enforcedByOwner: false },
  });
  assert.equal(observation.liveResponses.length, 10);
  assert.equal(
    observation.liveResponses.find((response) => response.name === "immutableReleases")
      ?.endpoint,
    "/repos/milos-agathon/forge3d-web/immutable-releases",
  );
});

for (const [name, mutate, expectedError] of [
  [
    "disabled release immutability",
    (value) => { value.repositorySettings.immutableReleases.enabled = false; },
    /expected constant true|release immutability mismatch/u,
  ],
  [
    "missing release immutability state",
    (value) => { delete value.repositorySettings.immutableReleases; },
    /required property is missing|release immutability/u,
  ],
  [
    "malformed release immutability owner enforcement",
    (value) => {
      value.repositorySettings.immutableReleases.enforcedByOwner = "false";
    },
    /expected type boolean|owner enforcement is invalid/u,
  ],
  [
    "missing immutable-releases live response",
    (value) => {
      value.liveResponses = value.liveResponses.filter(
        (response) => response.name !== "immutableReleases",
      );
    },
    /fewer than 10 items|bind every live trust response/u,
  ],
  [
    "mismatched immutable-releases endpoint",
    (value) => {
      value.liveResponses.find(
        (response) => response.name === "immutableReleases",
      ).endpoint = "/repos/another-owner/another-repository/immutable-releases";
    },
    /immutable-release response endpoint mismatch/u,
  ],
]) {
  test(`rejects release observation with ${name}`, () => {
    const releaseExpected = { ...expected, operation: "publish-web-release" };
    const value = JSON.parse(
      makeObservationBytes({ operation: releaseExpected.operation }).toString("utf8"),
    );
    mutate(value);
    assert.throws(
      () => verifyRepositoryTrustObservation({
        bytes: Buffer.from(canonicalJson(value)),
        expected: releaseExpected,
        policy,
        actionsLock,
        now: new Date(now.getTime() + 60_000),
      }),
      expectedError,
    );
  });
}

test("rejects immutable-release state on a non-release observation", () => {
  const value = JSON.parse(makeObservationBytes().toString("utf8"));
  value.repositorySettings = {
    immutableReleases: { enabled: true, enforcedByOwner: false },
  };
  value.liveResponses.push({
    name: "immutableReleases",
    endpoint: "/repos/milos-agathon/forge3d-web/immutable-releases",
    sha256: "a".repeat(64),
  });
  assert.throws(
    () => verifyRepositoryTrustObservation({
      bytes: Buffer.from(canonicalJson(value)),
      expected,
      policy,
      actionsLock,
      now: new Date(now.getTime() + 60_000),
    }),
    /expected type null|more than 9 items|cannot carry repository settings/u,
  );
});

test("rejects non-canonical observation bytes", () => {
  const value = JSON.parse(makeObservationBytes().toString("utf8"));
  assert.throws(
    () =>
      verifyRepositoryTrustObservation({
        bytes: Buffer.from(JSON.stringify(value, null, 2)),
        expected,
        policy,
        actionsLock,
        now,
      }),
    /not canonical/u,
  );
});

test("rejects an otherwise valid observation after its independent expiry", () => {
  assert.throws(
    () =>
      verifyRepositoryTrustObservation({
        bytes: makeObservationBytes(),
        expected,
        policy,
        actionsLock,
        now: new Date("2026-07-28T12:30:00.000Z"),
      }),
    /expired or not yet valid/u,
  );
});

test("validates the exact artifact ID/name/digest/content tuple", () => {
  const observationBytes = makeObservationBytes();
  const zipBytes = makeStoredZip(
    "repository-trust-observation.json",
    observationBytes,
  );
  const outputs = {
    artifactId: "9001",
    artifactName: "trust-123-2-package-broker",
    artifactDigest: sha256Hex(zipBytes),
    contentSha256: sha256Hex(observationBytes),
  };
  const metadata = {
    id: 9001,
    name: outputs.artifactName,
    digest: `sha256:${outputs.artifactDigest}`,
    expired: false,
    workflow_run: {
      id: expected.runId,
      repository_id: policy.repository.id,
      head_repository_id: policy.repository.id,
      head_branch: "main",
      head_sha: expected.workflowSha,
    },
  };
  const result = verifyObservationArtifact({
    outputs,
    metadata,
    zipBytes,
    expected,
    policy,
    actionsLock,
    now: new Date(now.getTime() + 60_000),
  });
  assert.equal(result.observation.operation, expected.operation);

  for (const [name, mutation, error] of [
    ["ID", (copy) => (copy.metadata.id = 9002), /artifact ID mismatch/u],
    ["name", (copy) => (copy.metadata.name = "lookup-by-name"), /artifact name mismatch/u],
    ["digest", (copy) => (copy.outputs.artifactDigest = "0".repeat(64)), /artifact metadata digest mismatch/u],
    ["content", (copy) => (copy.outputs.contentSha256 = "0".repeat(64)), /content digest mismatch/u],
    ["run", (copy) => (copy.metadata.workflow_run.id = 999), /workflow run ID mismatch/u],
    ["repository", (copy) => (copy.metadata.workflow_run.repository_id = 1), /repository ID mismatch/u],
    ["head repository", (copy) => (copy.metadata.workflow_run.head_repository_id = 1), /head repository ID mismatch/u],
    ["head branch", (copy) => (copy.metadata.workflow_run.head_branch = "feature"), /head branch mismatch/u],
    ["head SHA", (copy) => (copy.metadata.workflow_run.head_sha = "d".repeat(40)), /head SHA mismatch/u],
    ["expired", (copy) => (copy.metadata.expired = true), /expired flag mismatch/u],
  ]) {
    const copy = {
      outputs: structuredClone(outputs),
      metadata: structuredClone(metadata),
      zipBytes,
    };
    mutation(copy);
    assert.throws(
      () =>
        verifyObservationArtifact({
          ...copy,
          expected,
          policy,
          actionsLock,
          now: new Date(now.getTime() + 60_000),
        }),
      error,
      name,
    );
  }
});

test("rejects missing, zero, uppercase, and malformed observer outputs", () => {
  for (const outputs of [
    {},
    { artifactId: "0", artifactName: "x", artifactDigest: "a".repeat(64), contentSha256: "b".repeat(64) },
    { artifactId: "1", artifactName: "x", artifactDigest: "A".repeat(64), contentSha256: "b".repeat(64) },
    { artifactId: "1", artifactName: "list/name", artifactDigest: "a".repeat(64), contentSha256: "b".repeat(64) },
  ]) {
    assert.throws(() => validateOutputTuple(outputs));
  }
});

test("rejects an archive with multiple members", () => {
  const first = makeStoredZip("repository-trust-observation.json", makeObservationBytes());
  const second = Buffer.from(first);
  const eocd = second.length - 22;
  second.writeUInt16LE(2, eocd + 8);
  second.writeUInt16LE(2, eocd + 10);
  const outputs = {
    artifactId: "1",
    artifactName: "trust",
    artifactDigest: sha256Hex(second),
    contentSha256: sha256Hex(makeObservationBytes()),
  };
  assert.throws(
    () =>
      verifyObservationArtifact({
        outputs,
        metadata: {
          id: 1,
          name: "trust",
          digest: `sha256:${outputs.artifactDigest}`,
          expired: false,
          workflow_run: {
            id: expected.runId,
            repository_id: policy.repository.id,
            head_repository_id: policy.repository.id,
            head_branch: "main",
            head_sha: expected.workflowSha,
          },
        },
        zipBytes: second,
        expected,
        policy,
        actionsLock,
        now,
      }),
    /exactly one/u,
  );
});

test("publisher proof closes every nested observation binding", () => {
  const observation = JSON.parse(
    makeObservationBytes({ operation: "publish-web-release" }).toString("utf8"),
  );
  const outputs = {
    artifactId: "9001",
    artifactName: "trust-123-2-package-broker",
    artifactDigest: "a".repeat(64),
    contentSha256: sha256Hex(
      makeObservationBytes({ operation: "publish-web-release" }),
    ),
  };
  const metadata = {
    expired: false,
    workflow_run: {
      id: expected.runId,
      repository_id: policy.repository.id,
      head_repository_id: policy.repository.id,
      head_branch: "main",
      head_sha: expected.workflowSha,
    },
  };
  const proof = createPublisherProof({
    outputs,
    metadata,
    observation,
    repository: policy.repository.fullName,
  });
  const schema = JSON.parse(
    readFileSync(
      new URL("./repository-trust-publisher-proof.schema.json", import.meta.url),
      "utf8",
    ),
  );
  assertJsonSchema(proof, schema);
  for (const mutate of [
    (value) => { value.observation.consumers[0].extra = true; },
    (value) => { value.observation.workflow.extra = true; },
    (value) => { value.observation.run.extra = true; },
  ]) {
    const tampered = structuredClone(proof);
    mutate(tampered);
    assert.throws(() => assertJsonSchema(tampered, schema), /additional property/u);
  }
});

function makeObservationBytes({ operation = expected.operation } = {}) {
  const requireImmutableReleases = [
    "compute-hardware-release-readiness",
    "compute-lab-readiness",
    "publish-lab-canary",
    "publish-web-release",
  ].includes(operation);
  const verification = {
    ok: true,
    repository: {
      id: policy.repository.id,
      fullName: policy.repository.fullName,
    },
    currentMainSha: "dddddddddddddddddddddddddddddddddddddddd",
    trustEpochSha: policy.trustEpochSha,
    policySha256: sha256Hex(policy),
    workflowActionsLockSha256: sha256Hex(actionsLock),
    requiredChecks: [
      {
        id: 1,
        workflowJobId: 11,
        name: "Web Runtime / Build And Contract Tests",
        headSha: "dddddddddddddddddddddddddddddddddddddddd",
        status: "completed",
        conclusion: "success",
        app: { id: 15368, slug: "github-actions" },
      },
      {
        id: 2,
        workflowJobId: 12,
        name: "Web Runtime / Browser Preflight",
        headSha: "dddddddddddddddddddddddddddddddddddddddd",
        status: "completed",
        conclusion: "success",
        app: { id: 15368, slug: "github-actions" },
      },
    ],
    liveResponses: [
      "actionsPermissions",
      "branch",
      "checkRuns",
      "protection",
      "repository",
      "repositoryRunners",
      "trustEpochComparison",
      "workflowJobs",
      "workflowRuns",
    ].map((name, index) => ({
      name,
      endpoint: `/repos/milos-agathon/forge3d-web/resource-${index}`,
      sha256: String(index).repeat(64),
    })),
  };
  if (requireImmutableReleases) {
    verification.operation = operation;
    verification.repositorySettings = {
      immutableReleases: { enabled: true, enforcedByOwner: false },
    };
    verification.liveResponses.push({
      name: "immutableReleases",
      endpoint: "/repos/milos-agathon/forge3d-web/immutable-releases",
      sha256: "a".repeat(64),
    });
  }
  const observation = createRepositoryTrustObservation({
    verification,
    operation,
    consumers: structuredClone(expected.consumers),
    workflow: {
      path: expected.workflowPath,
      ref: "refs/heads/main",
      sha: expected.workflowSha,
    },
    run: { id: expected.runId, attempt: expected.runAttempt },
    candidateSha: expected.targetSha,
    targetSha: expected.targetSha,
    now,
    nonce: "0123456789abcdef0123456789abcdef",
  });
  return Buffer.from(canonicalJson(observation));
}

function makePolicy() {
  return {
    schemaVersion: 1,
    repository: {
      id: 1259761852,
      owner: "milos-agathon",
      name: "forge3d-web",
      fullName: "milos-agathon/forge3d-web",
      defaultBranch: "main",
    },
    bootstrapState: "active",
    trustEpochSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    branchProtection: {
      requiredStatusChecks: {
        checks: [
          {
            context: "Web Runtime / Build And Contract Tests",
            sourceAppSlug: "github-actions",
            sourceAppId: 15368,
          },
          {
            context: "Web Runtime / Browser Preflight",
            sourceAppSlug: "github-actions",
            sourceAppId: 15368,
          },
        ],
      },
    },
    actionsShaPinning: {},
    trustObserverApp: {},
    registrationBrokerApp: {},
  };
}

function makeStoredZip(name, content) {
  const nameBytes = Buffer.from(name, "utf8");
  const crc = crc32(content);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  nameBytes.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + content.length, 16);
  return Buffer.concat([local, content, central, eocd]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
