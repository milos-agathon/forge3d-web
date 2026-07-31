import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalJson } from "./canonical-json.mjs";
import {
  BROKER_PROTOCOL_VERSION,
  CLEANUP_PROTOCOL_VERSION,
} from "./protocol.mjs";

const REPOSITORY = "milos-agathon/forge3d-web";
const SERVICE_IDENTITY = "broker:forge3d-browser-lab";
const SIGNER_WORKFLOW =
  "milos-agathon/forge3d-web/.github/workflows/browser-lab-broker.yml";
const configurationPaths = [
  "crates/forge3d-web/tests/infrastructure/browser-policy.json",
  "crates/forge3d-web/tests/infrastructure/broker-lifecycle.schema.json",
  "crates/forge3d-web/tests/infrastructure/broker-protocol.schema.json",
  "crates/forge3d-web/tests/infrastructure/controller-health-endpoints.json",
  "crates/forge3d-web/tests/infrastructure/hardware-matrix.json",
  "crates/forge3d-web/tests/infrastructure/repository-trust-policy.json",
  "crates/forge3d-web/tests/infrastructure/runner-distribution-manifest.json",
  "crates/forge3d-web/tests/infrastructure/runner-transient-path-policy.json",
  "crates/forge3d-web/tests/infrastructure/workflow-actions-lock.json",
];

export function loadBrokerDeploymentProvenance({
  packageManifestPath,
  installationReceiptPath,
}) {
  if (!packageManifestPath || !installationReceiptPath) {
    throw new Error(
      "broker package manifest and administrator installation receipt are required",
    );
  }
  const packageManifestBytes = readFileSync(packageManifestPath);
  const packageManifest = JSON.parse(packageManifestBytes.toString("utf8"));
  const installationReceipt = JSON.parse(
    readFileSync(installationReceiptPath, "utf8"),
  );
  return verifyBrokerDeploymentProvenance({
    packageManifest,
    packageManifestBytes,
    installationReceipt,
  });
}

export function verifyBrokerDeploymentProvenance({
  packageManifest,
  packageManifestBytes,
  installationReceipt,
}) {
  assertBrokerPackageManifest(packageManifest);
  assertServiceDeploymentProvenance(installationReceipt, {
    service: "broker",
    serviceIdentity: SERVICE_IDENTITY,
    signerWorkflow: SIGNER_WORKFLOW,
  });
  const expected = {
    packageManifestSha256: sha256(packageManifestBytes),
    configurationSha256: packageManifest.configurationSha256,
    archiveName: packageManifest.archive.name,
    archiveSha256: packageManifest.archive.sha256,
    targetSha: packageManifest.targetSha,
    workflowSha: packageManifest.workflowSha,
    brokerProtocolVersion: packageManifest.brokerProtocolVersion,
    cleanupProtocolVersion: packageManifest.cleanupProtocolVersion,
  };
  if (
    installationReceipt.packageManifest.sha256 !==
      expected.packageManifestSha256 ||
    installationReceipt.source.targetSha !== expected.targetSha ||
    installationReceipt.source.workflowSha !== expected.workflowSha ||
    installationReceipt.packageManifest.attestation.sourceDigest !==
      expected.targetSha ||
    installationReceipt.archive.name !== expected.archiveName ||
    installationReceipt.archive.sha256 !== expected.archiveSha256 ||
    installationReceipt.configuration.sha256 !==
      expected.configurationSha256 ||
    installationReceipt.protocols.broker !==
      expected.brokerProtocolVersion ||
    installationReceipt.protocols.cleanup !==
      expected.cleanupProtocolVersion
  ) {
    throw new Error(
      "broker installation receipt does not bind the attested package manifest",
    );
  }
  return structuredClone(installationReceipt);
}

export function assertBrokerPackageManifest(manifest) {
  exactKeys(manifest, [
    "schemaVersion",
    "repository",
    "targetSha",
    "workflowSha",
    "brokerProtocolVersion",
    "cleanupProtocolVersion",
    "archive",
    "configuration",
    "configurationSha256",
  ], "broker package manifest");
  exactKeys(manifest.archive, ["name", "sha256"], "broker archive");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== REPOSITORY ||
    !sha40(manifest.targetSha) ||
    !sha40(manifest.workflowSha) ||
    manifest.brokerProtocolVersion !== BROKER_PROTOCOL_VERSION ||
    manifest.cleanupProtocolVersion !== CLEANUP_PROTOCOL_VERSION ||
    typeof manifest.archive.name !== "string" ||
    manifest.archive.name.length === 0 ||
    !digest(manifest.archive.sha256) ||
    !Array.isArray(manifest.configuration) ||
    manifest.configuration.length !== configurationPaths.length ||
    !digest(manifest.configurationSha256)
  ) {
    throw new Error("broker package manifest identity is invalid");
  }
  for (const [index, entry] of manifest.configuration.entries()) {
    exactKeys(entry, ["path", "sha256"], "broker configuration entry");
    if (
      entry.path !== configurationPaths[index] ||
      !digest(entry.sha256)
    ) {
      throw new Error("broker package configuration identity is invalid");
    }
  }
  if (
    sha256(Buffer.from(canonicalJson(manifest.configuration))) !==
    manifest.configurationSha256
  ) {
    throw new Error("broker package configuration digest is invalid");
  }
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
