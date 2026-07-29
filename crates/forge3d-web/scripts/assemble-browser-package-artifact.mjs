import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, "..", "..");

export function assembleBrowserPackageArtifact({
  evidenceDirectory,
  outputDirectory,
  targetSha,
  repository = "milos-agathon/forge3d-web",
  workflowPath = ".github/workflows/browser-package.yml",
  workflowSha = targetSha,
  runId = null,
  runAttempt = null,
  repositoryRootPath = repositoryRoot,
}) {
  assertSha(targetSha, "target SHA");
  assertSha(workflowSha, "workflow SHA");
  const evidence = resolve(evidenceDirectory);
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  const tarballs = readdirSync(evidence).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error("browser gate must produce exactly one npm tarball");
  }
  const tarballName = tarballs[0];
  const tarballBytes = readFileSync(join(evidence, tarballName));
  const packageJson = JSON.parse(
    readTarEntry(gunzipSync(tarballBytes), "package/package.json").toString(
      "utf8",
    ),
  );
  assertNoWorkspaceDependencies(packageJson);
  const packageEvidence = readJson(join(evidence, "package-evidence.json"));
  const browserEvidence = readJson(join(evidence, "browser-gate.json"));
  const tarballSha256 = sha256(tarballBytes);
  if (
    packageEvidence.commit !== targetSha ||
    packageEvidence.packageSha256 !== tarballSha256 ||
    browserEvidence.sourceRevision?.commit !== targetSha ||
    browserEvidence.artifact?.sha256 !== tarballSha256
  ) {
    throw new Error("package/browser evidence does not bind the exact target tarball");
  }
  assertCleanExactHead(repositoryRootPath, targetSha);

  copyFileSync(join(evidence, tarballName), join(output, tarballName));
  copyFileSync(
    join(evidence, "package-evidence.json"),
    join(output, "package-evidence.json"),
  );
  copyFileSync(
    join(evidence, "browser-gate.json"),
    join(output, "browser-gate.json"),
  );
  for (const file of [
    "browser-evidence.schema.json",
    "adapter-attestation.schema.json",
  ]) {
    copyFileSync(
      join(packageRoot, "tests", "browser", file),
      join(output, file),
    );
  }
  for (const file of [
    "assemble-browser-package-artifact.mjs",
    "materialize-browser-fixture.mjs",
    "capture-host-inventory.mjs",
    "capture-host-gpu-evidence.mjs",
    "join-adapter-attestation.mjs",
    "create-browser-matrix-record.mjs",
    "canonical-json.mjs",
    "create-run-nonce.mjs",
    "serve-browser-fixture.mjs",
    "probe-browser-fixture.mjs",
  ]) {
    copyFileSync(join(packageRoot, "scripts", file), join(output, file));
  }
  const fixtureArchiveName = "consumer-fixture.tar.gz";
  const fixtureArchive = createTarGz(join(evidence, "consumer-fixture"));
  writeFileSync(join(output, fixtureArchiveName), fixtureArchive, { mode: 0o600 });
  writeFileSync(
    join(output, `${tarballName}.sha256`),
    `${tarballSha256}  ${tarballName}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const metadata = {
    schemaVersion: 1,
    repository,
    workflowPath,
    workflowSha,
    runId,
    runAttempt,
    targetSha,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    tarball: tarballName,
    packageSha256: tarballSha256,
    sourceTreeClean: true,
  };
  writeFileSync(
    join(output, "source-tree-status.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        targetSha,
        headSha: targetSha,
        clean: true,
        statusEntries: [],
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    join(output, "commit-metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const files = readdirSync(output)
    .sort()
    .map((name) => ({
      name,
      sha256: sha256(readFileSync(join(output, name))),
    }));
  const manifest = {
    schemaVersion: 1,
    ...metadata,
    files,
  };
  writeFileSync(
    join(output, "browser-package-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return manifest;
}

export function assertNoWorkspaceDependencies(packageJson) {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, value] of Object.entries(packageJson[field] ?? {})) {
      if (/^(?:file|link|workspace):/u.test(String(value))) {
        throw new Error(`${field}.${name} uses a prohibited workspace dependency`);
      }
    }
  }
}

export function createTarGz(directory) {
  const root = resolve(directory);
  const blocks = [];
  for (const path of listFiles(root)) {
    const name = relative(root, path).replaceAll("\\", "/");
    const bytes = readFileSync(path);
    blocks.push(createTarHeader(name, bytes.length), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { mtime: 0 });
}

function createTarHeader(name, size) {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`consumer fixture path exceeds tar header limit: ${name}`);
  }
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

function writeString(buffer, offset, length, value) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 2, "0");
  buffer.write(`${text}\0 `, offset, length, "ascii");
}

function listFiles(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw new Error(`consumer fixture cannot contain symlinks: ${path}`);
      }
      return stats.isDirectory() ? listFiles(path) : [path];
    });
}

function readTarEntry(tar, expectedName) {
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0.*$/u, "");
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/u, "")
      .trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const bodyStart = offset + 512;
    if (name === expectedName) {
      return tar.subarray(bodyStart, bodyStart + size);
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`npm tarball is missing ${expectedName}`);
}

function assertCleanExactHead(root, targetSha) {
  const head = runGit(root, ["rev-parse", "HEAD"]);
  const status = runGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (head !== targetSha || status !== "") {
    throw new Error("browser package assembly requires a clean exact-target worktree");
  }
}

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function assertSha(value, label) {
  if (!/^[0-9a-f]{40}$/u.test(value ?? "")) {
    throw new Error(`${label} must be a full lowercase commit SHA`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    result.set(key, value);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const manifest = assembleBrowserPackageArtifact({
    evidenceDirectory: args.get("--evidence"),
    outputDirectory: args.get("--output"),
    targetSha: args.get("--target-sha"),
    workflowSha: args.get("--workflow-sha"),
    runId: Number(args.get("--run-id")),
    runAttempt: Number(args.get("--run-attempt")),
  });
  console.log(JSON.stringify({ ok: true, manifest }));
}
