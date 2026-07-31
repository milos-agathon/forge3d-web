import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createDeploymentPackageProof } from "../../scripts/create-deployment-package-proof.mjs";
import { canonicalJson } from "../../scripts/canonical-json.mjs";

const targetSha = "a".repeat(40);
const workflowSha = "b".repeat(40);

for (const service of ["broker", "controller"]) {
  test(`hosted proof binds exact ${service} run, artifact, manifest, and archive`, () => {
    const fixture = createFixture(service);
    const proof = createDeploymentPackageProof(fixture);
    assert.equal(proof.service, service);
    assert.equal(
      proof.packageManifest.sha256,
      fixture.deployment.packageManifest.sha256,
    );
    assert.equal(
      proof.archive.sha256,
      fixture.deployment.archive.sha256,
    );

    assert.throws(() =>
      createDeploymentPackageProof({
        ...fixture,
        artifact: {
          ...fixture.artifact,
          id: fixture.artifact.id + 1,
        },
      }),
    );
    assert.throws(() =>
      createDeploymentPackageProof({
        ...fixture,
        packageManifestBytes: Buffer.from(
          `${fixture.packageManifestBytes.toString("utf8")} `,
        ),
      }),
    );
    const previousAttempt = createFixture(service, 1);
    const substitutedAttempt = {
      ...previousAttempt,
      deployment: structuredClone(previousAttempt.deployment),
      run: {
        ...previousAttempt.run,
        run_attempt: 2,
      },
    };
    substitutedAttempt.deployment.packageRun.attempt = 2;
    assert.throws(
      () => createDeploymentPackageProof(substitutedAttempt),
      /run or artifact identity is invalid/u,
    );
  });
}

function createFixture(service, runAttempt = 2) {
  const runId = service === "broker" ? 101 : 102;
  const packageManifest = manifest(service);
  const packageManifestBytes = Buffer.from(JSON.stringify(packageManifest));
  const archiveBytes = Buffer.from(`${service} archive`);
  const artifactZipBytes = Buffer.from(`${service} artifact zip`);
  const artifactId = service === "broker" ? 201 : 202;
  const serviceIdentity =
    service === "broker"
      ? "broker:forge3d-browser-lab"
      : "controller:FW-LNX-NV-01";
  const archiveName =
    service === "broker"
      ? packageManifest.archive.name
      : packageManifest.archive;
  const archiveSha256 = sha256(archiveBytes);
  if (service === "broker") {
    packageManifest.archive.sha256 = archiveSha256;
  } else {
    packageManifest.archiveSha256 = archiveSha256;
  }
  const finalManifestBytes = Buffer.from(JSON.stringify(packageManifest));
  const artifactDigest = `sha256:${sha256(artifactZipBytes)}`;
  const deployment = {
    schemaVersion: 1,
    recordType: "lab-service-deployment-provenance",
    service,
    serviceIdentity,
    packageRun: {
      id: runId,
      attempt: runAttempt,
      artifact: {
        id: artifactId,
        name:
          `browser-lab-${service}-${targetSha}-${runId}-${runAttempt}`,
        digest: artifactDigest,
      },
    },
    source: {
      repository: "milos-agathon/forge3d-web",
      targetSha,
      workflowSha,
    },
    packageManifest: {
      sha256: sha256(finalManifestBytes),
      attestation: {
        verified: true,
        repository: "milos-agathon/forge3d-web",
        signerWorkflow:
          `milos-agathon/forge3d-web/.github/workflows/browser-lab-${service}.yml`,
        sourceRef: "refs/heads/main",
        sourceDigest: targetSha,
        denySelfHostedRunners: true,
      },
    },
    archive: { name: archiveName, sha256: archiveSha256 },
    configuration: {
      sha256:
        service === "broker"
          ? packageManifest.configurationSha256
          : sha256(Buffer.from(canonicalJson(packageManifest.files))),
    },
    protocols: {
      broker: "forge3d-browser-lab-broker/v1",
      cleanup: "forge3d-browser-lab-cleanup/v1",
    },
    administratorVerification: {
      status: "verified",
      method: "github-attestation",
      verifiedAt: "2026-07-31T09:00:00.000Z",
      verifiedBy: "lab-admin",
    },
  };
  const run = {
    id: runId,
    run_attempt: runAttempt,
    path: `.github/workflows/browser-lab-${service}.yml`,
    head_branch: "main",
    head_sha: targetSha,
    event: service === "broker" ? "push" : "workflow_dispatch",
    status: "completed",
    conclusion: "success",
  };
  const artifact = {
    id: artifactId,
    name: deployment.packageRun.artifact.name,
    digest: artifactDigest,
    expired: false,
    workflow_run: { id: runId },
  };
  return {
    deployment,
    run,
    artifact,
    artifactZipBytes,
    packageManifest,
    packageManifestBytes: finalManifestBytes,
    packageManifestName: `${service}-package-manifest.json`,
    archiveBytes,
    archiveName,
  };
}

function manifest(service) {
  if (service === "controller") {
    return {
      schemaVersion: 1,
      package: "@forge3d/browser-lab-controller",
      version: "1.0.0",
      targetSha,
      workflowSha,
      archive: "browser-lab-controller-1.0.0.tar.gz",
      archiveSha256: "0".repeat(64),
      files: [
        { path: "package.json", sha256: "1".repeat(64) },
        { path: "src/bootstrap.mjs", sha256: "2".repeat(64) },
        {
          path: "src/controller-service.mjs",
          sha256: "3".repeat(64),
        },
      ],
    };
  }
  const configuration = [
    "browser-policy.json",
    "broker-lifecycle.schema.json",
    "broker-protocol.schema.json",
    "controller-health-endpoints.json",
    "hardware-matrix.json",
    "repository-trust-policy.json",
    "runner-distribution-manifest.json",
    "runner-transient-path-policy.json",
    "workflow-actions-lock.json",
  ].map((name, index) => ({
    path: `crates/forge3d-web/tests/infrastructure/${name}`,
    sha256: String(index + 1).repeat(64),
  }));
  return {
    schemaVersion: 1,
    repository: "milos-agathon/forge3d-web",
    targetSha,
    workflowSha,
    brokerProtocolVersion: "forge3d-browser-lab-broker/v1",
    cleanupProtocolVersion: "forge3d-browser-lab-cleanup/v1",
    archive: {
      name: "browser-lab-broker.tar.gz",
      sha256: "0".repeat(64),
    },
    configuration,
    configurationSha256: sha256(Buffer.from(canonicalJson(configuration))),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
