import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  BROKER_PROTOCOL_VERSION,
  CLEANUP_PROTOCOL_VERSION,
} from "./broker-client.mjs";
import {
  canonicalJson,
  signControllerRecord,
} from "./controller-signing.mjs";

const REPOSITORY = "milos-agathon/forge3d-web";
const PACKAGE = "@forge3d/browser-lab-controller";
const BROKER_SIGNER_WORKFLOW =
  "milos-agathon/forge3d-web/.github/workflows/browser-lab-broker.yml";
const CONTROLLER_SIGNER_WORKFLOW =
  "milos-agathon/forge3d-web/.github/workflows/browser-lab-controller.yml";

export function loadControllerDeploymentProvenance({
  packageManifestPath,
  installationReceiptPath,
  packageRoot,
  hostId,
}) {
  if (!packageManifestPath || !installationReceiptPath || !packageRoot) {
    throw new Error(
      "controller package manifest, administrator installation receipt, and installed package root are required",
    );
  }
  const packageManifestBytes = readFileSync(packageManifestPath);
  const packageManifest = JSON.parse(packageManifestBytes.toString("utf8"));
  const installationReceipt = JSON.parse(
    readFileSync(installationReceiptPath, "utf8"),
  );
  const deploymentProvenance = verifyControllerDeploymentProvenance({
    packageManifest,
    packageManifestBytes,
    installationReceipt,
    hostId,
  });
  verifyInstalledControllerPackage({
    packageRoot,
    packageManifest,
  });
  return deploymentProvenance;
}

export function verifyControllerDeploymentProvenance({
  packageManifest,
  packageManifestBytes,
  installationReceipt,
  hostId,
}) {
  assertControllerPackageManifest(packageManifest);
  assertServiceDeploymentProvenance(installationReceipt, {
    service: "controller",
    serviceIdentity: `controller:${hostId}`,
    signerWorkflow: CONTROLLER_SIGNER_WORKFLOW,
  });
  const filesSha256 = sha256(
    Buffer.from(canonicalJson(packageManifest.files)),
  );
  if (
    installationReceipt.packageManifest.sha256 !==
      sha256(packageManifestBytes) ||
    installationReceipt.source.targetSha !== packageManifest.targetSha ||
    installationReceipt.source.workflowSha !== packageManifest.workflowSha ||
    installationReceipt.packageManifest.attestation.sourceDigest !==
      packageManifest.targetSha ||
    installationReceipt.archive.name !== packageManifest.archive ||
    installationReceipt.archive.sha256 !== packageManifest.archiveSha256 ||
    installationReceipt.configuration.sha256 !== filesSha256
  ) {
    throw new Error(
      "controller installation receipt does not bind the attested package manifest",
    );
  }
  return structuredClone(installationReceipt);
}

export function assertControllerPackageManifest(manifest) {
  exactKeys(manifest, [
    "schemaVersion",
    "package",
    "version",
    "targetSha",
    "workflowSha",
    "archive",
    "archiveSha256",
    "files",
  ], "controller package manifest");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.package !== PACKAGE ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(manifest.version ?? "") ||
    !sha40(manifest.targetSha) ||
    !sha40(manifest.workflowSha) ||
    typeof manifest.archive !== "string" ||
    manifest.archive.length === 0 ||
    !digest(manifest.archiveSha256) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error("controller package manifest identity is invalid");
  }
  const paths = new Set();
  const caseFoldedPaths = new Set();
  for (const entry of manifest.files) {
    exactKeys(entry, ["path", "sha256"], "controller package file");
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path
        .split("/")
        .some((segment) => ["", ".", ".."].includes(segment)) ||
      paths.has(entry.path) ||
      caseFoldedPaths.has(entry.path.toLowerCase()) ||
      !digest(entry.sha256)
    ) {
      throw new Error("controller package file identity is invalid");
    }
    paths.add(entry.path);
    caseFoldedPaths.add(entry.path.toLowerCase());
  }
  for (const requiredPath of [
    "package.json",
    "src/bootstrap.mjs",
    "src/controller-service.mjs",
  ]) {
    if (!paths.has(requiredPath)) {
      throw new Error(
        `controller package is missing required runtime file: ${requiredPath}`,
      );
    }
  }
}

export function verifyInstalledControllerPackage({
  packageRoot,
  packageManifest,
}) {
  assertControllerPackageManifest(packageManifest);
  verifyExactInstalledFiles({
    root: packageRoot,
    expected: packageManifest.files,
    label: "controller installed package",
  });
}

export function assertServiceDeploymentProvenance(
  record,
  { service, serviceIdentity, signerWorkflow },
) {
  exactKeys(record, [
    "schemaVersion",
    "recordType",
    "service",
    "serviceIdentity",
    "packageRun",
    "source",
    "packageManifest",
    "archive",
    "configuration",
    "protocols",
    "administratorVerification",
  ], "service deployment provenance");
  exactKeys(record.packageRun, [
    "id",
    "attempt",
    "artifact",
  ], "deployment package run");
  exactKeys(record.packageRun.artifact, [
    "id",
    "name",
    "digest",
  ], "deployment package artifact");
  exactKeys(record.source, [
    "repository",
    "targetSha",
    "workflowSha",
  ], "deployment source");
  exactKeys(record.packageManifest, [
    "sha256",
    "attestation",
  ], "deployment package manifest");
  exactKeys(record.packageManifest.attestation, [
    "verified",
    "repository",
    "signerWorkflow",
    "sourceRef",
    "sourceDigest",
    "denySelfHostedRunners",
  ], "deployment package attestation");
  exactKeys(record.archive, ["name", "sha256"], "deployment archive");
  exactKeys(record.configuration, ["sha256"], "deployment configuration");
  exactKeys(record.protocols, ["broker", "cleanup"], "deployment protocols");
  exactKeys(record.administratorVerification, [
    "status",
    "method",
    "verifiedAt",
    "verifiedBy",
  ], "deployment administrator verification");
  if (
    record.schemaVersion !== 1 ||
    record.recordType !== "lab-service-deployment-provenance" ||
    record.service !== service ||
    record.serviceIdentity !== serviceIdentity ||
    !/^(?:broker:forge3d-browser-lab|controller:FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+)$/u.test(
      record.serviceIdentity ?? "",
    ) ||
    !Number.isInteger(record.packageRun.id) ||
    record.packageRun.id < 1 ||
    !Number.isInteger(record.packageRun.attempt) ||
    record.packageRun.attempt < 1 ||
    !Number.isInteger(record.packageRun.artifact.id) ||
    record.packageRun.artifact.id < 1 ||
    record.packageRun.artifact.name !==
      `browser-lab-${service}-${record.source.targetSha}-${record.packageRun.id}-${record.packageRun.attempt}` ||
    !/^sha256:[0-9a-f]{64}$/u.test(
      record.packageRun.artifact.digest ?? "",
    ) ||
    record.source.repository !== REPOSITORY ||
    !sha40(record.source.targetSha) ||
    !sha40(record.source.workflowSha) ||
    !digest(record.packageManifest.sha256) ||
    record.packageManifest.attestation.verified !== true ||
    record.packageManifest.attestation.repository !== REPOSITORY ||
    record.packageManifest.attestation.signerWorkflow !== signerWorkflow ||
    record.packageManifest.attestation.sourceRef !== "refs/heads/main" ||
    !sha40(record.packageManifest.attestation.sourceDigest) ||
    record.packageManifest.attestation.sourceDigest !==
      record.source.targetSha ||
    record.packageManifest.attestation.denySelfHostedRunners !== true ||
    typeof record.archive.name !== "string" ||
    record.archive.name.length === 0 ||
    !digest(record.archive.sha256) ||
    !digest(record.configuration.sha256) ||
    record.protocols.broker !== BROKER_PROTOCOL_VERSION ||
    record.protocols.cleanup !== CLEANUP_PROTOCOL_VERSION ||
    record.administratorVerification.status !== "verified" ||
    record.administratorVerification.method !== "github-attestation" ||
    !timestamp(record.administratorVerification.verifiedAt) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u.test(
      record.administratorVerification.verifiedBy ?? "",
    )
  ) {
    throw new Error("service deployment provenance is invalid");
  }
}

export function createSignedDeploymentProvenanceReceipt({
  run,
  hostId,
  trustedSha,
  brokerDeployment,
  controllerDeployment,
  privateKey,
  signingKeyId,
  observedAt = new Date(),
}) {
  if (
    !Number.isInteger(run?.id) ||
    run.id < 1 ||
    !Number.isInteger(run.attempt) ||
    run.attempt < 1 ||
    !sha40(trustedSha)
  ) {
    throw new Error("deployment observation run or candidate is invalid");
  }
  assertServiceDeploymentProvenance(brokerDeployment, {
    service: "broker",
    serviceIdentity: "broker:forge3d-browser-lab",
    signerWorkflow: BROKER_SIGNER_WORKFLOW,
  });
  assertServiceDeploymentProvenance(controllerDeployment, {
    service: "controller",
    serviceIdentity: `controller:${hostId}`,
    signerWorkflow: CONTROLLER_SIGNER_WORKFLOW,
  });
  if (
    brokerDeployment.source.targetSha !==
      controllerDeployment.source.targetSha ||
    brokerDeployment.source.targetSha !== trustedSha ||
    brokerDeployment.source.workflowSha !==
      controllerDeployment.source.workflowSha ||
    brokerDeployment.protocols.broker !==
      controllerDeployment.protocols.broker ||
    brokerDeployment.protocols.cleanup !==
      controllerDeployment.protocols.cleanup
  ) {
    throw new Error("broker and controller deployment provenance disagree");
  }
  return signControllerRecord({
    record: {
      schemaVersion: 1,
      recordType: "lab-service-deployment-provenance-receipt",
      runId: run.id,
      runAttempt: run.attempt,
      hostId,
      controllerIdentity: `controller:${hostId}`,
      trustedSha,
      observedAt: new Date(observedAt).toISOString(),
      broker: structuredClone(brokerDeployment),
      controller: structuredClone(controllerDeployment),
    },
    privateKey,
    signingKeyId,
  });
}

export async function observeAndSignDeploymentProvenance({
  brokerClient,
  controllerDeployment,
  run,
  hostId,
  trustedSha,
  privateKey,
  signingKeyId,
  observedAt = new Date(),
}) {
  const brokerDeployment = await brokerClient.deployment();
  return createSignedDeploymentProvenanceReceipt({
    run,
    hostId,
    trustedSha,
    brokerDeployment,
    controllerDeployment,
    privateKey,
    signingKeyId,
    observedAt,
  });
}

function exactKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")
  ) {
    throw new Error(`${label} shape is invalid`);
  }
}

function sha40(value) {
  return /^[0-9a-f]{40}$/u.test(value ?? "");
}

function digest(value) {
  return /^[0-9a-f]{64}$/u.test(value ?? "");
}

function timestamp(value) {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/u.exec(
      value,
    );
  if (match === null) return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === `${match[1]}.${match[2] ?? "000"}Z`
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyExactInstalledFiles({ root, expected, label }) {
  const expectedByPath = new Map(
    expected.map((entry) => [entry.path, entry.sha256]),
  );
  const expectedDirectories = directorySet(expectedByPath.keys());
  let actual;
  try {
    actual = listRegularFiles(resolve(root), expectedDirectories);
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
  if (
    expectedByPath.size !== expected.length ||
    actual.length !== expected.length ||
    actual.some((entry) => !expectedByPath.has(entry.path))
  ) {
    throw new Error(`${label} file set does not match its manifest`);
  }
  for (const entry of actual) {
    if (
      sha256(readStableRegularFile(entry.absolutePath)) !==
      expectedByPath.get(entry.path)
    ) {
      throw new Error(`${label} file digest does not match: ${entry.path}`);
    }
  }
}

function listRegularFiles(root, expectedDirectories) {
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("installed root must be a real directory");
  }
  const files = [];
  walk(root, root, expectedDirectories, files);
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

function walk(root, directory, expectedDirectories, files) {
  for (const name of readdirSync(directory).sort()) {
    const absolutePath = join(directory, name);
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`installed tree contains a symlink: ${relative(root, absolutePath)}`);
    }
    if (stats.isDirectory()) {
      const path = relative(root, absolutePath).replaceAll("\\", "/");
      if (!expectedDirectories.has(path)) {
        throw new Error(`installed tree contains an unexpected directory: ${path}`);
      }
      walk(root, absolutePath, expectedDirectories, files);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(
        `installed tree contains a non-regular file: ${relative(root, absolutePath)}`,
      );
    }
    if (Number.isInteger(stats.nlink) && stats.nlink !== 1) {
      throw new Error(
        `installed tree contains a hard-linked file: ${relative(root, absolutePath)}`,
      );
    }
    files.push({
      absolutePath,
      path: relative(root, absolutePath).replaceAll("\\", "/"),
    });
  }
}

function readStableRegularFile(path) {
  let descriptor;
  try {
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (Number.isInteger(before.nlink) && before.nlink !== 1)
    ) {
      throw new Error("installed path is not a single-link regular file");
    }
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (!stableIdentity(before, opened)) {
      throw new Error("installed file identity changed while opening");
    }
    const bytes = readFileSync(descriptor);
    if (!stableIdentity(opened, fstatSync(descriptor))) {
      throw new Error("installed file identity changed while reading");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function stableIdentity(left, right) {
  return (
    left.isFile() &&
    right.isFile() &&
    (!Number.isInteger(right.nlink) || right.nlink === 1) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function directorySet(paths) {
  const result = new Set();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      result.add(segments.slice(0, index).join("/"));
    }
  }
  return result;
}
