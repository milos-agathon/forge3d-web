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
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repository = "milos-agathon/forge3d-web";
const signerWorkflow =
  `${repository}/.github/workflows/browser-lab-broker.yml`;
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
const requiredPackagePaths = [
  "README.md",
  "package.json",
  "schemas/broker-package-manifest.schema.json",
  "schemas/lab-service-deployment-provenance.schema.json",
  "services/browser-lab-broker.env.example",
  "services/browser-lab-broker.service",
  "src/bootstrap.mjs",
  "src/server.mjs",
];

export function verifyBrokerBootstrap({
  packageManifestPath,
  installationReceiptPath,
  packageArchivePath,
  packageRoot,
  configurationRoot,
  executedPackageRoot = packageRoot,
}) {
  if (resolve(packageRoot) !== resolve(executedPackageRoot)) {
    throw new Error("broker configured package root is not the executed package root");
  }
  const manifestBytes = readStableRegularFile(
    packageManifestPath,
    "broker package manifest",
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const receipt = JSON.parse(
    readStableRegularFile(
      installationReceiptPath,
      "broker installation receipt",
    ).toString("utf8"),
  );
  assertBrokerManifestAndReceipt({ manifest, manifestBytes, receipt });
  verifyBrokerPackageArchive({
    packageManifest: manifest,
    packageArchivePath,
    packageRoot,
    configurationRoot,
  });
}

export function verifyBrokerPackageArchive({
  packageManifest,
  packageArchivePath,
  packageRoot,
  configurationRoot,
}) {
  const archiveBytes = readStableRegularFile(
    packageArchivePath,
    "broker retained package archive",
  );
  if (
    basename(packageArchivePath) !== packageManifest.archive.name ||
    sha256(archiveBytes) !== packageManifest.archive.sha256
  ) {
    throw new Error("broker retained package archive does not match its manifest");
  }
  const outer = parseTarGzip(archiveBytes, "broker outer package archive");
  const expectedConfigurationMembers = new Map(
    packageManifest.configuration.map((entry) => [
      `broker-package/config/${basename(entry.path)}`,
      entry.sha256,
    ]),
  );
  const packageMembers = [...outer.files.keys()].filter((path) =>
    path.startsWith("broker-package/package/")
  );
  if (
    packageMembers.length !== 1 ||
    !/^broker-package\/package\/forge3d-browser-lab-broker-[0-9]+\.[0-9]+\.[0-9]+\.tgz$/u.test(
      packageMembers[0] ?? "",
    ) ||
    outer.files.size !== expectedConfigurationMembers.size + 1 ||
    [...expectedConfigurationMembers].some(
      ([path, digest]) =>
        !outer.files.has(path) || sha256(outer.files.get(path)) !== digest,
    ) ||
    [...outer.directories].some(
      (path) =>
        ![
          "broker-package",
          "broker-package/config",
          "broker-package/package",
        ].includes(path),
    )
  ) {
    throw new Error("broker outer package archive layout is invalid");
  }
  const packed = parseTarGzip(
    outer.files.get(packageMembers[0]),
    "broker npm package archive",
  );
  if (
    [...packed.files].some(([path]) => !path.startsWith("package/")) ||
    [...packed.directories].some(
      (path) =>
        path !== "package" &&
        !["package/src", "package/services", "package/schemas"].includes(path),
    )
  ) {
    throw new Error("broker npm package archive layout is invalid");
  }
  const installedFiles = new Map(
    [...packed.files].map(([path, bytes]) => [
      path.slice("package/".length),
      sha256(bytes),
    ]),
  );
  const packageJsonBytes = packed.files.get("package/package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonBytes?.toString("utf8"));
  } catch {
    throw new Error("broker npm package identity is invalid");
  }
  if (
    packageJson?.name !== "@forge3d/browser-lab-broker" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(packageJson.version ?? "") ||
    packageMembers[0] !==
      `broker-package/package/forge3d-browser-lab-broker-${packageJson.version}.tgz` ||
    requiredPackagePaths.some((path) => !installedFiles.has(path)) ||
    [...installedFiles.keys()].some((path) => !allowedBrokerPackagePath(path))
  ) {
    throw new Error("broker npm package identity is invalid");
  }
  verifyExactTree({
    root: packageRoot,
    expected: installedFiles,
    label: "broker installed package",
  });
  verifyExactTree({
    root: configurationRoot,
    expected: new Map(
      packageManifest.configuration.map((entry) => [
        basename(entry.path),
        entry.sha256,
      ]),
    ),
    label: "broker installed configuration",
  });
}

export async function startBrokerBootstrap(
  environment = process.env,
  {
    executedPackageRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
    ),
    loadRuntime = () => import("./server.mjs"),
  } = {},
) {
  verifyBrokerBootstrap({
    packageManifestPath: required(environment, "BROKER_PACKAGE_MANIFEST_PATH"),
    installationReceiptPath: required(
      environment,
      "BROKER_INSTALLATION_RECEIPT_PATH",
    ),
    packageArchivePath: required(
      environment,
      "BROKER_PACKAGE_ARCHIVE_PATH",
    ),
    packageRoot: required(environment, "BROKER_PACKAGE_ROOT"),
    configurationRoot: required(environment, "BROKER_CONFIGURATION_ROOT"),
    executedPackageRoot,
  });
  const { startInstalledBrokerService } = await loadRuntime();
  return startInstalledBrokerService(environment);
}

function assertBrokerManifestAndReceipt({ manifest, manifestBytes, receipt }) {
  const sha40 = (value) => /^[0-9a-f]{40}$/u.test(value ?? "");
  const digest = (value) => /^[0-9a-f]{64}$/u.test(value ?? "");
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
  ]);
  exactKeys(manifest.archive, ["name", "sha256"]);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== repository ||
    !sha40(manifest.targetSha) ||
    !sha40(manifest.workflowSha) ||
    manifest.brokerProtocolVersion !== "forge3d-browser-lab-broker/v1" ||
    manifest.cleanupProtocolVersion !== "forge3d-browser-lab-cleanup/v1" ||
    typeof manifest.archive.name !== "string" ||
    manifest.archive.name === "" ||
    !digest(manifest.archive.sha256) ||
    !Array.isArray(manifest.configuration) ||
    manifest.configuration.length !== configurationPaths.length ||
    !digest(manifest.configurationSha256)
  ) {
    throw new Error("broker bootstrap package manifest is invalid");
  }
  for (const [index, entry] of manifest.configuration.entries()) {
    exactKeys(entry, ["path", "sha256"]);
    if (
      entry.path !== configurationPaths[index] ||
      !digest(entry.sha256)
    ) {
      throw new Error("broker bootstrap configuration manifest is invalid");
    }
  }
  if (
    sha256(Buffer.from(canonicalJson(manifest.configuration))) !==
    manifest.configurationSha256
  ) {
    throw new Error("broker bootstrap configuration digest is invalid");
  }
  assertServiceReceipt(receipt, {
    service: "broker",
    serviceIdentity: "broker:forge3d-browser-lab",
    signer: signerWorkflow,
    manifest,
    manifestSha256: sha256(manifestBytes),
    configurationSha256: manifest.configurationSha256,
    archiveName: manifest.archive.name,
    archiveSha256: manifest.archive.sha256,
  });
}

function assertServiceReceipt(
  receipt,
  {
    service,
    serviceIdentity,
    signer,
    manifest,
    manifestSha256,
    configurationSha256,
    archiveName,
    archiveSha256,
  },
) {
  exactKeys(receipt, [
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
  ]);
  exactKeys(receipt.packageRun, ["id", "attempt", "artifact"]);
  exactKeys(receipt.packageRun.artifact, ["id", "name", "digest"]);
  exactKeys(receipt.source, ["repository", "targetSha", "workflowSha"]);
  exactKeys(receipt.packageManifest, ["sha256", "attestation"]);
  exactKeys(receipt.packageManifest.attestation, [
    "verified",
    "repository",
    "signerWorkflow",
    "sourceRef",
    "sourceDigest",
    "denySelfHostedRunners",
  ]);
  exactKeys(receipt.archive, ["name", "sha256"]);
  exactKeys(receipt.configuration, ["sha256"]);
  exactKeys(receipt.protocols, ["broker", "cleanup"]);
  exactKeys(receipt.administratorVerification, [
    "status",
    "method",
    "verifiedAt",
    "verifiedBy",
  ]);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.recordType !== "lab-service-deployment-provenance" ||
    receipt.service !== service ||
    receipt.serviceIdentity !== serviceIdentity ||
    !Number.isInteger(receipt.packageRun.id) ||
    receipt.packageRun.id < 1 ||
    !Number.isInteger(receipt.packageRun.attempt) ||
    receipt.packageRun.attempt < 1 ||
    !Number.isInteger(receipt.packageRun.artifact.id) ||
    receipt.packageRun.artifact.id < 1 ||
    receipt.packageRun.artifact.name !==
      `browser-lab-${service}-${manifest.targetSha}-${receipt.packageRun.id}-${receipt.packageRun.attempt}` ||
    !/^sha256:[0-9a-f]{64}$/u.test(
      receipt.packageRun.artifact.digest ?? "",
    ) ||
    receipt.source.repository !== repository ||
    receipt.source.targetSha !== manifest.targetSha ||
    receipt.source.workflowSha !== manifest.workflowSha ||
    receipt.packageManifest.sha256 !== manifestSha256 ||
    receipt.packageManifest.attestation.verified !== true ||
    receipt.packageManifest.attestation.repository !== repository ||
    receipt.packageManifest.attestation.signerWorkflow !== signer ||
    receipt.packageManifest.attestation.sourceRef !== "refs/heads/main" ||
    receipt.packageManifest.attestation.sourceDigest !== manifest.targetSha ||
    receipt.packageManifest.attestation.denySelfHostedRunners !== true ||
    receipt.archive.name !== archiveName ||
    receipt.archive.sha256 !== archiveSha256 ||
    receipt.configuration.sha256 !== configurationSha256 ||
    receipt.protocols.broker !== "forge3d-browser-lab-broker/v1" ||
    receipt.protocols.cleanup !== "forge3d-browser-lab-cleanup/v1" ||
    receipt.administratorVerification.status !== "verified" ||
    receipt.administratorVerification.method !== "github-attestation" ||
    !timestamp(receipt.administratorVerification.verifiedAt) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u.test(
      receipt.administratorVerification.verifiedBy ?? "",
    )
  ) {
    throw new Error("broker bootstrap administrator receipt is invalid");
  }
}

function parseTarGzip(compressed, label) {
  if (!Buffer.isBuffer(compressed) || compressed.length > 32 * 1024 * 1024) {
    throw new Error(`${label} is too large`);
  }
  let tar;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  } catch {
    throw new Error(`${label} is not a bounded gzip archive`);
  }
  const files = new Map();
  const directories = new Set();
  const caseFolded = new Set();
  let offset = 0;
  let endBlocks = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      endBlocks += 1;
      if (endBlocks === 2) break;
      continue;
    }
    if (endBlocks !== 0 || tarChecksum(header) !== parseOctal(header, 148, 8)) {
      throw new Error(`${label} has an invalid tar header`);
    }
    const name = tarPath(header);
    const type = header[156];
    const size = parseOctal(header, 124, 12);
    const isDirectory = type === 53;
    const isFile = type === 0 || type === 48;
    const normalized = isDirectory && name.endsWith("/")
      ? name.slice(0, -1)
      : name;
    if (
      !canonicalRelativePath(normalized) ||
      caseFolded.has(normalized.toLowerCase()) ||
      (!isDirectory && !isFile) ||
      (isDirectory && size !== 0) ||
      offset + size > tar.length
    ) {
      throw new Error(`${label} contains an invalid tar member`);
    }
    caseFolded.add(normalized.toLowerCase());
    if (isDirectory) {
      directories.add(normalized);
    } else {
      files.set(normalized, Buffer.from(tar.subarray(offset, offset + size)));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (
    endBlocks !== 2 ||
    tar.subarray(offset).some((byte) => byte !== 0) ||
    files.size === 0
  ) {
    throw new Error(`${label} has an invalid tar terminator`);
  }
  return { files, directories };
}

function tarPath(header) {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  return prefix === "" ? name : `${prefix}/${name}`;
}

function tarString(header, start, length) {
  const field = header.subarray(start, start + length);
  const zero = field.indexOf(0);
  const bytes = zero === -1 ? field : field.subarray(0, zero);
  return bytes.toString("utf8");
}

function parseOctal(header, start, length) {
  const value = tarString(header, start, length).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error("tar numeric field is invalid");
  }
  return Number.parseInt(value, 8);
}

function tarChecksum(header) {
  let checksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 32 : header[index];
  }
  return checksum;
}

function allowedBrokerPackagePath(path) {
  if (!canonicalRelativePath(path)) return false;
  if (["README.md", "package.json"].includes(path)) return true;
  const [root, ...rest] = path.split("/");
  return ["src", "services", "schemas"].includes(root) && rest.length > 0;
}

function verifyExactTree({ root, expected, label }) {
  const expectedByPath = expectedMap(expected, label);
  const expectedDirectories = directorySet(expectedByPath.keys());
  const actual = listTree(resolve(root), expectedDirectories, label);
  if (
    actual.length !== expectedByPath.size ||
    actual.some((entry) => !expectedByPath.has(entry.path))
  ) {
    throw new Error(`${label} file set does not match its archive`);
  }
  for (const entry of actual) {
    if (
      sha256(readStableRegularFile(entry.absolutePath, `${label} ${entry.path}`)) !==
      expectedByPath.get(entry.path)
    ) {
      throw new Error(`${label} file digest does not match: ${entry.path}`);
    }
  }
}

function expectedMap(expected, label) {
  const entries = expected instanceof Map ? [...expected] : expected;
  const result = new Map();
  const caseFolded = new Set();
  for (const value of entries) {
    const [path, digest] = Array.isArray(value)
      ? value
      : [value?.path, value?.sha256];
    if (
      !canonicalRelativePath(path) ||
      !/^[0-9a-f]{64}$/u.test(digest ?? "") ||
      result.has(path) ||
      caseFolded.has(path.toLowerCase())
    ) {
      throw new Error(`${label} expected file identity is invalid`);
    }
    result.set(path, digest);
    caseFolded.add(path.toLowerCase());
  }
  if (result.size === 0) throw new Error(`${label} expected file set is empty`);
  return result;
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

function listTree(root, expectedDirectories, label) {
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`${label} root must be a real directory`);
  }
  const files = [];
  walk(root, root, expectedDirectories, files, label);
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

function walk(root, directory, expectedDirectories, files, label) {
  for (const name of readdirSync(directory).sort()) {
    const absolutePath = join(directory, name);
    const path = relative(root, absolutePath).replaceAll("\\", "/");
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink: ${path}`);
    }
    if (stats.isDirectory()) {
      if (!expectedDirectories.has(path)) {
        throw new Error(`${label} contains an unexpected directory: ${path}`);
      }
      walk(root, absolutePath, expectedDirectories, files, label);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`${label} contains a non-regular file: ${path}`);
    }
    if (Number.isInteger(stats.nlink) && stats.nlink !== 1) {
      throw new Error(`${label} contains a hard-linked file: ${path}`);
    }
    files.push({ absolutePath, path });
  }
}

function readStableRegularFile(path, label) {
  let descriptor;
  try {
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (Number.isInteger(before.nlink) && before.nlink !== 1)
    ) {
      throw new Error("path is not a single-link regular file");
    }
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (!stableIdentity(before, opened)) {
      throw new Error("file identity changed while opening");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!stableIdentity(opened, after)) {
      throw new Error("file identity changed while reading");
    }
    return bytes;
  } catch (error) {
    throw new Error(`${label} is not stable: ${error.message}`);
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

function canonicalRelativePath(path) {
  return (
    typeof path === "string" &&
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((segment) => !["", ".", ".."].includes(segment))
  );
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function exactKeys(value, expected) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")
  ) {
    throw new Error("broker bootstrap object shape is invalid");
  }
}

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startBrokerBootstrap();
}
