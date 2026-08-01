import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";
import { requiresImmutableReleaseSettings } from "./verify-repository-trust.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultOutput = join(
  packageRoot,
  "repository-trust-observation.json",
);

export function createRepositoryTrustObservation({
  verification,
  operation,
  consumers,
  workflow,
  run,
  candidateSha,
  targetSha,
  now = new Date(),
  nonce = randomBytes(16).toString("hex"),
}) {
  if (verification?.ok !== true) {
    throw new Error("a passing live repository-trust verification is required");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(operation ?? "")) {
    throw new Error("operation must be a lowercase kebab-case identifier");
  }
  const requireImmutableReleases = requiresImmutableReleaseSettings(operation);
  const immutableResponses = (verification.liveResponses ?? []).filter(
    (response) => response.name === "immutableReleases",
  );
  if (requireImmutableReleases) {
    if (
      verification.operation !== operation ||
      verification.repositorySettings?.immutableReleases?.enabled !== true ||
      typeof verification.repositorySettings.immutableReleases.enforcedByOwner !==
        "boolean" ||
      immutableResponses.length !== 1 ||
      immutableResponses[0].endpoint !==
        `/repos/${verification.repository.fullName}/immutable-releases` ||
      !/^[0-9a-f]{64}$/u.test(immutableResponses[0].sha256 ?? "")
    ) {
      throw new Error(
        "release-setting operation requires an exact immutable-release verification",
      );
    }
  } else if (
    verification.repositorySettings !== undefined ||
    immutableResponses.length !== 0
  ) {
    throw new Error(
      "non-release operation cannot carry immutable-release verification",
    );
  }
  if (!Array.isArray(consumers) || consumers.length === 0) {
    throw new Error("at least one intended consumer job/environment is required");
  }
  const consumerKeys = new Set();
  for (const consumer of consumers) {
    const key = `${consumer.job}@${consumer.environment}`;
    if (
      consumerKeys.has(key) ||
      !/^[A-Za-z0-9_.-]+$/u.test(consumer.job) ||
      !/^[A-Za-z0-9_.-]+$/u.test(consumer.environment)
    ) {
      throw new Error(`invalid or duplicate observation consumer: ${key}`);
    }
    consumerKeys.add(key);
  }
  for (const [label, sha] of [
    ["workflow SHA", workflow.sha],
    ["candidate SHA", candidateSha],
    ["target SHA", targetSha],
    ["current main SHA", verification.currentMainSha],
    ["trust epoch SHA", verification.trustEpochSha],
  ]) {
    if (!/^[0-9a-f]{40}$/u.test(sha ?? "")) {
      throw new Error(`${label} must be a full lowercase commit SHA`);
    }
  }
  if (workflow.ref !== "refs/heads/main") {
    throw new Error("observer workflow ref must be refs/heads/main");
  }
  if (!Number.isInteger(run.id) || run.id < 1 || !Number.isInteger(run.attempt) || run.attempt < 1) {
    throw new Error("run ID and attempt must be positive integers");
  }
  if (!/^[0-9a-f]{32}$/u.test(nonce)) {
    throw new Error("observation nonce must contain 128 random bits");
  }

  const observedAt = new Date(now);
  const expiresAt = new Date(observedAt.getTime() + 30 * 60 * 1000);
  return {
    schemaVersion: 1,
    repository: verification.repository,
    operation,
    consumers: [...consumers].sort((left, right) =>
      `${left.job}@${left.environment}`.localeCompare(
        `${right.job}@${right.environment}`,
      ),
    ),
    workflow,
    run,
    candidateSha,
    targetSha,
    currentMainSha: verification.currentMainSha,
    trustEpochSha: verification.trustEpochSha,
    policySha256: verification.policySha256,
    workflowActionsLockSha256: verification.workflowActionsLockSha256,
    ...(requireImmutableReleases
      ? { repositorySettings: verification.repositorySettings }
      : {}),
    requiredChecks: verification.requiredChecks,
    liveResponses: verification.liveResponses,
    nonce,
    observedAt: observedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function parseArguments(argv) {
  const values = new Map();
  const consumers = [];
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "<end>"}`);
    }
    if (name === "--consumer") {
      consumers.push(value);
    } else if (values.has(name)) {
      throw new Error(`duplicate argument: ${name}`);
    } else {
      values.set(name, value);
    }
  }
  return { values, consumers };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, consumers: consumerArgs } = parseArguments(process.argv.slice(2));
  const verificationPath = values.get("--verification");
  if (!verificationPath) {
    throw new Error("--verification is required");
  }
  const consumers = consumerArgs.map((value) => {
    const split = value.lastIndexOf("@");
    if (split < 1 || split === value.length - 1) {
      throw new Error("--consumer must use job@environment");
    }
    return { job: value.slice(0, split), environment: value.slice(split + 1) };
  });
  const observation = createRepositoryTrustObservation({
    verification: JSON.parse(readFileSync(verificationPath, "utf8")),
    operation: values.get("--operation"),
    consumers,
    workflow: {
      path:
        values.get("--workflow-path") ??
        process.env.GITHUB_WORKFLOW_REF?.split("@")[0]?.split("/").slice(2).join("/"),
      ref: values.get("--workflow-ref") ?? process.env.GITHUB_REF,
      sha: values.get("--workflow-sha") ?? process.env.GITHUB_WORKFLOW_SHA,
    },
    run: {
      id: Number(values.get("--run-id") ?? process.env.GITHUB_RUN_ID),
      attempt: Number(values.get("--run-attempt") ?? process.env.GITHUB_RUN_ATTEMPT),
    },
    candidateSha: values.get("--candidate-sha"),
    targetSha: values.get("--target-sha"),
  });
  const outputPath = values.get("--output") ?? defaultOutput;
  const bytes = canonicalJson(observation);
  writeFileSync(outputPath, bytes, { encoding: "utf8", mode: 0o600 });
  console.log(
    JSON.stringify({
      output: outputPath,
      observationContentSha256: sha256Hex(bytes),
      expiresAt: observation.expiresAt,
    }),
  );
}
