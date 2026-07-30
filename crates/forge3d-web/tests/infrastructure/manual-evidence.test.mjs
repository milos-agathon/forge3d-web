import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checklistDefinition,
  createIntakeManifest,
  createManualEvidence,
  validateMediaAssets,
  validateStepResults,
} from "../../scripts/manual-evidence.mjs";
import { createManualSession } from "../../../../tools/browser-lab-controller/src/manual-session.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const intakeSchema = readJson("manual-evidence-intake.schema.json");
const sessionSchema = readJson("manual-session.schema.json");
const evidenceSchema = readJson("manual-evidence.schema.json");
const sha = "a".repeat(40);

test("device matrix freezes six public Appium IDs without serials or UDIDs", () => {
  const matrix = JSON.parse(
    readFileSync(join(root, "..", "device", "device-matrix.json"), "utf8"),
  );
  const schema = JSON.parse(
    readFileSync(
      join(root, "..", "device", "device-matrix.schema.json"),
      "utf8",
    ),
  );
  assertJsonSchema(matrix, schema);
  assert.equal(matrix.devices.length, 6);
  const serialized = JSON.stringify(matrix).toLowerCase();
  for (const forbidden of ["udid", "serialnumber", "teamid", "personal apple"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("checked manual checklists expose unique complete step IDs and isolate canary scope", () => {
  const mobile = checklistDefinition("mobile-multitouch");
  const trackpad = checklistDefinition("safari-trackpad");
  const canary = checklistDefinition("infrastructure-manual-canary");
  assert.ok(mobile.stepIds.includes("PEN_OR_PENCIL_ORBIT"));
  assert.ok(mobile.stepIds.includes("BACKGROUND_FOREGROUND"));
  assert.ok(trackpad.stepIds.includes("TRACKPAD_PINCH_ZOOM"));
  assert.equal(canary.supportClaim, false);
  assert.equal(canary.stepIds.some((id) => id.includes("ORBIT")), false);
});

test("intake binds authenticated actor, exact package/checklist/asset, 128-bit challenge, and 24 hours", () => {
  let requested = null;
  const intake = createIntakeManifest({
    trustedSha: sha,
    packageRunId: 10,
    packageSha256: "b".repeat(64),
    checklistId: "mobile-multitouch",
    assetId: "FW-AND-QCOM-01",
    expectedTester: "tester-login",
    prepareRun: { id: 20, attempt: 1, workflowSha: "c".repeat(40) },
    now: new Date("2026-07-29T10:00:00.000Z"),
    random: (bytes) => {
      requested = bytes;
      return Buffer.alloc(16, 9);
    },
  });
  assert.equal(requested, 16);
  assertJsonSchema(intake, intakeSchema);
  assert.equal(intake.mediaChallenge, "09".repeat(16));
  assert.equal(intake.expiresAt, "2026-07-30T10:00:00.000Z");
});

test("manual session is exactly 20 minutes, controller-signed, and cleanup-complete", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const intake = intakeFixture();
  const authorization = authorizationFixture(intake);
  const session = createManualSession({
    authorization,
    intake,
    runner: { id: 30, name: `FW-MAC-M2-01-${"d".repeat(32)}` },
    system: { os: "macOS 26", build: "25A123" },
    loginSession: { interactive: true, locked: false, remote: false },
    browser: { name: "Safari", channel: "stable", version: "26.0" },
    driver: { name: "safaridriver", version: "Included with Safari 26.0" },
    origins: {
      application: "https://mac-m2.webgpu-ci.forge3d.dev",
      asset: "https://assets-mac-m2.webgpu-ci.forge3d.dev",
    },
    routeBasePath: `/runs/20/21/${"e".repeat(32)}/`,
    packageRecord: {
      runId: 10,
      sha256: intake.packageSha256,
      harnessSha256: "f".repeat(64),
    },
    startedAt: "2026-07-29T10:00:00.000Z",
    endedAt: "2026-07-29T10:20:00.000Z",
    cleanup: cleanupFixture(),
    privateKey,
    signingKeyId: "controller-fw-mac-m2-01-p256-v1",
  });
  assertJsonSchema(session.record, sessionSchema);
  assert.equal(session.signature.algorithm, "SHA256withECDSA");
  assert.throws(
    () =>
      createManualSession({
        authorization,
        intake,
        startedAt: "2026-07-29T10:00:00.000Z",
        endedAt: "2026-07-29T10:19:59.000Z",
      }),
    /exactly 20 minutes/u,
  );
});

test("media and evidence require exact inventory, uploader, digest, window, steps, and independent actors", () => {
  const intake = intakeFixture();
  const session = {
    ...sessionFixture(intake),
    intakeManifestSha256: intake.sha256,
  };
  const asset = {
    id: 50,
    name: "gesture.webm",
    uploader: intake.expectedTester,
    size: 1024,
    mimeType: "video/webm",
    createdAt: "2026-07-29T10:10:00.000Z",
    apiSha256: "9".repeat(64),
    sha256: "9".repeat(64),
  };
  const media = validateMediaAssets({
    selectedAssets: [asset],
    releaseAssets: [{ id: 40 }, asset],
    intakeManifestAssetId: 40,
    intake,
    session,
    actor: intake.expectedTester,
  });
  const stepResults = Object.fromEntries(
    intake.stepIds.map((stepId) => [stepId, "pass"]),
  );
  assert.deepEqual(Object.keys(validateStepResults(stepResults, intake)), intake.stepIds);
  const evidence = createManualEvidence({
    intake,
    session,
    stepResults,
    media,
    actor: intake.expectedTester,
    approver: { id: 60, login: "independent-approver" },
    implementationActors: new Set(["implementation-author"]),
    submissionRun: { id: 70, attempt: 1, workflowSha: "8".repeat(40) },
    intakeReleaseId: 80,
    controllerSignatureSha256: "7".repeat(64),
  });
  assertJsonSchema(evidence, evidenceSchema);

  assert.throws(
    () => validateStepResults({ ...stepResults, EXTRA: "pass" }, intake),
    /complete checked-in step-ID set/u,
  );
  assert.throws(
    () =>
      validateMediaAssets({
        selectedAssets: [{ ...asset, uploader: "other" }],
        releaseAssets: [{ id: 40 }, { ...asset, uploader: "other" }],
        intakeManifestAssetId: 40,
        intake,
        session,
        actor: intake.expectedTester,
      }),
    /media asset is invalid/u,
  );
  assert.throws(
    () =>
      createManualEvidence({
        intake,
        session,
        stepResults,
        media,
        actor: intake.expectedTester,
        approver: { id: 60, login: "implementation-author" },
        implementationActors: new Set(["implementation-author"]),
      }),
    /independent/u,
  );
});

function intakeFixture() {
  const intake = createIntakeManifest({
    trustedSha: sha,
    packageRunId: 10,
    packageSha256: "b".repeat(64),
    checklistId: "mobile-multitouch",
    assetId: "FW-AND-QCOM-01",
    expectedTester: "tester-login",
    prepareRun: { id: 20, attempt: 1, workflowSha: "c".repeat(40) },
    now: new Date("2026-07-29T09:00:00.000Z"),
    random: () => Buffer.alloc(16, 9),
  });
  intake.sha256 = createHash("sha256")
    .update(JSON.stringify(intake))
    .digest("hex");
  return intake;
}

function authorizationFixture(intake) {
  return {
    workflow: { sha: "c".repeat(40) },
    run: { id: 20, attempt: 1 },
    queuedHardwareJob: { id: 21 },
    trustedSha: intake.trustedSha,
    hostId: intake.hostId,
    assetId: intake.assetId,
    sha256: "1".repeat(64),
    manualSession: {
      mediaChallenge: intake.mediaChallenge,
      intakeManifestSha256: intake.sha256,
    },
    labReadiness: {
      runId: 5,
      labInfrastructureDigest: "6".repeat(64),
    },
  };
}

function sessionFixture(intake) {
  return {
    run: { id: 20, attempt: 1 },
    hardwareJobId: 21,
    trustedSha: intake.trustedSha,
    package: { sha256: intake.packageSha256 },
    assetId: intake.assetId,
    hostId: intake.hostId,
    mediaChallenge: intake.mediaChallenge,
    authorizationSha256: "1".repeat(64),
    labReadiness: {
      runId: 5,
      labInfrastructureDigest: "6".repeat(64),
    },
    routeBasePath: `/runs/20/21/${"e".repeat(32)}/`,
    startedAt: "2026-07-29T10:00:00.000Z",
    endedAt: "2026-07-29T10:20:00.000Z",
  };
}

function cleanupFixture() {
  return {
    browserStopped: true,
    driverStopped: true,
    fixtureStopped: true,
    tunnelStopped: true,
    updatesRestored: true,
    runnerAbsent: true,
  };
}

function readJson(name) {
  return JSON.parse(readFileSync(join(root, name), "utf8"));
}
