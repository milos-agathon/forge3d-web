import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";

export function buildDistributionEntries(root, { excludePaths = [] } = {}) {
  const entries = [];
  walk(root, root, entries, new Set(excludePaths));
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function createRunnerDistributionManifest({
  runnerVersion,
  generatedAt,
  distributions,
}) {
  if (!/^\d+\.\d+\.\d+$/u.test(runnerVersion)) {
    throw new Error("runner version must be a semantic version without a v prefix");
  }
  const platforms = new Set();
  const normalized = distributions.map((distribution) => {
    if (platforms.has(distribution.platform)) {
      throw new Error(`duplicate runner platform: ${distribution.platform}`);
    }
    platforms.add(distribution.platform);
    if (!/^[0-9a-f]{64}$/u.test(distribution.archiveSha256)) {
      throw new Error(`${distribution.platform} archive SHA-256 is invalid`);
    }
    return {
      platform: distribution.platform,
      archiveFileName: distribution.archiveFileName,
      archiveSha256: distribution.archiveSha256,
      entries: buildDistributionEntries(distribution.root),
    };
  });
  return {
    schemaVersion: 1,
    runnerVersion,
    generatedAt: new Date(generatedAt).toISOString(),
    distributions: normalized.sort((left, right) =>
      left.platform.localeCompare(right.platform),
    ),
  };
}

function walk(root, directory, entries, excludePaths) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const normalizedPath = relative(root, path).split(sep).join("/");
    if (excludePaths.has(normalizedPath)) continue;
    const stats = lstatSync(path);
    const mode = (stats.mode & 0o7777).toString(8).padStart(4, "0");
    if (stats.isSymbolicLink()) {
      entries.push({
        path: normalizedPath,
        type: "symlink",
        size: 0,
        mode,
        sha256: null,
        target: readlinkSync(path),
      });
    } else if (stats.isDirectory()) {
      entries.push({
        path: normalizedPath,
        type: "directory",
        size: 0,
        mode,
        sha256: null,
        target: null,
      });
      walk(root, path, entries, excludePaths);
    } else if (stats.isFile()) {
      entries.push({
        path: normalizedPath,
        type: "file",
        size: stats.size,
        mode,
        sha256: sha256Hex(readFileSync(path)),
        target: null,
      });
    } else {
      throw new Error(`runner archive contains unsupported entry ${normalizedPath}`);
    }
  }
}

function parseArguments(argv) {
  const values = new Map();
  const distributions = [];
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    if (key === "--distribution") {
      distributions.push(value);
    } else if (values.has(key)) {
      throw new Error(`duplicate argument ${key}`);
    } else {
      values.set(key, value);
    }
  }
  return { values, distributions };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, distributions } = parseArguments(process.argv.slice(2));
  const output = values.get("--output");
  if (!output || distributions.length === 0) {
    throw new Error("--output and at least one --distribution are required");
  }
  const manifest = createRunnerDistributionManifest({
    runnerVersion: values.get("--runner-version"),
    generatedAt: values.get("--generated-at") ?? new Date(),
    distributions: distributions.map((encoded) => {
      const [platform, archiveFileName, archiveSha256, root] = encoded.split("|");
      if (!platform || !archiveFileName || !archiveSha256 || !root) {
        throw new Error(
          "--distribution must use platform|archiveFileName|archiveSha256|root",
        );
      }
      return { platform, archiveFileName, archiveSha256, root };
    }),
  });
  const bytes = canonicalJson(manifest);
  writeFileSync(output, bytes, { encoding: "utf8", mode: 0o644 });
  console.log(
    JSON.stringify({
      output,
      sha256: sha256Hex(bytes),
      distributionCount: manifest.distributions.length,
      entryCount: manifest.distributions.reduce(
        (sum, distribution) => sum + distribution.entries.length,
        0,
      ),
    }),
  );
}
