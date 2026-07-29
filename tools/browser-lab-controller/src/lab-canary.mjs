import { signControllerRecord } from "./controller-signing.mjs";

export function createHostLabCanary({
  authorization,
  browserEvidence,
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
