import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  computeEffectiveLabInfrastructure,
  computeLabConfiguration,
  computeLabReadiness,
  isFreshWithinAcceptanceWindow,
  labConfigurationFiles,
  validateLabConfigurationInventory,
  verifyLabReadinessForPromotion,
} from "../../scripts/compute-lab-readiness.mjs";
import { canonicalJson, sha256Hex } from "../../scripts/canonical-json.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";
import { exactHostInventory } from "./host-inventory-fixture.mjs";
import {
  diagnosticRetentionFixture,
  serviceInstallationFixture,
} from "./service-installation-fixture.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const checkedMatrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const hardwareMatrixSchema = JSON.parse(
  readFileSync(new URL("./hardware-matrix.schema.json", import.meta.url), "utf8"),
);
const checkedBrowserPolicy = JSON.parse(
  readFileSync(new URL("./browser-policy.json", import.meta.url), "utf8"),
);
const deviceMatrix = JSON.parse(
  readFileSync(new URL("../device/device-matrix.json", import.meta.url), "utf8"),
);
const httpsOriginPolicy = JSON.parse(
  readFileSync(new URL("./https-origin-policy.json", import.meta.url), "utf8"),
);
const runnerDistributionManifest = JSON.parse(
  readFileSync(
    new URL("./runner-distribution-manifest.json", import.meta.url),
    "utf8",
  ),
);
const checkedRunnerTransientPathPolicy = JSON.parse(
  readFileSync(
    new URL("./runner-transient-path-policy.json", import.meta.url),
    "utf8",
  ),
);
const matrix = structuredClone(checkedMatrix);
matrix.provisioningState = "active";
for (const host of matrix.hosts) {
  host.state = "active";
  host.maintenanceReason = null;
  host.controller.state = "online";
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
const runnerTransientPathPolicy = structuredClone(
  checkedRunnerTransientPathPolicy,
);
runnerTransientPathPolicy.canaryState = "verified";
const browserPolicy = {
  ...checkedBrowserPolicy,
  provisioningState: "active",
  runnerTransientPathPolicySha256: sha256Hex(runnerTransientPathPolicy),
};
const candidateSha = "a".repeat(40);
const packageRecord = {
  runId: 50,
  targetSha: candidateSha,
  packageSha256: "b".repeat(64),
  attestation: { verified: true, denySelfHostedRunners: true },
};
const configuration = computeLabConfiguration({ repositoryRoot });

test("lab digest binds plan-named files and the production dependency closure", () => {
  const paths = new Set(configuration.files.map(({ path }) => path));
  for (const path of [
    ".github/workflows/web.yml",
    "crates/forge3d-web/docs/browser-lab-runbook.md",
    "crates/forge3d-web/docs/release-checklist.md",
    "crates/forge3d-web/scripts/assemble-browser-package-artifact.mjs",
    "crates/forge3d-web/scripts/browser-lane-runtime.mjs",
    "crates/forge3d-web/scripts/browser-launch-provenance.mjs",
    "crates/forge3d-web/scripts/browser-run-provenance.mjs",
    "crates/forge3d-web/scripts/capture-trackpad-inventory.mjs",
    "crates/forge3d-web/scripts/emit-repository-trust-observation.mjs",
    "crates/forge3d-web/scripts/generate-runner-distribution-manifest.mjs",
    "crates/forge3d-web/scripts/join-adapter-attestation.mjs",
    "crates/forge3d-web/scripts/lab-canary-publication.mjs",
    "crates/forge3d-web/scripts/manage-browser-route.mjs",
    "crates/forge3d-web/scripts/manage-browser-update-window.mjs",
    "crates/forge3d-web/scripts/mint-github-app-token.mjs",
    "crates/forge3d-web/scripts/resolve-package-bootstrap.mjs",
    "crates/forge3d-web/scripts/probe-mobile-device-routes.mjs",
    "crates/forge3d-web/scripts/validate-hardware-matrix.mjs",
    "crates/forge3d-web/scripts/verify-repository-trust-observation.mjs",
    "crates/forge3d-web/scripts/verify-repository-trust.mjs",
    "crates/forge3d-web/scripts/verify-runner-distribution.mjs",
    "crates/forge3d-web/scripts/verify-workflow-action-pins.mjs",
    "crates/forge3d-web/tests/browser/json-schema-validator.mjs",
    "crates/forge3d-web/tests/browser/hardware-page-harness.js",
    "crates/forge3d-web/tests/infrastructure/browser-policy.json",
    "crates/forge3d-web/tests/infrastructure/browser-release-publication-record.schema.json",
    "crates/forge3d-web/tests/infrastructure/host-inventory.schema.json",
    "crates/forge3d-web/tests/infrastructure/mobile-device-route-readiness.schema.json",
    "crates/forge3d-web/tests/infrastructure/lab-canary-publication-record.schema.json",
    "crates/forge3d-web/tests/infrastructure/manual-media-sources.schema.json",
    "crates/forge3d-web/tests/infrastructure/runner-distribution-manifest.json",
    "crates/forge3d-web/tests/infrastructure/runner-transient-path-policy.json",
    "tools/browser-lab-broker/scripts/create-package-manifest.mjs",
    "tools/browser-lab-broker/services/browser-lab-broker.env.example",
    "tools/browser-lab-broker/src/authorization-verifier.mjs",
    "tools/browser-lab-broker/src/runner-authorization.mjs",
    "tools/browser-lab-controller/scripts/create-package-manifest.mjs",
    "tools/browser-lab-controller/src/broker-lifecycle-store.mjs",
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
    "tools/browser-lab-controller/services/unix-runner-transient-paths.mjs",
    "tools/browser-lab-controller/services/windows-interactive-session-bridge.ps1",
  ]) {
    assert.equal(paths.has(path), true, `${path} is not configuration-bound`);
  }
  const repositoryWorkflows = readdirSync(
    resolve(repositoryRoot, ".github/workflows"),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
  assert.deepEqual(
    configuration.files
      .map(({ path }) => path)
      .filter((path) => path.startsWith(".github/workflows/"))
      .sort(),
    repositoryWorkflows,
  );
});

test("lab configuration rejects omitted dependencies and stale workflow inventories", () => {
  assert.throws(
    () =>
      validateLabConfigurationInventory({
        repositoryRoot,
        files: labConfigurationFiles.filter(
          (path) => path !== ".github/workflows/web.yml",
        ),
      }),
    /exact workflow inventory/u,
  );
  assert.throws(
    () =>
      validateLabConfigurationInventory({
        repositoryRoot,
        files: labConfigurationFiles.filter(
          (path) =>
            path !==
            "crates/forge3d-web/tests/browser/json-schema-validator.mjs",
        ),
      }),
    /omits local dependency/u,
  );
});

const hostCanaries = matrix.hosts.map((host, index) => {
  const runId = 60 + index;
  const hardwareJobId = 160 + index;
  const record = {
  runId,
  runAttempt: 1,
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
  runner: {
    id: 260 + index,
    name: `${host.assetId}-${"c".repeat(32)}`,
    acceptedJobCount: 1,
    absentAfterRun: true,
  },
  cleanup: { complete: true },
  inventory: exactHostInventory(matrix, host.assetId),
  route: null,
  browserRouteReadiness: completeRouteFixture(),
  attestation: { verified: true },
  completedAt: `2026-07-29T10:${String(index + 1).padStart(2, "0")}:00.000Z`,
  controllerCompletion: {
    state: "completed",
    hostLockReleased: true,
    quarantined: false,
    completedAt: `2026-07-29T10:${String(index + 1).padStart(2, "0")}:00.000Z`,
  },
  hardwareJob: {
    id: hardwareJobId,
    startedAt: "2026-07-29T07:50:00.000Z",
    completedAt: `2026-07-29T10:${String(index).padStart(2, "0")}:00.000Z`,
  },
  finalizer: {
    run: { id: runId, attempt: 1 },
    observedAt: `2026-07-29T10:${String(index + 2).padStart(2, "0")}:00.000Z`,
  },
  mobileRouteReadiness: null,
  };
  record.route = hostRouteFixture(record);
  if (host.assetId === "FW-MAC-M2-01") {
    record.mobileRouteReadiness = mobileRouteFixture(record);
  }
  record.installations = {
    controller: serviceInstallationFixture({
      component: "controller",
      instanceId: host.assetId,
      targetSha: candidateSha,
      inventory: record.inventory,
      browserPolicy,
    }),
    broker: serviceInstallationFixture({
      component: "broker",
      instanceId: "browser-lab-broker",
      targetSha: candidateSha,
    }),
  };
  record.diagnosticRetention = diagnosticRetentionFixture({
    authorizationDigest: "d".repeat(64),
    hostId: host.assetId,
    run: { id: runId, attempt: 1 },
    runnerNonce: "c".repeat(32),
  });
  record.authorization.sha256 = record.diagnosticRetention.authorizationDigest;
  return record;
});
const effectiveInfrastructure = computeEffectiveLabInfrastructure({
  configuration,
  serviceInstallations: {
    broker: hostCanaries[0].installations.broker,
    controllers: [...hostCanaries]
      .sort((left, right) => left.hostId.localeCompare(right.hostId))
      .map((record) => record.installations.controller),
  },
});
const manualCanary = {
  runId: 70,
  runAttempt: 1,
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
    controllerCompletionState: "completed",
    hostLockReleased: true,
    quarantined: false,
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
const canaryPublication = canaryPublicationFixture();
const selectedRuns = {
  hosts: hostCanaries.map((record) => ({
    hostId: record.hostId,
    selectedRunId: record.runId,
    apiRunId: record.runId,
    runAttempt: record.runAttempt,
    workflowPath: ".github/workflows/browser-hardware.yml",
    createdAt: "2026-07-29T07:45:00.000Z",
    completedAt: `2026-07-29T10:${String(
      matrix.hosts.findIndex((host) => host.assetId === record.hostId) + 3,
    ).padStart(2, "0")}:00.000Z`,
    status: "completed",
    conclusion: "success",
    headSha: candidateSha,
    headBranch: "main",
    event: "workflow_dispatch",
    hardwareJobId: record.hardwareJob.id,
  })),
  manual: {
    selectedRunId: manualCanary.runId,
    apiRunId: manualCanary.runId,
    runAttempt: manualCanary.runAttempt,
    workflowPath: ".github/workflows/submit-browser-manual-evidence.yml",
    hardwareJobId: manualCanary.hardwareJobId,
    intakeReleaseId: manualCanary.intakeReleaseId,
  },
};
const base = {
  candidateSha,
  packageRecord,
  hostCanaries,
  manualCanary,
  selectedRuns,
  canaryPublication,
  repositoryTrust: {
    verified: true,
    currentMainSha: candidateSha,
    targetSha: candidateSha,
  },
  matrix,
  deviceMatrix,
  httpsOriginPolicy,
  browserPolicy,
  runnerDistributionManifest,
  runnerTransientPathPolicy,
  configuration,
  run: { id: 90, attempt: 1, workflowSha: candidateSha },
  now: new Date("2026-07-30T00:00:00Z"),
};

test("readiness closes four hosts, generic manual canary, and immutable canary release", () => {
  assert.doesNotThrow(() => assertJsonSchema(matrix, hardwareMatrixSchema));
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
  assert.equal(result.manifest.hostCanaryFreshness.length, 4);
  assert.equal(result.manifest.diagnosticRetentions.length, 4);
  assert.equal(
    result.manifest.hostCanaryFreshness.every(
      (entry) => entry.acceptanceWindowHours === 24,
    ),
    true,
  );
  assert.equal(result.manifest.mobileRouteReadiness.devices.length, 6);
  assert.match(
    result.manifest.mobileRouteReadiness.applicationUrl,
    /^https:\/\/mac-m2\.webgpu-ci\.forge3d\.dev\/runs\//u,
  );
  assert.match(
    result.manifest.mobileRouteReadiness.assetUrl,
    /^https:\/\/assets-mac-m2\.webgpu-ci\.forge3d\.dev\/runs\//u,
  );
  assert.equal(result.manifest.supportClaim, false);
  assert.equal(result.manifest.canaryPublication.run.attempt, 1);
  assert.equal(result.manifest.canaryPublication.artifact.id, 91);
  assert.equal(
    result.manifest.canaryPublication.verification.assets.length,
    canaryPublication.record.assets.length,
  );
  assert.deepEqual(result.manifest.canaryPublication.retainedMedia, [
    {
      sourceAssetId: 901,
      sourceName: "manual-proof.png",
      releaseName: "manual-media-901",
      size: Buffer.byteLength("retained-manual-media"),
      mimeType: "image/png",
      sha256: sha256Hex("retained-manual-media"),
      sourceApiDigest: `sha256:${sha256Hex("retained-manual-media")}`,
    },
  ]);
  const retainedReleaseProof =
    result.manifest.canaryPublication.verification.release;
  assert.equal(
    sha256Hex(Buffer.from(retainedReleaseProof.outputBytesBase64, "base64")),
    retainedReleaseProof.outputSha256,
  );
});

test("host evidence freshness accepts the exact window boundary and rejects stale or future instants", () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const window = 24 * 60 * 60 * 1000;
  assert.equal(isFreshWithinAcceptanceWindow(now - window, now, window), true);
  assert.equal(isFreshWithinAcceptanceWindow(now - window - 1, now, window), false);
  assert.equal(isFreshWithinAcceptanceWindow(now + 1, now, window), false);
});

test("readiness recomputes diagnostic file and receipt hashes", () => {
  const digestMismatch = structuredClone(hostCanaries);
  digestMismatch[0].diagnosticRetention.files[0].sha256 = "f".repeat(64);
  assert.throws(
    () => computeLabReadiness({ ...base, hostCanaries: digestMismatch }),
    /diagnostic retention receipt is invalid/u,
  );

  const receiptMismatch = structuredClone(hostCanaries);
  receiptMismatch[0].diagnosticRetention.sha256 = "f".repeat(64);
  assert.throws(
    () => computeLabReadiness({ ...base, hostCanaries: receiptMismatch }),
    /diagnostic retention receipt is invalid/u,
  );
});

test("readiness rejects stale host inventory and substituted mobile route declarations", () => {
  const staleHosts = structuredClone(hostCanaries);
  staleHosts[0].inventory.capturedAt = "2026-07-28T23:59:59.999Z";
  assert.throws(
    () => computeLabReadiness({ ...base, hostCanaries: staleHosts }),
    /host infrastructure canary is invalid/u,
  );
  const futureSelection = structuredClone(selectedRuns);
  futureSelection.hosts[0].completedAt = "2026-07-30T00:00:00.001Z";
  assert.throws(
    () => computeLabReadiness({ ...base, selectedRuns: futureSelection }),
    /host infrastructure canary is invalid/u,
  );
  const missingDevice = structuredClone(hostCanaries);
  const mac = missingDevice.find((record) => record.hostId === "FW-MAC-M2-01");
  mac.mobileRouteReadiness.probes.pop();
  assert.throws(
    () => computeLabReadiness({ ...base, hostCanaries: missingDevice }),
    /host infrastructure canary is invalid/u,
  );
  const hostDeclaration = structuredClone(hostCanaries);
  const declared = hostDeclaration.find(
    (record) => record.hostId === "FW-MAC-M2-01",
  );
  declared.mobileRouteReadiness.probes[0].routeReadiness.trustedHttps = false;
  assert.throws(
    () => computeLabReadiness({ ...base, hostCanaries: hostDeclaration }),
    /host infrastructure canary is invalid/u,
  );
});

test("readiness rejects caller-selected or swapped host route pairs", () => {
  const browserDidNotTrustAsset = structuredClone(hostCanaries);
  browserDidNotTrustAsset[0].browserRouteReadiness.assetCertificateTrusted =
    false;
  assert.throws(
    () =>
      computeLabReadiness({
        ...base,
        hostCanaries: browserDidNotTrustAsset,
      }),
    /host infrastructure canary is invalid/u,
  );

  const callerSelected = structuredClone(hostCanaries);
  callerSelected[0].route.applicationHost =
    "caller-selected.webgpu-ci.forge3d.dev";
  callerSelected[0].route.applicationUrl =
    `https://caller-selected.webgpu-ci.forge3d.dev${callerSelected[0].route.basePath}`;
  assert.throws(
    () => computeLabReadiness({ ...base, hostCanaries: callerSelected }),
    /host infrastructure canary is invalid/u,
  );

  const swapped = structuredClone(hostCanaries);
  const routeToSwap = swapped[1].route;
  [routeToSwap.applicationHost, routeToSwap.assetHost] =
    [routeToSwap.assetHost, routeToSwap.applicationHost];
  routeToSwap.applicationUrl =
    `https://${routeToSwap.applicationHost}${routeToSwap.basePath}`;
  routeToSwap.assetUrl = `https://${routeToSwap.assetHost}${routeToSwap.basePath}`;
  assert.throws(
    () => computeLabReadiness({ ...base, hostCanaries: swapped }),
    /host infrastructure canary is invalid/u,
  );
});

test("readiness rejects runner policies before clean JIT canary activation", () => {
  assert.throws(
    () =>
      computeLabReadiness({
        ...base,
        browserPolicy: {
          ...browserPolicy,
          provisioningState: "pending-jit-canary",
        },
      }),
    /not passed the clean JIT canary/u,
  );
  assert.throws(
    () =>
      computeLabReadiness({
        ...base,
        browserPolicy: checkedBrowserPolicy,
        runnerTransientPathPolicy: checkedRunnerTransientPathPolicy,
      }),
    /not passed the clean JIT canary/u,
  );
});

test("product promotion consumes only same-SHA package-bound attested readiness", () => {
  const manifest = computeLabReadiness(base).manifest;
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  const promotionContext = {
    readinessRun: {
      id: 90,
      attempt: 1,
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
    configuration,
    attestation: {
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/browser-lab-infrastructure-readiness.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: candidateSha,
      denySelfHostedRunners: true,
    },
  };
  const identity = verifyLabReadinessForPromotion({
    manifest,
    manifestBytes,
    ...promotionContext,
  });
  assert.deepEqual(identity, {
    runId: 90,
    manifestSha256: sha256Hex(manifestBytes),
    labInfrastructureDigest: effectiveInfrastructure.labInfrastructureDigest,
  });
  assert.throws(
    () =>
      verifyLabReadinessForPromotion({
        manifest,
        manifestBytes: Buffer.from(
          `${canonicalJson({ ...manifest, createdAt: "old" })}\n`,
        ),
        readinessRun: {
          id: 90,
          attempt: 1,
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
      }),
    /does not unlock/u,
  );
  const substitutedConfigurationDigest = "f".repeat(64);
  const substitutedManifest = {
    ...manifest,
    configurationDigest: substitutedConfigurationDigest,
    configurationFiles: manifest.configurationFiles.map((file, index) =>
      index === 0 ? { ...file, sha256: "e".repeat(64) } : file,
    ),
    labInfrastructureDigest: sha256Hex({
      schemaVersion: 1,
      configurationDigest: substitutedConfigurationDigest,
      serviceInstallationDigest: manifest.serviceInstallationDigest,
    }),
  };
  assert.throws(
    () =>
      verifyLabReadinessForPromotion({
        manifest: substitutedManifest,
        manifestBytes: Buffer.from(`${canonicalJson(substitutedManifest)}\n`),
        ...promotionContext,
      }),
    /does not unlock/u,
  );
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
    {
      canaryPublication: {
        ...canaryPublication,
        record: { ...canaryPublication.record, tag: "other" },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        record: {
          ...canaryPublication.record,
          intakeDeletedAfterVerification: true,
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        preflight: { ...canaryPublication.preflight, sha256: "f".repeat(64) },
      },
    },
    { hostCanaries: hostCanaries.slice(1) },
  ]) {
    assert.throws(() => computeLabReadiness({ ...base, ...changed }));
  }
});

test("readiness rejects stale selected or embedded host/manual/publication identities", () => {
  for (const changed of [
    {
      hostCanaries: [
        { ...hostCanaries[0], runId: hostCanaries[0].runId + 1000 },
        ...hostCanaries.slice(1),
      ],
    },
    {
      manualCanary: { ...manualCanary, runId: manualCanary.runId + 1000 },
    },
    {
      selectedRuns: {
        ...selectedRuns,
        manual: { ...selectedRuns.manual, apiRunId: manualCanary.runId + 1 },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        attestation: {
          ...canaryPublication.attestation,
          verified: false,
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        attestation: {
          ...canaryPublication.attestation,
          repository: "substitute/forge3d-web",
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        attestation: {
          ...canaryPublication.attestation,
          signerWorkflow:
            "milos-agathon/forge3d-web/.github/workflows/publish-web-release.yml",
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        attestation: {
          ...canaryPublication.attestation,
          sourceRef: "refs/heads/substitute",
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        attestation: {
          ...canaryPublication.attestation,
          sourceDigest: "0".repeat(40),
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        attestation: {
          ...canaryPublication.attestation,
          denySelfHostedRunners: false,
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        selection: {
          ...canaryPublication.selection,
          run: { ...canaryPublication.selection.run, runAttempt: 2 },
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        selection: {
          ...canaryPublication.selection,
          artifact: {
            ...canaryPublication.selection.artifact,
            digest: "sha256:garbage",
            archiveSha256: "garbage",
          },
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        selection: {
          ...canaryPublication.selection,
          artifact: {
            ...canaryPublication.selection.artifact,
            digest: `sha256:${"A".repeat(64)}`,
            archiveSha256: "A".repeat(64),
          },
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        record: {
          ...canaryPublication.record,
          publicationRun: {
            ...canaryPublication.record.publicationRun,
            attempt: 2,
          },
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        recordSha256: "0".repeat(64),
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        intakeBinding: {
          ...canaryPublication.intakeBinding,
          record: {
            ...canaryPublication.intakeBinding.record,
            media: canaryPublication.intakeBinding.record.media.map((asset) => ({
              ...asset,
              sha256: "0".repeat(64),
            })),
          },
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        selection: {
          ...canaryPublication.selection,
          artifact: {
            ...canaryPublication.selection.artifact,
            digest: `sha256:${"0".repeat(64)}`,
          },
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        selection: {
          ...canaryPublication.selection,
          artifact: { ...canaryPublication.selection.artifact, id: 0 },
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        freshVerification: {
          ...canaryPublication.freshVerification,
          assetVerifications:
            canaryPublication.freshVerification.assetVerifications.slice(1),
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        freshVerification: {
          ...canaryPublication.freshVerification,
          assetVerifications:
            canaryPublication.freshVerification.assetVerifications.map(
              (proof, index) =>
                index === 0
                  ? { ...proof, outputSha256: "0".repeat(64) }
                  : proof,
            ),
        },
      },
    },
    {
      canaryPublication: {
        ...canaryPublication,
        freshVerification: {
          ...canaryPublication.freshVerification,
          releaseVerification: {
            ...canaryPublication.freshVerification.releaseVerification,
            outputBytesBase64: Buffer.from(
              `${canonicalJson({ verified: false, source: "substituted" })}\n`,
            ).toString("base64"),
          },
        },
      },
    },
    {
      selectedRuns: {
        ...selectedRuns,
        hosts: selectedRuns.hosts.map((selection, index) =>
          index === 0 ? { ...selection, runAttempt: 2 } : selection,
        ),
      },
    },
  ]) {
    assert.throws(() => computeLabReadiness({ ...base, ...changed }));
  }
});

function canaryPublicationFixture() {
  const publicationRunId = 81;
  const tag =
    `browser-lab-canary-${effectiveInfrastructure.labInfrastructureDigest}-${publicationRunId}`;
  const candidateManifest = {
    schemaVersion: 1,
    recordType: "lab-canary-publication-candidate",
    supportClaim: false,
    candidateSha,
    publicationRunId,
    tag,
    labInfrastructureDigest: effectiveInfrastructure.labInfrastructureDigest,
    manualIntakeReleaseId: manualCanary.intakeReleaseId,
    intakeDeletionPlannedAfterVerification: true,
  };
  const candidateManifestSha256 = sha256Hex(candidateManifest);
  const syntheticSha256 = sha256Hex("synthetic");
  const retainedMediaBytes = Buffer.from("retained-manual-media");
  const retainedMediaSha256 = sha256Hex(retainedMediaBytes);
  const intakeBinding = {
    schemaVersion: 1,
    recordType: "lab-canary-manual-intake-binding",
    supportClaim: false,
    candidateSha,
    release: {
      id: manualCanary.intakeReleaseId,
      tagName: "manual-evidence-intake-61",
      targetCommitish: candidateSha,
      draft: true,
      prerelease: false,
    },
    intakeManifest: {
      id: 900,
      name: "intake-manifest.json",
      size: 10,
      sha256: "d".repeat(64),
      apiDigest: `sha256:${"d".repeat(64)}`,
    },
    media: [
      {
        id: 901,
        name: "manual-proof.png",
        releaseName: "manual-media-901",
        uploader: "tester",
        size: retainedMediaBytes.length,
        mimeType: "image/png",
        createdAt: "2026-07-29T23:50:00.000Z",
        sha256: retainedMediaSha256,
        apiDigest: `sha256:${retainedMediaSha256}`,
      },
    ],
  };
  const intakeBindingBytes = Buffer.from(`${JSON.stringify(intakeBinding)}\n`);
  const intakeBindingSha256 = sha256Hex(intakeBindingBytes);
  const preflight = {
    schemaVersion: 1,
    mode: "laboratory-canary",
    supportClaim: false,
    workflow: ".github/workflows/publish-browser-lab-canary.yml",
    run: {
      id: publicationRunId,
      attempt: 1,
    },
    targetSha: candidateSha,
    tag,
    readiness: {
      runId: publicationRunId,
      artifactId: 1,
      sha256: effectiveInfrastructure.labInfrastructureDigest,
      status: "LAB_CANARY_PREFLIGHT_READY",
    },
    assets: [
      {
        sourceId: 1,
        name: "browser-lab-canary-manifest.json",
        sha256: candidateManifestSha256,
      },
      {
        sourceId: 2,
        name: "manual-intake-binding.json",
        sha256: intakeBindingSha256,
      },
      { sourceId: 3, name: "synthetic.json", sha256: syntheticSha256 },
      {
        sourceId: 4,
        name: intakeBinding.media[0].releaseName,
        sha256: retainedMediaSha256,
      },
    ],
  };
  const preflightSha256 = sha256Hex(preflight);
  const assets = [
    {
      id: 101,
      name: "browser-lab-canary-manifest.json",
      size: 100,
      apiDigest: `sha256:${candidateManifestSha256}`,
      sha256: candidateManifestSha256,
    },
    {
      id: 102,
      name: "manual-intake-binding.json",
      size: intakeBindingBytes.length,
      apiDigest: `sha256:${intakeBindingSha256}`,
      sha256: intakeBindingSha256,
    },
    {
      id: 103,
      name: "synthetic.json",
      size: 9,
      apiDigest: `sha256:${syntheticSha256}`,
      sha256: syntheticSha256,
    },
    {
      id: 104,
      name: intakeBinding.media[0].releaseName,
      size: retainedMediaBytes.length,
      apiDigest: `sha256:${retainedMediaSha256}`,
      sha256: retainedMediaSha256,
    },
  ];
  const assetPages = [
    assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      digest: asset.apiDigest,
    })),
  ];
  const releaseVerification = {
    outputSha256: "c".repeat(64),
    output: { verified: true },
  };
  const assetVerifications = assets
    .map((asset, index) => ({
      name: asset.name,
      outputSha256: String(index + 1).repeat(64),
      output: { asset: asset.name, verified: true },
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const verificationBundleSha256 = sha256Hex([
    { name: "release", sha256: releaseVerification.outputSha256 },
    ...assetVerifications.map(({ name, outputSha256 }) => ({
      name,
      sha256: outputSha256,
    })),
  ]);
  const record = {
    schemaVersion: 1,
    recordType: "lab-canary-publication",
    supportClaim: false,
    candidateSha,
    labInfrastructureDigest: effectiveInfrastructure.labInfrastructureDigest,
    publicationRunId,
    publicationRun: {
      id: publicationRunId,
      attempt: 1,
      workflowPath: ".github/workflows/publish-browser-lab-canary.yml",
    },
    tag,
    candidateManifestSha256,
    preflightSha256,
    release: {
      id: 80,
      tagName: tag,
      targetCommitish: candidateSha,
      draft: false,
      prerelease: false,
      immutable: true,
      publishedAt: "2026-07-29T23:57:00.000Z",
    },
    assetApiPagination: {
      requestedPerPage: 100,
      pageCount: 1,
      totalAssets: assets.length,
      pagesSha256: sha256Hex(assetPages),
    },
    assets,
    releaseVerification,
    assetVerifications,
    verificationBundleSha256,
    verifiedAt: "2026-07-29T23:58:00.000Z",
    intake: {
      releaseId: manualCanary.intakeReleaseId,
      tagName: "manual-evidence-intake-61",
      bindingSha256: intakeBindingSha256,
      deletedAfterVerification: true,
      deletedAt: "2026-07-29T23:59:00.000Z",
    },
    createdAt: "2026-07-30T00:00:00.000Z",
  };
  const publicationArchiveSha256 = "e".repeat(64);
  const freshReleaseOutput = { verified: true, source: "readiness" };
  const freshReleaseBytes = `${canonicalJson(freshReleaseOutput)}\n`;
  const freshReleaseVerification = {
    outputBytesBase64: Buffer.from(freshReleaseBytes).toString("base64"),
    outputSha256: sha256Hex(freshReleaseBytes),
    output: freshReleaseOutput,
  };
  const freshAssetVerifications = assets.map((asset) => {
    const output = {
      asset: asset.name,
      verified: true,
      source: "readiness",
    };
    const bytes = `${canonicalJson(output)}\n`;
    return {
      name: asset.name,
      outputBytesBase64: Buffer.from(bytes).toString("base64"),
      outputSha256: sha256Hex(bytes),
      output,
    };
  });
  return {
    record,
    recordSha256: sha256Hex(`${canonicalJson(record)}\n`),
    attestation: {
      verified: true,
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/publish-browser-lab-canary.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: candidateSha,
      denySelfHostedRunners: true,
    },
    selection: {
      run: {
        selectedRunId: publicationRunId,
        apiRunId: publicationRunId,
        runAttempt: 1,
        workflowPath: ".github/workflows/publish-browser-lab-canary.yml",
        headSha: candidateSha,
        headBranch: "main",
        conclusion: "success",
      },
      artifact: {
        id: 91,
        name: `lab-canary-publication-${publicationRunId}-1`,
        digest: `sha256:${publicationArchiveSha256}`,
        archiveSha256: publicationArchiveSha256,
      },
    },
    candidateManifest: {
      record: candidateManifest,
      sha256: candidateManifestSha256,
    },
    intakeBinding: {
      record: intakeBinding,
      sha256: intakeBindingSha256,
      bytesBase64: intakeBindingBytes.toString("base64"),
    },
    preflight: { record: preflight, sha256: preflightSha256 },
    release: {
      id: record.release.id,
      tagName: tag,
      targetCommitish: candidateSha,
      draft: false,
      prerelease: false,
      immutable: true,
      publishedAt: record.release.publishedAt,
      assets,
    },
    proof: {
      assetPages: { pages: assetPages, sha256: record.assetApiPagination.pagesSha256 },
      releaseVerification,
      assetVerifications,
    },
    freshVerification: {
      releaseVerification: freshReleaseVerification,
      assetVerifications: freshAssetVerifications,
      verifiedAt: "2026-07-30T00:00:00.000Z",
    },
  };
}

function mobileRouteFixture(record) {
  const nonce = "c".repeat(32);
  const basePath = `/runs/${record.runId}/${record.hardwareJob.id}/${nonce}/`;
  const route = {
    schemaVersion: 1,
    applicationHost: "mac-m2.webgpu-ci.forge3d.dev",
    assetHost: "assets-mac-m2.webgpu-ci.forge3d.dev",
    basePath,
    applicationUrl: `https://mac-m2.webgpu-ci.forge3d.dev${basePath}`,
    assetUrl: `https://assets-mac-m2.webgpu-ci.forge3d.dev${basePath}`,
    expectedPackageSha256: packageRecord.packageSha256,
  };
  return {
    schemaVersion: 1,
    recordType: "mobile-device-route-readiness",
    supportClaim: false,
    hostId: record.hostId,
    binding: {
      runId: record.runId,
      jobId: record.hardwareJob.id,
      assetId: record.assetId,
      commit: record.trustedSha,
      packageSha256: record.packageSha256,
    },
    route,
    probes: deviceMatrix.devices.map((device, index) => ({
      hostId: record.hostId,
      assetId: device.assetId,
      appiumId: device.appiumId,
      platformName: device.platformName,
      automationName: device.automationName,
      browserName: device.browserName,
      browserVersion: "current",
      platformVersion: "current-patched",
      appiumVersion: deviceMatrix.appium.version,
      driverVersion:
        device.automationName === "XCUITest"
          ? deviceMatrix.appium.drivers.xcuitest
          : deviceMatrix.appium.drivers.uiautomator2,
      connected: true,
      unlocked: true,
      trusted: true,
      acceptInsecureCerts: false,
      routeUrl: route.applicationUrl,
      routeReadiness: {
        secureContext: true,
        trustedHttps: true,
        applicationCertificateTrusted: true,
        assetCertificateTrusted: true,
        packageSha256Matched: true,
        wasmMimePassed: true,
        corsAllowPassed: true,
        corsDenyPassed: true,
        rangePassed: true,
        wrongMimeRejected: true,
        publicLoaderAllowedWasmPassed: true,
        wrongMimeErrorCode: "WASM_LOAD_FAILED",
        corsDenyWasmErrorCode: "WASM_LOAD_FAILED",
        corsWrongOriginWasmErrorCode: "WASM_LOAD_FAILED",
      },
      observedAt: `2026-07-29T08:${String(index + 1).padStart(2, "0")}:00.000Z`,
    })),
    startedAt: "2026-07-29T08:00:00.000Z",
    completedAt: "2026-07-29T08:10:00.000Z",
  };
}

function hostRouteFixture(record) {
  const checked = httpsOriginPolicy.hosts.find(
    (origin) => origin.hostAssetId === record.hostId,
  );
  const basePath =
    `/runs/${record.runId}/${record.hardwareJob.id}/${"d".repeat(32)}/`;
  const certificate = {
    authorized: true,
    authorizationError: null,
    subject: "*.webgpu-ci.forge3d.dev",
    issuer: "Public CA",
    validFrom: "Jul 1 00:00:00 2026 GMT",
    validTo: "Oct 1 00:00:00 2026 GMT",
    fingerprint256: Array(32).fill("AA").join(":"),
  };
  return {
    ok: true,
    applicationHost: checked.applicationHost,
    assetHost: checked.assetHost,
    basePath,
    applicationUrl: `https://${checked.applicationHost}${basePath}`,
    assetUrl: `https://${checked.assetHost}${basePath}`,
    packageSha256: record.packageSha256,
    certificates: {
      application: certificate,
      asset: certificate,
    },
    httpsVerified: true,
    corsRangeControlsPassed: true,
  };
}

function completeRouteFixture() {
  return {
    secureContext: true,
    trustedHttps: true,
    applicationCertificateTrusted: true,
    assetCertificateTrusted: true,
    packageSha256Matched: true,
    wasmMimePassed: true,
    corsAllowPassed: true,
    corsDenyPassed: true,
    rangePassed: true,
    wrongMimeRejected: true,
    publicLoaderAllowedWasmPassed: true,
    wrongMimeErrorCode: "WASM_LOAD_FAILED",
    corsDenyWasmErrorCode: "WASM_LOAD_FAILED",
    corsWrongOriginWasmErrorCode: "WASM_LOAD_FAILED",
  };
}
