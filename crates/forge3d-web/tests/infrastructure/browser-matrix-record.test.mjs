import assert from "node:assert/strict";
import test from "node:test";

import {
  createAutomatedMatrixRecord,
  createManualMatrixRecord,
  finalizeMatrixRecord,
} from "../../scripts/create-browser-matrix-record.mjs";

test("automated and manual sources derive closed matrix keys without artifact claims", () => {
  const automated = createAutomatedMatrixRecord({
    promotion: {
      lane: "chrome-linux-rtx3070",
      mode: "automated",
      hostId: "FW-LNX-NV-01",
      assetId: "FW-LNX-NV-01",
      trustedSha: "a".repeat(40),
      packageManifestSha256: "b".repeat(64),
      labInfrastructureDigest: "c".repeat(64),
    },
    evidence: {
      result: "PASS",
      lane: "chrome-linux-rtx3070",
      trustedSha: "a".repeat(40),
      packageSha256: "d".repeat(64),
      packageManifestSha256: "b".repeat(64),
      adapter: {
        isFallbackAdapter: false,
        deviceCreated: true,
        surfacePresented: true,
      },
    },
    attestation: {
      result: "PASS",
      required: true,
      binding: {
        runId: 10,
        assetId: "FW-LNX-NV-01",
        commit: "a".repeat(40),
        packageSha256: "d".repeat(64),
      },
      page: { isFallbackAdapter: false },
      host: {
        hostId: "FW-LNX-NV-01",
        expectedGpuPresent: true,
        headedSessionAvailable: true,
      },
    },
    run: { id: 10 },
  });
  assert.equal(automated.key, "automated:FW-LNX-NV-01:chrome-linux-rtx3070");
  const manual = createManualMatrixRecord({
    evidence: {
      checklistId: "safari-trackpad",
      run: { id: 20, attempt: 1 },
      assetId: "FW-TRACKPAD-01",
      trustedSha: "a".repeat(40),
      packageSha256: "d".repeat(64),
      labInfrastructureDigest: "c".repeat(64),
      stepResults: { A: "pass", B: "pass", C: "pass", D: "pass" },
      manualSessionRunId: 21,
      manualSessionJobId: 22,
      authorizationSha256: "e".repeat(64),
      controllerSignatureSha256: "f".repeat(64),
      routeBasePath: `/runs/21/22/${"1".repeat(32)}/`,
      mediaChallenge: "2".repeat(32),
      expiresAt: "2026-08-01T00:00:00Z",
    },
    run: { id: 20, attempt: 1 },
  });
  assert.equal(manual.key, "manual:FW-TRACKPAD-01:safari-trackpad");
  const final = finalizeMatrixRecord({
    source: manual,
    artifactId: 30,
    resolution: manualResolution(manual),
    attestation: { verified: true, denySelfHostedRunners: true },
  });
  assert.equal(final.workflow.artifactId, 30);
  const {
    attestation: finalizedAttestation,
    workflow: finalizedWorkflowWithArtifact,
    ...finalizedBody
  } = final;
  const { artifactId: finalizedArtifactId, ...finalizedWorkflow } =
    finalizedWorkflowWithArtifact;
  assert.deepEqual(finalizedAttestation, {
    verified: true,
    denySelfHostedRunners: true,
  });
  assert.equal(finalizedArtifactId, 30);
  assert.deepEqual(
    { ...finalizedBody, workflow: finalizedWorkflow },
    manual,
  );
});

test("infrastructure canary, fallback adapter, failed identity, and unattested artifact fail", () => {
  assert.throws(() =>
    createAutomatedMatrixRecord({
      promotion: { lane: "infrastructure-canary", mode: "canary-host" },
      evidence: {},
      run: {},
    }),
  );
  assert.throws(
    () =>
      createAutomatedMatrixRecord({
        promotion: {
          lane: "chrome-linux-rtx3070",
          mode: "automated",
          hostId: "FW-LNX-NV-01",
          assetId: "FW-LNX-NV-01",
          trustedSha: "a".repeat(40),
          packageManifestSha256: "b".repeat(64),
        },
        evidence: {
          result: "PASS",
          lane: "chrome-linux-rtx3070",
          trustedSha: "a".repeat(40),
          packageSha256: "d".repeat(64),
          packageManifestSha256: "b".repeat(64),
          adapter: {
            isFallbackAdapter: false,
            deviceCreated: true,
            surfacePresented: true,
          },
        },
        run: { id: 10 },
      }),
    /does not match/u,
  );
  assert.throws(() =>
    finalizeMatrixRecord({
      source: {},
      artifactId: 1,
      resolution: {},
      attestation: { verified: false, denySelfHostedRunners: true },
    }),
  );
});

test("matrix finalization rejects substituted selected run and artifact identity", () => {
  const source = createManualMatrixRecord({
    evidence: {
      checklistId: "safari-trackpad",
      run: { id: 20, attempt: 1 },
      assetId: "FW-TRACKPAD-01",
      trustedSha: "a".repeat(40),
      packageSha256: "d".repeat(64),
      labInfrastructureDigest: "c".repeat(64),
      stepResults: { A: "pass", B: "pass", C: "pass", D: "pass" },
      manualSessionRunId: 21,
      manualSessionJobId: 22,
      authorizationSha256: "e".repeat(64),
      controllerSignatureSha256: "f".repeat(64),
      routeBasePath: `/runs/21/22/${"1".repeat(32)}/`,
      mediaChallenge: "2".repeat(32),
      expiresAt: "2026-08-01T00:00:00Z",
    },
    run: { id: 20, attempt: 1 },
  });
  const resolution = manualResolution(source);
  for (const changed of [
    { run: { ...resolution.run, id: 99 } },
    { run: { ...resolution.run, attempt: 2 } },
    { run: { ...resolution.run, path: ".github/workflows/browser-hardware.yml" } },
    { run: { ...resolution.run, headSha: "b".repeat(40) } },
    { run: { ...resolution.run, status: "in_progress" } },
    {
      run: {
        ...resolution.run,
        inputs: { hardwareJobId: "99" },
      },
    },
    { artifact: { ...resolution.artifact, id: 31 } },
    {
      artifact: {
        ...resolution.artifact,
        name: "browser-manual-evidence-20-2",
      },
    },
  ]) {
    assert.throws(() =>
      finalizeMatrixRecord({
        source,
        artifactId: 30,
        resolution: { ...resolution, ...changed },
        attestation: { verified: true, denySelfHostedRunners: true },
      }),
    );
  }
});

test("matrix finalization binds authenticated source kind to the selected API workflow", () => {
  const source = createManualMatrixRecord({
    evidence: {
      checklistId: "safari-trackpad",
      run: { id: 20, attempt: 1 },
      assetId: "FW-TRACKPAD-01",
      trustedSha: "a".repeat(40),
      packageSha256: "d".repeat(64),
      labInfrastructureDigest: "c".repeat(64),
      stepResults: { A: "pass", B: "pass", C: "pass", D: "pass" },
      manualSessionRunId: 21,
      manualSessionJobId: 22,
      authorizationSha256: "e".repeat(64),
      controllerSignatureSha256: "f".repeat(64),
      routeBasePath: `/runs/21/22/${"1".repeat(32)}/`,
      mediaChallenge: "2".repeat(32),
      expiresAt: "2026-08-01T00:00:00Z",
    },
    run: { id: 20, attempt: 1 },
  });
  const resolution = manualResolution(source);
  assert.throws(
    () =>
      finalizeMatrixRecord({
        source: { ...source, kind: "automated" },
        artifactId: 30,
        resolution,
        attestation: { verified: true, denySelfHostedRunners: true },
      }),
    /kind does not match/u,
  );
  assert.throws(
    () =>
      finalizeMatrixRecord({
        source,
        artifactId: 30,
        resolution: {
          ...resolution,
          run: {
            ...resolution.run,
            inputs: {
              manualSessionRunId: source.session.runId,
              hardwareJobId: source.session.jobId,
            },
          },
        },
        attestation: { verified: true, denySelfHostedRunners: true },
      }),
    /inputs do not match/u,
  );
  assert.throws(
    () =>
      finalizeMatrixRecord({
        source,
        artifactId: 30,
        attestation: { verified: true, denySelfHostedRunners: true },
      }),
    /exact artifact and attestation proof/u,
  );
});

function manualResolution(source) {
  return {
    run: {
      id: source.workflow.runId,
      attempt: 1,
      path: source.workflow.path,
      headBranch: "main",
      ref: source.workflow.ref,
      headSha: source.trustedSha,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: source.workflow.conclusion,
      inputs: {},
    },
    artifact: {
      id: 30,
      name: `browser-manual-evidence-${source.workflow.runId}-1`,
      digest: `sha256:${"0".repeat(64)}`,
    },
  };
}
