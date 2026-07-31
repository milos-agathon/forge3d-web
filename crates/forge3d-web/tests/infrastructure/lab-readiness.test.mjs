import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  computeLabConfiguration,
  computeLabReadiness,
  verifyLabReadinessForPromotion,
} from "../../scripts/compute-lab-readiness.mjs";
import {
  canonicalJson,
  sha256Hex,
} from "../../scripts/canonical-json.mjs";
import { validateHardwareMatrix } from "../../scripts/validate-hardware-matrix.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const hostCanarySchema = JSON.parse(
  readFileSync(new URL("./lab-host-canary.schema.json", import.meta.url), "utf8"),
);
const manualCanarySchema = JSON.parse(
  readFileSync(new URL("./manual-canary.schema.json", import.meta.url), "utf8"),
);
const checkedMatrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const runnerDistributionManifest = JSON.parse(
  readFileSync(
    new URL("./runner-distribution-manifest.json", import.meta.url),
    "utf8",
  ),
);
const runnerTransientPathPolicy = JSON.parse(
  readFileSync(
    new URL("./runner-transient-path-policy.json", import.meta.url),
    "utf8",
  ),
);
runnerTransientPathPolicy.canaryState = "verified";
const browserPolicy = JSON.parse(
  readFileSync(new URL("./browser-policy.json", import.meta.url), "utf8"),
);
browserPolicy.provisioningState = "active";
browserPolicy.runnerTransientPathPolicySha256 = sha256Hex(
  runnerTransientPathPolicy,
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
    "crates/forge3d-web/scripts/create-deployment-package-proof.mjs",
    "crates/forge3d-web/scripts/finalize-deployment-provenance.mjs",
    "crates/forge3d-web/scripts/join-adapter-attestation.mjs",
    "crates/forge3d-web/scripts/manage-browser-route.mjs",
    "crates/forge3d-web/scripts/manage-browser-update-window.mjs",
    "crates/forge3d-web/scripts/generate-runner-distribution-manifest.mjs",
    "crates/forge3d-web/scripts/validate-hardware-matrix.mjs",
    "crates/forge3d-web/scripts/verify-runner-distribution.mjs",
    "crates/forge3d-web/tests/browser/hardware-page-harness.js",
    "crates/forge3d-web/tests/infrastructure/lab-host-canary.schema.json",
    "crates/forge3d-web/tests/infrastructure/lab-deployment-provenance.schema.json",
    "crates/forge3d-web/tests/infrastructure/manual-canary.schema.json",
    "tools/browser-lab-broker/src/authorization-verifier.mjs",
    "tools/browser-lab-broker/src/bootstrap.mjs",
    "tools/browser-lab-broker/src/deployment-provenance.mjs",
    "tools/browser-lab-broker/schemas/broker-package-manifest.schema.json",
    "tools/browser-lab-broker/schemas/lab-service-deployment-provenance.schema.json",
    "tools/browser-lab-broker/scripts/create-package-manifest.mjs",
    "tools/browser-lab-broker/src/runner-authorization.mjs",
    "tools/browser-lab-controller/src/controller-service.mjs",
    "tools/browser-lab-controller/src/bootstrap.mjs",
    "tools/browser-lab-controller/src/deployment-provenance.mjs",
    "tools/browser-lab-controller/schemas/controller-deployment-provenance-receipt.schema.json",
    "tools/browser-lab-controller/schemas/controller-package-manifest.schema.json",
    "tools/browser-lab-controller/schemas/lab-service-deployment-provenance.schema.json",
    "tools/browser-lab-controller/scripts/create-package-manifest.mjs",
    "tools/browser-lab-controller/src/controller-evidence-inputs.mjs",
    "tools/browser-lab-controller/src/broker-lifecycle-store.mjs",
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
});

const hostCanaries = matrix.hosts.map((host, index) =>
  createFinalizedHostCanaryFixture(host, index),
);
const deploymentProvenance = matrix.hosts.map((host, index) =>
  createDeploymentProvenanceFixture(host, hostCanaries[index], index),
);
const deploymentPackageProofs = [
  createDeploymentPackageProofFixture(
    deploymentProvenance[0].broker,
  ),
  ...deploymentProvenance.map((record) =>
    createDeploymentPackageProofFixture(record.controller),
  ),
];
const manualCanary = {
  schemaVersion: 1,
  recordType: "manual-lab-canary",
  runId: 70,
  runAttempt: 1,
  hardwareJobId: 71,
  intakeReleaseId: 72,
  lane: "infrastructure-canary",
  canaryMode: "manual",
  checklistId: "infrastructure-manual-canary",
  checklistStepResults: {
    SESSION_OPEN: "pass",
    VISIBLE_CHALLENGE: "pass",
    AUTHENTICATED_MEDIA_UPLOAD: "pass",
    SESSION_CLEANUP: "pass",
  },
  supportClaim: false,
  trustedSha: candidateSha,
  packageRunId: packageRecord.runId,
  packageSha256: packageRecord.packageSha256,
  session: {
    durationMinutes: 20,
    controllerSignatureVerified: true,
    runnerAbsent: true,
    cleanupComplete: true,
    runId: 69,
    runAttempt: 1,
    jobId: 71,
  },
  media: {
    authenticatedUploader: true,
    challengeMatched: true,
    digestsVerified: true,
    assetIds: [73],
    assets: [
      {
        id: 73,
        name: "manual-canary.mp4",
        uploader: "tester",
        size: 2048,
        mimeType: "video/mp4",
        createdAt: "2026-07-29T10:10:00.000Z",
        apiSha256: "e".repeat(64),
        sha256: "e".repeat(64),
      },
    ],
  },
  tester: "tester",
  approver: { id: 74, login: "independent-approver" },
  productAssertionsExecuted: false,
  attestation: {
    verified: true,
    denySelfHostedRunners: true,
    repository: "milos-agathon/forge3d-web",
    signerWorkflow:
      "milos-agathon/forge3d-web/.github/workflows/submit-browser-manual-evidence.yml",
    sourceRef: "refs/heads/main",
    sourceDigest: candidateSha,
  },
  createdAt: "2026-07-29T11:00:00.000Z",
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
  deploymentProvenance,
  deploymentPackageProofs,
  manualCanary,
  canaryRelease,
  repositoryTrust: {
    verified: true,
    currentMainSha: candidateSha,
    targetSha: candidateSha,
  },
  matrix,
  browserPolicy,
  runnerDistributionManifest,
  runnerTransientPathPolicy,
  configuration,
  run: { id: 90, attempt: 1, workflowSha: candidateSha },
  now: new Date("2026-07-30T00:00:00Z"),
};

test("schema-valid provisioned matrix satisfies validation and readiness contracts", () => {
  assertJsonSchema(
    matrix,
    JSON.parse(
      readFileSync(
        new URL("./hardware-matrix.schema.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.equal(
    validateHardwareMatrix(matrix, { requireProvisioned: true }).provisioned,
    true,
  );
  assert.equal(computeLabReadiness(base).manifest.status, "LAB_INFRA_READY");
});

test("readiness closes four hosts, generic manual canary, and immutable canary release", () => {
  for (const hostCanary of hostCanaries) {
    assertJsonSchema(hostCanary, hostCanarySchema);
  }
  assertJsonSchema(manualCanary, manualCanarySchema);
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

test("readiness rejects host canary fields outside the strict schema", () => {
  const changed = structuredClone(hostCanaries);
  changed[0].ignoredEvidence = true;
  assert.throws(
    () => computeLabReadiness({ ...base, hostCanaries: changed }),
    /\$\.ignoredEvidence: additional property is not allowed/u,
  );
});

test("readiness rejects malformed nested host canary evidence", () => {
  const changed = structuredClone(hostCanaries);
  changed[0].adapter.presentedFrameLuma = "bright";
  assert.throws(
    () => computeLabReadiness({ ...base, hostCanaries: changed }),
    /\$\.adapter\.presentedFrameLuma: expected type number/u,
  );
});

test("readiness rejects manual canary fields outside the strict schema", () => {
  const changed = structuredClone(manualCanary);
  changed.ignoredEvidence = true;
  assert.throws(
    () => computeLabReadiness({ ...base, manualCanary: changed }),
    /\$\.ignoredEvidence: additional property is not allowed/u,
  );
});

test("readiness rejects malformed nested manual canary evidence", () => {
  const changed = structuredClone(manualCanary);
  changed.media.assets[0].size = 0;
  assert.throws(
    () => computeLabReadiness({ ...base, manualCanary: changed }),
    /\$\.media\.assets\[0\]\.size: less than minimum 1/u,
  );
});

function createFinalizedHostCanaryFixture(host, index) {
  const runId = 60 + index;
  const jobId = 160 + index;
  const platform = {
    macOS: "darwin",
    Windows: "win32",
    Ubuntu: "linux",
  }[host.os.family];
  const displayServer = {
    darwin: "WindowServer",
    win32: "Desktop Window Manager",
    linux: "GNOME Wayland",
  }[platform];
  const pageAdapter = {
    schemaVersion: 1,
    runId,
    jobId,
    assetId: host.assetId,
    commit: candidateSha,
    packageSha256: packageRecord.packageSha256,
    navigatorGpu: true,
    adapterInfoAvailable: true,
    adapterInfo: {
      vendor: host.gpu,
      architecture: "physical",
      device: host.gpu,
      description: host.gpu,
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
    identifier: `session-${index + 1}`,
  };
  const adapterAttestation = {
    schemaVersion: 1,
    binding: {
      runId,
      jobId,
      assetId: host.assetId,
      commit: candidateSha,
      packageSha256: packageRecord.packageSha256,
    },
    required: true,
    result: "PASS",
    page: pageAdapter,
    host: {
      schemaVersion: 1,
      lane: "infrastructure-canary",
      runId,
      jobId,
      assetId: host.assetId,
      commit: candidateSha,
      packageSha256: packageRecord.packageSha256,
      hostId: host.assetId,
      platform,
      expectedGpu: host.gpu,
      expectedGpuPresent: true,
      headedSessionAvailable: true,
      osBuild: `${host.os.family} checked build`,
      session,
      inventoryCapturedAt: "2026-07-29T10:00:00.000Z",
      commandEvidence: { source: `${platform}-live-gpu-probe` },
      capturedAt: "2026-07-29T10:01:00.000Z",
    },
  };
  const certificate = {
    authorized: true,
    authorizationError: null,
    subject: `${host.assetId.toLowerCase()}.webgpu-ci.forge3d.dev`,
    issuer: "Let's Encrypt",
    validFrom: "Jul 29 00:00:00 2026 GMT",
    validTo: "Oct 27 23:59:59 2026 GMT",
    fingerprint256: `AA:BB:CC:${index}`,
  };
  return {
    schemaVersion: 1,
    recordType: "host-lab-canary",
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
    adapter: pageAdapter,
    adapterAttestation,
    authorization: {
      sha256: "c".repeat(64),
      attested: true,
    },
    controller: {
      signatureVerified: true,
      signingKeyId: host.controller.signingKeyId,
    },
    runner: {
      id: 260 + index,
      name: `${host.assetId}-${"d".repeat(32)}`,
      acceptedJobCount: 1,
      absentAfterRun: true,
    },
    cleanup: { complete: true },
    inventory: {
      schemaVersion: 1,
      assetId: host.assetId,
      platform,
      osBuild: `${host.os.family} checked build`,
      headed: true,
      displayServer,
      session,
      browsers: [
        {
          id: "chrome-stable",
          channel: "stable",
          classification: "required",
          automation: "playwright",
          version: "150.0.7339.1",
          executable: `${platform}-chrome`,
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
      hostId: host.assetId,
      attachedAssetIds: host.attachedAssetIds,
    },
    route: {
      ok: true,
      applicationHost: `${host.assetId.toLowerCase()}-app.webgpu-ci.forge3d.dev`,
      assetHost: `${host.assetId.toLowerCase()}-asset.webgpu-ci.forge3d.dev`,
      basePath: `/runs/${runId}/${jobId}/${"f".repeat(32)}/`,
      packageSha256: packageRecord.packageSha256,
      certificates: {
        application: certificate,
        asset: certificate,
      },
      httpsVerified: true,
      corsRangeControlsPassed: true,
    },
    attestation: {
      verified: true,
      denySelfHostedRunners: true,
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/browser-hardware.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: candidateSha,
    },
    finalizer: {
      run: { id: runId, attempt: 1 },
      job: "finalize-hardware-evidence",
      environment: "forge3d-trust-observer",
      absenceObservations: [
        {
          status: 404,
          sha256: "0".repeat(64),
          observedAt: "2026-07-29T10:59:59.000Z",
        },
      ],
      observedAt: "2026-07-29T11:00:00.000Z",
    },
  };
}

function createDeploymentProvenanceFixture(host, hostCanary, index) {
  const broker = serviceDeploymentFixture({
    service: "broker",
    serviceIdentity: "broker:forge3d-browser-lab",
    runId: 101,
    artifactId: 201,
  });
  const controller = serviceDeploymentFixture({
    service: "controller",
    serviceIdentity: `controller:${host.assetId}`,
    runId: 110 + index,
    artifactId: 210 + index,
  });
  return {
    schemaVersion: 1,
    recordType: "lab-service-deployment-provenance-receipt",
    runId: hostCanary.runId,
    runAttempt: hostCanary.runAttempt,
    hostId: host.assetId,
    controllerIdentity: `controller:${host.assetId}`,
    trustedSha: candidateSha,
    observedAt: "2026-07-29T10:30:00.000Z",
    broker,
    controller,
    controllerSignature: {
      verified: true,
      signingKeyId: host.controller.signingKeyId,
    },
    attestation: {
      verified: true,
      denySelfHostedRunners: true,
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/browser-hardware.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: candidateSha,
    },
    finalizer: {
      run: {
        id: hostCanary.runId,
        attempt: hostCanary.runAttempt,
      },
      job: "finalize-hardware-evidence",
      environment: "forge3d-trust-observer",
      observedAt: "2026-07-29T11:00:00.000Z",
    },
  };
}

function serviceDeploymentFixture({
  service,
  serviceIdentity,
  runId,
  artifactId,
}) {
  const archiveName =
    service === "broker"
      ? "browser-lab-broker.tar.gz"
      : "browser-lab-controller-1.0.0.tar.gz";
  const packageRun = { id: runId, attempt: 1 };
  const manifest = packageManifestFixture(service, archiveName);
  return {
    schemaVersion: 1,
    recordType: "lab-service-deployment-provenance",
    service,
    serviceIdentity,
    packageRun: {
      ...packageRun,
      artifact: {
        id: artifactId,
        name:
          `browser-lab-${service}-${candidateSha}-${packageRun.id}-${packageRun.attempt}`,
        digest: `sha256:${String(artifactId % 10).repeat(64)}`,
      },
    },
    source: {
      repository: "milos-agathon/forge3d-web",
      targetSha: candidateSha,
      workflowSha: candidateSha,
    },
    packageManifest: {
      sha256: String((artifactId + 1) % 10).repeat(64),
      attestation: {
        verified: true,
        repository: "milos-agathon/forge3d-web",
        signerWorkflow:
          `milos-agathon/forge3d-web/.github/workflows/browser-lab-${service}.yml`,
        sourceRef: "refs/heads/main",
        sourceDigest: candidateSha,
        denySelfHostedRunners: true,
      },
    },
    archive: {
      name: archiveName,
      sha256:
        service === "broker"
          ? manifest.archive.sha256
          : manifest.archiveSha256,
    },
    configuration: {
      sha256:
        service === "broker"
          ? manifest.configurationSha256
          : sha256Hex(manifest.files),
    },
    protocols: {
      broker: "forge3d-browser-lab-broker/v1",
      cleanup: "forge3d-browser-lab-cleanup/v1",
    },
    administratorVerification: {
      status: "verified",
      method: "github-attestation",
      verifiedAt: "2026-07-29T09:00:00.000Z",
      verifiedBy: "lab-admin",
    },
  };
}

function packageManifestFixture(service, archiveName) {
  if (service === "controller") {
    return {
      schemaVersion: 1,
      package: "@forge3d/browser-lab-controller",
      version: "1.0.0",
      targetSha: candidateSha,
      workflowSha: candidateSha,
      archive: archiveName,
      archiveSha256: "6".repeat(64),
      files: [
        { path: "package.json", sha256: "7".repeat(64) },
        { path: "src/bootstrap.mjs", sha256: "8".repeat(64) },
        {
          path: "src/controller-service.mjs",
          sha256: "9".repeat(64),
        },
      ],
    };
  }
  const paths = [
    "crates/forge3d-web/tests/infrastructure/browser-policy.json",
    "crates/forge3d-web/tests/infrastructure/broker-lifecycle.schema.json",
    "crates/forge3d-web/tests/infrastructure/broker-protocol.schema.json",
    "crates/forge3d-web/tests/infrastructure/controller-health-endpoints.json",
    "crates/forge3d-web/tests/infrastructure/hardware-matrix.json",
    "crates/forge3d-web/tests/infrastructure/repository-trust-policy.json",
    "crates/forge3d-web/tests/infrastructure/runner-distribution-manifest.json",
    "crates/forge3d-web/tests/infrastructure/runner-transient-path-policy.json",
    "crates/forge3d-web/tests/infrastructure/workflow-actions-lock.json",
  ];
  const brokerConfiguration = paths.map((path, index) => ({
    path,
    sha256: String(index + 1).repeat(64),
  }));
  return {
    schemaVersion: 1,
    repository: "milos-agathon/forge3d-web",
    targetSha: candidateSha,
    workflowSha: candidateSha,
    brokerProtocolVersion: "forge3d-browser-lab-broker/v1",
    cleanupProtocolVersion: "forge3d-browser-lab-cleanup/v1",
    archive: {
      name: archiveName,
      sha256: "5".repeat(64),
    },
    configuration: brokerConfiguration,
    configurationSha256: sha256Hex(brokerConfiguration),
  };
}

function createDeploymentPackageProofFixture(deployment) {
  return {
    service: deployment.service,
    serviceIdentity: deployment.serviceIdentity,
    run: {
      id: deployment.packageRun.id,
      attempt: deployment.packageRun.attempt,
      path:
        `.github/workflows/browser-lab-${deployment.service}.yml`,
      headSha: deployment.source.targetSha,
      event:
        deployment.service === "broker"
          ? "push"
          : "workflow_dispatch",
      status: "completed",
      conclusion: "success",
    },
    artifact: structuredClone(deployment.packageRun.artifact),
    packageManifest: {
      name: `${deployment.service}-package-manifest.json`,
      sha256: deployment.packageManifest.sha256,
      value: packageManifestFixture(
        deployment.service,
        deployment.archive.name,
      ),
    },
    archive: structuredClone(deployment.archive),
    hostedAttestationVerification: {
      verified: true,
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        deployment.packageManifest.attestation.signerWorkflow,
      sourceRef: "refs/heads/main",
      sourceDigest: deployment.source.targetSha,
      denySelfHostedRunners: true,
    },
  };
}

test("readiness requires all checked runner-policy inputs", () => {
  for (const field of [
    "browserPolicy",
    "runnerDistributionManifest",
    "runnerTransientPathPolicy",
  ]) {
    assert.throws(
      () =>
        computeLabReadiness({
          ...base,
          [field]: undefined,
        }),
      /checked runner policy inputs are required/u,
    );
  }
});

test("readiness requires fresh exact deployment sidecars and package proofs", () => {
  for (const changed of [
    { deploymentProvenance: deploymentProvenance.slice(1) },
    {
      deploymentProvenance: deploymentProvenance.map((record, index) =>
        index === 0
          ? {
              ...record,
              broker: {
                ...record.broker,
                archive: {
                  ...record.broker.archive,
                  sha256: "0".repeat(64),
                },
              },
            }
          : record,
      ),
    },
    {
      deploymentPackageProofs: deploymentPackageProofs.map(
        (proof, index) =>
          index === 1
            ? {
                ...proof,
                artifact: {
                  ...proof.artifact,
                  id: proof.artifact.id + 1,
                },
              }
            : proof,
      ),
    },
  ]) {
    assert.throws(
      () => computeLabReadiness({ ...base, ...changed }),
      /deployment|deployed/u,
    );
  }
});

test("readiness rejects pending browser and transient canary states", () => {
  assert.throws(
    () =>
      computeLabReadiness({
        ...base,
        browserPolicy: {
          ...browserPolicy,
          provisioningState: "pending-jit-canary",
        },
      }),
    /runner policy has not passed the clean JIT canary/u,
  );
  const pendingTransientPathPolicy = {
    ...runnerTransientPathPolicy,
    canaryState: "pending",
  };
  assert.throws(
    () =>
      computeLabReadiness({
        ...base,
        browserPolicy: {
          ...browserPolicy,
          runnerTransientPathPolicySha256: sha256Hex(
            pendingTransientPathPolicy,
          ),
        },
        runnerTransientPathPolicy: pendingTransientPathPolicy,
      }),
    /runner policy has not passed the clean JIT canary/u,
  );
});

test("readiness preserves runner-policy digest failures", () => {
  assert.throws(
    () =>
      computeLabReadiness({
        ...base,
        browserPolicy: {
          ...browserPolicy,
          runnerTransientPathPolicySha256: "0".repeat(64),
        },
      }),
    /runner manifest or transient policy digest changed/u,
  );
});

test("product promotion consumes only exact current attested readiness", () => {
  const digest = verifyLabReadinessForPromotion(
    createPromotionVerificationInput(),
  );
  assert.equal(digest, configuration.labInfrastructureDigest);
});

test("product promotion independently rejects every readiness binding category", () => {
  const failure =
    /laboratory readiness does not unlock this exact product lane/u;
  const cases = [
    [
      "readiness schema",
      (input) => {
        input.manifest.unexpected = true;
        recanonicalizeManifest(input);
      },
    ],
    [
      "exact four host IDs",
      (input) => {
        input.manifest.hostCanaryRunIds[1] =
          input.manifest.hostCanaryRunIds[0];
        recanonicalizeManifest(input);
      },
    ],
    [
      "manual binding shape",
      (input) => {
        input.manifest.manualCanary.runId = 0;
        recanonicalizeManifest(input);
      },
    ],
    [
      "canary release binding shape",
      (input) => {
        input.manifest.canaryReleaseId = 0;
        recanonicalizeManifest(input);
      },
    ],
    [
      "canonical manifest bytes",
      (input) => {
        input.manifestBytes = Buffer.from(canonicalJson(input.manifest));
      },
    ],
    ["API run exact shape", (input) => (input.readinessRun.unexpected = true)],
    ["API run ID", (input) => (input.readinessRun.id += 1)],
    ["API run attempt", (input) => (input.readinessRun.attempt += 1)],
    ["API workflow path", (input) => (input.readinessRun.path = "other.yml")],
    ["API workflow ref", (input) => (input.readinessRun.ref = "refs/heads/dev")],
    ["API head branch", (input) => (input.readinessRun.headBranch = "dev")],
    ["API head SHA", (input) => (input.readinessRun.headSha = "c".repeat(40))],
    ["API event", (input) => (input.readinessRun.event = "push")],
    ["API status", (input) => (input.readinessRun.status = "in_progress")],
    ["API conclusion", (input) => (input.readinessRun.conclusion = "failure")],
    ["dispatch exact shape", (input) => (input.dispatch.unexpected = true)],
    ["dispatch trusted SHA", (input) => (input.dispatch.trustedSha = "c".repeat(40))],
    ["dispatch package run", (input) => (input.dispatch.packageRunId += 1)],
    [
      "dispatch readiness run",
      (input) => (input.dispatch.labReadinessRunId += 1),
    ],
    [
      "package manifest exact shape",
      (input) => (input.packageManifest.unexpected = true),
    ],
    [
      "package repository",
      (input) => (input.packageManifest.repository = "other/repository"),
    ],
    [
      "package workflow path",
      (input) => (input.packageManifest.workflowPath = "other.yml"),
    ],
    [
      "package workflow SHA",
      (input) => (input.packageManifest.workflowSha = "c".repeat(40)),
    ],
    ["package manifest run ID", (input) => (input.packageManifest.runId += 1)],
    [
      "package manifest run attempt",
      (input) => (input.packageManifest.runAttempt += 1),
    ],
    [
      "package target SHA",
      (input) => (input.packageManifest.targetSha = "c".repeat(40)),
    ],
    [
      "package name",
      (input) => (input.packageManifest.packageName = "@other/web"),
    ],
    [
      "package version",
      (input) => (input.packageManifest.packageVersion = "latest"),
    ],
    ["package tarball", (input) => (input.packageManifest.tarball = "other.tgz")],
    [
      "package digest",
      (input) => (input.packageManifest.packageSha256 = "c".repeat(64)),
    ],
    [
      "package clean source",
      (input) => (input.packageManifest.sourceTreeClean = false),
    ],
    [
      "package file identity",
      (input) => (input.packageManifest.files[0].sha256 = "c".repeat(64)),
    ],
    [
      "package resolution exact shape",
      (input) => (input.packageResolution.unexpected = true),
    ],
    [
      "package resolution run ID",
      (input) => (input.packageResolution.packageRunId += 1),
    ],
    [
      "package resolution attempt",
      (input) => (input.packageResolution.packageRunAttempt += 1),
    ],
    [
      "package artifact ID",
      (input) => (input.packageResolution.packageArtifactId = 0),
    ],
    [
      "package artifact name",
      (input) => (input.packageResolution.packageArtifactName = "other"),
    ],
    [
      "package artifact digest",
      (input) =>
        (input.packageResolution.packageArtifactDigest = "sha256:invalid"),
    ],
    [
      "package resolution workflow SHA",
      (input) =>
        (input.packageResolution.packageWorkflowSha = "c".repeat(40)),
    ],
    [
      "package resolution workflow path",
      (input) => (input.packageResolution.packageRunPath = "other.yml"),
    ],
    [
      "package resolution head branch",
      (input) => (input.packageResolution.packageRunHeadBranch = "dev"),
    ],
    [
      "package resolution ref",
      (input) => (input.packageResolution.packageRunRef = "refs/heads/dev"),
    ],
    [
      "package resolution event",
      (input) => (input.packageResolution.packageRunEvent = "pull_request"),
    ],
    [
      "package resolution status",
      (input) => (input.packageResolution.packageRunStatus = "in_progress"),
    ],
    [
      "package resolution conclusion",
      (input) => (input.packageResolution.packageRunConclusion = "failure"),
    ],
    [
      "attestation exact shape",
      (input) => (input.attestation.unexpected = true),
    ],
    ["attestation status", (input) => (input.attestation.verified = false)],
    [
      "attestation repository",
      (input) => (input.attestation.repository = "other/repository"),
    ],
    [
      "attestation signer",
      (input) => (input.attestation.signerWorkflow = "other.yml"),
    ],
    [
      "attestation source ref",
      (input) => (input.attestation.sourceRef = "refs/heads/dev"),
    ],
    [
      "attestation source digest",
      (input) => (input.attestation.sourceDigest = "c".repeat(40)),
    ],
    [
      "attestation runner policy",
      (input) => (input.attestation.denySelfHostedRunners = false),
    ],
    [
      "attestation subject digest",
      (input) => (input.attestation.subjectSha256 = "c".repeat(64)),
    ],
    [
      "current configuration digest",
      (input) =>
        (input.expectedConfiguration.labInfrastructureDigest =
          "c".repeat(64)),
    ],
    [
      "manifest current configuration digest",
      (input) => {
        input.manifest.labInfrastructureDigest = "c".repeat(64);
        recanonicalizeManifest(input);
      },
    ],
    [
      "ordered configuration files",
      (input) => {
        input.expectedConfiguration.files.reverse();
        input.expectedConfiguration.labInfrastructureDigest =
          configurationDigest(input.expectedConfiguration);
        input.manifest.labInfrastructureDigest =
          input.expectedConfiguration.labInfrastructureDigest;
        recanonicalizeManifest(input);
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const input = createPromotionVerificationInput();
    mutate(input);
    assert.throws(
      () => verifyLabReadinessForPromotion(input),
      failure,
      name,
    );
  }
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

function createPromotionVerificationInput() {
  const result = computeLabReadiness(base);
  const manifestBytes = Buffer.from(`${result.canonical}\n`, "utf8");
  const packageVersion = "1.0.0";
  const tarball = `forge3d-web-${packageVersion}.tgz`;
  const packageManifest = {
    schemaVersion: 1,
    repository: "milos-agathon/forge3d-web",
    workflowPath: ".github/workflows/browser-package.yml",
    workflowSha: candidateSha,
    runId: packageRecord.runId,
    runAttempt: 2,
    targetSha: candidateSha,
    packageName: "@forge3d/web",
    packageVersion,
    tarball,
    packageSha256: packageRecord.packageSha256,
    sourceTreeClean: true,
    files: [{ name: tarball, sha256: packageRecord.packageSha256 }],
  };
  return {
    manifest: result.manifest,
    manifestBytes,
    readinessRun: {
      id: result.manifest.run.id,
      attempt: result.manifest.run.attempt,
      path: result.manifest.workflow,
      ref: "refs/heads/main",
      headSha: candidateSha,
      headBranch: "main",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
    },
    dispatch: {
      trustedSha: candidateSha,
      packageRunId: packageRecord.runId,
      labReadinessRunId: result.manifest.run.id,
    },
    packageManifest,
    packageResolution: {
      packageRunId: packageRecord.runId,
      packageArtifactId: 101,
      packageArtifactName: `browser-package-${candidateSha}`,
      packageArtifactDigest: `sha256:${"d".repeat(64)}`,
      packageWorkflowSha: candidateSha,
      packageRunAttempt: packageManifest.runAttempt,
      packageRunPath: ".github/workflows/browser-package.yml",
      packageRunHeadBranch: "main",
      packageRunRef: "refs/heads/main",
      packageRunEvent: "push",
      packageRunStatus: "completed",
      packageRunConclusion: "success",
    },
    attestation: {
      verified: true,
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/browser-lab-infrastructure-readiness.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: candidateSha,
      denySelfHostedRunners: true,
      subjectSha256: sha256Hex(manifestBytes),
    },
    expectedConfiguration: structuredClone(configuration),
  };
}

function recanonicalizeManifest(input) {
  input.manifestBytes = Buffer.from(
    `${canonicalJson(input.manifest)}\n`,
    "utf8",
  );
  input.attestation.subjectSha256 = sha256Hex(input.manifestBytes);
}

function configurationDigest(value) {
  return sha256Hex({
    schemaVersion: value.schemaVersion,
    files: value.files,
    versions: value.versions,
  });
}
