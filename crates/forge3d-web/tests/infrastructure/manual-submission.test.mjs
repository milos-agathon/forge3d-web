import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createIntakeManifest } from "../../scripts/manual-evidence.mjs";
import { validateManualSubmission } from "../../scripts/validate-manual-evidence.mjs";
import { prepareManualSubmission } from "../../scripts/prepare-manual-submission.mjs";
import { createManualFinalizerRecord } from "../../scripts/finalize-manual-session.mjs";
import { createManualSession } from "../../../../tools/browser-lab-controller/src/manual-session.mjs";
import { createTestPrivateKeySigner } from "../../../../tools/browser-lab-controller/test/test-signer.mjs";
import { canonicalJson, sha256Hex } from "../../scripts/canonical-json.mjs";
import { exactHostInventory } from "./host-inventory-fixture.mjs";
import { activeManualMatrices } from "./manual-intake-fixture.mjs";
import {
  diagnosticRetentionFixture,
  serviceInstallationFixture,
} from "./service-installation-fixture.mjs";

const matrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);

const intake = createIntakeManifest({
  trustedSha: "a".repeat(40),
  packageRunId: 10,
  packageSha256: "b".repeat(64),
  checklistId: "safari-trackpad",
  assetId: "FW-TRACKPAD-01",
  ...activeManualMatrices("FW-TRACKPAD-01"),
  expectedTester: "tester",
  prepareRun: { id: 20, attempt: 1, workflowSha: "c".repeat(40) },
  now: new Date("2026-07-29T09:00:00.000Z"),
  random: () => Buffer.alloc(16, 8),
});
const intakeSha256 = "d".repeat(64);
const hostInventory = exactHostInventory(matrix, "FW-MAC-M2-01");
const session = {
  workflow: ".github/workflows/browser-hardware.yml",
  workflowSha: "e".repeat(40),
  run: { id: 30, attempt: 1 },
  hardwareJobId: 31,
  runner: { id: 32, name: `FW-MAC-M2-01-${"2".repeat(32)}` },
  trustedSha: intake.trustedSha,
  package: { runId: intake.packageRunId, sha256: intake.packageSha256 },
  labReadiness: {
    runId: 5,
    manifestSha256: "5".repeat(64),
    labInfrastructureDigest: "6".repeat(64),
  },
  assetId: intake.assetId,
  hostId: intake.hostId,
  system: { os: hostInventory.platform, build: hostInventory.osBuild },
  browser: { name: "Safari", channel: "stable", version: "26.0" },
  driver: { name: "safaridriver", version: "26.0" },
  hostInventory,
  mediaChallenge: intake.mediaChallenge,
  intakeManifestSha256: intakeSha256,
  authorizationSha256: "f".repeat(64),
  routeBasePath: `/runs/30/31/${"2".repeat(32)}/`,
  startedAt: "2026-07-29T10:00:00.000Z",
  endedAt: "2026-07-29T10:20:00.000Z",
  cleanup: { runnerAbsent: true },
  controllerCompletion: {
    state: "completed",
    brokerCleanup: "deleted",
    runnerAbsent: true,
    workRootWiped: true,
    hostCleanupComplete: true,
    hostLockReleased: true,
    quarantined: false,
    completedAt: "2026-07-29T10:21:00.000Z",
  },
  installations: {
    controller: serviceInstallationFixture({
      component: "controller",
      instanceId: intake.hostId,
      targetSha: intake.trustedSha,
      inventory: hostInventory,
    }),
    broker: serviceInstallationFixture({
      component: "broker",
      instanceId: "browser-lab-broker",
      targetSha: intake.trustedSha,
    }),
  },
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
  controllerSignatureSha256: "1".repeat(64),
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
    {
      state: "approved",
      user: { id: 60, login: "independent-approver" },
      environments: [{ id: 600, name: "forge3d-manual-evidence" }],
    },
  ],
  implementationActors: ["implementation-author"],
  submissionRun: { id: 70, attempt: 1, workflowSha: "4".repeat(40) },
  now: new Date("2026-07-29T11:00:00.000Z"),
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("submission produces closed evidence from draft, session, media, approval, and actors", () => {
  const evidence = validateManualSubmission(structuredClone(input));
  assert.equal(evidence.intakeReleaseId, 50);
  assert.equal(evidence.media[0].id, 40);
  assert.equal(evidence.approver.login, "independent-approver");
  assert.equal(evidence.controllerSignatureSha256, "1".repeat(64));
  assert.equal(Object.hasOwn(session, "controllerSignatureSha256"), false);
  assert.deepEqual(evidence.approver.environment, {
    id: 600,
    name: "forge3d-manual-evidence",
  });
  assert.equal(evidence.approvalProvenance.length, 1);
  assert.deepEqual(evidence.labReadiness, session.labReadiness);
  assert.equal(evidence.hostInventory.trackpad.assetId, "FW-TRACKPAD-01");
});

test("genuine producer, finalizer, preparer, and validator preserve signed record bytes", () => {
  const intakeBytes = Buffer.from(canonicalJson(intake));
  const intakeDigest = sha256(intakeBytes);
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const runnerNonce = "2".repeat(32);
  const authorization = {
    workflow: { sha: "e".repeat(40) },
    run: { id: 30, attempt: 1 },
    queuedHardwareJob: { id: 31 },
    runnerName: `FW-MAC-M2-01-${runnerNonce}`,
    runnerNonce,
    trustedSha: intake.trustedSha,
    packageRunId: intake.packageRunId,
    lane: "manual-safari-trackpad",
    hostId: intake.hostId,
    assetId: intake.assetId,
    sha256: "f".repeat(64),
    labReadiness: session.labReadiness,
    manualSession: {
      mediaChallenge: intake.mediaChallenge,
      intakeManifestSha256: intakeDigest,
    },
  };
  const genuine = createManualSession({
    authorization,
    intake: { ...intake, sha256: intakeDigest },
    runner: { id: 32, name: authorization.runnerName },
    system: session.system,
    loginSession: { interactive: true, locked: false, remote: false },
    browser: session.browser,
    driver: session.driver,
    origins: { application: "https://app.example", asset: "https://asset.example" },
    routeBasePath: session.routeBasePath,
    packageRecord: { runId: 10, sha256: intake.packageSha256, harnessSha256: "8".repeat(64) },
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    cleanup: {
      browserStopped: true, driverStopped: true, fixtureStopped: true,
      tunnelStopped: true, updatesRestored: true, runnerAbsent: true,
    },
    installations: session.installations,
    diagnosticRetention: diagnosticRetentionFixture({
      authorizationDigest: authorization.sha256,
      hostId: authorization.hostId,
      run: authorization.run,
      runnerNonce,
      retainedAt: "2026-07-29T10:20:30.000Z",
    }),
    controllerCompletion: session.controllerCompletion,
    hostInventory,
    signer: createTestPrivateKeySigner({
      privateKey: keys.privateKey,
      signingKeyId: "controller-fw-mac-m2-01-p256-v1",
    }),
  });
  const finalizer = createManualFinalizerRecord({
    session: genuine.record,
    terminalJobState: "success",
    absenceObservations: [{ status: 404 }],
    finalizer: {
      workflowSha: genuine.record.workflowSha,
      run: genuine.record.run,
      job: "finalize-manual-session",
      environment: "forge3d-trust-observer",
      observedAt: "2026-07-29T10:21:00.000Z",
    },
  });
  const mediaBytes = Buffer.from("genuine-media");
  const mediaDigest = sha256(mediaBytes);
  const signedSessionBytes = Buffer.from(canonicalJson(genuine));
  const finalizerBytes = Buffer.from(canonicalJson(finalizer));
  const prepared = prepareManualSubmission({
    dispatch: {
      intakeReleaseId: "50", manualSessionRunId: "30", hardwareJobId: "31",
      mediaAssetIds: "[40]", stepResults: canonicalJson(input.stepResults),
    },
    releaseApi: { id: 50, draft: true, tag_name: "manual-evidence-intake-20", target_commitish: intake.trustedSha },
    intake, intakeBytes, signedSession: genuine, signedSessionBytes,
    sessionFinalizer: finalizer, sessionFinalizerBytes: finalizerBytes,
    sessionRunApi: { id: 30, run_attempt: 1, path: genuine.record.workflow, head_branch: "main", head_sha: intake.trustedSha, event: "workflow_dispatch", status: "completed", conclusion: "success" },
    hardwareJobApi: { id: 31, name: "Browser Hardware / Ephemeral Execution", status: "completed", conclusion: "success", runner_id: 32, runner_name: authorization.runnerName },
    releaseAssets: [{ id: 39, name: "intake-manifest.json" }, { id: 40, name: "trackpad.mp4", uploader: { login: "tester" }, size: mediaBytes.length, content_type: "video/mp4", created_at: "2026-07-29T10:10:00Z", digest: `sha256:${mediaDigest}` }],
    mediaBytesById: new Map([[40, mediaBytes]]), approvals: input.approvals,
    implementationActors: input.implementationActors, actor: "tester",
    submissionRun: input.submissionRun,
  });
  assert.deepEqual(prepared.session, genuine.record);
  assert.equal(canonicalJson(prepared.session), genuine.canonical);
  assert.equal(Object.hasOwn(prepared.session, "controllerSignatureSha256"), false);
  assert.equal(prepared.controllerSignatureSha256, sha256(Buffer.from(genuine.signature.value, "base64url")));
  assert.equal(validateManualSubmission({ ...prepared, now: input.now }).media[0].sha256, mediaDigest);
});

test("infrastructure submission produces a non-support manual canary, not a product row", () => {
  const canaryIntake = createIntakeManifest({
    trustedSha: intake.trustedSha,
    packageRunId: 10,
    packageSha256: intake.packageSha256,
    checklistId: "infrastructure-manual-canary",
    assetId: "FW-TRACKPAD-01",
    ...activeManualMatrices("FW-TRACKPAD-01"),
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
        approvals: [{
          state: "approved",
          user: { id: 1, login: "tester" },
          environments: [{ id: 600, name: "forge3d-manual-evidence" }],
        }],
      }),
    /independent/u,
  );
  assert.throws(
    () =>
      validateManualSubmission({
        ...structuredClone(input),
        approvals: [{
          state: "approved",
          user: { id: 61, login: "unrelated" },
          environments: [{ id: 601, name: "other-environment" }],
        }],
      }),
    /no approval exists/u,
  );
  assert.throws(
    () =>
      validateManualSubmission({
        ...structuredClone(input),
        approvals: [{
          state: "approved",
          user: { id: 61, login: "mixed" },
          environments: [
            { id: 600, name: "forge3d-manual-evidence" },
            { id: 601, name: "other-environment" },
          ],
        }],
      }),
    /mixes/u,
  );
  assert.throws(
    () =>
      validateManualSubmission({
        ...structuredClone(input),
        actor: "Tester",
        approvals: [{
          state: "approved",
          user: { id: 62, login: "tester" },
          environments: [{ id: 600, name: "forge3d-manual-evidence" }],
        }],
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

test("manual evidence preserves every exact target-environment approval", () => {
  const evidence = validateManualSubmission({
    ...structuredClone(input),
    approvals: [
      ...structuredClone(input.approvals),
      {
        state: "approved",
        user: { id: 61, login: "second-approver" },
        environments: [{ id: 600, name: "forge3d-manual-evidence" }],
      },
    ],
  });
  assert.deepEqual(
    evidence.approvalProvenance.map((approval) => approval.login),
    ["independent-approver", "second-approver"],
  );
});
