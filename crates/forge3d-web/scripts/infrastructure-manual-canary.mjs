export function validateInfrastructureStepResults(stepResults, intake) {
  if (intake.checklistId !== "infrastructure-manual-canary") {
    throw new Error("infrastructure evidence requires its closed canary checklist");
  }
  const supplied = Object.keys(stepResults).sort();
  const expected = [...intake.stepIds].sort();
  if (
    supplied.length !== expected.length ||
    supplied.some((key, index) => key !== expected[index]) ||
    Object.values(stepResults).some((value) => value !== "pass")
  ) {
    throw new Error("infrastructure canary requires every checked step to pass");
  }
  return Object.fromEntries(
    intake.stepIds.map((stepId) => [stepId, stepResults[stepId]]),
  );
}

export function createInfrastructureManualCanary({
  intake,
  session,
  stepResults,
  media,
  actor,
  approver,
  implementationActors,
  submissionRun,
  intakeReleaseId,
  now = new Date(),
}) {
  if (
    intake.supportClaim !== false ||
    actor !== intake.expectedTester ||
    implementationActors.has(actor) ||
    approver.login === actor ||
    implementationActors.has(approver.login) ||
    session.trustedSha !== intake.trustedSha ||
    session.package.runId !== intake.packageRunId ||
    session.package.sha256 !== intake.packageSha256 ||
    session.assetId !== intake.assetId ||
    session.hostId !== intake.hostId ||
    session.mediaChallenge !== intake.mediaChallenge ||
    session.intakeManifestSha256 !== intake.sha256 ||
    Object.values(session.cleanup).some((value) => value !== true) ||
    session.controllerCompletion?.state !== "completed" ||
    session.controllerCompletion.hostLockReleased !== true ||
    session.controllerCompletion.quarantined !== false
  ) {
    throw new Error("infrastructure manual canary identity or independence failed");
  }
  const durationMinutes =
    (new Date(session.endedAt) - new Date(session.startedAt)) / 60_000;
  if (durationMinutes !== 20 || media.length < 1) {
    throw new Error("infrastructure manual canary requires a complete capture");
  }
  return {
    schemaVersion: 1,
    recordType: "manual-lab-canary",
    runId: submissionRun.id,
    runAttempt: submissionRun.attempt,
    hardwareJobId: session.hardwareJobId,
    intakeReleaseId,
    lane: "infrastructure-canary",
    canaryMode: "manual",
    checklistId: intake.checklistId,
    checklistStepResults: validateInfrastructureStepResults(
      stepResults,
      intake,
    ),
    supportClaim: false,
    trustedSha: intake.trustedSha,
    packageRunId: intake.packageRunId,
    packageSha256: intake.packageSha256,
    session: {
      durationMinutes,
      controllerSignatureVerified: true,
      runnerAbsent: session.cleanup.runnerAbsent,
      cleanupComplete: true,
      controllerCompletionState: session.controllerCompletion.state,
      hostLockReleased: session.controllerCompletion.hostLockReleased,
      quarantined: session.controllerCompletion.quarantined,
      runId: session.run.id,
      runAttempt: session.run.attempt,
      jobId: session.hardwareJobId,
    },
    media: {
      authenticatedUploader: media.every(
        (asset) => asset.uploader === intake.expectedTester,
      ),
      challengeMatched: session.mediaChallenge === intake.mediaChallenge,
      digestsVerified: media.every(
        (asset) => asset.apiSha256 === asset.sha256,
      ),
      assetIds: media.map((asset) => asset.id).sort((left, right) => left - right),
      assets: media,
    },
    tester: actor,
    approver,
    productAssertionsExecuted: false,
    attestation: { verified: false },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(
      new Date(session.endedAt).getTime() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString(),
  };
}
