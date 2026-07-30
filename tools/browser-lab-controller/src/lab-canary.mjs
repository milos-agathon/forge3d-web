import { signControllerRecord } from "./controller-signing.mjs";

export function createHostLabCanary({
  authorization,
  browserEvidence,
  adapterAttestation,
  inventory,
  route,
  execution,
  privateKey,
  signingKeyId,
}) {
  if (
    authorization.lane !== "infrastructure-canary" ||
    authorization.manualSession !== null ||
    browserEvidence.result !== "PASS" ||
    browserEvidence.assertions?.supportAssertionsExecuted !== false ||
    browserEvidence.adapter?.isFallbackAdapter !== false ||
    browserEvidence.adapter?.deviceCreated !== true ||
    browserEvidence.adapter?.surfacePresented !== true ||
    adapterAttestation?.result !== "PASS" ||
    adapterAttestation.required !== true ||
    adapterAttestation.binding?.runId !== authorization.run.id ||
    adapterAttestation.binding?.assetId !== authorization.assetId ||
    adapterAttestation.binding?.commit !== authorization.trustedSha ||
    adapterAttestation.binding?.packageSha256 !== browserEvidence.packageSha256 ||
    adapterAttestation.host?.hostId !== authorization.hostId ||
    adapterAttestation.host?.expectedGpuPresent !== true ||
    adapterAttestation.host?.headedSessionAvailable !== true ||
    execution.acceptedJobCount !== 1 ||
    execution.cleanupComplete !== true ||
    route.httpsVerified !== true ||
    route.corsRangeControlsPassed !== true ||
    inventory.hostId !== authorization.hostId
  ) {
    throw new Error("host laboratory canary observations are incomplete");
  }
  return signControllerRecord({
    record: {
      schemaVersion: 1,
      recordType: "host-lab-canary",
      runId: authorization.run.id,
      runAttempt: authorization.run.attempt,
      lane: authorization.lane,
      canaryMode: "host",
      hostId: authorization.hostId,
      assetId: authorization.assetId,
      trustedSha: authorization.trustedSha,
      packageRunId: authorization.packageRunId,
      packageSha256: browserEvidence.packageSha256,
      result: "PASS",
      supportAssertionsExecuted: false,
      adapter: browserEvidence.adapter,
      adapterAttestation,
      authorization: {
        sha256: authorization.sha256,
        attested: true,
      },
      controller: { signatureVerified: true },
      runner: {
        id: execution.runnerId,
        name: execution.runnerName,
        acceptedJobCount: 1,
        absentAfterRun: execution.runnerAbsent === true,
      },
      cleanup: { complete: true },
      inventory,
      route,
      attestation: { verified: false },
    },
    privateKey,
    signingKeyId,
  });
}
