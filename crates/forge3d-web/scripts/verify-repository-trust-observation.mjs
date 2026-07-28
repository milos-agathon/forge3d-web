import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const policyPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "repository-trust-policy.json",
);
const actionsLockPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "workflow-actions-lock.json",
);
const observationName = "repository-trust-observation.json";

export function verifyRepositoryTrustObservation({
  bytes,
  expected,
  policy = readJson(policyPath),
  actionsLock = readJson(actionsLockPath),
  now = new Date(),
}) {
  const text = Buffer.from(bytes).toString("utf8");
  const observation = JSON.parse(text);
  if (canonicalJson(observation) !== text) {
    throw new Error("repository trust observation is not canonical JSON");
  }
  if (observation.schemaVersion !== 1) {
    throw new Error("repository trust observation schema version is unsupported");
  }
  assertEqual(observation.repository.id, policy.repository.id, "repository ID");
  assertEqual(
    observation.repository.fullName,
    policy.repository.fullName,
    "repository name",
  );
  assertEqual(observation.operation, expected.operation, "operation");
  assertEqual(observation.run.id, expected.runId, "run ID");
  assertEqual(observation.run.attempt, expected.runAttempt, "run attempt");
  assertEqual(
    observation.candidateSha,
    expected.candidateSha ?? expected.targetSha,
    "candidate SHA",
  );
  assertEqual(observation.targetSha, expected.targetSha, "target SHA");
  assertEqual(observation.workflow.path, expected.workflowPath, "workflow path");
  assertEqual(observation.workflow.ref, "refs/heads/main", "workflow ref");
  assertEqual(observation.workflow.sha, expected.workflowSha, "workflow SHA");
  assertEqual(
    observation.policySha256,
    sha256Hex(policy),
    "repository policy digest",
  );
  assertEqual(
    observation.workflowActionsLockSha256,
    sha256Hex(actionsLock),
    "workflow action lock digest",
  );
  assertEqual(observation.trustEpochSha, policy.trustEpochSha, "trust epoch SHA");
  if (expected.currentMainSha) {
    assertEqual(
      observation.currentMainSha,
      expected.currentMainSha,
      "current main SHA",
    );
  }

  const desiredChecks = policy.branchProtection.requiredStatusChecks.checks
    .map((check) => ({
      name: check.context,
      sourceAppId: check.sourceAppId,
    }))
    .sort(compareChecks);
  const observedChecks = observation.requiredChecks
    .map((check) => {
      if (
        !Number.isInteger(check.id) ||
        check.id < 1 ||
        check.conclusion !== "success"
      ) {
        throw new Error("observation required check result is invalid");
      }
      return { name: check.name, sourceAppId: check.sourceAppId };
    })
    .sort(compareChecks);
  if (canonicalJson(observedChecks) !== canonicalJson(desiredChecks)) {
    throw new Error("observation required checks do not match policy");
  }
  if (
    !Array.isArray(observation.liveResponses) ||
    observation.liveResponses.length < 7
  ) {
    throw new Error("observation must bind every live trust response");
  }
  const responseNames = new Set();
  for (const response of observation.liveResponses) {
    if (
      responseNames.has(response.name) ||
      !response.endpoint?.startsWith("/repos/") ||
      !/^[0-9a-f]{64}$/u.test(response.sha256 ?? "")
    ) {
      throw new Error("observation live response binding is invalid");
    }
    responseNames.add(response.name);
  }

  const consumerKeys = observation.consumers.map(
    (consumer) => `${consumer.job}@${consumer.environment}`,
  );
  if (new Set(consumerKeys).size !== consumerKeys.length) {
    throw new Error("observation contains duplicate consumers");
  }
  const intendedConsumer = `${expected.consumerJob}@${expected.consumerEnvironment}`;
  if (!consumerKeys.includes(intendedConsumer)) {
    throw new Error(`observation is not bound to consumer ${intendedConsumer}`);
  }

  const observedAt = Date.parse(observation.observedAt);
  const expiresAt = Date.parse(observation.expiresAt);
  const current = new Date(now).getTime();
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= observedAt ||
    expiresAt - observedAt > 30 * 60 * 1000
  ) {
    throw new Error("observation validity window must be positive and at most 30 minutes");
  }
  if (current < observedAt || current >= expiresAt) {
    throw new Error("repository trust observation is expired or not yet valid");
  }
  if (!/^[0-9a-f]{32}$/u.test(observation.nonce)) {
    throw new Error("repository trust observation nonce is invalid");
  }
  return observation;
}

export function verifyObservationArtifact({
  outputs,
  metadata,
  zipBytes,
  expected,
  policy = readJson(policyPath),
  actionsLock = readJson(actionsLockPath),
  now = new Date(),
}) {
  validateOutputTuple(outputs);
  assertEqual(String(metadata.id), outputs.artifactId, "artifact ID");
  assertEqual(metadata.name, outputs.artifactName, "artifact name");
  assertEqual(
    metadata.digest,
    `sha256:${outputs.artifactDigest}`,
    "artifact metadata digest",
  );
  assertEqual(metadata.expired, false, "artifact expired flag");
  assertEqual(
    metadata.workflow_run?.id,
    expected.runId,
    "artifact workflow run ID",
  );
  assertEqual(
    metadata.workflow_run?.repository_id,
    policy.repository.id,
    "artifact repository ID",
  );
  assertEqual(
    metadata.workflow_run?.head_repository_id,
    policy.repository.id,
    "artifact head repository ID",
  );
  assertEqual(
    metadata.workflow_run?.head_branch,
    policy.repository.defaultBranch,
    "artifact head branch",
  );
  assertEqual(
    metadata.workflow_run?.head_sha,
    expected.workflowSha,
    "artifact head SHA",
  );
  assertEqual(sha256Hex(zipBytes), outputs.artifactDigest, "downloaded archive digest");

  const entry = readSingleZipEntry(zipBytes);
  assertEqual(entry.name, observationName, "artifact archive member");
  assertEqual(
    sha256Hex(entry.bytes),
    outputs.contentSha256,
    "observation content digest",
  );
  const observation = verifyRepositoryTrustObservation({
    bytes: entry.bytes,
    expected,
    policy,
    actionsLock,
    now,
  });
  return { observation, observationBytes: entry.bytes };
}

export function validateOutputTuple(outputs) {
  if (!/^[1-9]\d*$/u.test(outputs.artifactId ?? "")) {
    throw new Error("observation artifact ID must be a non-zero decimal value");
  }
  if (!/^[A-Za-z0-9_.-]+$/u.test(outputs.artifactName ?? "")) {
    throw new Error("observation artifact name is invalid");
  }
  for (const [label, value] of [
    ["artifact digest", outputs.artifactDigest],
    ["content digest", outputs.contentSha256],
  ]) {
    if (!/^[0-9a-f]{64}$/u.test(value ?? "")) {
      throw new Error(`observation ${label} must be 64 lowercase hex characters`);
    }
  }
}

export function readSingleZipEntry(bytes) {
  const archive = Buffer.from(bytes);
  const eocdOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (entryCount !== 1) {
    throw new Error("observation artifact must contain exactly one archive member");
  }
  if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
    throw new Error("observation artifact central directory is invalid");
  }
  const method = archive.readUInt16LE(centralOffset + 10);
  const expectedCrc = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const commentLength = archive.readUInt16LE(centralOffset + 32);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const name = archive
    .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
    .toString("utf8");
  if (
    name.endsWith("/") ||
    name.startsWith("/") ||
    name.split("/").includes("..") ||
    extraLength + commentLength > archive.length
  ) {
    throw new Error("observation artifact member path is unsafe");
  }
  if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("observation artifact local header is invalid");
  }
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
  let content;
  if (method === 0) {
    content = Buffer.from(compressed);
  } else if (method === 8) {
    content = inflateRawSync(compressed);
  } else {
    throw new Error(`unsupported observation artifact ZIP method ${method}`);
  }
  if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) {
    throw new Error("observation artifact member size or CRC is invalid");
  }
  return { name, bytes: content };
}

async function fetchArtifact({ outputs, token, apiBase, repository }) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const artifactUrl = `${apiBase}/repos/${repository}/actions/artifacts/${outputs.artifactId}`;
  const metadataResponse = await fetch(artifactUrl, { headers });
  if (metadataResponse.status === 404 || metadataResponse.status === 410) {
    throw new Error(`observation artifact ${outputs.artifactId} is absent or expired`);
  }
  if (!metadataResponse.ok) {
    throw new Error(`artifact metadata request failed with HTTP ${metadataResponse.status}`);
  }
  const zipResponse = await fetch(`${artifactUrl}/zip`, { headers, redirect: "follow" });
  if (zipResponse.status === 404 || zipResponse.status === 410) {
    throw new Error(`observation artifact ${outputs.artifactId} archive is unavailable`);
  }
  if (!zipResponse.ok) {
    throw new Error(`artifact download failed with HTTP ${zipResponse.status}`);
  }
  return {
    metadata: await metadataResponse.json(),
    zipBytes: Buffer.from(await zipResponse.arrayBuffer()),
  };
}

function verifyAttestation(path, expected, repository) {
  const signerWorkflow = `${repository}/${expected.workflowPath}`;
  const result = spawnSync(
    "gh",
    [
      "attestation",
      "verify",
      path,
      "--repo",
      repository,
      "--signer-workflow",
      signerWorkflow,
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      expected.workflowSha,
      "--deny-self-hosted-runners",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`observation attestation verification failed: ${result.stderr.trim()}`);
  }
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("observation artifact is not a valid ZIP archive");
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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch`);
  }
}

function compareChecks(left, right) {
  return (
    left.name.localeCompare(right.name) ||
    left.sourceAppId - right.sourceAppId
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputs = {
    artifactId: process.env.OBSERVATION_ARTIFACT_ID,
    artifactName: process.env.OBSERVATION_ARTIFACT_NAME,
    artifactDigest: process.env.OBSERVATION_ARTIFACT_DIGEST,
    contentSha256: process.env.OBSERVATION_CONTENT_SHA256,
  };
  const expected = {
    operation: process.env.EXPECTED_OPERATION,
    consumerJob: process.env.EXPECTED_CONSUMER_JOB,
    consumerEnvironment: process.env.EXPECTED_CONSUMER_ENVIRONMENT,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    candidateSha:
      process.env.EXPECTED_CANDIDATE_SHA ?? process.env.EXPECTED_TARGET_SHA,
    targetSha: process.env.EXPECTED_TARGET_SHA,
    currentMainSha: process.env.EXPECTED_CURRENT_MAIN_SHA,
    workflowPath: process.env.EXPECTED_WORKFLOW_PATH,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
  };
  validateOutputTuple(outputs);
  const artifact = await fetchArtifact({
    outputs,
    token: process.env.GITHUB_TOKEN,
    apiBase: process.env.GITHUB_API_URL ?? "https://api.github.com",
    repository: process.env.GITHUB_REPOSITORY,
  });
  const verified = verifyObservationArtifact({
    ...artifact,
    outputs,
    expected,
  });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "forge3d-observation-"));
  try {
    const observationPath = join(temporaryDirectory, observationName);
    writeFileSync(observationPath, verified.observationBytes, { mode: 0o600 });
    verifyAttestation(observationPath, expected, process.env.GITHUB_REPOSITORY);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, operation: verified.observation.operation }));
}
