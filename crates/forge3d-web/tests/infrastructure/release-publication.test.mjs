import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertGitHubResourceAbsent,
  createBrowserReleaseCandidate,
  createManualMediaSourcePlan,
  createPublicationPreflight,
  createReleasePublicationRecord,
  validateCanaryCandidate,
  validateIndependentPublisher,
  validateManualMediaIntake,
  validateReleaseCandidate,
  verifyPublicationHandoff,
} from "../../scripts/release-publication.mjs";
import { sha256Hex } from "../../scripts/canonical-json.mjs";
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
const preflightReadiness = {
  runId: readiness.runId,
  artifactId: readiness.artifactId,
  sha256: readiness.sha256,
  status: readiness.status,
};

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
        {
          state: "approved",
          user: { id: 1, login: "independent" },
          environments: [{ id: 100, name: "forge3d-web-release" }],
        },
      ],
    }),
  );
  assert.throws(() =>
    validateIndependentPublisher({
      actor: "publisher",
      implementationActors: ["implementer"],
      approvals: [
        {
          state: "approved",
          user: { id: 1, login: "publisher" },
          environments: [{ id: 100, name: "forge3d-web-release" }],
        },
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

test("publisher counts only exact forge3d-web-release approvals", () => {
  const common = {
    actor: "publisher",
    implementationActors: ["implementer"],
  };
  assert.deepEqual(
    validateIndependentPublisher({
      ...common,
      approvals: [
        {
          state: "approved",
          user: { id: 1, login: "observer-approver" },
          environments: [{ id: 90, name: "forge3d-trust-observer" }],
        },
        {
          state: "approved",
          user: { id: 2, login: "release-approver" },
          environments: [{ id: 100, name: "forge3d-web-release" }],
        },
      ],
    }),
    [{
      id: 2,
      login: "release-approver",
      environment: { id: 100, name: "forge3d-web-release" },
    }],
  );
  assert.throws(
    () =>
      validateIndependentPublisher({
        ...common,
        approvals: [{
          state: "approved",
          user: { id: 1, login: "observer-approver" },
          environments: [{ id: 90, name: "forge3d-trust-observer" }],
        }],
      }),
    /no approval exists/u,
  );
  assert.throws(
    () =>
      validateIndependentPublisher({
        ...common,
        approvals: [{
          state: "approved",
          user: { id: 3, login: "mixed" },
          environments: [
            { id: 100, name: "forge3d-web-release" },
            { id: 90, name: "forge3d-trust-observer" },
          ],
        }],
      }),
    /mixes/u,
  );
  assert.throws(
    () =>
      validateIndependentPublisher({
        actor: "Publisher",
        implementationActors: ["implementer"],
        approvals: [{
          state: "approved",
          user: { id: 4, login: "publisher" },
          environments: [{ id: 100, name: "forge3d-web-release" }],
        }],
      }),
    /independent/u,
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
    readiness: preflightReadiness,
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
        mode: "supported-release",
        supportClaim: true,
        repository: "milos-agathon/forge3d-web",
        workflowSha: sha,
        runId: 40,
        runAttempt: 1,
        targetSha: sha,
        tag: "v1.26.3",
        publisherJob: "publish-release",
        readiness: preflightReadiness,
        assets: [{ sourceId: 30, name: "manifest.json", sha256: "e".repeat(64) }],
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

test("publication handoff rejects readiness, asset, mode, and lifetime substitutions", () => {
  const base = createPublicationPreflight({
    mode: "supported-release",
    supportClaim: true,
    targetSha: sha,
    tag: "v1.26.3",
    readiness: preflightReadiness,
    assets: [{ sourceId: 30, name: "manifest.json", sha256: "e".repeat(64) }],
    observation: {
      artifactId: 20,
      artifactName: "trust",
      artifactDigest: "sha256:" + "c".repeat(64),
      contentSha256: "d".repeat(64),
    },
    run: {
      id: 40,
      attempt: 1,
      workflow: ".github/workflows/publish-web-release.yml",
    },
    workflowSha: sha,
    publisher: { actor: "publisher", job: "publish-release" },
    implementationActors: ["implementer"],
    createdAt: new Date("2026-07-30T00:00:00Z"),
  }).record;
  const expected = {
    mode: "supported-release",
    supportClaim: true,
    repository: "milos-agathon/forge3d-web",
    workflowSha: sha,
    runId: 40,
    runAttempt: 1,
    targetSha: sha,
    tag: "v1.26.3",
    publisherJob: "publish-release",
    readiness: preflightReadiness,
    assets: [{ sourceId: 30, name: "manifest.json", sha256: "e".repeat(64) }],
    observationArtifactId: 20,
    observationArtifactName: "trust",
    observationArtifactDigest: "sha256:" + "c".repeat(64),
    observationContentSha256: "d".repeat(64),
  };
  const verify = (preflight, now = "2026-07-30T00:10:00Z") =>
    verifyPublicationHandoff({
      preflight,
      expected: { ...expected, preflightSha256: sha256Hex(preflight) },
      now: new Date(now),
    });
  assert.doesNotThrow(() => verify(base));
  for (const mutate of [
    (value) => { value.mode = "laboratory-canary"; value.supportClaim = false; },
    (value) => { value.readiness.sha256 = "f".repeat(64); },
    (value) => { value.assets[0].sha256 = "f".repeat(64); },
    (value) => { value.repository = "attacker/repository"; },
    (value) => { value.expiresAt = "2026-07-30T00:30:00.001Z"; },
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.throws(() => verify(changed), /missing, stale, or mismatched|schema/u);
  }
  assert.throws(
    () => verify(base, "2026-07-29T23:59:59.999Z"),
    /missing, stale, or mismatched/u,
  );
});

test("GitHub resource absence requires an explicit HTTP 404", async () => {
  const input = {
    repository: "milos-agathon/forge3d-web",
    resourcePath: "releases/tags/v1.26.3",
    token: "test-token",
  };
  assert.equal(
    await assertGitHubResourceAbsent({
      ...input,
      fetchImpl: async () => ({ status: 404 }),
    }),
    true,
  );
  for (const status of [200, 204, 403, 500]) {
    await assert.rejects(
      () =>
        assertGitHubResourceAbsent({
          ...input,
          fetchImpl: async () => ({ status }),
        }),
      /present|not proven/u,
    );
  }
});

test("GitHub resource absence fails closed on transport and malformed status", async () => {
  const input = {
    repository: "milos-agathon/forge3d-web",
    resourcePath: "git/ref/tags/v1.26.3",
    token: "test-token",
  };
  await assert.rejects(
    () =>
      assertGitHubResourceAbsent({
        ...input,
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    /transport failed/u,
  );
  for (const status of [undefined, "404", Number.NaN]) {
    await assert.rejects(
      () =>
        assertGitHubResourceAbsent({
          ...input,
          fetchImpl: async () => ({ status }),
        }),
      /malformed status/u,
    );
  }
});

test("supported manual media is re-bound to the exact still-draft intake and bytes", () => {
  const fixture = manualMediaFixture();
  const validated = validateManualMediaIntake(fixture);
  const plan = createManualMediaSourcePlan({ targetSha: sha, intakes: [validated] });
  assertJsonSchema(plan.record, schema("manual-media-sources.schema.json"));
  assert.equal(validated.media[0].finalName, "manual-media-71-81-proof.png");
  assert.equal(plan.record.intakes[0].draft, true);
});

test("missing, swapped, overwritten, and API-digest-mismatched intake media fail closed", () => {
  const missing = manualMediaFixture();
  missing.intakeRelease.assets = missing.intakeRelease.assets.slice(0, 1);
  assert.throws(() => validateManualMediaIntake(missing), /closed inventory/u);

  const swapped = manualMediaFixture();
  swapped.mediaMetadata[0].name = "swapped.png";
  assert.throws(() => validateManualMediaIntake(swapped), /missing, swapped, or overwritten/u);

  const overwritten = manualMediaFixture();
  overwritten.currentMediaBytes["81"] = Buffer.from("other");
  assert.throws(() => validateManualMediaIntake(overwritten), /missing, swapped, or overwritten/u);

  const digestMismatch = manualMediaFixture();
  digestMismatch.mediaMetadata[0].digest = `sha256:${"f".repeat(64)}`;
  assert.throws(() => validateManualMediaIntake(digestMismatch), /missing, swapped, or overwritten/u);
});

test("candidate record is schema-valid and makes no post-publication CLI claims", () => {
  const plan = createManualMediaSourcePlan({
    targetSha: sha,
    intakes: [validateManualMediaIntake(manualMediaFixture())],
  });
  const candidate = createBrowserReleaseCandidate({
    targetSha: sha,
    tag: "v1.26.3",
    readiness,
    assets: [
      { name: "payload.bin", sha256: digest(Buffer.from("payload")) },
      { name: "manual-media-sources.json", sha256: plan.sha256 },
    ],
    manualMediaPlanSha256: plan.sha256,
    createdAt: new Date("2026-07-30T00:00:00Z"),
  });
  assertJsonSchema(candidate.record, schema("browser-release-manifest.schema.json"));
  assert.equal(Object.hasOwn(candidate.record, "releaseVerification"), false);
  assert.equal(Object.hasOwn(candidate.record, "publishedAt"), false);
});

test("post-publication record retains exact CLI JSON digests and immutable release identity", () => {
  const fixture = publicationFixture();
  const result = createReleasePublicationRecord(fixture);
  assertJsonSchema(
    result.record,
    schema("browser-release-publication-record.schema.json"),
  );
  assert.equal(result.record.release.immutable, true);
  assert.deepEqual(result.record.publicationRun, {
    id: 40,
    attempt: 1,
    workflowPath: ".github/workflows/publish-web-release.yml",
  });
  assert.equal(
    result.record.releaseVerification.outputSha256,
    digest(Buffer.from('{"verified":true}\n')),
  );
  assert.equal(result.record.assetVerifications.length, fixture.assets.length);
});

test("early intake deletion, absent CLI output, and publication schema drift fail", () => {
  const early = publicationFixture();
  early.intakeDeletions[0].deletedAt = "2026-07-30T00:09:59Z";
  assert.throws(() => createReleasePublicationRecord(early), /verification proof/u);

  const missingCli = publicationFixture();
  missingCli.assetVerifications.pop();
  assert.throws(() => createReleasePublicationRecord(missingCli), /verification proof/u);

  const result = createReleasePublicationRecord(publicationFixture()).record;
  result.releaseVerified = true;
  assert.throws(
    () => assertJsonSchema(result, schema("browser-release-publication-record.schema.json")),
    /additional property/u,
  );
});

test("post-publication record rejects missing, non-positive, or drifted publication run identity", () => {
  for (const publicationRun of [
    undefined,
    { id: 0, attempt: 1, workflowPath: ".github/workflows/publish-web-release.yml" },
    { id: 40, attempt: 0, workflowPath: ".github/workflows/publish-web-release.yml" },
    {
      id: 40,
      attempt: 1,
      workflowPath: ".github/workflows/publish-browser-lab-canary.yml",
    },
  ]) {
    assert.throws(
      () => createReleasePublicationRecord({ ...publicationFixture(), publicationRun }),
      /release identity/u,
    );
  }
});

function manualMediaFixture() {
  const bytes = Buffer.from("proof");
  const mediaSha = digest(bytes);
  const intake = {
    schemaVersion: 1,
    repository: "milos-agathon/forge3d-web",
    prepareWorkflow: ".github/workflows/prepare-browser-manual-evidence.yml",
    prepareRun: { id: 61, attempt: 1, workflowSha: "b".repeat(40) },
    trustedSha: sha,
    packageRunId: 62,
    packageSha256: "c".repeat(64),
    checklistId: "safari-trackpad",
    checklistSha256: "d".repeat(64),
    stepIds: ["ONE", "TWO", "THREE", "FOUR"],
    assetId: "FW-TRACKPAD-01",
    hostId: "FW-MAC-M2-01",
    expectedTester: "tester",
    mediaChallenge: "e".repeat(32),
    supportClaim: true,
    createdAt: "2026-07-30T00:00:00.000Z",
    expiresAt: "2026-07-31T00:00:00.000Z",
  };
  const intakeBytes = Buffer.from(`${JSON.stringify(intake)}\n`);
  const media = {
    id: 81,
    name: "proof.png",
    uploader: "tester",
    size: bytes.length,
    mimeType: "image/png",
    createdAt: "2026-07-30T00:02:00Z",
    apiSha256: mediaSha,
    sha256: mediaSha,
  };
  const evidence = {
    schemaVersion: 1,
    repository: "milos-agathon/forge3d-web",
    workflow: ".github/workflows/submit-browser-manual-evidence.yml",
    run: { id: 63, attempt: 1, workflowSha: "f".repeat(40) },
    trustedSha: sha,
    packageRunId: 62,
    packageSha256: "c".repeat(64),
    labInfrastructureDigest: "1".repeat(64),
    labReadiness: {
      runId: 60,
      manifestSha256: "5".repeat(64),
      labInfrastructureDigest: "1".repeat(64),
    },
    checklistId: "safari-trackpad",
    stepResults: { ONE: "pass", TWO: "pass", THREE: "pass", FOUR: "pass" },
    assetId: "FW-TRACKPAD-01",
    hostId: "FW-MAC-M2-01",
    system: { os: "macOS", build: "25A1" },
    browser: { name: "Safari", channel: "stable", version: "18.0" },
    driver: { name: "safaridriver", version: "18.0" },
    hostInventory: {},
    actor: "tester",
    approver: {
      id: 64,
      login: "approver",
      environment: { id: 600, name: "forge3d-manual-evidence" },
    },
    approvalProvenance: [{
      id: 64,
      login: "approver",
      state: "approved",
      environment: { id: 600, name: "forge3d-manual-evidence" },
    }],
    intakeReleaseId: 71,
    manualSessionRunId: 65,
    manualSessionJobId: 66,
    authorizationSha256: "2".repeat(64),
    controllerSignatureSha256: "3".repeat(64),
    routeBasePath: `/runs/65/66/${"4".repeat(32)}/`,
    mediaChallenge: "e".repeat(32),
    media: [media],
    createdAt: "2026-07-30T00:03:00.000Z",
    expiresAt: "2026-08-06T00:03:00.000Z",
  };
  const metadata = {
    id: 81,
    name: "proof.png",
    uploader: { login: "tester" },
    size: bytes.length,
    content_type: "image/png",
    created_at: "2026-07-30T00:02:00Z",
    digest: `sha256:${mediaSha}`,
  };
  return {
    targetSha: sha,
    evidenceArtifactId: 70,
    evidence,
    intake,
    intakeRelease: {
      id: 71,
      tag_name: "manual-evidence-intake-61",
      target_commitish: sha,
      draft: true,
      prerelease: false,
      assets: [
        {
          id: 80,
          name: "intake-manifest.json",
          digest: `sha256:${digest(intakeBytes)}`,
        },
        { ...metadata },
      ],
    },
    intakeManifestAssetId: 80,
    attestedIntakeBytes: intakeBytes,
    currentIntakeBytes: intakeBytes,
    mediaMetadata: [metadata],
    attestedMediaBytes: { "81": bytes },
    currentMediaBytes: { "81": bytes },
  };
}

function publicationFixture() {
  const manual = createManualMediaSourcePlan({
    targetSha: sha,
    intakes: [validateManualMediaIntake(manualMediaFixture())],
  });
  const payloadSha = digest(Buffer.from("payload"));
  const candidate = createBrowserReleaseCandidate({
    targetSha: sha,
    tag: "v1.26.3",
    readiness,
    assets: [
      { name: "payload.bin", sha256: payloadSha },
      { name: "manual-media-sources.json", sha256: manual.sha256 },
    ],
    manualMediaPlanSha256: manual.sha256,
    createdAt: new Date("2026-07-30T00:00:00Z"),
  });
  const expected = [
    ["payload.bin", payloadSha],
    ["manual-media-sources.json", manual.sha256],
    ["browser-release-manifest.json", candidate.sha256],
  ];
  const assets = expected.map(([name, sha256], index) => ({
    id: 100 + index,
    name,
    size: 10 + index,
    apiDigest: `sha256:${sha256}`,
    sha256,
  }));
  return {
    candidate: candidate.record,
    candidateSha256: candidate.sha256,
    manualMediaPlan: manual.record,
    publicationRun: {
      id: 40,
      attempt: 1,
      workflowPath: ".github/workflows/publish-web-release.yml",
    },
    release: {
      id: 99,
      tag_name: "v1.26.3",
      target_commitish: sha,
      draft: false,
      prerelease: false,
      immutable: true,
      published_at: "2026-07-30T00:09:00Z",
    },
    assets,
    releaseVerification: { bytes: Buffer.from('{"verified":true}\n') },
    assetVerifications: assets.map((asset) => ({
      name: asset.name,
      bytes: Buffer.from(`{"asset":"${asset.name}","verified":true}\n`),
    })),
    intakeDeletions: [
      {
        releaseId: 71,
        tagName: "manual-evidence-intake-61",
        deletedAfterVerification: true,
        deletedAt: "2026-07-30T00:11:00Z",
      },
    ],
    verifiedAt: "2026-07-30T00:10:00Z",
    createdAt: new Date("2026-07-30T00:12:00Z"),
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function schema(name) {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
}
