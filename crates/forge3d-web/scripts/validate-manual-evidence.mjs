import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createManualEvidence,
  validateMediaAssets,
} from "./manual-evidence.mjs";
import { createInfrastructureManualCanary } from "./infrastructure-manual-canary.mjs";
import { canonicalJson, sha256Hex } from "./canonical-json.mjs";

export function validateManualSubmission({
  release,
  intake,
  intakeSha256,
  intakeManifestAssetId,
  intakeAttestation,
  session,
  signedSessionSha256,
  signedSessionSubjectSha256,
  sessionRun,
  hardwareJob,
  sessionFinalizer,
  sessionFinalizerSubjectSha256,
  sessionAttestation,
  selectedAssets,
  releaseAssets,
  stepResults,
  actor,
  approvals,
  implementationActors,
  submissionRun,
  now = new Date(),
}) {
  if (
    release.id < 1 ||
    release.draft !== true ||
    release.tagName !== `manual-evidence-intake-${intake.prepareRun.id}` ||
    release.targetCommitish !== intake.trustedSha ||
    new Date(now) > new Date(intake.expiresAt)
  ) {
    throw new Error("manual intake release is not the exact non-expired draft");
  }
  if (
    intakeAttestation.repository !== "milos-agathon/forge3d-web" ||
    intakeAttestation.signerWorkflow !==
      "milos-agathon/forge3d-web/.github/workflows/prepare-browser-manual-evidence.yml" ||
    intakeAttestation.sourceRef !== "refs/heads/main" ||
    intakeAttestation.sourceDigest !== intake.prepareRun.workflowSha ||
    intakeAttestation.subjectSha256 !== intakeSha256 ||
    intakeAttestation.denySelfHostedRunners !== true
  ) {
    throw new Error("manual intake attestation is invalid");
  }
  if (
    sessionRun.id !== session.run.id ||
    sessionRun.runAttempt !== session.run.attempt ||
    sessionRun.path !== ".github/workflows/browser-hardware.yml" ||
    sessionRun.headBranch !== "main" ||
    sessionRun.headSha !== session.trustedSha ||
    sessionRun.event !== "workflow_dispatch" ||
    sessionRun.status !== "completed" ||
    sessionRun.conclusion !== "success" ||
    hardwareJob.id !== session.hardwareJobId ||
    hardwareJob.name !== "Browser Hardware / Ephemeral Execution" ||
    hardwareJob.status !== "completed" ||
    hardwareJob.conclusion !== "success" ||
    hardwareJob.runnerId !== session.runner.id ||
    hardwareJob.runnerName !== session.runner.name
  ) {
    throw new Error("manual session run or hardware job is invalid");
  }
  const canonicalSessionSha256 = sha256Hex(canonicalJson(session));
  if (
    signedSessionSha256 !== canonicalSessionSha256 ||
    sessionFinalizer.operation !== "finalize-manual-session" ||
    sessionFinalizer.workflowSha !== session.workflowSha ||
    sessionFinalizer.run.id !== session.run.id ||
    sessionFinalizer.run.attempt !== session.run.attempt ||
    sessionFinalizer.runner.id !== session.runner.id ||
    sessionFinalizer.runner.name !== session.runner.name ||
    sessionFinalizer.authorizationSha256 !== session.authorizationSha256 ||
    sessionFinalizer.manualSessionSha256 !== canonicalSessionSha256 ||
    sessionFinalizer.terminalJobState !== "success" ||
    sessionFinalizer.absenceObservations.at(-1)?.status !== 404
  ) {
    throw new Error("manual session finalizer record is invalid");
  }
  if (
    sessionAttestation.repository !== "milos-agathon/forge3d-web" ||
    sessionAttestation.signerWorkflow !==
      "milos-agathon/forge3d-web/.github/workflows/browser-hardware.yml" ||
    sessionAttestation.sourceRef !== "refs/heads/main" ||
    sessionAttestation.sourceDigest !== session.workflowSha ||
    sessionAttestation.denySelfHostedRunners !== true ||
    sessionAttestation.sessionSubjectSha256 !== signedSessionSubjectSha256 ||
    sessionAttestation.finalizerSubjectSha256 !==
      sessionFinalizerSubjectSha256 ||
    session.cleanup.runnerAbsent !== true
  ) {
    throw new Error("manual session finalizer attestation is invalid");
  }
  const approved = approvals.filter((approval) => approval.state === "approved");
  if (
    approved.length < 1 ||
    approved.some(
      (approval) =>
        approval.user.login === actor ||
        implementationActors.includes(approval.user.login),
    )
  ) {
    throw new Error("manual evidence requires independent protected-environment approval");
  }
  const boundIntake = { ...intake, sha256: intakeSha256 };
  const media = validateMediaAssets({
    selectedAssets,
    releaseAssets,
    intakeManifestAssetId,
    intake: boundIntake,
    session,
    actor,
  });
  const common = {
    intake: boundIntake,
    session,
    stepResults,
    media,
    actor,
    approver: {
      id: approved[0].user.id,
      login: approved[0].user.login,
    },
    implementationActors: new Set(implementationActors),
    submissionRun,
    intakeReleaseId: release.id,
    controllerSignatureSha256: session.controllerSignatureSha256,
    now,
  };
  return intake.checklistId === "infrastructure-manual-canary"
    ? createInfrastructureManualCanary(common)
    : createManualEvidence(common);
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
  const input = JSON.parse(readFileSync(args.get("--input"), "utf8"));
  const evidence = validateManualSubmission(input);
  writeFileSync(args.get("--output"), `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, output: args.get("--output") }));
}
