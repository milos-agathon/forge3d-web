import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";
import { assertJsonSchema } from "../tests/browser/json-schema-validator.mjs";
import { selectIndependentEnvironmentApprovals } from "./environment-approval.mjs";

const manualEvidenceSchema = readJson(
  new URL("../tests/infrastructure/manual-evidence.schema.json", import.meta.url),
);
const manualEvidenceIntakeSchema = readJson(
  new URL(
    "../tests/infrastructure/manual-evidence-intake.schema.json",
    import.meta.url,
  ),
);
const manualMediaSourcesSchema = readJson(
  new URL(
    "../tests/infrastructure/manual-media-sources.schema.json",
    import.meta.url,
  ),
);
const releaseCandidateSchema = readJson(
  new URL(
    "../tests/infrastructure/browser-release-manifest.schema.json",
    import.meta.url,
  ),
);
const releasePublicationSchema = readJson(
  new URL(
    "../tests/infrastructure/browser-release-publication-record.schema.json",
    import.meta.url,
  ),
);
const publicationPreflightSchema = readJson(
  new URL(
    "../tests/infrastructure/release-publication-preflight.schema.json",
    import.meta.url,
  ),
);

export async function assertGitHubResourceAbsent({
  apiBase = "https://api.github.com",
  repository,
  resourcePath,
  token,
  fetchImpl = fetch,
}) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") ||
    !resourcePath ||
    resourcePath.startsWith("/") ||
    resourcePath.includes("..") ||
    typeof token !== "string" ||
    token.length < 1
  ) {
    throw new Error("GitHub resource absence probe input is invalid");
  }
  let response;
  try {
    response = await fetchImpl(
      `${apiBase.replace(/\/$/u, "")}/repos/${repository}/${resourcePath}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
  } catch (cause) {
    throw new Error("GitHub resource absence probe transport failed", { cause });
  }
  if (!Number.isInteger(response?.status)) {
    throw new Error("GitHub resource absence probe returned a malformed status");
  }
  if (response.status === 404) return true;
  if (response.status >= 200 && response.status < 300) {
    throw new Error(
      `GitHub resource is present; absence probe returned HTTP ${response.status}`,
    );
  }
  throw new Error(
    `GitHub resource absence is not proven; probe returned HTTP ${response.status}`,
  );
}

export function validateReleaseCandidate({
  targetSha,
  tag,
  packageVersion,
  readiness,
  repositorySettings,
  existingRelease,
  existingTag,
  repositoryTrust,
}) {
  if (
    !/^[0-9a-f]{40}$/u.test(targetSha ?? "") ||
    tag !== `v${packageVersion}` ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(
      packageVersion ?? "",
    ) ||
    readiness.status !== "RELEASE_MATRIX_READY" ||
    readiness.supportClaim !== true ||
    readiness.targetSha !== targetSha ||
    repositoryTrust.verified !== true ||
    repositoryTrust.targetSha !== targetSha ||
    repositoryTrust.currentMainSha !== targetSha ||
    repositorySettings.immutableReleases !== true ||
    existingRelease !== null ||
    existingTag !== null
  ) {
    throw new Error("supported release candidate is not publication-safe");
  }
  return true;
}

export function validateCanaryCandidate({
  candidateSha,
  publicationRunId,
  labInfrastructureDigest,
  repositorySettings,
  existingRelease,
  existingTag,
  repositoryTrust,
}) {
  const tag = `browser-lab-canary-${labInfrastructureDigest}-${publicationRunId}`;
  if (
    !/^[0-9a-f]{40}$/u.test(candidateSha ?? "") ||
    !/^[0-9a-f]{64}$/u.test(labInfrastructureDigest ?? "") ||
    !Number.isInteger(publicationRunId) ||
    publicationRunId < 1 ||
    repositoryTrust.verified !== true ||
    repositoryTrust.targetSha !== candidateSha ||
    repositoryTrust.currentMainSha !== candidateSha ||
    repositorySettings.immutableReleases !== true ||
    existingRelease !== null ||
    existingTag !== null
  ) {
    throw new Error("laboratory canary candidate is not publication-safe");
  }
  return { tag, supportClaim: false };
}

export function validateIndependentPublisher({
  actor,
  implementationActors,
  approvals,
  environment = "forge3d-web-release",
}) {
  const approved = selectIndependentEnvironmentApprovals({
    actor,
    implementationActors,
    approvals,
    environment,
  });
  return approved.map((approval) => ({
    id: approval.user.id,
    login: approval.user.login,
    environment: approval.environment,
  }));
}

export function validateManualMediaIntake({
  targetSha,
  evidenceArtifactId,
  evidence,
  intake,
  intakeRelease,
  intakeManifestAssetId,
  attestedIntakeBytes,
  currentIntakeBytes,
  mediaMetadata,
  attestedMediaBytes,
  currentMediaBytes,
}) {
  assertJsonSchema(evidence, manualEvidenceSchema);
  assertJsonSchema(intake, manualEvidenceIntakeSchema);
  const intakeManifestAsset = intakeRelease.assets?.find(
    (asset) => asset.id === intakeManifestAssetId,
  );
  const expectedTag = `manual-evidence-intake-${intake.prepareRun.id}`;
  const expectedIds = [intakeManifestAssetId, ...evidence.media.map((asset) => asset.id)]
    .sort((left, right) => left - right);
  const actualIds = (intakeRelease.assets ?? [])
    .map((asset) => asset.id)
    .sort((left, right) => left - right);
  const intakeDigest = sha256Hex(currentIntakeBytes);
  let currentIntake;
  try {
    currentIntake = JSON.parse(Buffer.from(currentIntakeBytes).toString("utf8"));
  } catch {
    throw new Error("current intake manifest is not JSON");
  }
  if (
    !Number.isInteger(evidenceArtifactId) ||
    evidenceArtifactId < 1 ||
    evidence.trustedSha !== targetSha ||
    intake.trustedSha !== targetSha ||
    evidence.intakeReleaseId !== intakeRelease.id ||
    intakeRelease.tag_name !== expectedTag ||
    intakeRelease.target_commitish !== targetSha ||
    intakeRelease.draft !== true ||
    intakeRelease.prerelease !== false ||
    intakeManifestAsset?.name !== "intake-manifest.json" ||
    intakeManifestAsset?.digest !== `sha256:${intakeDigest}` ||
    !Buffer.from(attestedIntakeBytes).equals(Buffer.from(currentIntakeBytes)) ||
    canonicalJson(currentIntake) !== canonicalJson(intake) ||
    expectedIds.length !== actualIds.length ||
    expectedIds.some((id, index) => id !== actualIds[index]) ||
    new Set(evidence.media.map((asset) => asset.id)).size !== evidence.media.length
  ) {
    throw new Error("manual intake release, manifest, or closed inventory is invalid");
  }

  const metadataById = new Map(mediaMetadata.map((asset) => [asset.id, asset]));
  if (
    mediaMetadata.length !== evidence.media.length ||
    metadataById.size !== evidence.media.length
  ) {
    throw new Error("manual media metadata is not the exact selected set");
  }
  const media = evidence.media.map((expected) => {
    const releaseAsset = intakeRelease.assets.find(
      (asset) => asset.id === expected.id,
    );
    const metadata = metadataById.get(expected.id);
    const attestedBytes = Buffer.from(attestedMediaBytes[String(expected.id)] ?? []);
    const currentBytes = Buffer.from(currentMediaBytes[String(expected.id)] ?? []);
    const finalName = `manual-media-${intakeRelease.id}-${expected.id}-${expected.name}`;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(expected.name) ||
      !releaseAsset ||
      !metadata ||
      metadata.id !== expected.id ||
      metadata.name !== expected.name ||
      metadata.uploader?.login !== expected.uploader ||
      metadata.size !== expected.size ||
      metadata.content_type !== expected.mimeType ||
      metadata.created_at !== expected.createdAt ||
      metadata.digest !== `sha256:${expected.apiSha256}` ||
      expected.apiSha256 !== expected.sha256 ||
      releaseAsset.name !== metadata.name ||
      releaseAsset.uploader?.login !== metadata.uploader.login ||
      releaseAsset.size !== metadata.size ||
      releaseAsset.content_type !== metadata.content_type ||
      releaseAsset.created_at !== metadata.created_at ||
      releaseAsset.digest !== metadata.digest ||
      currentBytes.length !== expected.size ||
      sha256Hex(currentBytes) !== expected.sha256 ||
      !attestedBytes.equals(currentBytes)
    ) {
      throw new Error(`manual media asset is missing, swapped, or overwritten: ${expected.id}`);
    }
    return {
      assetId: expected.id,
      originalName: expected.name,
      finalName,
      uploader: expected.uploader,
      size: expected.size,
      mimeType: expected.mimeType,
      createdAt: expected.createdAt,
      apiSha256: expected.apiSha256,
      sha256: expected.sha256,
    };
  });
  return {
    evidenceArtifactId,
    releaseId: intakeRelease.id,
    tagName: expectedTag,
    targetCommitish: targetSha,
    draft: true,
    intakeManifest: {
      assetId: intakeManifestAssetId,
      sha256: intakeDigest,
    },
    media: media.sort((left, right) => left.assetId - right.assetId),
  };
}

export function createManualMediaSourcePlan({ targetSha, intakes }) {
  const plan = {
    schemaVersion: 1,
    targetSha,
    intakes: [...intakes].sort((left, right) => left.releaseId - right.releaseId),
  };
  if (
    !/^[0-9a-f]{40}$/u.test(targetSha ?? "") ||
    plan.intakes.length < 1 ||
    new Set(plan.intakes.map((entry) => entry.releaseId)).size !==
      plan.intakes.length ||
    plan.intakes.some(
      (entry) => entry.targetCommitish !== targetSha || entry.draft !== true,
    ) ||
    new Set(plan.intakes.flatMap((entry) => entry.media.map((asset) => asset.finalName)))
      .size !== plan.intakes.flatMap((entry) => entry.media).length
  ) {
    throw new Error("manual media source plan is not a closed unique set");
  }
  assertJsonSchema(plan, manualMediaSourcesSchema);
  return { record: plan, canonical: canonicalJson(plan), sha256: sha256Hex(plan) };
}

export function createBrowserReleaseCandidate({
  targetSha,
  tag,
  readiness,
  assets,
  manualMediaPlanSha256,
  createdAt = new Date(),
}) {
  const candidate = {
    schemaVersion: 1,
    recordType: "browser-release-candidate",
    supportClaim: true,
    targetSha,
    tag,
    readiness: {
      runId: readiness.runId,
      sha256: readiness.sha256,
    },
    manualMediaPlanSha256,
    assets: [...assets]
      .map(({ name, sha256 }) => ({ name, sha256 }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    createdAt: new Date(createdAt).toISOString(),
  };
  if (
    new Set(candidate.assets.map((asset) => asset.name)).size !==
      candidate.assets.length ||
    candidate.assets.some((asset) => asset.name === "browser-release-manifest.json")
  ) {
    throw new Error("release candidate asset names are not unique");
  }
  assertJsonSchema(candidate, releaseCandidateSchema);
  return {
    record: candidate,
    canonical: canonicalJson(candidate),
    sha256: sha256Hex(candidate),
  };
}

export function createReleasePublicationRecord({
  candidate,
  candidateSha256,
  manualMediaPlan,
  publicationRun,
  release,
  assets,
  releaseVerification,
  assetVerifications,
  intakeDeletions,
  verifiedAt,
  createdAt = new Date(),
}) {
  assertJsonSchema(candidate, releaseCandidateSchema);
  assertJsonSchema(manualMediaPlan, manualMediaSourcesSchema);
  const normalizedReleaseVerification = normalizeVerificationProof(
    releaseVerification,
  );
  const normalizedAssetVerifications = assetVerifications.map((proof) => ({
    name: proof.name,
    ...normalizeVerificationProof(proof),
  }));
  const expectedAssetDigests = new Map(
    candidate.assets.map((asset) => [asset.name, asset.sha256]),
  );
  expectedAssetDigests.set("browser-release-manifest.json", candidateSha256);
  const actualAssetNames = assets.map((asset) => asset.name).sort();
  const expectedAssetNames = [...expectedAssetDigests.keys()].sort();
  const proofNames = normalizedAssetVerifications
    .map((proof) => proof.name)
    .sort();
  const expectedIntakes = manualMediaPlan.intakes
    .map(({ releaseId, tagName }) => ({ releaseId, tagName }))
    .sort((left, right) => left.releaseId - right.releaseId);
  const actualIntakes = intakeDeletions
    .map(({ releaseId, tagName }) => ({ releaseId, tagName }))
    .sort((left, right) => left.releaseId - right.releaseId);
  const verified = new Date(verifiedAt);
  const published = new Date(release.published_at);
  const created = new Date(createdAt);
  if (
    !/^[0-9a-f]{64}$/u.test(candidateSha256 ?? "") ||
    sha256Hex(candidate) !== candidateSha256 ||
    sha256Hex(manualMediaPlan) !== candidate.manualMediaPlanSha256 ||
    manualMediaPlan.targetSha !== candidate.targetSha ||
    !Number.isInteger(publicationRun?.id) ||
    publicationRun.id < 1 ||
    !Number.isInteger(publicationRun?.attempt) ||
    publicationRun.attempt < 1 ||
    publicationRun.workflowPath !== ".github/workflows/publish-web-release.yml" ||
    release.tag_name !== candidate.tag ||
    release.target_commitish !== candidate.targetSha ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.immutable !== true ||
    !Number.isInteger(release.id) ||
    release.id < 1 ||
    Number.isNaN(published.getTime()) ||
    Number.isNaN(verified.getTime()) ||
    Number.isNaN(created.getTime()) ||
    published > verified ||
    verified > created ||
    actualAssetNames.length !== expectedAssetNames.length ||
    actualAssetNames.some((name, index) => name !== expectedAssetNames[index]) ||
    proofNames.length !== expectedAssetNames.length ||
    proofNames.some((name, index) => name !== expectedAssetNames[index]) ||
    !isNonEmptyJsonObject(normalizedReleaseVerification.output) ||
    !/^[0-9a-f]{64}$/u.test(normalizedReleaseVerification.outputSha256 ?? "") ||
    new Set(normalizedAssetVerifications.map((proof) => proof.name)).size !==
      normalizedAssetVerifications.length ||
    normalizedAssetVerifications.some(
      (proof) =>
        !isNonEmptyJsonObject(proof.output) ||
        !/^[0-9a-f]{64}$/u.test(proof.outputSha256 ?? ""),
    ) ||
    actualIntakes.length !== expectedIntakes.length ||
    actualIntakes.some(
      (intake, index) =>
        intake.releaseId !== expectedIntakes[index].releaseId ||
        intake.tagName !== expectedIntakes[index].tagName,
    ) ||
    intakeDeletions.some(
      (deletion) =>
        deletion.deletedAfterVerification !== true ||
        Number.isNaN(new Date(deletion.deletedAt).getTime()) ||
        new Date(deletion.deletedAt) < verified ||
        new Date(deletion.deletedAt) > created,
    )
  ) {
    throw new Error("post-publication release identity or verification proof is invalid");
  }
  const normalizedAssets = assets
    .map((asset) => {
      const expectedSha256 = expectedAssetDigests.get(asset.name);
      if (
        !Number.isInteger(asset.id) ||
        asset.id < 1 ||
        !Number.isInteger(asset.size) ||
        asset.size < 1 ||
        asset.sha256 !== expectedSha256 ||
        asset.apiDigest !== `sha256:${asset.sha256}`
      ) {
        throw new Error(`published asset digest or identity mismatch: ${asset.name}`);
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
    recordType: "browser-release-publication",
    supportClaim: true,
    targetSha: candidate.targetSha,
    tag: candidate.tag,
    candidateSha256,
    publicationRun: {
      id: publicationRun.id,
      attempt: publicationRun.attempt,
      workflowPath: publicationRun.workflowPath,
    },
    release: {
      id: release.id,
      tagName: release.tag_name,
      targetCommitish: release.target_commitish,
      draft: false,
      prerelease: false,
      immutable: true,
      publishedAt: release.published_at,
    },
    assets: normalizedAssets,
    releaseVerification: normalizedReleaseVerification,
    assetVerifications: sortedAssetVerifications,
    verificationBundleSha256: sha256Hex(proofDigests),
    verifiedAt: verified.toISOString(),
    intakes: [...intakeDeletions]
      .map((deletion) => ({
        releaseId: deletion.releaseId,
        tagName: deletion.tagName,
        deletedAfterVerification: true,
        deletedAt: new Date(deletion.deletedAt).toISOString(),
      }))
      .sort((left, right) => left.releaseId - right.releaseId),
    createdAt: new Date(createdAt).toISOString(),
  };
  assertJsonSchema(record, releasePublicationSchema);
  return { record, canonical: canonicalJson(record), sha256: sha256Hex(record) };
}

export function createPublicationPreflight({
  mode,
  supportClaim,
  targetSha,
  tag,
  readiness,
  assets,
  observation,
  run,
  workflowSha,
  publisher,
  implementationActors,
  createdAt = new Date(),
}) {
  if (
    !["supported-release", "laboratory-canary"].includes(mode) ||
    supportClaim !== (mode === "supported-release") ||
    !/^[0-9a-f]{40}$/u.test(targetSha ?? "") ||
    !Array.isArray(assets) ||
    assets.length < 1 ||
    assets.some(
      (asset) =>
        !Number.isInteger(asset.sourceId) ||
        asset.sourceId < 1 ||
        !/^[0-9a-f]{64}$/u.test(asset.sha256 ?? "") ||
        !asset.name,
    ) ||
    new Set(assets.map((asset) => asset.name)).size !== assets.length
  ) {
    throw new Error("publication preflight asset set is invalid");
  }
  if (!publisher.actor || implementationActors.includes(publisher.actor)) {
    throw new Error("publication actor must be independent of implementation");
  }
  const record = {
    schemaVersion: 1,
    mode,
    supportClaim,
    repository: "milos-agathon/forge3d-web",
    workflow: run.workflow,
    workflowSha,
    run: { id: run.id, attempt: run.attempt },
    targetSha,
    tag,
    readiness: {
      runId: readiness.runId,
      artifactId: readiness.artifactId,
      sha256: readiness.sha256,
      status: readiness.status,
    },
    observation: {
      artifactId: observation.artifactId,
      artifactName: observation.artifactName,
      artifactDigest: observation.artifactDigest,
      contentSha256: observation.contentSha256,
    },
    assets: [...assets].sort((left, right) => left.name.localeCompare(right.name)),
    publisher: {
      job: publisher.job,
      environment: "forge3d-web-release",
      actor: publisher.actor,
      approvers: [],
    },
    implementationActors: [...implementationActors].sort(),
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(
      new Date(createdAt).getTime() + 30 * 60 * 1000,
    ).toISOString(),
  };
  assertJsonSchema(record, publicationPreflightSchema);
  return {
    record,
    canonical: canonicalJson(record),
    sha256: sha256Hex(record),
  };
}

export function verifyPublicationHandoff({
  preflight,
  expected,
  now = new Date(),
}) {
  assertJsonSchema(preflight, publicationPreflightSchema);
  const createdAt = new Date(preflight.createdAt);
  const expiresAt = new Date(preflight.expiresAt);
  const checkedAt = new Date(now);
  if (
    preflight.mode !== expected.mode ||
    preflight.supportClaim !== expected.supportClaim ||
    preflight.repository !== expected.repository ||
    preflight.workflowSha !== expected.workflowSha ||
    preflight.run.id !== expected.runId ||
    preflight.run.attempt !== expected.runAttempt ||
    preflight.targetSha !== expected.targetSha ||
    preflight.tag !== expected.tag ||
    preflight.publisher.job !== expected.publisherJob ||
    preflight.publisher.environment !== "forge3d-web-release" ||
    canonicalJson(preflight.readiness) !== canonicalJson(expected.readiness) ||
    canonicalJson(preflight.assets) !== canonicalJson(expected.assets) ||
    preflight.observation.artifactId !== expected.observationArtifactId ||
    preflight.observation.artifactName !== expected.observationArtifactName ||
    preflight.observation.artifactDigest !==
      expected.observationArtifactDigest ||
    preflight.observation.contentSha256 !== expected.observationContentSha256 ||
    sha256Hex(preflight) !== expected.preflightSha256 ||
    Number.isNaN(createdAt.getTime()) ||
    Number.isNaN(expiresAt.getTime()) ||
    Number.isNaN(checkedAt.getTime()) ||
    expiresAt <= createdAt ||
    expiresAt.getTime() - createdAt.getTime() > 30 * 60 * 1000 ||
    checkedAt < createdAt ||
    checkedAt >= expiresAt
  ) {
    throw new Error("publication preflight handoff is missing, stale, or mismatched");
  }
  return preflight;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const operation = process.argv[3];
  const result =
    operation === "create-preflight"
      ? createPublicationPreflight(input)
      : operation === "verify-handoff"
        ? verifyPublicationHandoff(input)
        : operation === "validate-release"
          ? validateReleaseCandidate(input)
          : operation === "validate-canary"
            ? validateCanaryCandidate(input)
            : operation === "create-candidate"
              ? createBrowserReleaseCandidate(input)
              : operation === "create-publication-record"
                ? createReleasePublicationRecord(input)
            : null;
  if (result === null) throw new Error("unknown release-publication operation");
  if (process.argv[4]) {
    writeFileSync(
      process.argv[4],
      `${result.canonical ?? canonicalJson(result)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  console.log(JSON.stringify({ ok: true, operation }));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isNonEmptyJsonObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

function normalizeVerificationProof(proof) {
  if (proof?.path) {
    const bytes = readFileSync(proof.path);
    const output = JSON.parse(bytes.toString("utf8"));
    return { outputSha256: sha256Hex(bytes), output };
  }
  if (proof?.bytes !== undefined) {
    const bytes = Buffer.from(proof.bytes);
    const output = JSON.parse(bytes.toString("utf8"));
    return { outputSha256: sha256Hex(bytes), output };
  }
  return { outputSha256: proof?.outputSha256, output: proof?.output };
}
