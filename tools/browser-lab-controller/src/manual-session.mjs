import { signControllerRecord } from "./controller-signing.mjs";
import { assertCompleteHostInventory } from "./controller-evidence-inputs.mjs";
import { validateDiagnosticRetentionReceipt } from "./diagnostic-retention.mjs";

export function createManualSession({
  authorization,
  intake,
  runner,
  system,
  loginSession,
  browser,
  driver,
  origins,
  routeBasePath,
  packageRecord,
  startedAt,
  endedAt,
  cleanup,
  installations,
  diagnosticRetention,
  controllerCompletion,
  hostInventory = null,
  privateKey,
  signingKeyId,
}) {
  const duration = new Date(endedAt) - new Date(startedAt);
  if (duration !== 20 * 60 * 1000) {
    throw new Error("manual session capture window must be exactly 20 minutes");
  }
  validateDiagnosticRetentionReceipt(diagnosticRetention, {
    authorizationDigest: authorization.sha256,
    hostId: authorization.hostId,
    run: authorization.run,
    runnerNonce: authorization.runnerNonce,
  });
  if (
    authorization.manualSession?.mediaChallenge !== intake.mediaChallenge ||
    authorization.manualSession?.intakeManifestSha256 !== intake.sha256 ||
    authorization.assetId !== intake.assetId ||
    authorization.hostId !== intake.hostId
  ) {
    throw new Error("manual session authorization/intake binding is invalid");
  }
  const requiresTrackpadInventory =
    authorization.hostId === "FW-MAC-M2-01" &&
    (authorization.lane === "infrastructure-canary" ||
      authorization.lane === "manual-safari-trackpad");
  if (requiresTrackpadInventory) {
    assertCompleteHostInventory(hostInventory, { authorization });
  }
  if (
    Object.values(cleanup).some((value) => value !== true) ||
    controllerCompletion?.state !== "completed" ||
    controllerCompletion.hostLockReleased !== true ||
    controllerCompletion.quarantined !== false ||
    installations?.controller?.component !== "controller" ||
    installations.controller.instanceId !== authorization.hostId ||
    installations?.broker?.component !== "broker" ||
    origins.application === origins.asset ||
    loginSession?.interactive !== true ||
    loginSession.locked !== false ||
    loginSession.remote !== false
  ) {
    throw new Error(
      "manual session cleanup, session, and dual-origin policy must pass",
    );
  }
  const record = {
    schemaVersion: 1,
    repository: "milos-agathon/forge3d-web",
    workflow: ".github/workflows/browser-hardware.yml",
    workflowSha: authorization.workflow.sha,
    run: authorization.run,
    hardwareJobId: authorization.queuedHardwareJob.id,
    authorizationSha256: authorization.sha256,
    intakeManifestSha256: intake.sha256,
    runner,
    trustedSha: authorization.trustedSha,
    package: {
      ...packageRecord,
      promotionRunId: authorization.run.id,
    },
    labReadiness: authorization.labReadiness,
    hostId: authorization.hostId,
    assetId: authorization.assetId,
    controllerKeyId: signingKeyId,
    system,
    browser,
    driver,
    headed: true,
    loginSession,
    origins,
    routeBasePath,
    mediaChallenge: intake.mediaChallenge,
    startedAt,
    endedAt,
    cleanup,
    diagnosticRetention,
    controllerCompletion,
    installations,
    ...(requiresTrackpadInventory ? { hostInventory } : {}),
  };
  return signControllerRecord({
    record,
    privateKey,
    signingKeyId,
  });
}
