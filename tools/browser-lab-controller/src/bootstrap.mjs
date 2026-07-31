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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyControllerBootstrap({
  packageManifestPath,
  installationReceiptPath,
  packageRoot,
  controllerAssetId,
  executedPackageRoot = packageRoot,
}) {
  if (resolve(packageRoot) !== resolve(executedPackageRoot)) {
    throw new Error("controller configured package root is not the executed package root");
  }
  const manifestBytes = readStableRegularFile(
    packageManifestPath,
    "controller package manifest",
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const receipt = JSON.parse(
    readStableRegularFile(
      installationReceiptPath,
      "controller installation receipt",
    ).toString("utf8"),
  );
  assertControllerManifestAndReceipt({
    manifest,
    manifestBytes,
    receipt,
    controllerAssetId,
  });
  verifyExactTree({
    root: packageRoot,
    expected: manifest.files,
    label: "controller installed package",
  });
}

export async function startControllerBootstrap({
  argv = process.argv,
  baseEnvironment = process.env,
  executedPackageRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
  ),
  loadRuntime = () => import("./controller-service.mjs"),
} = {}) {
  const environmentFileIndex = argv.indexOf("--environment-file");
  const environment =
    environmentFileIndex === -1
      ? { ...baseEnvironment }
      : loadEnvironmentFile(argv[environmentFileIndex + 1], baseEnvironment);
  verifyControllerBootstrap({
    packageManifestPath: required(
      environment,
      "FORGE3D_CONTROLLER_PACKAGE_MANIFEST_FILE",
    ),
    installationReceiptPath: required(
      environment,
      "FORGE3D_CONTROLLER_INSTALLATION_RECEIPT_FILE",
    ),
    packageRoot: required(
      environment,
      "FORGE3D_CONTROLLER_PACKAGE_ROOT",
    ),
    controllerAssetId: required(
      environment,
      "FORGE3D_CONTROLLER_ASSET_ID",
    ),
    executedPackageRoot,
  });
  const { createInstalledControllerService } = await loadRuntime();
  const service = createInstalledControllerService({ environment });
  service.start();
  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return service;
}

function assertControllerManifestAndReceipt({
  manifest,
  manifestBytes,
  receipt,
  controllerAssetId,
}) {
  exactKeys(manifest, [
    "schemaVersion",
    "package",
    "version",
    "targetSha",
    "workflowSha",
    "archive",
    "archiveSha256",
    "files",
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.package !== "@forge3d/browser-lab-controller" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(manifest.version ?? "") ||
    !/^[0-9a-f]{40}$/u.test(manifest.targetSha ?? "") ||
    !/^[0-9a-f]{40}$/u.test(manifest.workflowSha ?? "") ||
    typeof manifest.archive !== "string" ||
    manifest.archive === "" ||
    !/^[0-9a-f]{64}$/u.test(manifest.archiveSha256 ?? "") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error("controller bootstrap package manifest is invalid");
  }
  expectedMap(manifest.files, "controller installed package");
  for (const requiredPath of [
    "package.json",
    "src/bootstrap.mjs",
    "src/controller-service.mjs",
  ]) {
    if (!manifest.files.some((entry) => entry.path === requiredPath)) {
      throw new Error(
        `controller bootstrap package is missing runtime file: ${requiredPath}`,
      );
    }
  }
  assertServiceReceipt(receipt, {
    manifest,
    manifestSha256: sha256(manifestBytes),
    configurationSha256: sha256(
      Buffer.from(canonicalJson(manifest.files)),
    ),
    controllerAssetId,
  });
}

function assertServiceReceipt(
  receipt,
  {
    manifest,
    manifestSha256,
    configurationSha256,
    controllerAssetId,
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
  const repository = "milos-agathon/forge3d-web";
  if (
    !/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(controllerAssetId ?? "") ||
    receipt.schemaVersion !== 1 ||
    receipt.recordType !== "lab-service-deployment-provenance" ||
    receipt.service !== "controller" ||
    receipt.serviceIdentity !== `controller:${controllerAssetId}` ||
    !Number.isInteger(receipt.packageRun.id) ||
    receipt.packageRun.id < 1 ||
    !Number.isInteger(receipt.packageRun.attempt) ||
    receipt.packageRun.attempt < 1 ||
    !Number.isInteger(receipt.packageRun.artifact.id) ||
    receipt.packageRun.artifact.id < 1 ||
    receipt.packageRun.artifact.name !==
      `browser-lab-controller-${manifest.targetSha}-${receipt.packageRun.id}-${receipt.packageRun.attempt}` ||
    !/^sha256:[0-9a-f]{64}$/u.test(
      receipt.packageRun.artifact.digest ?? "",
    ) ||
    receipt.source.repository !== repository ||
    receipt.source.targetSha !== manifest.targetSha ||
    receipt.source.workflowSha !== manifest.workflowSha ||
    receipt.packageManifest.sha256 !== manifestSha256 ||
    receipt.packageManifest.attestation.verified !== true ||
    receipt.packageManifest.attestation.repository !== repository ||
    receipt.packageManifest.attestation.signerWorkflow !==
      `${repository}/.github/workflows/browser-lab-controller.yml` ||
    receipt.packageManifest.attestation.sourceRef !== "refs/heads/main" ||
    receipt.packageManifest.attestation.sourceDigest !== manifest.targetSha ||
    receipt.packageManifest.attestation.denySelfHostedRunners !== true ||
    receipt.archive.name !== manifest.archive ||
    receipt.archive.sha256 !== manifest.archiveSha256 ||
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
    throw new Error("controller bootstrap administrator receipt is invalid");
  }
}

function verifyExactTree({ root, expected, label }) {
  const expectedByPath = expectedMap(expected, label);
  const expectedDirectories = directorySet(expectedByPath.keys());
  const actual = listTree(resolve(root), expectedDirectories, label);
  if (
    actual.length !== expectedByPath.size ||
    actual.some((entry) => !expectedByPath.has(entry.path))
  ) {
    throw new Error(`${label} file set does not match its manifest`);
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

function expectedMap(entries, label) {
  const result = new Map();
  const caseFolded = new Set();
  for (const entry of entries) {
    const path = entry?.path;
    if (
      !canonicalRelativePath(path) ||
      !/^[0-9a-f]{64}$/u.test(entry?.sha256 ?? "") ||
      result.has(path) ||
      caseFolded.has(path.toLowerCase())
    ) {
      throw new Error(`${label} manifest file identity is invalid`);
    }
    result.set(path, entry.sha256);
    caseFolded.add(path.toLowerCase());
  }
  if (result.size === 0) {
    throw new Error(`${label} manifest file set is empty`);
  }
  return result;
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

function loadEnvironmentFile(path, baseEnvironment) {
  const environment = { ...baseEnvironment };
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      separator < 1 ||
      !/^[A-Z][A-Z0-9_]+$/u.test(name) ||
      value === "" ||
      Object.hasOwn(environment, name)
    ) {
      throw new Error(`controller environment line is invalid: ${rawLine}`);
    }
    environment[name] = value;
  }
  return environment;
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
    throw new Error("controller bootstrap object shape is invalid");
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
  await startControllerBootstrap();
}
