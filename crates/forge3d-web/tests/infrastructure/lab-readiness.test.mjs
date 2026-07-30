import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  computeLabConfiguration,
  computeLabReadiness,
  verifyLabReadinessForPromotion,
} from "../../scripts/compute-lab-readiness.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const checkedMatrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const matrix = structuredClone(checkedMatrix);
matrix.provisioningState = "active";
for (const host of matrix.hosts) {
  host.state = "active";
  host.maintenanceReason = null;
  host.controller.state = "active";
  host.controller.signingKeyId =
    `controller-${host.assetId.toLowerCase()}-p256-v1`;
  host.controller.publicJwk = {
    kty: "EC",
    crv: "P-256",
    x: "a".repeat(43),
    y: "b".repeat(43),
  };
}
for (const asset of matrix.assets) asset.state = "active";
const candidateSha = "a".repeat(40);
const packageRecord = {
  runId: 50,
  targetSha: candidateSha,
  packageSha256: "b".repeat(64),
  attestation: { verified: true, denySelfHostedRunners: true },
};
const configuration = computeLabConfiguration({ repositoryRoot });

test("lab digest binds the production controller broker browser and route paths", () => {
  const paths = new Set(configuration.files.map(({ path }) => path));
  for (const path of [
    "crates/forge3d-web/scripts/browser-lane-runtime.mjs",
    "crates/forge3d-web/scripts/browser-launch-provenance.mjs",
    "crates/forge3d-web/scripts/browser-run-provenance.mjs",
    "crates/forge3d-web/scripts/join-adapter-attestation.mjs",
    "crates/forge3d-web/scripts/manage-browser-route.mjs",
    "crates/forge3d-web/scripts/manage-browser-update-window.mjs",
    "crates/forge3d-web/tests/browser/hardware-page-harness.js",
    "tools/browser-lab-broker/src/authorization-verifier.mjs",
    "tools/browser-lab-broker/src/runner-authorization.mjs",
    "tools/browser-lab-controller/src/controller-service.mjs",
    "tools/browser-lab-controller/src/controller-evidence-inputs.mjs",
    "tools/browser-lab-controller/src/production-dependencies.mjs",
    "tools/browser-lab-controller/src/unix-runner-execution.mjs",
    "tools/browser-lab-controller/src/windows-runner-execution.mjs",
    "tools/browser-lab-controller/services/browser-lab-controller.env.example",
    "tools/browser-lab-controller/services/browser-lab-controller.sudoers-linux",
    "tools/browser-lab-controller/services/browser-lab-controller.sudoers-macos",
    "tools/browser-lab-controller/services/unix-interactive-session-bridge.mjs",
    "tools/browser-lab-controller/services/unix-interactive-session-contract.mjs",
    "tools/browser-lab-controller/services/windows-interactive-session-bridge.ps1",
  ]) {
    assert.equal(paths.has(path), true, `${path} is not configuration-bound`);
  }
});

const hostCanaries = matrix.hosts.map((host, index) => ({
  runId: 60 + index,
  lane: "infrastructure-canary",
  canaryMode: "host",
  hostId: host.assetId,
  assetId: host.assetId,
  trustedSha: candidateSha,
  packageRunId: packageRecord.runId,
  packageSha256: packageRecord.packageSha256,
  result: "PASS",
  supportAssertionsExecuted: false,
  adapter: {
    isFallbackAdapter: false,
    deviceCreated: true,
    surfacePresented: true,
  },
  authorization: { attested: true },
  controller: { signatureVerified: true },
  runner: { acceptedJobCount: 1, absentAfterRun: true },
  cleanup: { complete: true },
  inventory: {
    hostId: host.assetId,
    attachedAssetIds: host.attachedAssetIds,
  },
  route: { httpsVerified: true, corsRangeControlsPassed: true },
  attestation: { verified: true },
}));
const manualCanary = {
  runId: 70,
  hardwareJobId: 71,
  intakeReleaseId: 72,
  lane: "infrastructure-canary",
  canaryMode: "manual",
  checklistId: "infrastructure-manual-canary",
  supportClaim: false,
  trustedSha: candidateSha,
  packageRunId: packageRecord.runId,
  packageSha256: packageRecord.packageSha256,
  session: {
    durationMinutes: 20,
    controllerSignatureVerified: true,
    runnerAbsent: true,
    cleanupComplete: true,
  },
  media: {
    authenticatedUploader: true,
    challengeMatched: true,
    digestsVerified: true,
  },
  productAssertionsExecuted: false,
  attestation: { verified: true },
  expiresAt: "2026-08-01T00:00:00Z",
};
const canaryRelease = {
  id: 80,
  publicationRunId: 81,
  tagName: `browser-lab-canary-${configuration.labInfrastructureDigest}-81`,
  targetSha: candidateSha,
  supportClaim: false,
  draft: false,
  immutableReleaseVerified: true,
  allAssetsVerified: true,
  intakeDeletedAfterVerification: true,
  attestation: { verified: true },
};
const base = {
  candidateSha,
  packageRecord,
  hostCanaries,
  manualCanary,
  canaryRelease,
  repositoryTrust: {
    verified: true,
    currentMainSha: candidateSha,
    targetSha: candidateSha,
  },
  matrix,
  configuration,
  run: { id: 90, attempt: 1, workflowSha: candidateSha },
  now: new Date("2026-07-30T00:00:00Z"),
};

test("readiness closes four hosts, generic manual canary, and immutable canary release", () => {
  const result = computeLabReadiness(base);
  assertJsonSchema(
    result.manifest,
    JSON.parse(
      readFileSync(
        new URL(
          "./browser-lab-infrastructure-readiness.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  assert.equal(result.manifest.status, "LAB_INFRA_READY");
  assert.equal(result.manifest.hostCanaryRunIds.length, 4);
  assert.equal(result.manifest.supportClaim, false);
});

test("product promotion consumes only same-SHA package-bound attested readiness", () => {
  const manifest = computeLabReadiness(base).manifest;
  const digest = verifyLabReadinessForPromotion({
    manifest,
    readinessRun: {
      id: 90,
      path: ".github/workflows/browser-lab-infrastructure-readiness.yml",
      headSha: candidateSha,
      headBranch: "main",
      conclusion: "success",
    },
    dispatch: {
      trustedSha: candidateSha,
      packageRunId: packageRecord.runId,
      labReadinessRunId: 90,
    },
    packageManifest: { packageSha256: packageRecord.packageSha256 },
    attestation: {
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/browser-lab-infrastructure-readiness.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: candidateSha,
      denySelfHostedRunners: true,
    },
  });
  assert.equal(digest, configuration.labInfrastructureDigest);
});

test("unprovisioned inventory, product assertions, stale media, and wrong release fail", () => {
  for (const changed of [
    { matrix: checkedMatrix },
    {
      manualCanary: {
        ...manualCanary,
        productAssertionsExecuted: true,
      },
    },
    { manualCanary: { ...manualCanary, expiresAt: "2026-07-29T00:00:00Z" } },
    { canaryRelease: { ...canaryRelease, tagName: "other" } },
    { hostCanaries: hostCanaries.slice(1) },
  ]) {
    assert.throws(() => computeLabReadiness({ ...base, ...changed }));
  }
});
