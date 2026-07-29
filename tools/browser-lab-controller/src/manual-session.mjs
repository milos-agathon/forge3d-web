import { signControllerRecord } from "./controller-signing.mjs";

export function createManualSession({
  authorization,
  intake,
  runner,
  system,
  browser,
  driver,
  origins,
  routeBasePath,
  packageRecord,
  startedAt,
  endedAt,
  cleanup,
  privateKey,
  signingKeyId,
}) {
  const duration = new Date(endedAt) - new Date(startedAt);
  if (duration !== 20 * 60 * 1000) {
    throw new Error("manual session capture window must be exactly 20 minutes");
  }
  if (
    authorization.manualSession?.mediaChallenge !== intake.mediaChallenge ||
    authorization.manualSession?.intakeManifestSha256 !== intake.sha256 ||
    authorization.assetId !== intake.assetId ||
    authorization.hostId !== intake.hostId
  ) {
    throw new Error("manual session authorization/intake binding is invalid");
  }
  if (
    Object.values(cleanup).some((value) => value !== true) ||
    origins.application === origins.asset
  ) {
    throw new Error("manual session cleanup and dual-origin policy must pass");
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
    loginSession: { interactive: true, locked: false, remote: false },
    origins,
    routeBasePath,
    mediaChallenge: intake.mediaChallenge,
    startedAt,
    endedAt,
    cleanup,
  };
  return signControllerRecord({
    record,
    privateKey,
    signingKeyId,
  });
}
