import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-json.mjs";
import { verifyControllerRecord } from "./verify-controller-record.mjs";
import { assertServiceDeploymentProvenance } from "../../../tools/browser-lab-controller/src/deployment-provenance.mjs";

const BROKER_WORKFLOW =
  "milos-agathon/forge3d-web/.github/workflows/browser-lab-broker.yml";
const CONTROLLER_WORKFLOW =
  "milos-agathon/forge3d-web/.github/workflows/browser-lab-controller.yml";

export function finalizeDeploymentProvenance({
  signedRecord,
  authorization,
  matrix,
  finalizer,
}) {
  const record = verifyControllerRecord({
    signed: signedRecord,
    matrix,
    recordType: "lab-service-deployment-provenance-receipt",
  });
  exactKeys(record, [
    "schemaVersion",
    "recordType",
    "runId",
    "runAttempt",
    "hostId",
    "controllerIdentity",
    "trustedSha",
    "observedAt",
    "broker",
    "controller",
  ]);
  assertServiceDeploymentProvenance(record.broker, {
    service: "broker",
    serviceIdentity: "broker:forge3d-browser-lab",
    signerWorkflow: BROKER_WORKFLOW,
  });
  assertServiceDeploymentProvenance(record.controller, {
    service: "controller",
    serviceIdentity: `controller:${record.hostId}`,
    signerWorkflow: CONTROLLER_WORKFLOW,
  });
  if (
    record.schemaVersion !== 1 ||
    record.runId !== authorization.record.run.id ||
    record.runAttempt !== authorization.record.run.attempt ||
    record.hostId !== authorization.record.hostId ||
    record.controllerIdentity !== `controller:${record.hostId}` ||
    record.trustedSha !== authorization.record.trustedSha ||
    record.broker.source.targetSha !== record.trustedSha ||
    record.controller.source.targetSha !== record.trustedSha ||
    record.broker.source.workflowSha !==
      record.controller.source.workflowSha ||
    finalizer.workflowSha !== authorization.record.workflow.sha ||
    finalizer.run?.id !== record.runId ||
    finalizer.run?.attempt !== record.runAttempt ||
    finalizer.job !== "finalize-hardware-evidence" ||
    finalizer.environment !== "forge3d-trust-observer" ||
    !Number.isFinite(Date.parse(finalizer.observedAt ?? ""))
  ) {
    throw new Error(
      "deployment receipt, authorization, or finalizer binding is invalid",
    );
  }
  return {
    ...structuredClone(record),
    controllerSignature: {
      verified: true,
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
      run: structuredClone(finalizer.run),
      job: finalizer.job,
      environment: finalizer.environment,
      observedAt: finalizer.observedAt,
    },
  };
}

function exactKeys(value, expected) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !==
      [...expected].sort().join("\n")
  ) {
    throw new Error("controller deployment receipt shape is invalid");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const result = finalizeDeploymentProvenance({
    ...input,
    signedRecord: input.signedDeploymentRecord ?? input.signedRecord,
  });
  writeFileSync(process.argv[3], `${canonicalJson(result)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, hostId: result.hostId }));
}
