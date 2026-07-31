import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function createControllerPackageManifest({
  packageRoot,
  archivePath,
  targetSha,
  workflowSha,
}) {
  if (
    !/^[0-9a-f]{40}$/u.test(targetSha ?? "") ||
    !/^[0-9a-f]{40}$/u.test(workflowSha ?? "")
  ) {
    throw new Error("controller package requires exact target/workflow SHAs");
  }
  const root = resolve(packageRoot);
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("controller package root must be a real directory");
  }
  const files = listFiles(root)
    .map((path) => ({
      path: relative(root, path).replaceAll("\\", "/"),
      sha256: sha256(readFileSync(path)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) {
    throw new Error("controller package manifest cannot be empty");
  }
  return {
    schemaVersion: 1,
    package: "@forge3d/browser-lab-controller",
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    targetSha,
    workflowSha,
    archive: basename(archivePath),
    archiveSha256: sha256(readFileSync(archivePath)),
    files,
  };
}

function listFiles(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw new Error(`controller package cannot contain symlinks: ${path}`);
      }
      if (stats.isFile() && Number.isInteger(stats.nlink) && stats.nlink !== 1) {
        throw new Error(`controller package cannot contain hard links: ${path}`);
      }
      if (!stats.isDirectory() && !stats.isFile()) {
        throw new Error(
          `controller package cannot contain non-regular files: ${path}`,
        );
      }
      return stats.isDirectory() ? listFiles(path) : [path];
    });
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
  const manifest = createControllerPackageManifest({
    packageRoot: args.get("--package-root"),
    archivePath: args.get("--archive"),
    targetSha: args.get("--target-sha"),
    workflowSha: args.get("--workflow-sha"),
  });
  writeFileSync(args.get("--output"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, manifest }));
}
