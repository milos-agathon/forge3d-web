import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-json.mjs";
import { validateHostInventory } from "./capture-host-inventory.mjs";
import { assertJsonSchema } from "../tests/browser/json-schema-validator.mjs";
import { validateDiagnosticRetentionReceipt } from "../../../tools/browser-lab-controller/src/diagnostic-retention.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manualSessionSchema = JSON.parse(
  readFileSync(
    join(packageRoot, "tests", "infrastructure", "manual-session.schema.json"),
    "utf8",
  ),
);
const installationSchema = JSON.parse(
  readFileSync(
    join(
      packageRoot,
      "tests",
      "infrastructure",
      "lab-service-installation.schema.json",
    ),
    "utf8",
  ),
);

export function verifySignedManualSession({
  signedSession,
  authorization,
  hardwareJob,
  matrix,
  hostInventory,
}) {
  const { record, signature } = signedSession;
  assertJsonSchema(record, manualSessionSchema);
  assertJsonSchema(record.installations.controller, installationSchema);
  assertJsonSchema(record.installations.broker, installationSchema);
  validateDiagnosticRetentionReceipt(record.diagnosticRetention, {
    authorizationDigest: record.authorizationSha256,
    hostId: record.hostId,
    run: record.run,
    runnerNonce: authorization.record.runnerNonce,
  });
  const host = matrix.hosts.find((candidate) => candidate.assetId === record.hostId);
  const requiresTrackpadInventory =
    record.hostId === "FW-MAC-M2-01" &&
    (authorization.record.lane === "infrastructure-canary" ||
      authorization.record.lane === "manual-safari-trackpad");
  if (requiresTrackpadInventory) {
    validateHostInventory(record.hostInventory, {
      matrix,
      requireTrackpad: true,
    });
    if (hostInventory !== undefined) {
      validateHostInventory(hostInventory, { matrix, requireTrackpad: true });
      if (canonicalJson(record.hostInventory) !== canonicalJson(hostInventory)) {
        throw new Error("signed manual-session inventory does not match the job artifact");
      }
    }
  }
  if (
    host?.controller?.state !== "online" ||
    !host.controller.publicJwk ||
    signature.signingKeyId !== host.controller.signingKeyId ||
    record.controllerKeyId !== host.controller.signingKeyId
  ) {
    throw new Error("manual session controller key is not active and pinned");
  }
  const canonical = canonicalJson(record);
  const valid = verifySignature(
    "SHA256",
    Buffer.from(canonical),
    {
      key: createPublicKey({ key: host.controller.publicJwk, format: "jwk" }),
      dsaEncoding: "ieee-p1363",
    },
    Buffer.from(signature.value, "base64url"),
  );
  if (
    !valid ||
    signedSession.canonical !== canonical ||
    signedSession.sha256 !== sha256(canonical) ||
    signature.algorithm !== "SHA256withECDSA" ||
    signature.encoding !== "ieee-p1363-base64url"
  ) {
    throw new Error("manual session controller signature is invalid");
  }
  if (
    record.authorizationSha256 !== authorization.sha256 ||
    record.diagnosticRetention.runnerNonce !==
      authorization.record.runnerNonce ||
    record.runner.name !==
      `${record.hostId}-${record.diagnosticRetention.runnerNonce}` ||
    record.run.id !== authorization.record.run.id ||
    record.run.attempt !== authorization.record.run.attempt ||
    record.hardwareJobId !== authorization.record.queuedHardwareJob.id ||
    record.runner.name !== authorization.record.runnerName ||
    record.trustedSha !== authorization.record.trustedSha ||
    record.package.runId !== authorization.record.packageRunId ||
    canonicalJson(record.labReadiness) !==
      canonicalJson(authorization.record.labReadiness) ||
    record.hostId !== authorization.record.hostId ||
    record.assetId !== authorization.record.assetId
  ) {
    throw new Error("manual session does not match the runner authorization");
  }
  if (
    hardwareJob.id !== record.hardwareJobId ||
    hardwareJob.name !== "Browser Hardware / Ephemeral Execution" ||
    hardwareJob.status !== "completed" ||
    hardwareJob.conclusion !== "success" ||
    hardwareJob.runner_id !== record.runner.id ||
    hardwareJob.runner_name !== record.runner.name ||
    Object.values(record.cleanup).some((value) => value !== true)
    || record.controllerCompletion?.state !== "completed"
    || record.controllerCompletion.hostLockReleased !== true
    || record.controllerCompletion.quarantined !== false
  ) {
    throw new Error("manual session hardware job or signed cleanup is invalid");
  }
  return record;
}

export async function pollRunnerAbsent({
  repository,
  token,
  runner,
  apiBase = "https://api.github.com",
  fetchImpl = fetch,
  delayImpl = delay,
  now = () => new Date(),
  timeoutMs = 5 * 60 * 1000,
}) {
  if (!token) throw new Error("runner absence requires an installation token");
  const startedAt = now().getTime();
  const observations = [];
  for (;;) {
    const response = await fetchImpl(
      `${apiBase}/repos/${repository}/actions/runners/${runner.id}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    observations.push({
      status: response.status,
      sha256: sha256(bytes),
      observedAt: now().toISOString(),
    });
    if (response.status === 404) return observations;
    if (response.status !== 200) {
      throw new Error(`runner absence API failed with HTTP ${response.status}`);
    }
    const current = JSON.parse(bytes.toString("utf8"));
    if (current.id !== runner.id || current.name !== runner.name) {
      throw new Error("runner API tuple changed before absence was observed");
    }
    if (now().getTime() - startedAt >= timeoutMs) {
      throw new Error("runner remained registered after five minutes");
    }
    await delayImpl(5_000);
  }
}

export function createManualFinalizerRecord({
  session,
  terminalJobState,
  absenceObservations,
  finalizer,
}) {
  if (
    terminalJobState !== "success" ||
    absenceObservations.at(-1)?.status !== 404 ||
    finalizer.job !== "finalize-manual-session" ||
    finalizer.environment !== "forge3d-trust-observer"
  ) {
    throw new Error("manual finalizer cannot attest an incomplete operation");
  }
  return {
    schemaVersion: 1,
    operation: "finalize-manual-session",
    repository: "milos-agathon/forge3d-web",
    workflow: ".github/workflows/browser-hardware.yml",
    workflowSha: finalizer.workflowSha,
    run: finalizer.run,
    consumer: {
      job: finalizer.job,
      environment: finalizer.environment,
    },
    runner: session.runner,
    authorizationSha256: session.authorizationSha256,
    manualSessionSha256: sha256(canonicalJson(session)),
    terminalJobState,
    absenceObservations,
    cleanup: session.cleanup,
    diagnosticRetention: session.diagnosticRetention,
    controllerCompletion: session.controllerCompletion,
    installations: session.installations,
    observedAt: finalizer.observedAt,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const session = verifySignedManualSession(input);
  const absenceObservations = await pollRunnerAbsent({
    repository: "milos-agathon/forge3d-web",
    token: process.env.TRUST_OBSERVER_TOKEN,
    runner: session.runner,
  });
  const record = createManualFinalizerRecord({
    session,
    terminalJobState: input.hardwareJob.conclusion,
    absenceObservations,
    finalizer: input.finalizer,
  });
  writeFileSync(process.argv[3], `${canonicalJson(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, runnerAbsent: true }));
}
