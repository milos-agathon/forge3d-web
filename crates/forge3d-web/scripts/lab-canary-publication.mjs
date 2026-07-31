import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";
import { assertJsonSchema } from "../tests/browser/json-schema-validator.mjs";

const publicationSchema = JSON.parse(
  readFileSync(
    new URL(
      "../tests/infrastructure/lab-canary-publication-record.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export async function requireGitHubResourceAbsent({
  url,
  token,
  fetchImpl = fetch,
}) {
  if (
    typeof url !== "string" ||
    !url.startsWith("https://api.github.com/repos/") ||
    typeof token !== "string" ||
    token.length < 1
  ) {
    throw new Error("GitHub absence probe input is invalid");
  }
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (cause) {
    throw new Error("GitHub resource absence could not be proven", { cause });
  }
  if (!Number.isInteger(response?.status)) {
    throw new Error("GitHub resource absence returned a malformed status");
  }
  if (response.status === 404) return true;
  if (response.status >= 200 && response.status <= 299) {
    throw new Error(`GitHub resource is present: HTTP ${response.status}`);
  }
  throw new Error(
    `GitHub resource absence could not be proven: HTTP ${response.status}`,
  );
}

export function verifyCanaryManualIntake({
  candidateSha,
  binding,
  release,
  intakeManifestMetadata,
  intakeManifest,
  media,
  retainedMedia,
}) {
  const manifestBytes = resolveBytes(intakeManifest);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const expectedAssets = [binding.intakeManifest, ...binding.media].sort(
    (left, right) => left.id - right.id,
  );
  const releaseAssets = [...(release.assets ?? [])].sort(
    (left, right) => left.id - right.id,
  );
  const manifestReleaseAsset = release.assets?.find(
    (asset) => asset.id === binding.intakeManifest.id,
  );
  if (
    !/^[0-9a-f]{40}$/u.test(candidateSha ?? "") ||
    binding.schemaVersion !== 1 ||
    binding.recordType !== "lab-canary-manual-intake-binding" ||
    binding.supportClaim !== false ||
    binding.candidateSha !== candidateSha ||
    release.id !== binding.release.id ||
    release.tag_name !== binding.release.tagName ||
    release.target_commitish !== candidateSha ||
    release.draft !== true ||
    release.prerelease !== false ||
    expectedAssets.length !== releaseAssets.length ||
    expectedAssets.some((asset, index) => asset.id !== releaseAssets[index].id) ||
    intakeManifestMetadata.id !== binding.intakeManifest.id ||
    intakeManifestMetadata.name !== binding.intakeManifest.name ||
    intakeManifestMetadata.size !== binding.intakeManifest.size ||
    intakeManifestMetadata.digest !== binding.intakeManifest.apiDigest ||
    manifestReleaseAsset?.name !== intakeManifestMetadata.name ||
    manifestReleaseAsset?.size !== intakeManifestMetadata.size ||
    manifestReleaseAsset?.digest !== intakeManifestMetadata.digest ||
    manifestBytes.length !== binding.intakeManifest.size ||
    sha256Hex(manifestBytes) !== binding.intakeManifest.sha256 ||
    manifest.trustedSha !== candidateSha ||
    manifest.supportClaim !== false ||
    `manual-evidence-intake-${manifest.prepareRun?.id}` !== binding.release.tagName ||
    !Array.isArray(media) ||
    !Array.isArray(retainedMedia) ||
    media.length !== binding.media.length
  ) {
    throw new Error("manual canary intake identity or manifest bytes changed");
  }

  const actualMedia = new Map(media.map((asset) => [asset.metadata.id, asset]));
  const retainedMediaByName = new Map(
    retainedMedia.map((asset) => [asset.name, asset]),
  );
  if (
    actualMedia.size !== binding.media.length ||
    retainedMedia.length !== binding.media.length ||
    retainedMediaByName.size !== binding.media.length
  ) {
    throw new Error("manual canary media inventory changed");
  }
  for (const expected of binding.media) {
    const actual = actualMedia.get(expected.id);
    const retained = retainedMediaByName.get(expected.releaseName);
    const releaseAsset = release.assets.find((asset) => asset.id === expected.id);
    if (!actual || !releaseAsset || !retained) {
      throw new Error(`manual canary media is missing: ${expected.id}`);
    }
    const bytes = resolveBytes(actual.bytes);
    const retainedBytes = resolveBytes(retained.bytes);
    if (
      expected.releaseName !== `manual-media-${expected.id}` ||
      retained.name !== expected.releaseName ||
      actual.metadata.id !== expected.id ||
      actual.metadata.name !== expected.name ||
      actual.metadata.uploader?.login !== expected.uploader ||
      actual.metadata.size !== expected.size ||
      actual.metadata.content_type !== expected.mimeType ||
      actual.metadata.created_at !== expected.createdAt ||
      actual.metadata.digest !== expected.apiDigest ||
      releaseAsset.name !== actual.metadata.name ||
      releaseAsset.uploader?.login !== actual.metadata.uploader.login ||
      releaseAsset.size !== actual.metadata.size ||
      releaseAsset.content_type !== actual.metadata.content_type ||
      releaseAsset.created_at !== actual.metadata.created_at ||
      releaseAsset.digest !== actual.metadata.digest ||
      bytes.length !== expected.size ||
      sha256Hex(bytes) !== expected.sha256 ||
      retainedBytes.length !== expected.size ||
      sha256Hex(retainedBytes) !== expected.sha256 ||
      expected.apiDigest !== `sha256:${expected.sha256}`
    ) {
      throw new Error(
        `manual canary media bytes or metadata changed, including retained release asset: ${expected.id}`,
      );
    }
  }
  return true;
}

export function createLabCanaryPublicationRecord({
  candidate,
  preflight,
  intakeBinding,
  release,
  assetPages,
  assets,
  releaseVerification,
  assetVerifications,
  intakeDeletion,
  verifiedAt,
  createdAt = new Date(),
}) {
  const candidateDocument = resolveJsonDocument(candidate);
  const preflightDocument = resolveJsonDocument(preflight);
  const bindingDocument = resolveJsonDocument(intakeBinding);
  const pagesDocument = resolveJsonDocument(assetPages);
  const normalizedReleaseVerification = normalizeVerificationProof(
    releaseVerification,
  );
  const normalizedAssetVerifications = assetVerifications.map((proof) => ({
    name: proof.name,
    ...normalizeVerificationProof(proof),
  }));
  const candidateRecord = candidateDocument.output;
  const preflightRecord = preflightDocument.output;
  const binding = bindingDocument.output;
  const pages = pagesDocument.output;
  const expectedTag = `browser-lab-canary-${candidateRecord.labInfrastructureDigest}-${candidateRecord.publicationRunId}`;
  const expectedAssets = new Map(
    preflightRecord.assets.map((asset) => [asset.name, asset.sha256]),
  );
  const pageAssets = pages.flat();
  const expectedNames = [...expectedAssets.keys()].sort();
  const pageNames = pageAssets.map((asset) => asset.name).sort();
  const assetNames = assets.map((asset) => asset.name).sort();
  const proofNames = normalizedAssetVerifications
    .map((proof) => proof.name)
    .sort();
  const published = new Date(release.published_at);
  const verified = new Date(verifiedAt);
  const deleted = new Date(intakeDeletion.deletedAt);
  const created = new Date(createdAt);
  if (
    candidateRecord.schemaVersion !== 1 ||
    candidateRecord.recordType !== "lab-canary-publication-candidate" ||
    candidateRecord.supportClaim !== false ||
    candidateRecord.intakeDeletionPlannedAfterVerification !== true ||
    candidateRecord.tag !== expectedTag ||
    candidateRecord.candidateSha !== preflightRecord.targetSha ||
    candidateRecord.publicationRunId !== preflightRecord.run.id ||
    !Number.isInteger(preflightRecord.run.attempt) ||
    preflightRecord.run.attempt < 1 ||
    preflightRecord.workflow !==
      ".github/workflows/publish-browser-lab-canary.yml" ||
    candidateRecord.manualIntakeReleaseId !== binding.release.id ||
    preflightRecord.mode !== "laboratory-canary" ||
    preflightRecord.supportClaim !== false ||
    preflightRecord.tag !== expectedTag ||
    preflightRecord.readiness.status !== "LAB_CANARY_PREFLIGHT_READY" ||
    expectedAssets.get("browser-lab-canary-manifest.json") !==
      candidateDocument.sha256 ||
    expectedAssets.get("manual-intake-binding.json") !== bindingDocument.sha256 ||
    binding.candidateSha !== candidateRecord.candidateSha ||
    binding.schemaVersion !== 1 ||
    binding.recordType !== "lab-canary-manual-intake-binding" ||
    binding.supportClaim !== false ||
    binding.release.targetCommitish !== candidateRecord.candidateSha ||
    binding.release.draft !== true ||
    binding.release.prerelease !== false ||
    !Array.isArray(binding.media) ||
    binding.media.length < 1 ||
    new Set(binding.media.map((asset) => asset.releaseName)).size !==
      binding.media.length ||
    binding.media.some(
      (asset) =>
        asset.releaseName !== `manual-media-${asset.id}` ||
        expectedAssets.get(asset.releaseName) !== asset.sha256 ||
        assets.find((publishedAsset) => publishedAsset.name === asset.releaseName)
          ?.size !== asset.size,
    ) ||
    release.tag_name !== expectedTag ||
    release.target_commitish !== candidateRecord.candidateSha ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.immutable !== true ||
    !Number.isInteger(release.id) ||
    release.id < 1 ||
    !Array.isArray(pages) ||
    pages.length < 1 ||
    pages.some(
      (page, index) =>
        !Array.isArray(page) ||
        page.length < 1 ||
        page.length > 100 ||
        (index < pages.length - 1 && page.length !== 100),
    ) ||
    new Set(pageAssets.map((asset) => asset.id)).size !== pageAssets.length ||
    new Set(pageAssets.map((asset) => asset.name)).size !== pageAssets.length ||
    expectedNames.length !== pageNames.length ||
    expectedNames.some((name, index) => name !== pageNames[index]) ||
    expectedNames.length !== assetNames.length ||
    expectedNames.some((name, index) => name !== assetNames[index]) ||
    expectedNames.length !== proofNames.length ||
    expectedNames.some((name, index) => name !== proofNames[index]) ||
    !isNonEmptyJsonObject(normalizedReleaseVerification.output) ||
    normalizedAssetVerifications.some(
      (proof) => !isNonEmptyJsonObject(proof.output),
    ) ||
    Number.isNaN(published.getTime()) ||
    Number.isNaN(verified.getTime()) ||
    Number.isNaN(deleted.getTime()) ||
    Number.isNaN(created.getTime()) ||
    published > verified ||
    verified > deleted ||
    deleted > created ||
    intakeDeletion.releaseId !== binding.release.id ||
    intakeDeletion.tagName !== binding.release.tagName ||
    intakeDeletion.deletedAfterVerification !== true
  ) {
    throw new Error("laboratory canary post-publication proof is invalid");
  }

  const normalizedAssets = assets
    .map((asset) => {
      const expectedSha256 = expectedAssets.get(asset.name);
      const apiAsset = pageAssets.find((value) => value.id === asset.id);
      if (
        !Number.isInteger(asset.id) ||
        asset.id < 1 ||
        !Number.isInteger(asset.size) ||
        asset.size < 1 ||
        asset.sha256 !== expectedSha256 ||
        asset.apiDigest !== `sha256:${expectedSha256}` ||
        apiAsset?.name !== asset.name ||
        apiAsset?.size !== asset.size ||
        apiAsset?.digest !== asset.apiDigest
      ) {
        throw new Error(`published canary asset closure failed: ${asset.name}`);
      }
      return {
        id: asset.id,
        name: asset.name,
        size: asset.size,
        apiDigest: asset.apiDigest,
        sha256: asset.sha256,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const sortedAssetVerifications = [...normalizedAssetVerifications].sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const proofDigests = [
    { name: "release", sha256: normalizedReleaseVerification.outputSha256 },
    ...sortedAssetVerifications.map((proof) => ({
      name: proof.name,
      sha256: proof.outputSha256,
    })),
  ];
  const record = {
    schemaVersion: 1,
    recordType: "lab-canary-publication",
    supportClaim: false,
    candidateSha: candidateRecord.candidateSha,
    labInfrastructureDigest: candidateRecord.labInfrastructureDigest,
    publicationRunId: candidateRecord.publicationRunId,
    publicationRun: {
      id: preflightRecord.run.id,
      attempt: preflightRecord.run.attempt,
      workflowPath: preflightRecord.workflow,
    },
    tag: expectedTag,
    candidateManifestSha256: candidateDocument.sha256,
    preflightSha256: preflightDocument.sha256,
    release: {
      id: release.id,
      tagName: release.tag_name,
      targetCommitish: release.target_commitish,
      draft: false,
      prerelease: false,
      immutable: true,
      publishedAt: new Date(release.published_at).toISOString(),
    },
    assetApiPagination: {
      requestedPerPage: 100,
      pageCount: pages.length,
      totalAssets: pageAssets.length,
      pagesSha256: pagesDocument.sha256,
    },
    assets: normalizedAssets,
    releaseVerification: normalizedReleaseVerification,
    assetVerifications: sortedAssetVerifications,
    verificationBundleSha256: sha256Hex(proofDigests),
    verifiedAt: verified.toISOString(),
    intake: {
      releaseId: intakeDeletion.releaseId,
      tagName: intakeDeletion.tagName,
      bindingSha256: bindingDocument.sha256,
      deletedAfterVerification: true,
      deletedAt: deleted.toISOString(),
    },
    createdAt: created.toISOString(),
  };
  assertJsonSchema(record, publicationSchema);
  return { record, canonical: canonicalJson(record), sha256: sha256Hex(record) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const operation = process.argv[3];
  const result =
    operation === "verify-intake"
      ? verifyCanaryManualIntake(input)
      : operation === "create-publication-record"
        ? createLabCanaryPublicationRecord(input)
        : null;
  if (result === null) throw new Error("unknown lab-canary publication operation");
  if (process.argv[4]) {
    const output = result.canonical ?? canonicalJson({ verified: result });
    writeFileSync(process.argv[4], `${output}\n`, { encoding: "utf8", mode: 0o600 });
  }
  console.log(JSON.stringify({ ok: true, operation }));
}

function resolveBytes(value) {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return Buffer.from(value);
  if (value?.path) return readFileSync(value.path);
  if (value?.bytes !== undefined) return Buffer.from(value.bytes);
  throw new Error("byte source is missing");
}

function resolveJsonDocument(value) {
  const bytes = resolveBytes(value);
  const output = JSON.parse(bytes.toString("utf8"));
  return { output, sha256: sha256Hex(bytes) };
}

function normalizeVerificationProof(proof) {
  const document = resolveJsonDocument(proof);
  return { outputSha256: document.sha256, output: document.output };
}

function isNonEmptyJsonObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}
