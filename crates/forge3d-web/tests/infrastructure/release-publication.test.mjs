import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createPublicationPreflight,
  validateCanaryCandidate,
  validateIndependentPublisher,
  validateReleaseCandidate,
  verifyPublicationHandoff,
} from "../../scripts/release-publication.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const sha = "a".repeat(40);
const readiness = {
  runId: 10,
  artifactId: 11,
  sha256: "b".repeat(64),
  status: "RELEASE_MATRIX_READY",
  supportClaim: true,
  targetSha: sha,
};
const trust = { verified: true, targetSha: sha, currentMainSha: sha };

test("supported and canary candidates require exact main, immutable setting, and absent tag", () => {
  assert.equal(
    validateReleaseCandidate({
      targetSha: sha,
      tag: "v1.26.3",
      packageVersion: "1.26.3",
      readiness,
      repositorySettings: { immutableReleases: true },
      existingRelease: null,
      existingTag: null,
      repositoryTrust: trust,
    }),
    true,
  );
  assert.deepEqual(
    validateCanaryCandidate({
      candidateSha: sha,
      publicationRunId: 12,
      labInfrastructureDigest: "c".repeat(64),
      repositorySettings: { immutableReleases: true },
      existingRelease: null,
      existingTag: null,
      repositoryTrust: trust,
    }),
    {
      tag: `browser-lab-canary-${"c".repeat(64)}-12`,
      supportClaim: false,
    },
  );
});

test("publisher, self approval, implementer approval, drift, and existing release fail", () => {
  assert.throws(() =>
    validateIndependentPublisher({
      actor: "implementer",
      implementationActors: ["implementer"],
      approvals: [
        { state: "approved", user: { id: 1, login: "independent" } },
      ],
    }),
  );
  assert.throws(() =>
    validateIndependentPublisher({
      actor: "publisher",
      implementationActors: ["implementer"],
      approvals: [
        { state: "approved", user: { id: 1, login: "publisher" } },
      ],
    }),
  );
  assert.throws(() =>
    validateReleaseCandidate({
      targetSha: sha,
      tag: "v1.26.3",
      packageVersion: "1.26.3",
      readiness,
      repositorySettings: { immutableReleases: false },
      existingRelease: { id: 1 },
      existingTag: null,
      repositoryTrust: trust,
    }),
  );
});

test("preflight is exact-consumer, independently approved, and expires in 30 minutes", () => {
  const observation = {
    artifactId: 20,
    artifactName: "trust",
    artifactDigest: "sha256:" + "c".repeat(64),
    contentSha256: "d".repeat(64),
  };
  const result = createPublicationPreflight({
    mode: "supported-release",
    supportClaim: true,
    targetSha: sha,
    tag: "v1.26.3",
    readiness,
    assets: [{ sourceId: 30, name: "manifest.json", sha256: "e".repeat(64) }],
    observation,
    run: {
      id: 40,
      attempt: 1,
      workflow: ".github/workflows/publish-web-release.yml",
    },
    workflowSha: sha,
    publisher: { actor: "publisher", job: "publish-release" },
    implementationActors: ["implementer"],
    createdAt: new Date("2026-07-30T00:00:00Z"),
  });
  assertJsonSchema(
    result.record,
    JSON.parse(
      readFileSync(
        new URL("./release-publication-preflight.schema.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.equal(result.record.expiresAt, "2026-07-30T00:30:00.000Z");
  assert.deepEqual(result.record.publisher.approvers, []);
  assert.equal(
    verifyPublicationHandoff({
      preflight: result.record,
      expected: {
        workflowSha: sha,
        runId: 40,
        runAttempt: 1,
        targetSha: sha,
        tag: "v1.26.3",
        publisherJob: "publish-release",
        observationArtifactId: 20,
        observationArtifactName: "trust",
        observationArtifactDigest: "sha256:" + "c".repeat(64),
        observationContentSha256: "d".repeat(64),
        preflightSha256: result.sha256,
      },
      now: new Date("2026-07-30T00:10:00Z"),
    }).tag,
    "v1.26.3",
  );
});
