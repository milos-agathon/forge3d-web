import assert from "node:assert/strict";
import test from "node:test";

import { createIntakeManifest } from "../../scripts/manual-evidence.mjs";
import { verifyManualIntake } from "../../scripts/resolve-manual-intake.mjs";
import { activeManualMatrices } from "./manual-intake-fixture.mjs";

const bytes = Buffer.from("intake bytes");
const digest = "4ddfccdb4f1ff02d0913731b75e710981a69de79b1723cbd40230ee7fde8713d";
const intake = createIntakeManifest({
  trustedSha: "a".repeat(40),
  packageRunId: 12,
  packageSha256: "b".repeat(64),
  checklistId: "mobile-multitouch",
  assetId: "FW-AND-QCOM-01",
  ...activeManualMatrices("FW-AND-QCOM-01"),
  expectedTester: "tester",
  prepareRun: { id: 20, attempt: 1, workflowSha: "c".repeat(40) },
  now: new Date("2026-07-29T10:00:00Z"),
  random: () => Buffer.alloc(16, 7),
});
const fixture = {
  release: {
    id: 30,
    draft: true,
    tagName: "manual-evidence-intake-20",
    targetCommitish: intake.trustedSha,
  },
  intakeAsset: { name: "intake-manifest.json", sha256: digest },
  intake,
  intakeBytes: bytes,
  attestation: {
    repository: "milos-agathon/forge3d-web",
    signerWorkflow:
      "milos-agathon/forge3d-web/.github/workflows/prepare-browser-manual-evidence.yml",
    sourceRef: "refs/heads/main",
    sourceDigest: intake.prepareRun.workflowSha,
    denySelfHostedRunners: true,
    subjectSha256: digest,
  },
  dispatch: {
    intakeReleaseId: 30,
    trustedSha: intake.trustedSha,
    packageRunId: 12,
    lane: "manual-mobile-multitouch",
    canaryMode: null,
    assetId: intake.assetId,
    hostId: intake.hostId,
  },
  packageManifest: { packageSha256: intake.packageSha256 },
  actor: "tester",
  now: new Date("2026-07-29T11:00:00Z"),
};

test("manual promotion derives only challenge and intake digest from verified draft", () => {
  assert.deepEqual(verifyManualIntake(fixture), {
    intakeReleaseId: 30,
    checklistId: "mobile-multitouch",
    mediaChallenge: intake.mediaChallenge,
    intakeManifestSha256: digest,
  });
});

test("wrong actor, lane, expiry, package, or attestation fails before promotion", () => {
  for (const change of [
    { actor: "other" },
    { dispatch: { ...fixture.dispatch, lane: "manual-safari-trackpad" } },
    { now: new Date("2026-07-30T10:00:00Z") },
    { packageManifest: { packageSha256: "d".repeat(64) } },
    {
      attestation: {
        ...fixture.attestation,
        denySelfHostedRunners: false,
      },
    },
  ]) {
    assert.throws(() => verifyManualIntake({ ...fixture, ...change }));
  }
});
