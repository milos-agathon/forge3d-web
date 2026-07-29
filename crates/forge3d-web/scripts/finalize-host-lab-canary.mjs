import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-json.mjs";
import { pollRunnerAbsent } from "./finalize-manual-session.mjs";
import { verifyControllerRecord } from "./verify-controller-record.mjs";

export function finalizeHostLabCanary({
  signedRecord,
  authorization,
  hardwareJob,
  matrix,
  absenceObservations,
  finalizer,
}) {
  const record = verifyControllerRecord({
    signed: signedRecord,
    matrix,
    recordType: "host-lab-canary",
  });
  if (
    record.runId !== authorization.record.run.id ||
    record.runAttempt !== authorization.record.run.attempt ||
    record.hostId !== authorization.record.hostId ||
    record.assetId !== authorization.record.assetId ||
    record.trustedSha !== authorization.record.trustedSha ||
    record.packageRunId !== authorization.record.packageRunId ||
    record.authorization.sha256 !== authorization.sha256 ||
    hardwareJob.id !== authorization.record.queuedHardwareJob.id ||
    hardwareJob.name !== "Browser Hardware / Ephemeral Execution" ||
    hardwareJob.status !== "completed" ||
    hardwareJob.conclusion !== "success" ||
    hardwareJob.runner_id !== record.runner.id ||
    hardwareJob.runner_name !== record.runner.name ||
    record.runner.absentAfterRun !== true ||
    absenceObservations.at(-1)?.status !== 404 ||
    finalizer.job !== "finalize-hardware-evidence" ||
    finalizer.environment !== "forge3d-trust-observer" ||
    finalizer.workflowSha !== authorization.record.workflow.sha
  ) {
    throw new Error("host canary receipt, job, authorization, or absence mismatch");
  }
  return {
    ...record,
    controller: {
      signatureVerified: true,
      signingKeyId: signedRecord.signature.signingKeyId,
    },
    attestation: {
      verified: true,
      denySelfHostedRunners: true,
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/browser-hardware.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: finalizer.workflowSha,
    },
    finalizer: {
      run: finalizer.run,
      job: finalizer.job,
      environment: finalizer.environment,
      absenceObservations,
      observedAt: finalizer.observedAt,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const record = verifyControllerRecord({
    signed: input.signedRecord,
    matrix: input.matrix,
    recordType: "host-lab-canary",
  });
  const absenceObservations = await pollRunnerAbsent({
    repository: "milos-agathon/forge3d-web",
    token: process.env.TRUST_OBSERVER_TOKEN,
    runner: record.runner,
  });
  const result = finalizeHostLabCanary({
    ...input,
    absenceObservations,
  });
  writeFileSync(process.argv[3], `${canonicalJson(result)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, hostId: result.hostId }));
}
