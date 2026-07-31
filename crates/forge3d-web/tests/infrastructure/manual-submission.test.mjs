import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createIntakeManifest } from "../../scripts/manual-evidence.mjs";
import { validateManualSubmission } from "../../scripts/validate-manual-evidence.mjs";
import { canonicalJson, sha256Hex } from "../../scripts/canonical-json.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const manualCanarySchema = JSON.parse(
  readFileSync(new URL("./manual-canary.schema.json", import.meta.url), "utf8"),
);

const intake = createIntakeManifest({
  trustedSha: "a".repeat(40),
  packageRunId: 10,
  packageSha256: "b".repeat(64),
  checklistId: "safari-trackpad",
  assetId: "FW-TRACKPAD-01",
  expectedTester: "tester",
  prepareRun: { id: 20, attempt: 1, workflowSha: "c".repeat(40) },
  now: new Date("2026-07-29T09:00:00.000Z"),
  random: () => Buffer.alloc(16, 8),
});
const intakeSha256 = "d".repeat(64);
const session = {
  workflow: ".github/workflows/browser-hardware.yml",
  workflowSha: "e".repeat(40),
  run: { id: 30, attempt: 1 },
  hardwareJobId: 31,
  runner: { id: 32, name: `FW-MAC-M2-01-${"2".repeat(32)}` },
  trustedSha: intake.trustedSha,
  package: { sha256: intake.packageSha256 },
  labReadiness: {
    runId: 5,
    labInfrastructureDigest: "6".repeat(64),
  },
  assetId: intake.assetId,
  hostId: intake.hostId,
  mediaChallenge: intake.mediaChallenge,
  intakeManifestSha256: intakeSha256,
  authorizationSha256: "f".repeat(64),
  controllerSignatureSha256: "1".repeat(64),
  routeBasePath: `/runs/30/31/${"2".repeat(32)}/`,
  startedAt: "2026-07-29T10:00:00.000Z",
  endedAt: "2026-07-29T10:20:00.000Z",
  cleanup: { runnerAbsent: true },
};
const signedSessionSha256 = sha256Hex(canonicalJson(session));
const sessionFinalizer = {
  operation: "finalize-manual-session",
  workflowSha: session.workflowSha,
  run: session.run,
  runner: session.runner,
  authorizationSha256: session.authorizationSha256,
  manualSessionSha256: signedSessionSha256,
  terminalJobState: "success",
  absenceObservations: [{ status: 404 }],
};
const asset = {
  id: 40,
  name: "trackpad.mp4",
  uploader: "tester",
  size: 2048,
  mimeType: "video/mp4",
  createdAt: "2026-07-29T10:10:00.000Z",
  apiSha256: "3".repeat(64),
  sha256: "3".repeat(64),
};
const input = {
  release: {
    id: 50,
    draft: true,
    tagName: "manual-evidence-intake-20",
    targetCommitish: intake.trustedSha,
  },
  intake,
  intakeSha256,
  intakeManifestAssetId: 39,
  intakeAttestation: {
    repository: "milos-agathon/forge3d-web",
    signerWorkflow:
      "milos-agathon/forge3d-web/.github/workflows/prepare-browser-manual-evidence.yml",
    sourceRef: "refs/heads/main",
    sourceDigest: intake.prepareRun.workflowSha,
    subjectSha256: intakeSha256,
    denySelfHostedRunners: true,
  },
  session,
  signedSessionSha256,
  signedSessionSubjectSha256: "5".repeat(64),
  sessionRun: {
    id: 30,
    runAttempt: 1,
    path: ".github/workflows/browser-hardware.yml",
    headBranch: "main",
    headSha: session.trustedSha,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
  },
  hardwareJob: {
    id: 31,
    name: "Browser Hardware / Ephemeral Execution",
    status: "completed",
    conclusion: "success",
    runnerId: session.runner.id,
    runnerName: session.runner.name,
  },
  sessionFinalizer,
  sessionFinalizerSubjectSha256: "6".repeat(64),
  sessionAttestation: {
    repository: "milos-agathon/forge3d-web",
    signerWorkflow:
      "milos-agathon/forge3d-web/.github/workflows/browser-hardware.yml",
    sourceRef: "refs/heads/main",
    sourceDigest: session.workflowSha,
    denySelfHostedRunners: true,
    sessionSubjectSha256: "5".repeat(64),
    finalizerSubjectSha256: "6".repeat(64),
  },
  selectedAssets: [asset],
  releaseAssets: [{ id: 39 }, asset],
  stepResults: Object.fromEntries(intake.stepIds.map((id) => [id, "pass"])),
  actor: "tester",
  approvals: [
    { state: "approved", user: { id: 60, login: "independent-approver" } },
  ],
  implementationActors: ["implementation-author"],
  submissionRun: { id: 70, attempt: 1, workflowSha: "4".repeat(40) },
  now: new Date("2026-07-29T11:00:00.000Z"),
};

test("submission produces closed evidence from draft, session, media, approval, and actors", () => {
  const evidence = validateManualSubmission(structuredClone(input));
  assert.equal(evidence.intakeReleaseId, 50);
  assert.equal(evidence.media[0].id, 40);
  assert.equal(evidence.approver.login, "independent-approver");
});

test("infrastructure submission produces a non-support manual canary, not a product row", () => {
  const canaryIntake = createIntakeManifest({
    trustedSha: intake.trustedSha,
    packageRunId: 10,
    packageSha256: intake.packageSha256,
    checklistId: "infrastructure-manual-canary",
    assetId: "FW-TRACKPAD-01",
    expectedTester: "tester",
    prepareRun: intake.prepareRun,
    now: new Date("2026-07-29T09:00:00.000Z"),
    random: () => Buffer.alloc(16, 8),
  });
  const canarySession = {
    ...structuredClone(session),
    package: { runId: 10, sha256: canaryIntake.packageSha256 },
    mediaChallenge: canaryIntake.mediaChallenge,
    intakeManifestSha256: intakeSha256,
  };
  const canarySessionSha256 = sha256Hex(canonicalJson(canarySession));
  const canary = validateManualSubmission({
    ...structuredClone(input),
    intake: canaryIntake,
    session: canarySession,
    signedSessionSha256: canarySessionSha256,
    sessionFinalizer: {
      ...structuredClone(sessionFinalizer),
      manualSessionSha256: canarySessionSha256,
    },
    stepResults: Object.fromEntries(
      canaryIntake.stepIds.map((id) => [id, "pass"]),
    ),
  });
  assert.equal(canary.recordType, "manual-lab-canary");
  assert.equal(canary.supportClaim, false);
  assert.equal(canary.productAssertionsExecuted, false);
  assert.equal(canary.attestation.verified, false);
  assert.deepEqual(canary.media.assetIds, [40]);
  const publishedCanary = {
    ...canary,
    attestation: {
      verified: true,
      denySelfHostedRunners: true,
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/submit-browser-manual-evidence.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: canary.trustedSha,
    },
  };
  assertJsonSchema(publishedCanary, manualCanarySchema);
  assert.throws(
    () =>
      assertJsonSchema(
        {
          ...publishedCanary,
          session: {
            ...publishedCanary.session,
            productSupportClaim: true,
          },
        },
        manualCanarySchema,
      ),
    /additional property/u,
  );
});

test("expired draft, self approval, implementation approval, or wrong finalizer fails", () => {
  assert.throws(
    () =>
      validateManualSubmission({
        ...structuredClone(input),
        now: new Date("2026-07-30T09:00:00.001Z"),
      }),
    /non-expired draft/u,
  );
  assert.throws(
    () =>
      validateManualSubmission({
        ...structuredClone(input),
        approvals: [{ state: "approved", user: { id: 1, login: "tester" } }],
      }),
    /independent/u,
  );
  assert.throws(
    () =>
      validateManualSubmission({
        ...structuredClone(input),
        sessionAttestation: {
          ...input.sessionAttestation,
          denySelfHostedRunners: false,
        },
      }),
    /finalizer attestation/u,
  );
});
