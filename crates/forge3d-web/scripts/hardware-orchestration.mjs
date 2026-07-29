import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const matrixPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "hardware-matrix.json",
);
const browserPolicyPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "browser-policy.json",
);

const infrastructureLane = "infrastructure-canary";
const manualLanes = new Set([
  "manual-mobile-multitouch",
  "manual-safari-trackpad",
]);

export function validateHardwareDispatch(inputs, matrix) {
  const trustedSha = requireSha(inputs.trustedSha, "trusted_sha");
  const packageRunId = requireDecimal(inputs.packageRunId, "packageRunId");
  const labReadinessRunId = optionalDecimal(
    inputs.labReadinessRunId,
    "labReadinessRunId",
  );
  const intakeReleaseId = optionalDecimal(
    inputs.intakeReleaseId,
    "intakeReleaseId",
  );
  const required = parseBoolean(inputs.required);
  const { asset, host } = resolveAsset(inputs.assetId, matrix);
  const productLanes = new Set(
    matrix.hosts.flatMap((candidate) => candidate.requiredBrowserLanes),
  );
  if (
    inputs.lane !== infrastructureLane &&
    !manualLanes.has(inputs.lane) &&
    !productLanes.has(inputs.lane)
  ) {
    throw new Error(`lane is not a checked closed value: ${inputs.lane}`);
  }

  let mode;
  if (inputs.lane === infrastructureLane) {
    if (!["host", "manual"].includes(inputs.canaryMode)) {
      throw new Error("infrastructure-canary requires canaryMode host|manual");
    }
    if (labReadinessRunId !== null) {
      throw new Error("infrastructure-canary cannot consume laboratory readiness");
    }
    if (inputs.canaryMode === "manual" && intakeReleaseId === null) {
      throw new Error("manual infrastructure canary requires intakeReleaseId");
    }
    if (inputs.canaryMode === "host" && intakeReleaseId !== null) {
      throw new Error("host infrastructure canary rejects intakeReleaseId");
    }
    if (inputs.canaryMode === "host" && asset !== null) {
      throw new Error("host infrastructure canary requires a host assetId");
    }
    mode = `canary-${inputs.canaryMode}`;
  } else if (manualLanes.has(inputs.lane)) {
    if (inputs.canaryMode) {
      throw new Error("product manual lane rejects canaryMode");
    }
    if (labReadinessRunId === null || intakeReleaseId === null) {
      throw new Error("product manual lane requires readiness and intake IDs");
    }
    mode = "manual";
  } else {
    if (inputs.canaryMode || intakeReleaseId !== null) {
      throw new Error("browser-family lane rejects canaryMode and intakeReleaseId");
    }
    if (labReadinessRunId === null) {
      throw new Error("browser-family lane requires labReadinessRunId");
    }
    if (
      !host.requiredBrowserLanes.includes(inputs.lane) &&
      inputs.lane !== "mobile-usb-controller"
    ) {
      throw new Error(`${inputs.lane} is not routed to ${host.assetId}`);
    }
    mode = "automated";
  }
  return {
    lane: inputs.lane,
    mode,
    canaryMode: inputs.canaryMode || null,
    required,
    trustedSha,
    packageRunId,
    labReadinessRunId,
    intakeReleaseId,
    assetId: inputs.assetId,
    hostId: host.assetId,
    hardwareLabel: host.requiredLabels[1],
  };
}

export function createPromotion({
  dispatch,
  matrix,
  trustEpochSha,
  workflowSha,
  packageManifestSha256,
  labInfrastructureDigest = null,
  manualSession = null,
  random = randomBytes,
}) {
  const validated = validateHardwareDispatch(dispatch, matrix);
  requireSha(trustEpochSha, "trustEpochSha");
  requireSha(workflowSha, "workflowSha");
  if (!/^[0-9a-f]{64}$/u.test(packageManifestSha256 ?? "")) {
    throw new Error("package manifest digest must be 64 lowercase hex");
  }
  if (
    validated.labReadinessRunId !== null &&
    !/^[0-9a-f]{64}$/u.test(labInfrastructureDigest ?? "")
  ) {
    throw new Error("product lanes require an exact laboratory digest");
  }
  const runnerNonce = random(16).toString("hex");
  if (!/^[0-9a-f]{32}$/u.test(runnerNonce)) {
    throw new Error("runner nonce must contain 128 random bits");
  }
  return {
    schemaVersion: 1,
    ...validated,
    trustEpochSha,
    workflowSha,
    packageManifestSha256,
    labInfrastructureDigest,
    manualSession,
    runnerNonce,
    nonceLabel: `jit-${runnerNonce}`,
    runnerName: `${validated.hostId}-${runnerNonce}`,
    customLabels: [
      "forge3d-web",
      validated.hardwareLabel,
      `jit-${runnerNonce}`,
    ],
  };
}

export function createRunnerAuthorization({
  promotion,
  queuedJob,
  repository = { id: 1259761852, name: "milos-agathon/forge3d-web" },
  workflow,
  run,
  promotionJobId,
  authorizationJobId,
  platformLabels = [],
  issuedAt = new Date(),
  policy,
}) {
  if (
    queuedJob.name !== "Browser Hardware / Ephemeral Execution" ||
    queuedJob.status !== "queued"
  ) {
    throw new Error("authorization requires the exact queued hardware job");
  }
  assertExactCustomLabels(queuedJob.labels, promotion.customLabels);
  const start = new Date(issuedAt);
  const record = {
    schemaVersion: 1,
    repository,
    workflow: {
      path: ".github/workflows/browser-hardware.yml",
      ref: "refs/heads/main",
      sha: workflow.sha,
      event: "workflow_dispatch",
    },
    run,
    promotionJobId,
    authorizationJobId,
    queuedHardwareJob: {
      id: queuedJob.id,
      name: queuedJob.name,
      status: queuedJob.status,
    },
    trustedSha: promotion.trustedSha,
    trustEpochSha: promotion.trustEpochSha,
    lane: promotion.lane,
    required: promotion.required,
    assetId: promotion.assetId,
    hostId: promotion.hostId,
    runnerNonce: promotion.runnerNonce,
    nonceLabel: promotion.nonceLabel,
    runnerName: promotion.runnerName,
    customLabels: [...promotion.customLabels],
    platformLabels: [...platformLabels].sort(),
    repositoryJitRunnerGroupId: policy.repositoryJitRunnerGroupId,
    workFolder: policy.jitWorkFolder,
    packageRunId: promotion.packageRunId,
    packageManifestSha256: promotion.packageManifestSha256,
    labReadiness:
      promotion.labReadinessRunId === null
        ? null
        : {
            runId: promotion.labReadinessRunId,
            labInfrastructureDigest: promotion.labInfrastructureDigest,
          },
    manualSession: promotion.manualSession,
    issuedAt: start.toISOString(),
    expiresAt: new Date(start.getTime() + 10 * 60 * 1000).toISOString(),
  };
  return {
    record,
    canonical: canonicalJson(record),
    sha256: sha256Hex(canonicalJson(record)),
  };
}

export function assertExactCustomLabels(actualLabels, expectedCustomLabels) {
  const custom = actualLabels.filter(
    (label) =>
      label === "forge3d-web" ||
      label.startsWith("hw-") ||
      label.startsWith("jit-"),
  );
  if (
    custom.length !== 3 ||
    custom.some((label, index) => label !== expectedCustomLabels[index])
  ) {
    throw new Error("queued job custom labels do not match exact authorization order");
  }
}

function resolveAsset(assetId, matrix) {
  const directHost = matrix.hosts.find((host) => host.assetId === assetId);
  if (directHost) return { asset: null, host: directHost };
  const asset = matrix.assets.find((candidate) => candidate.assetId === assetId);
  if (!asset) throw new Error(`assetId is not checked: ${assetId}`);
  const host = matrix.hosts.find(
    (candidate) => candidate.assetId === asset.hostAssetId,
  );
  if (!host) throw new Error(`owning host is missing for ${assetId}`);
  return { asset, host };
}

function parseBoolean(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("required must be a boolean");
}

function requireDecimal(value, label) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ""))) {
    throw new Error(`${label} must be a positive decimal ID`);
  }
  return Number(value);
}

function optionalDecimal(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return requireDecimal(value, label);
}

function requireSha(value, label) {
  if (!/^[0-9a-f]{40}$/u.test(value ?? "")) {
    throw new Error(`${label} must be a full lowercase commit SHA`);
  }
  return value;
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
  const operation = args.get("--operation");
  const matrix = JSON.parse(readFileSync(args.get("--matrix") ?? matrixPath, "utf8"));
  const policy = JSON.parse(
    readFileSync(args.get("--browser-policy") ?? browserPolicyPath, "utf8"),
  );
  if (operation === "promote") {
    const input = JSON.parse(readFileSync(args.get("--input"), "utf8"));
    const promotion = createPromotion({
      dispatch: input.dispatch,
      matrix,
      trustEpochSha: input.trustEpochSha,
      workflowSha: input.workflowSha,
      packageManifestSha256: input.packageManifestSha256,
      labInfrastructureDigest: input.labInfrastructureDigest,
      manualSession: input.manualSession,
    });
    writeFileSync(args.get("--output"), `${JSON.stringify(promotion, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(JSON.stringify({ ok: true, promotion }));
  } else if (operation === "authorize") {
    const input = JSON.parse(readFileSync(args.get("--input"), "utf8"));
    const authorization = createRunnerAuthorization({ ...input, policy });
    writeFileSync(args.get("--output"), `${authorization.canonical}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(JSON.stringify({ ok: true, sha256: authorization.sha256 }));
  } else {
    throw new Error("--operation must be promote or authorize");
  }
}
