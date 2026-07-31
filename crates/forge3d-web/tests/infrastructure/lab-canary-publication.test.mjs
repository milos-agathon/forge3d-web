import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createLabCanaryPublicationRecord,
  requireGitHubResourceAbsent,
  verifyCanaryManualIntake,
} from "../../scripts/lab-canary-publication.mjs";
import { canonicalJson } from "../../scripts/canonical-json.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const candidateSha = "a".repeat(40);
const labDigest = "b".repeat(64);
const tag = `browser-lab-canary-${labDigest}-42`;
const manifestBytes = Buffer.from(
  canonicalJson({
    schemaVersion: 1,
    recordType: "lab-canary-publication-candidate",
    supportClaim: false,
    candidateSha,
    publicationRunId: 42,
    tag,
    labInfrastructureDigest: labDigest,
    manualIntakeReleaseId: 71,
    intakeDeletionPlannedAfterVerification: true,
  }),
);
const intakeBytes = Buffer.from(
  JSON.stringify({
    trustedSha: candidateSha,
    supportClaim: false,
    prepareRun: { id: 61 },
  }),
);
const mediaBytes = Buffer.from("authenticated-media");
const binding = {
  schemaVersion: 1,
  recordType: "lab-canary-manual-intake-binding",
  supportClaim: false,
  candidateSha,
  release: {
    id: 71,
    tagName: "manual-evidence-intake-61",
    targetCommitish: candidateSha,
    draft: true,
    prerelease: false,
  },
  intakeManifest: {
    id: 81,
    name: "intake-manifest.json",
    size: intakeBytes.length,
    sha256: digest(intakeBytes),
    apiDigest: `sha256:${digest(intakeBytes)}`,
  },
  media: [
    {
      id: 82,
      name: "proof.png",
      releaseName: "manual-media-82",
      uploader: "tester",
      size: mediaBytes.length,
      mimeType: "image/png",
      createdAt: "2026-07-30T00:01:00Z",
      sha256: digest(mediaBytes),
      apiDigest: `sha256:${digest(mediaBytes)}`,
    },
  ],
};
const bindingBytes = Buffer.from(canonicalJson(binding));

test("fresh manual intake identity, metadata, API digests, and bytes close exactly", () => {
  assert.equal(verifyCanaryManualIntake(intakeFixture()), true);

  const changed = intakeFixture();
  changed.media[0].bytes = Buffer.from("changed-media");
  assert.throws(
    () => verifyCanaryManualIntake(changed),
    /media bytes or metadata changed/u,
  );

  const changedRetainedMedia = intakeFixture();
  changedRetainedMedia.retainedMedia[0].bytes = Buffer.alloc(
    mediaBytes.length,
    0x78,
  );
  assert.throws(
    () => verifyCanaryManualIntake(changedRetainedMedia),
    /retained release asset/u,
  );

  const extra = intakeFixture();
  extra.release.assets.push({ id: 99, name: "late.bin" });
  assert.throws(
    () => verifyCanaryManualIntake(extra),
    /identity or manifest bytes changed/u,
  );
});

test("only an explicit GitHub 404 proves resource absence", async () => {
  const input = {
    url: "https://api.github.com/repos/milos-agathon/forge3d-web/releases/tags/canary",
    token: "token",
  };
  assert.equal(
    await requireGitHubResourceAbsent({
      ...input,
      fetchImpl: async () => ({ status: 404 }),
    }),
    true,
  );
  for (const status of [200, 201, 204]) {
    await assert.rejects(
      requireGitHubResourceAbsent({
        ...input,
        fetchImpl: async () => ({ status }),
      }),
      /resource is present/u,
    );
  }
  for (const status of [403, 500, 503]) {
    await assert.rejects(
      requireGitHubResourceAbsent({
        ...input,
        fetchImpl: async () => ({ status }),
      }),
      /could not be proven/u,
    );
  }
  await assert.rejects(
    requireGitHubResourceAbsent({
      ...input,
      fetchImpl: async () => ({}),
    }),
    /malformed status/u,
  );
  await assert.rejects(
    requireGitHubResourceAbsent({
      ...input,
      fetchImpl: async () => {
        throw new Error("transport failed");
      },
    }),
    /could not be proven/u,
  );
});

test("post-publication record is non-support, immutable, paginated, and schema-valid", () => {
  const result = createLabCanaryPublicationRecord(publicationFixture());
  assertJsonSchema(
    result.record,
    JSON.parse(
      readFileSync(
        new URL("./lab-canary-publication-record.schema.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.equal(result.record.supportClaim, false);
  assert.equal(result.record.release.immutable, true);
  assert.deepEqual(result.record.publicationRun, {
    id: 42,
    attempt: 1,
    workflowPath: ".github/workflows/publish-browser-lab-canary.yml",
  });
  assert.equal(result.record.assetApiPagination.requestedPerPage, 100);
  assert.equal(result.record.intake.deletedAfterVerification, true);
  assert.equal(
    result.record.assets.some(
      (asset) =>
        asset.name === binding.media[0].releaseName &&
        asset.sha256 === binding.media[0].sha256,
    ),
    true,
  );
});

test("prepublication identity drift, incomplete pagination, API mismatch, and early deletion fail", () => {
  const wrongTag = publicationFixture();
  wrongTag.release.tag_name = "browser-lab-canary-wrong-42";
  assert.throws(
    () => createLabCanaryPublicationRecord(wrongTag),
    /post-publication proof is invalid/u,
  );

  const missingPageAsset = publicationFixture();
  const pages = JSON.parse(
    Buffer.from(missingPageAsset.assetPages.bytes).toString("utf8"),
  );
  pages[0].pop();
  missingPageAsset.assetPages.bytes = Buffer.from(JSON.stringify(pages));
  assert.throws(
    () => createLabCanaryPublicationRecord(missingPageAsset),
    /post-publication proof is invalid/u,
  );

  const apiMismatch = publicationFixture();
  apiMismatch.assets[0].apiDigest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => createLabCanaryPublicationRecord(apiMismatch),
    /asset closure failed/u,
  );

  const earlyDeletion = publicationFixture();
  earlyDeletion.intakeDeletion.deletedAt = "2026-07-30T00:09:59Z";
  assert.throws(
    () => createLabCanaryPublicationRecord(earlyDeletion),
    /post-publication proof is invalid/u,
  );

  for (const mutateRun of [
    (run) => {
      run.id = 0;
    },
    (run) => {
      run.attempt = 0;
    },
    (_run, preflight) => {
      preflight.workflow = ".github/workflows/publish-web-release.yml";
    },
  ]) {
    const driftedRun = publicationFixture();
    const driftedPreflight = JSON.parse(
      Buffer.from(driftedRun.preflight.bytes).toString("utf8"),
    );
    mutateRun(driftedPreflight.run, driftedPreflight);
    driftedRun.preflight.bytes = Buffer.from(canonicalJson(driftedPreflight));
    assert.throws(
      () => createLabCanaryPublicationRecord(driftedRun),
      /post-publication proof is invalid/u,
    );
  }

  const substitutedRetainedMedia = publicationFixture();
  const substitutedSha = digest("substituted-retained-media");
  const substitutedPreflight = JSON.parse(
    Buffer.from(substitutedRetainedMedia.preflight.bytes).toString("utf8"),
  );
  substitutedPreflight.assets.find(
    (asset) => asset.name === binding.media[0].releaseName,
  ).sha256 = substitutedSha;
  substitutedRetainedMedia.preflight.bytes = Buffer.from(
    canonicalJson(substitutedPreflight),
  );
  const substitutedPages = JSON.parse(
    Buffer.from(substitutedRetainedMedia.assetPages.bytes).toString("utf8"),
  );
  substitutedPages[0].find(
    (asset) => asset.name === binding.media[0].releaseName,
  ).digest = `sha256:${substitutedSha}`;
  substitutedRetainedMedia.assetPages.bytes = Buffer.from(
    JSON.stringify(substitutedPages),
  );
  const substitutedAsset = substitutedRetainedMedia.assets.find(
    (asset) => asset.name === binding.media[0].releaseName,
  );
  substitutedAsset.sha256 = substitutedSha;
  substitutedAsset.apiDigest = `sha256:${substitutedSha}`;
  assert.throws(
    () => createLabCanaryPublicationRecord(substitutedRetainedMedia),
    /post-publication proof is invalid/u,
  );
});

function intakeFixture() {
  const mediaMetadata = {
    id: 82,
    name: "proof.png",
    uploader: { login: "tester" },
    size: mediaBytes.length,
    content_type: "image/png",
    created_at: "2026-07-30T00:01:00Z",
    digest: `sha256:${digest(mediaBytes)}`,
  };
  const manifestMetadata = {
    id: 81,
    name: "intake-manifest.json",
    size: intakeBytes.length,
    digest: `sha256:${digest(intakeBytes)}`,
  };
  return {
    candidateSha,
    binding: structuredClone(binding),
    release: {
      id: 71,
      tag_name: "manual-evidence-intake-61",
      target_commitish: candidateSha,
      draft: true,
      prerelease: false,
      assets: [manifestMetadata, mediaMetadata],
    },
    intakeManifestMetadata: manifestMetadata,
    intakeManifest: { bytes: intakeBytes },
    media: [{ metadata: mediaMetadata, bytes: mediaBytes }],
    retainedMedia: [
      {
        name: binding.media[0].releaseName,
        bytes: mediaBytes,
      },
    ],
  };
}

function publicationFixture() {
  const preflight = {
    schemaVersion: 1,
    mode: "laboratory-canary",
    supportClaim: false,
    workflow: ".github/workflows/publish-browser-lab-canary.yml",
    run: { id: 42, attempt: 1 },
    targetSha: candidateSha,
    tag,
    readiness: { status: "LAB_CANARY_PREFLIGHT_READY" },
    assets: [
      {
        sourceId: 1,
        name: "browser-lab-canary-manifest.json",
        sha256: digest(manifestBytes),
      },
      {
        sourceId: 2,
        name: "manual-intake-binding.json",
        sha256: digest(bindingBytes),
      },
      { sourceId: 3, name: "synthetic.json", sha256: digest("synthetic") },
      {
        sourceId: 4,
        name: binding.media[0].releaseName,
        sha256: binding.media[0].sha256,
      },
    ],
  };
  const preflightBytes = Buffer.from(canonicalJson(preflight));
  const expected = [
    ["browser-lab-canary-manifest.json", digest(manifestBytes), manifestBytes.length],
    ["manual-intake-binding.json", digest(bindingBytes), bindingBytes.length],
    ["synthetic.json", digest("synthetic"), Buffer.byteLength("synthetic")],
    [binding.media[0].releaseName, binding.media[0].sha256, mediaBytes.length],
  ];
  const apiAssets = expected.map(([name, sha256, size], index) => ({
    id: 100 + index,
    name,
    size,
    digest: `sha256:${sha256}`,
  }));
  const assets = apiAssets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    size: asset.size,
    apiDigest: asset.digest,
    sha256: asset.digest.slice("sha256:".length),
  }));
  return {
    candidate: { bytes: manifestBytes },
    preflight: { bytes: preflightBytes },
    intakeBinding: { bytes: bindingBytes },
    release: {
      id: 90,
      tag_name: tag,
      target_commitish: candidateSha,
      draft: false,
      prerelease: false,
      immutable: true,
      published_at: "2026-07-30T00:09:00Z",
    },
    assetPages: { bytes: Buffer.from(JSON.stringify([apiAssets])) },
    assets,
    releaseVerification: { bytes: Buffer.from('{"verified":true}\n') },
    assetVerifications: assets.map((asset) => ({
      name: asset.name,
      bytes: Buffer.from(`{"asset":"${asset.name}","verified":true}\n`),
    })),
    intakeDeletion: {
      releaseId: 71,
      tagName: "manual-evidence-intake-61",
      deletedAfterVerification: true,
      deletedAt: "2026-07-30T00:11:00Z",
    },
    verifiedAt: "2026-07-30T00:10:00Z",
    createdAt: new Date("2026-07-30T00:12:00Z"),
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
