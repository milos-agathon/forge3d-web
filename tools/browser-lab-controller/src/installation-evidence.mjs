import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { ISSUE_PROTOCOL, CLEANUP_PROTOCOL } from "./broker-client.mjs";
import { canonicalJson } from "./controller-signing.mjs";

const CONTROLLER_PROTOCOL = "forge3d-browser-lab-controller/v1";
const REPOSITORY = "milos-agathon/forge3d-web";
const SIGNER =
  "milos-agathon/forge3d-web/.github/workflows/browser-lab-controller.yml";

export function loadInstalledControllerEvidence({
  receiptPath,
  packageManifestPath,
  hostId,
  inventoryHelperPath,
  servicePath,
  requiredHelpers = [],
  requiredConfigurations = [],
}) {
  const receiptBytes = readFileSync(receiptPath);
  const manifestBytes = readFileSync(packageManifestPath);
  const receipt = JSON.parse(receiptBytes);
  const manifest = JSON.parse(manifestBytes);
  validateInstalledControllerEvidence({
    receipt,
    manifest,
    manifestBytes,
    hostId,
    inventoryHelperPath,
    servicePath,
    requiredHelpers,
    requiredConfigurations,
  });
  return structuredClone(receipt);
}

export function validateInstalledControllerEvidence({
  receipt,
  manifest,
  manifestBytes,
  hostId,
  inventoryHelperPath,
  servicePath,
  requiredHelpers = [],
  requiredConfigurations = [],
}) {
  assertReceiptClosure(receipt);
  const protocols = {
    controller: CONTROLLER_PROTOCOL,
    broker: ISSUE_PROTOCOL,
    cleanup: CLEANUP_PROTOCOL,
  };
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.recordType !== "lab-service-installation" ||
    receipt.component !== "controller" ||
    receipt.instanceId !== hostId ||
    receipt.repository !== REPOSITORY ||
    receipt.package?.name !== "@forge3d/browser-lab-controller" ||
    receipt.package.version !== manifest?.version ||
    receipt.package.targetSha !== manifest?.targetSha ||
    receipt.package.workflowSha !== manifest?.workflowSha ||
    canonicalJson(receipt.package.archive) !== canonicalJson(manifest?.archive) ||
    receipt.package.manifestSha256 !== sha256(manifestBytes) ||
    receipt.package.configurationSha256 !== manifest?.configurationSha256 ||
    canonicalJson(receipt.package.protocols) !== canonicalJson(protocols) ||
    canonicalJson(manifest?.protocols) !== canonicalJson(protocols) ||
    receipt.attestation?.verified !== true ||
    receipt.attestation.repository !== REPOSITORY ||
    receipt.attestation.signerWorkflow !== SIGNER ||
    receipt.attestation.sourceRef !== "refs/heads/main" ||
    receipt.attestation.sourceDigest !== manifest.targetSha ||
    receipt.attestation.denySelfHostedRunners !== true ||
    receipt.attestation.archiveSha256 !== manifest.archive.sha256 ||
    receipt.attestation.manifestSha256 !== receipt.package.manifestSha256 ||
    !Number.isFinite(Date.parse(receipt.verifiedAt))
  ) {
    throw new Error("installed controller package evidence is invalid");
  }
  verifyInstalledFiles(receipt.installed);
  const service = requireInstalledRole(receipt.installed.files, "service");
  const helper = requireInstalledRole(receipt.installed.files, "helper");
  const helpers = receipt.installed.files.filter((file) => file.role === "helper");
  const configurations = receipt.installed.files.filter(
    (file) => file.role === "configuration",
  );
  const packageService = manifest.files?.find(
    (file) => file.path === service.packagePath,
  );
  if (
    resolve(service.path) !== resolve(servicePath) ||
    resolve(helper.path) !== resolve(inventoryHelperPath) ||
    packageService?.sha256 !== service.sha256 ||
    configurations.length !== manifest.configuration?.length ||
    configurations.some((file) =>
      !manifest.configuration.some(
        (expected) =>
          expected.path === file.packagePath && expected.sha256 === file.sha256,
      ),
    ) ||
    requiredHelpers.some((expected) =>
      !helpers.some(
        (file) =>
          file.identity === expected.identity &&
          resolve(file.path) === resolve(expected.path) &&
          file.packagePath === expected.packagePath &&
          (expected.version === undefined || file.version === expected.version) &&
          (expected.packagePath === null ||
            manifest.files.some(
              (candidate) =>
                candidate.path === expected.packagePath &&
                candidate.sha256 === file.sha256,
            )),
      ),
    ) ||
    requiredConfigurations.some((expected) =>
      !configurations.some(
        (file) =>
          file.packagePath === expected.packagePath &&
          resolve(file.path) === resolve(expected.path),
      ),
    )
  ) {
    throw new Error("installed controller service/helper paths are not pinned");
  }
  return receipt;
}

function assertReceiptClosure(receipt) {
  assertExactKeys(receipt, [
    "schemaVersion", "recordType", "component", "instanceId", "repository",
    "package", "attestation", "installed", "verifiedAt",
  ]);
  assertExactKeys(receipt.package, [
    "name", "version", "targetSha", "workflowSha", "archive",
    "manifestSha256", "configurationSha256", "protocols",
  ]);
  assertExactKeys(receipt.package.archive, ["name", "sha256"]);
  assertExactKeys(receipt.package.protocols, ["controller", "broker", "cleanup"]);
  assertExactKeys(receipt.attestation, [
    "verified", "repository", "signerWorkflow", "sourceRef", "sourceDigest",
    "denySelfHostedRunners", "archiveSha256", "manifestSha256",
  ]);
  assertExactKeys(receipt.installed, ["root", "files", "filesSha256"]);
  for (const file of receipt.installed.files ?? []) {
    assertExactKeys(file, [
      "role", "identity", "path", "packagePath", "version", "sha256",
    ]);
  }
  assertNoProhibitedKeys(receipt);
}

function assertExactKeys(value, expected) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("installed controller evidence contains unreviewed fields");
  }
}

function assertNoProhibitedKeys(value) {
  if (Array.isArray(value)) return value.forEach(assertNoProhibitedKeys);
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    if (
      ["key", "token", "secret", "credential", "serial", "udid"].includes(normalized) ||
      normalized.includes("privatekey") ||
      normalized.includes("serialnumber") ||
      normalized.endsWith("address")
    ) throw new Error("installed controller evidence contains prohibited data");
    assertNoProhibitedKeys(nested);
  }
}

function verifyInstalledFiles(installed) {
  const files = installed?.files;
  if (
    !isAbsolute(installed?.root ?? "") ||
    !Array.isArray(files) ||
    files.length < 2 ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    canonicalJson(files) !==
      canonicalJson([...files].sort((left, right) => left.path.localeCompare(right.path))) ||
    installed.filesSha256 !== sha256(Buffer.from(canonicalJson(files)))
  ) {
    throw new Error("installed controller file closure is invalid");
  }
  for (const file of files) {
    if (
      !["service", "configuration", "helper"].includes(file?.role) ||
      typeof file.identity !== "string" ||
      !isAbsolute(file.path ?? "") ||
      (file.packagePath !== null &&
        !/^[A-Za-z0-9_.\/-]+$/u.test(file.packagePath ?? "")) ||
      (file.version !== null &&
        (typeof file.version !== "string" || file.version.length < 1)) ||
      !/^[0-9a-f]{64}$/u.test(file.sha256 ?? "") ||
      sha256(readFileSync(file.path)) !== file.sha256
    ) {
      throw new Error(`installed controller file digest is invalid: ${file?.path}`);
    }
  }
}

function requireInstalledRole(files, role) {
  const matches = files.filter((file) =>
    role === "helper"
      ? file.role === role &&
        file.identity === "FORGE3D_BROWSER_INVENTORY_HELPER"
      : file.role === role,
  );
  if (matches.length !== 1) {
    throw new Error(`installed controller requires exactly one ${role} file`);
  }
  return matches[0];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
