import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ISSUE_PROTOCOL, CLEANUP_PROTOCOL } from "../src/broker-client.mjs";
import { canonicalJson } from "../src/controller-signing.mjs";

export const CONTROLLER_PROTOCOL_VERSION =
  "forge3d-browser-lab-controller/v1";

export function createControllerPackageManifest({
  packageRoot,
  repositoryRoot,
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
  const repository = resolve(repositoryRoot);
  const files = listFiles(root)
    .map((path) => ({
      path: relative(root, path).replaceAll("\\", "/"),
      sha256: sha256(readFileSync(path)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) {
    throw new Error("controller package manifest cannot be empty");
  }
  const configurationPaths = [
    "crates/forge3d-web/tests/infrastructure/browser-policy.json",
    "crates/forge3d-web/tests/infrastructure/controller-helper-digest-policy.json",
    "crates/forge3d-web/tests/infrastructure/controller-helper-digest-policy.schema.json",
    "crates/forge3d-web/tests/infrastructure/controller-health-endpoints.json",
    "crates/forge3d-web/tests/infrastructure/controller-protocol.schema.json",
    "crates/forge3d-web/tests/infrastructure/hardware-matrix.json",
    "crates/forge3d-web/tests/infrastructure/lab-service-installation.schema.json",
    "crates/forge3d-web/tests/infrastructure/runner-distribution-manifest.json",
    "crates/forge3d-web/tests/infrastructure/runner-diagnostic-retention.schema.json",
    "crates/forge3d-web/tests/infrastructure/runner-transient-path-policy.json",
    "crates/forge3d-web/tests/infrastructure/workflow-actions-lock.json",
  ];
  const configuration = configurationPaths.map((path) => ({
    path,
    sha256: sha256(readFileSync(join(repository, path))),
  }));
  return {
    schemaVersion: 1,
    package: "@forge3d/browser-lab-controller",
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    targetSha,
    workflowSha,
    protocols: {
      controller: CONTROLLER_PROTOCOL_VERSION,
      broker: ISSUE_PROTOCOL,
      cleanup: CLEANUP_PROTOCOL,
    },
    archive: {
      name: basename(archivePath),
      sha256: sha256(readFileSync(archivePath)),
    },
    configuration,
    configurationSha256: sha256(Buffer.from(canonicalJson(configuration))),
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
    repositoryRoot: args.get("--repository-root"),
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
