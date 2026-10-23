import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommandInvocation } from "./command-executable.mjs";

function run(command, args, cwd) {
  const call = resolveCommandInvocation(command, args);
  const result = spawnSync(call.command, call.args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(result.error?.message ?? result.stdout + result.stderr);
  return result.stdout;
}
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
function revision(root) {
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  if (status.trim()) {
    const diff = run("git", ["diff", "--no-ext-diff", "--stat", "HEAD"], root).trim();
    throw Error(`Installed artifact requires clean committed release inputs\nGit status:\n${status.trimEnd()}\nTracked diff:\n${diff || "(none)"}`);
  }
  return run("git", ["rev-parse", "HEAD"], root).trim();
}

// Creation owns the complete provenance chain. A manifest is published only after
// installation succeeds; consumers never fall back to source or rebuild on error.
export function createInstalledArtifact(packageRoot, manifestPath) {
  packageRoot = resolve(packageRoot);
  manifestPath = resolve(manifestPath);
  const sourceRevision = revision(packageRoot);
  run("npm", ["run", "build"], packageRoot);
  if (revision(packageRoot) !== sourceRevision) throw Error("Release input changed during build");
  const directory = dirname(manifestPath);
  mkdirSync(directory, { recursive: true });
  const pack = join(directory, "pack"), installation = join(directory, "installation");
  mkdirSync(pack); mkdirSync(installation);
  const packages = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", pack], packageRoot));
  if (!Array.isArray(packages) || packages.length !== 1) throw Error("Exactly one tarball expected");
  const metadata = packages[0], tarball = join(pack, metadata.filename);
  writeFileSync(join(installation, "package.json"), JSON.stringify({ private: true, type: "module", devDependencies: { "selenium-webdriver": "4.35.0" } }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installation);
  const installed = join(installation, "node_modules", metadata.name);
  const files = Object.fromEntries(metadata.files.map(({path}) => [path, digest(join(installed, path))]));
  for (const file of ["dist/index.js", "dist/forge3d_web_bg.wasm", "types/index.d.ts"])
    if (!files[file]) throw Error(`Missing emitted artifact: ${file}`);
  const manifest = { version: 1, packageRoot, revision: sourceRevision, metadata, tarball,
    packageSha256: digest(tarball), installed, installation, files };
  if (revision(packageRoot) !== sourceRevision) throw Error("Release input changed during packing");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

export function verifyInstalledArtifact(manifestPath, packageRoot) {
  const artifact = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (artifact.version !== 1 || resolve(artifact.packageRoot) !== resolve(packageRoot)
      || artifact.revision !== revision(packageRoot)) throw Error("Installed artifact provenance mismatch");
  if (digest(artifact.tarball) !== artifact.packageSha256) throw Error("Installed artifact tarball digest mismatch");
  if (!artifact.files || !Object.keys(artifact.files).length) throw Error("Missing emitted file inventory");
  for (const [file, hash] of Object.entries(artifact.files))
    if (digest(join(artifact.installed, file)) !== hash) throw Error(`Installed artifact file changed: ${file}`);
  return artifact;
}

export function attachInstalledSuite({ packageRoot, consumer, suite, artifactPath = process.env.FORGE3D_INSTALLED_ARTIFACT }) {
  const manifestPath = artifactPath ? resolve(artifactPath) : join(dirname(consumer), "artifact", "manifest.json");
  if (!artifactPath) createInstalledArtifact(packageRoot, manifestPath);
  const artifact = verifyInstalledArtifact(manifestPath, packageRoot);
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  symlinkSync(join(artifact.installation, "node_modules"), join(consumer, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  appendFileSync(join(dirname(manifestPath), "suites.jsonl"), JSON.stringify({ suite, revision: artifact.revision, packageSha256: artifact.packageSha256 }) + "\n");
  return artifact;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = process.argv[2] ?? process.env.FORGE3D_INSTALLED_ARTIFACT;
  if (!manifestPath) throw Error("An artifact manifest destination is required");
  createInstalledArtifact(packageRoot, manifestPath);
}
