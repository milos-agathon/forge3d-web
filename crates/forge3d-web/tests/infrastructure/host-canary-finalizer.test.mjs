import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { finalizeHostLabCanary } from "../../scripts/finalize-host-lab-canary.mjs";
import { joinAdapterAttestation } from "../../scripts/join-adapter-attestation.mjs";
import { createHostLabCanary } from "../../../../tools/browser-lab-controller/src/lab-canary.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const hostId = "FW-LNX-NV-01";
const keyId = "controller-fw-lnx-nv-01-p256-v1";
const hostCanarySchema = JSON.parse(
  readFileSync(new URL("./lab-host-canary.schema.json", import.meta.url), "utf8"),
);
const authorization = {
  record: {
    workflow: { sha: "a".repeat(40) },
    run: { id: 20, attempt: 2 },
    queuedHardwareJob: { id: 21 },
    lane: "infrastructure-canary",
    manualSession: null,
    hostId,
    assetId: hostId,
    trustedSha: "b".repeat(40),
    packageRunId: 12,
  },
  sha256: "c".repeat(64),
};
const pageAdapter = {
  schemaVersion: 1,
  runId: authorization.record.run.id,
  jobId: authorization.record.queuedHardwareJob.id,
  assetId: hostId,
  commit: authorization.record.trustedSha,
  packageSha256: "d".repeat(64),
  navigatorGpu: true,
  adapterInfoAvailable: true,
  adapterInfo: {
    vendor: "nvidia",
    architecture: "ampere",
    device: "RTX 3070",
    description: "NVIDIA GeForce RTX 3070",
    isFallbackAdapter: false,
  },
  isFallbackAdapter: false,
  deviceAdapterInfo: null,
  limits: { maxTextureDimension2D: 16384 },
  deviceCreated: true,
  surfaceCreated: true,
  surfacePresented: true,
  presentedFrameLuma: 0.42,
  lumaChanged: true,
  effectiveLaunchArguments: [],
};
const session = {
  interactive: true,
  locked: false,
  remote: false,
  identifier: "7",
};
const adapterHost = {
  schemaVersion: 1,
  lane: "infrastructure-canary",
  runId: authorization.record.run.id,
  jobId: authorization.record.queuedHardwareJob.id,
  assetId: hostId,
  commit: authorization.record.trustedSha,
  packageSha256: "d".repeat(64),
  hostId,
  platform: "linux",
  expectedGpu: "NVIDIA GeForce RTX 3070 8 GB",
  expectedGpuPresent: true,
  headedSessionAvailable: true,
  osBuild: "Ubuntu 24.04.3 LTS",
  session,
  inventoryCapturedAt: "2026-07-29T10:00:00.000Z",
  commandEvidence: {
    lspci: "NVIDIA Corporation GA104 GeForce RTX 3070",
    nvidiaSmi: "NVIDIA GeForce RTX 3070, 555.42.02",
  },
  capturedAt: "2026-07-29T10:01:00.000Z",
};
const adapterAttestation = joinAdapterAttestation(pageAdapter, adapterHost);
const inventory = {
  schemaVersion: 1,
  assetId: hostId,
  platform: "linux",
  osBuild: "Ubuntu 24.04.3 LTS",
  headed: true,
  displayServer: "GNOME Wayland",
  session,
  browsers: [
    {
      id: "chrome-stable",
      channel: "stable",
      classification: "required",
      automation: "playwright",
      version: "150.0.7339.1",
      executable: "/usr/bin/google-chrome",
    },
  ],
  tools: {
    playwright: "1.56.1",
    selenium: "4.35.0",
    geckodriver: "0.36.0",
  },
  effectiveLaunchArguments: [],
  prohibitedLaunchArgumentsPresent: [],
  capturedAt: "2026-07-29T10:00:00.000Z",
  hostId,
  attachedAssetIds: [],
};
const certificate = {
  authorized: true,
  authorizationError: null,
  subject: "lab.webgpu-ci.forge3d.dev",
  issuer: "Let's Encrypt",
  validFrom: "Jul 29 00:00:00 2026 GMT",
  validTo: "Oct 27 23:59:59 2026 GMT",
  fingerprint256: "AA:BB:CC:DD",
};
const route = {
  ok: true,
  applicationHost: "lnx-nv-app.webgpu-ci.forge3d.dev",
  assetHost: "lnx-nv-asset.webgpu-ci.forge3d.dev",
  basePath: `/runs/20/21/${"1".repeat(32)}/`,
  packageSha256: "d".repeat(64),
  certificates: {
    application: certificate,
    asset: certificate,
  },
  httpsVerified: true,
  corsRangeControlsPassed: true,
};
const signedRecord = createHostLabCanary({
  authorization: {
    ...authorization.record,
    sha256: authorization.sha256,
  },
  browserEvidence: {
    result: "PASS",
    packageSha256: "d".repeat(64),
    assertions: { supportAssertionsExecuted: false },
    adapter: pageAdapter,
  },
  adapterAttestation,
  inventory,
  route,
  execution: {
    acceptedJobCount: 1,
    cleanupComplete: true,
    runnerId: 31,
    runnerName: `${hostId}-${"e".repeat(32)}`,
    runnerAbsent: true,
  },
  privateKey: keys.privateKey,
  signingKeyId: keyId,
});
const matrix = {
  hosts: [
    {
      assetId: hostId,
      controller: {
        state: "online",
        signingKeyId: keyId,
        publicJwk: keys.publicKey.export({ format: "jwk" }),
      },
    },
  ],
};
const hardwareJob = {
  id: 21,
  name: "Browser Hardware / Ephemeral Execution",
  status: "completed",
  conclusion: "success",
  runner_id: 31,
  runner_name: signedRecord.record.runner.name,
};
const finalizer = {
  workflowSha: authorization.record.workflow.sha,
  run: authorization.record.run,
  job: "finalize-hardware-evidence",
  environment: "forge3d-trust-observer",
  observedAt: "2026-07-29T11:00:00.000Z",
};

test("host finalizer joins controller signature, exact job, and independent absence", () => {
  const absenceObservations = [
    {
      status: 404,
      sha256: "f".repeat(64),
      observedAt: "2026-07-29T10:59:59.000Z",
    },
  ];
  const result = finalizeHostLabCanary({
    signedRecord,
    authorization,
    hardwareJob,
    matrix,
    absenceObservations,
    finalizer,
  });
  assertJsonSchema(result, hostCanarySchema);
  assert.equal(result.attestation.verified, true);
  assert.equal(result.controller.signatureVerified, true);
  assert.equal(result.finalizer.absenceObservations.at(-1).status, 404);
  assert.throws(
    () =>
      assertJsonSchema(
        {
          ...result,
          controller: {
            ...result.controller,
            unreviewedProvenance: true,
          },
        },
        hostCanarySchema,
      ),
    /additional property/u,
  );
});

test("host finalizer rejects a substituted runner or missing absence", () => {
  assert.throws(() =>
    finalizeHostLabCanary({
      signedRecord,
      authorization,
      hardwareJob: { ...hardwareJob, runner_id: 99 },
      matrix,
      absenceObservations: [{ status: 200 }],
      finalizer,
    }),
  );
});
