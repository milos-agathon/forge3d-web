import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../src/canonical-json.mjs";
import {
  BROKER_PROTOCOL_VERSION,
  CLEANUP_PROTOCOL_VERSION,
} from "../src/protocol.mjs";

export function createBrokerPackageManifest({
  repositoryRoot,
  archivePath,
  targetSha,
  workflowSha,
}) {
  for (const [label, value] of [
    ["target SHA", targetSha],
    ["workflow SHA", workflowSha],
  ]) {
    if (!/^[0-9a-f]{40}$/u.test(value ?? "")) {
      throw new Error(`${label} must be a full lowercase commit SHA`);
    }
  }
  const configurationPaths = [
    "crates/forge3d-web/tests/infrastructure/browser-policy.json",
    "crates/forge3d-web/tests/infrastructure/broker-lifecycle.schema.json",
    "crates/forge3d-web/tests/infrastructure/broker-protocol.schema.json",
    "crates/forge3d-web/tests/infrastructure/hardware-matrix.json",
    "crates/forge3d-web/tests/infrastructure/repository-trust-policy.json",
    "crates/forge3d-web/tests/infrastructure/runner-distribution-manifest.json",
    "crates/forge3d-web/tests/infrastructure/runner-transient-path-policy.json",
    "crates/forge3d-web/tests/infrastructure/workflow-actions-lock.json",
  ];
  const configuration = configurationPaths.map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(repositoryRoot, path))),
  }));
  return {
    schemaVersion: 1,
    repository: "milos-agathon/forge3d-web",
    targetSha,
    workflowSha,
    brokerProtocolVersion: BROKER_PROTOCOL_VERSION,
    cleanupProtocolVersion: CLEANUP_PROTOCOL_VERSION,
    archive: {
      name: basename(archivePath),
      sha256: sha256(readFileSync(archivePath)),
    },
    configuration,
    configurationSha256: sha256(Buffer.from(canonicalJson(configuration))),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    values.set(key, value);
  }
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const outputPath = resolve(args.get("--output"));
  const repositoryRoot = resolve(args.get("--repository-root"));
  const archivePath = resolve(args.get("--archive"));
  const manifest = createBrokerPackageManifest({
    repositoryRoot,
    archivePath,
    targetSha: args.get("--target-sha"),
    workflowSha: args.get("--workflow-sha"),
  });
  writeFileSync(outputPath, canonicalJson(manifest), {
    encoding: "utf8",
    mode: 0o644,
  });
  console.log(
    JSON.stringify({
      output: relative(repositoryRoot, outputPath),
      archiveSha256: manifest.archive.sha256,
      configurationSha256: manifest.configurationSha256,
    }),
  );
}
