import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPromotion,
  createRunnerAuthorization,
  validateHardwareDispatch,
} from "../../scripts/hardware-orchestration.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const matrix = readJson("hardware-matrix.json");
const policy = readJson("browser-policy.json");
const authorizationSchema = readJson("runner-authorization.schema.json");
const sha = "a".repeat(40);
const labReadiness = {
  runId: 20,
  manifestSha256: "f".repeat(64),
  labInfrastructureDigest: "e".repeat(64),
};

test("closed dispatch rules separate canary, browser, and manual lanes", () => {
  const canary = validateHardwareDispatch(
    {
      lane: "infrastructure-canary",
      assetId: "FW-LNX-NV-01",
      required: true,
      trustedSha: sha,
      packageRunId: "10",
      canaryMode: "host",
    },
    matrix,
  );
  assert.equal(canary.hostId, "FW-LNX-NV-01");
  assert.equal(canary.labReadinessRunId, null);
  assert.throws(
    () =>
      validateHardwareDispatch(
        {
          lane: "infrastructure-canary",
          assetId: "FW-LNX-NV-01",
          required: true,
          trustedSha: sha,
          packageRunId: "10",
          labReadinessRunId: "20",
          canaryMode: "host",
        },
        matrix,
      ),
    /cannot consume laboratory readiness/u,
  );
  assert.throws(
    () =>
      validateHardwareDispatch(
        {
          lane: "chrome-linux-rtx3070",
          assetId: "FW-LNX-NV-01",
          required: true,
          trustedSha: sha,
          packageRunId: "10",
        },
        matrix,
      ),
    /requires labReadinessRunId/u,
  );
  assert.throws(
    () =>
      validateHardwareDispatch(
        {
          lane: "manual-mobile-multitouch",
          assetId: "FW-AND-QCOM-01",
          required: true,
          trustedSha: sha,
          packageRunId: "10",
          labReadinessRunId: "20",
        },
        matrix,
      ),
    /requires readiness and intake/u,
  );
});

test("Chrome Beta probes are optional, asset-bound, and never required rows", () => {
  const probe = validateHardwareDispatch({
    lane: "chrome-beta-linux-intel12", assetId: "FW-LNX-I12-01", required: false,
    trustedSha: sha, packageRunId: "10", labReadinessRunId: "20",
  }, matrix);
  assert.equal(probe.required, false);
  assert.equal(probe.hostId, "FW-LNX-I12-01");
  assert.throws(() => validateHardwareDispatch({
    lane: "chrome-beta-linux-intel12", assetId: "FW-LNX-I12-01", required: true,
    trustedSha: sha, packageRunId: "10", labReadinessRunId: "20",
  }, matrix), /reject required:true/u);
  assert.throws(() => validateHardwareDispatch({
    lane: "chrome-beta-linux-intel12", assetId: "FW-LNX-NV-01", required: false,
    trustedSha: sha, packageRunId: "10", labReadinessRunId: "20",
  }, matrix), /not routed/u);
  assert.equal(matrix.hosts.flatMap((host) => host.requiredBrowserLanes).some((lane) => lane.includes("beta")), false);
});

test("Firefox dispatch preserves the closed stable-required and Nightly-optional classifications", () => {
  const base = { trustedSha: sha, packageRunId: "10", labReadinessRunId: "20" };
  assert.throws(() => validateHardwareDispatch({ ...base, lane: "firefox-macos-m2",
    assetId: "FW-MAC-M2-01", required: false }, matrix), /reject required:false/u);
  assert.throws(() => validateHardwareDispatch({ ...base, lane: "firefox-nightly-linux-intel12",
    assetId: "FW-LNX-I12-01", required: true }, matrix), /reject required:true/u);
  assert.equal(validateHardwareDispatch({ ...base, lane: "firefox-nightly-linux-intel12",
    assetId: "FW-LNX-I12-01", required: false }, matrix).required, false);
});

test("all mobile, trackpad, and desktop Safari work serialize on the Mac host", () => {
  for (const [lane, assetId] of [
    ["mobile-usb-controller", "FW-AND-QCOM-01"],
    ["mobile-usb-controller", "FW-IOS-NEW-01"],
    ["manual-mobile-multitouch", "FW-IPAD-01"],
    ["manual-safari-trackpad", "FW-TRACKPAD-01"],
    ["safari-macos-m2", "FW-MAC-M2-01"],
  ]) {
    const dispatch = {
      lane,
      assetId,
      required: true,
      trustedSha: sha,
      packageRunId: "10",
      labReadinessRunId: "20",
      ...(lane.startsWith("manual-") ? { intakeReleaseId: "30" } : {}),
    };
    assert.equal(validateHardwareDispatch(dispatch, matrix).hostId, "FW-MAC-M2-01");
  }
});

test("promotion generates only the derived hardware and nonce labels", () => {
  let requested = null;
  const promotion = createPromotion({
    dispatch: {
      lane: "chrome-linux-rtx3070",
      assetId: "FW-LNX-NV-01",
      required: true,
      trustedSha: sha,
      packageRunId: "10",
      labReadinessRunId: "20",
    },
    matrix,
    trustEpochSha: "b".repeat(40),
    workflowSha: "c".repeat(40),
    packageManifestSha256: "d".repeat(64),
    labReadiness,
    random: (bytes) => {
      requested = bytes;
      return Buffer.alloc(16, 9);
    },
  });
  assert.equal(requested, 16);
  assert.deepEqual(promotion.customLabels, [
    "forge3d-web",
    "hw-linux-rtx3070",
    `jit-${"09".repeat(16)}`,
  ]);
});

test("authorization freezes exact queued job, labels, expiry, and package/readiness", () => {
  const promotion = createPromotion({
    dispatch: {
      lane: "chrome-linux-rtx3070",
      assetId: "FW-LNX-NV-01",
      required: true,
      trustedSha: sha,
      packageRunId: "10",
      labReadinessRunId: "20",
    },
    matrix,
    trustEpochSha: "b".repeat(40),
    workflowSha: "c".repeat(40),
    packageManifestSha256: "d".repeat(64),
    labReadiness,
    random: () => Buffer.alloc(16, 9),
  });
  const authorization = createRunnerAuthorization({
    promotion,
    queuedJob: {
      id: 50,
      name: "Browser Hardware / Ephemeral Execution",
      status: "queued",
      labels: promotion.customLabels,
    },
    workflow: { sha: "c".repeat(40) },
    run: { id: 40, attempt: 1 },
    promotionJobId: 41,
    authorizationJobId: 42,
    policy,
    issuedAt: new Date("2026-07-29T10:00:00.000Z"),
  });
  assertJsonSchema(authorization.record, authorizationSchema);
  assert.equal(
    authorization.record.expiresAt,
    "2026-07-29T10:10:00.000Z",
  );
  assert.deepEqual(authorization.record.labReadiness, labReadiness);
  assert.throws(
    () =>
      createRunnerAuthorization({
        promotion,
        queuedJob: {
          id: 50,
          name: "Browser Hardware / Ephemeral Execution",
          status: "queued",
          labels: [
            "forge3d-web",
            "hw-linux-rtx3070",
            `jit-${"08".repeat(16)}`,
          ],
        },
        workflow: { sha: "c".repeat(40) },
        run: { id: 40, attempt: 1 },
        promotionJobId: 41,
        authorizationJobId: 42,
        policy,
      }),
    /custom labels/u,
  );
});

test("promotion rejects missing, mismatched, or malformed readiness identities", () => {
  const base = {
    dispatch: {
      lane: "chrome-linux-rtx3070",
      assetId: "FW-LNX-NV-01",
      required: true,
      trustedSha: sha,
      packageRunId: "10",
      labReadinessRunId: "20",
    },
    matrix,
    trustEpochSha: "b".repeat(40),
    workflowSha: "c".repeat(40),
    packageManifestSha256: "d".repeat(64),
    random: () => Buffer.alloc(16, 9),
  };
  for (const changed of [
    null,
    { ...labReadiness, runId: 19 },
    { ...labReadiness, manifestSha256: "0".repeat(63) },
  ]) {
    assert.throws(
      () => createPromotion({ ...base, labReadiness: changed }),
      /exact laboratory readiness identity/u,
    );
  }
});

function readJson(name) {
  return JSON.parse(readFileSync(join(root, name), "utf8"));
}
