import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";
import { buildDistributionEntries } from "./generate-runner-distribution-manifest.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const infrastructureRoot = join(packageRoot, "tests", "infrastructure");

export function verifyRunnerPolicy({
  browserPolicy,
  manifest,
  transientPolicy,
  requireCanary = false,
}) {
  if (
    browserPolicy.runnerVersion !== manifest.runnerVersion ||
    browserPolicy.runnerVersion !== transientPolicy.runnerVersion
  ) {
    throw new Error("runner version is inconsistent across checked policies");
  }
  if (
    browserPolicy.repositoryJitRunnerGroupId !== 1 ||
    browserPolicy.jitWorkFolder !== "_work"
  ) {
    throw new Error("repository JIT group or work folder changed");
  }
  if (
    browserPolicy.runnerDistributionManifestSha256 !== sha256Hex(manifest) ||
    browserPolicy.runnerTransientPathPolicySha256 !== sha256Hex(transientPolicy)
  ) {
    throw new Error("runner manifest or transient policy digest changed");
  }
  const archives = new Map(
    browserPolicy.archives.map((archive) => [archive.platform, archive]),
  );
  for (const distribution of manifest.distributions) {
    const archive = archives.get(distribution.platform);
    if (
      !archive ||
      archive.fileName !== distribution.archiveFileName ||
      archive.sha256 !== distribution.archiveSha256
    ) {
      throw new Error(`${distribution.platform} archive pin disagrees with manifest`);
    }
  }
  validateTransientPolicy(transientPolicy);
  if (
    requireCanary &&
    (browserPolicy.provisioningState !== "active" ||
      transientPolicy.canaryState !== "verified")
  ) {
    throw new Error("runner policy has not passed the clean JIT canary");
  }
  return { ok: true, runnerVersion: browserPolicy.runnerVersion };
}

export function verifyRunnerTree({
  root,
  platform,
  manifest,
  transientPolicy,
}) {
  const distribution = manifest.distributions.find(
    (candidate) => candidate.platform === platform,
  );
  if (!distribution) {
    throw new Error(`runner manifest does not contain ${platform}`);
  }
  validateTransientPolicy(transientPolicy);
  const transientRoots = transientPolicyRoots(transientPolicy);
  const expected = new Map(
    distribution.entries.map((entry) => [entry.path, entry]),
  );
  const actual = new Map(
    buildDistributionEntries(root, {
      excludePaths: [...transientRoots.keys()],
    }).map((entry) => [entry.path, entry]),
  );
  for (const [path, expectedEntry] of expected) {
    const actualEntry = actual.get(path);
    if (!actualEntry) {
      throw new Error(`runner distribution entry is missing: ${path}`);
    }
    if (canonicalJson(actualEntry) !== canonicalJson(expectedEntry)) {
      throw new Error(`runner distribution entry changed: ${path}`);
    }
    actual.delete(path);
  }
  for (const entry of actual.values()) {
    throw new Error(`unknown runner path outside transient policy: ${entry.path}`);
  }
  const transientEntries = inspectTransientRoots(root, transientRoots);
  return {
    ok: true,
    immutableEntryCount: expected.size,
    transientEntries,
  };
}

function validateTransientPolicy(policy) {
  const seen = new Set();
  for (const entry of policy.paths) {
    if (seen.has(entry.pattern)) {
      throw new Error(`duplicate transient path pattern: ${entry.pattern}`);
    }
    seen.add(entry.pattern);
    if (
      entry.pattern === "*" ||
      entry.pattern === "**" ||
      entry.pattern.startsWith("/") ||
      entry.pattern.includes("..") ||
      (entry.kind === "tree" && !/^[A-Za-z0-9_.-]+\/\*\*$/u.test(entry.pattern)) ||
      (entry.kind === "file" && !/^[A-Za-z0-9_.-]+$/u.test(entry.pattern))
    ) {
      throw new Error(`transient path pattern is too broad or unsafe: ${entry.pattern}`);
    }
  }
}

function transientPolicyRoots(policy) {
  const roots = new Map();
  for (const entry of policy.paths) {
    const root =
      entry.kind === "tree"
        ? entry.pattern.replace(/\/\*\*$/u, "")
        : entry.pattern;
    if (roots.has(root)) {
      throw new Error(`duplicate transient path root: ${root}`);
    }
    roots.set(root, entry.kind);
  }
  return roots;
}

function inspectTransientRoots(root, transientRoots) {
  const present = [];
  for (const [name, kind] of transientRoots) {
    const path = join(root, name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (
      stats.isSymbolicLink() ||
      (kind === "tree" && !stats.isDirectory()) ||
      (kind === "file" && !stats.isFile())
    ) {
      throw new Error(`runner transient path changed kind: ${name}`);
    }
    present.push(name);
  }
  return present.sort();
}

function readJson(name) {
  return JSON.parse(readFileSync(join(infrastructureRoot, name), "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf("--root");
  const platformIndex = process.argv.indexOf("--platform");
  const requireCanary = process.argv.includes("--require-canary");
  const browserPolicy = readJson("browser-policy.json");
  const manifest = readJson("runner-distribution-manifest.json");
  const transientPolicy = readJson("runner-transient-path-policy.json");
  const policyResult = verifyRunnerPolicy({
    browserPolicy,
    manifest,
    transientPolicy,
    requireCanary,
  });
  const treeResult =
    rootIndex >= 0 && platformIndex >= 0
      ? verifyRunnerTree({
          root: process.argv[rootIndex + 1],
          platform: process.argv[platformIndex + 1],
          manifest,
          transientPolicy,
        })
      : null;
  console.log(JSON.stringify({ ...policyResult, tree: treeResult }, null, 2));
}
