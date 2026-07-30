import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";

export const labConfigurationFiles = [
  ".github/workflows/browser-hardware.yml",
  ".github/workflows/browser-hardware-release-readiness.yml",
  ".github/workflows/browser-lab-broker.yml",
  ".github/workflows/browser-lab-infrastructure-readiness.yml",
  ".github/workflows/browser-lab-controller.yml",
  ".github/workflows/browser-package.yml",
  ".github/workflows/prepare-browser-manual-evidence.yml",
  ".github/workflows/publish-browser-lab-canary.yml",
  ".github/workflows/publish-web-release.yml",
  ".github/workflows/submit-browser-manual-evidence.yml",
  "crates/forge3d-web/tests/device/device-matrix.json",
  "crates/forge3d-web/tests/device/device-matrix.schema.json",
  "crates/forge3d-web/tests/manual/infrastructure-manual-canary.md",
  "crates/forge3d-web/tests/manual/mobile-multitouch.md",
  "crates/forge3d-web/tests/manual/safari-trackpad.md",
  "crates/forge3d-web/tests/browser/adapter-attestation.ts",
  "crates/forge3d-web/tests/browser/adapter-attestation.schema.json",
  "crates/forge3d-web/tests/browser/hardware-page-harness.js",
  "crates/forge3d-web/tests/infrastructure/broker-lifecycle.schema.json",
  "crates/forge3d-web/tests/infrastructure/broker-protocol.schema.json",
  "crates/forge3d-web/tests/infrastructure/browser-hardware-release-readiness.schema.json",
  "crates/forge3d-web/tests/infrastructure/browser-lab-infrastructure-readiness.schema.json",
  "crates/forge3d-web/tests/infrastructure/browser-policy.json",
  "crates/forge3d-web/tests/infrastructure/browser-policy.schema.json",
  "crates/forge3d-web/tests/infrastructure/browser-release-manifest.schema.json",
  "crates/forge3d-web/tests/infrastructure/controller-health-endpoints.json",
  "crates/forge3d-web/tests/infrastructure/controller-health-endpoints.schema.json",
  "crates/forge3d-web/tests/infrastructure/controller-protocol.schema.json",
  "crates/forge3d-web/tests/infrastructure/hardware-matrix.json",
  "crates/forge3d-web/tests/infrastructure/hardware-matrix.schema.json",
  "crates/forge3d-web/tests/infrastructure/https-origin-policy.json",
  "crates/forge3d-web/tests/infrastructure/https-origin-policy.schema.json",
  "crates/forge3d-web/tests/infrastructure/manual-evidence-intake.schema.json",
  "crates/forge3d-web/tests/infrastructure/manual-evidence.schema.json",
  "crates/forge3d-web/tests/infrastructure/manual-session.schema.json",
  "crates/forge3d-web/tests/infrastructure/release-publication-preflight.schema.json",
  "crates/forge3d-web/tests/infrastructure/repository-trust-observation.schema.json",
  "crates/forge3d-web/tests/infrastructure/repository-trust-policy.json",
  "crates/forge3d-web/tests/infrastructure/repository-trust-policy.schema.json",
  "crates/forge3d-web/tests/infrastructure/runner-distribution-manifest.json",
  "crates/forge3d-web/tests/infrastructure/runner-distribution-manifest.schema.json",
  "crates/forge3d-web/tests/infrastructure/runner-transient-path-policy.json",
  "crates/forge3d-web/tests/infrastructure/runner-transient-path-policy.schema.json",
  "crates/forge3d-web/tests/infrastructure/workflow-actions-lock.json",
  "crates/forge3d-web/tests/infrastructure/workflow-actions-lock.schema.json",
  "crates/forge3d-web/tests/infrastructure/runner-authorization.schema.json",
  "crates/forge3d-web/scripts/authorize-hardware-runner.mjs",
  "crates/forge3d-web/scripts/browser-lane-runtime.mjs",
  "crates/forge3d-web/scripts/browser-launch-provenance.mjs",
  "crates/forge3d-web/scripts/browser-process-registry.mjs",
  "crates/forge3d-web/scripts/browser-run-provenance.mjs",
  "crates/forge3d-web/scripts/browser-session-runtime.mjs",
  "crates/forge3d-web/scripts/canonical-json.mjs",
  "crates/forge3d-web/scripts/capture-host-gpu-evidence.mjs",
  "crates/forge3d-web/scripts/capture-host-inventory.mjs",
  "crates/forge3d-web/scripts/cleanup-browser-hardware.mjs",
  "crates/forge3d-web/scripts/compute-lab-readiness.mjs",
  "crates/forge3d-web/scripts/create-browser-matrix-record.mjs",
  "crates/forge3d-web/scripts/create-run-nonce.mjs",
  "crates/forge3d-web/scripts/finalize-host-lab-canary.mjs",
  "crates/forge3d-web/scripts/finalize-manual-session.mjs",
  "crates/forge3d-web/scripts/hardware-orchestration.mjs",
  "crates/forge3d-web/scripts/infrastructure-manual-canary.mjs",
  "crates/forge3d-web/scripts/join-adapter-attestation.mjs",
  "crates/forge3d-web/scripts/manual-evidence.mjs",
  "crates/forge3d-web/scripts/manage-browser-route.mjs",
  "crates/forge3d-web/scripts/manage-browser-update-window.mjs",
  "crates/forge3d-web/scripts/materialize-browser-fixture.mjs",
  "crates/forge3d-web/scripts/merge-browser-evidence.mjs",
  "crates/forge3d-web/scripts/prepare-manual-submission.mjs",
  "crates/forge3d-web/scripts/probe-browser-fixture.mjs",
  "crates/forge3d-web/scripts/release-publication.mjs",
  "crates/forge3d-web/scripts/resolve-host-runtime.mjs",
  "crates/forge3d-web/scripts/resolve-hardware-promotion.mjs",
  "crates/forge3d-web/scripts/resolve-implementation-actors.mjs",
  "crates/forge3d-web/scripts/resolve-manual-intake.mjs",
  "crates/forge3d-web/scripts/serve-browser-fixture.mjs",
  "crates/forge3d-web/scripts/validate-manual-evidence.mjs",
  "crates/forge3d-web/scripts/verify-controller-record.mjs",
  "crates/forge3d-web/scripts/webdriver-client.mjs",
  "tools/browser-lab-broker/package.json",
  "tools/browser-lab-broker/services/browser-lab-broker.service",
  "tools/browser-lab-broker/src/authorization-verifier.mjs",
  "tools/browser-lab-broker/src/broker.mjs",
  "tools/browser-lab-broker/src/canonical-json.mjs",
  "tools/browser-lab-broker/src/controller-reachability.mjs",
  "tools/browser-lab-broker/src/github-client.mjs",
  "tools/browser-lab-broker/src/ledger.mjs",
  "tools/browser-lab-broker/src/protocol.mjs",
  "tools/browser-lab-broker/src/runner-authorization.mjs",
  "tools/browser-lab-broker/src/server.mjs",
  "tools/browser-lab-controller/package.json",
  "tools/browser-lab-controller/services/browser-lab-controller.env.example",
  "tools/browser-lab-controller/services/browser-lab-controller.service",
  "tools/browser-lab-controller/services/browser-lab-controller.sudoers-linux",
  "tools/browser-lab-controller/services/browser-lab-controller.sudoers-macos",
  "tools/browser-lab-controller/services/com.forge3d.browser-lab-controller.plist",
  "tools/browser-lab-controller/services/forge3d-browser-lab-controller.xml",
  "tools/browser-lab-controller/services/unix-interactive-session-bridge.mjs",
  "tools/browser-lab-controller/services/unix-interactive-session-contract.mjs",
  "tools/browser-lab-controller/services/windows-interactive-session-bridge.ps1",
  "tools/browser-lab-controller/src/appium-session.mjs",
  "tools/browser-lab-controller/src/authorization-source.mjs",
  "tools/browser-lab-controller/src/broker-client.mjs",
  "tools/browser-lab-controller/src/controller-daemon.mjs",
  "tools/browser-lab-controller/src/controller-evidence-inputs.mjs",
  "tools/browser-lab-controller/src/controller-health-service.mjs",
  "tools/browser-lab-controller/src/controller-job-files.mjs",
  "tools/browser-lab-controller/src/controller-receipt-store.mjs",
  "tools/browser-lab-controller/src/controller-service.mjs",
  "tools/browser-lab-controller/src/controller-signing.mjs",
  "tools/browser-lab-controller/src/controller.mjs",
  "tools/browser-lab-controller/src/host-lock.mjs",
  "tools/browser-lab-controller/src/github-actions-client.mjs",
  "tools/browser-lab-controller/src/lab-canary.mjs",
  "tools/browser-lab-controller/src/manual-session.mjs",
  "tools/browser-lab-controller/src/production-dependencies.mjs",
  "tools/browser-lab-controller/src/runner-execution.mjs",
  "tools/browser-lab-controller/src/unix-runner-execution.mjs",
  "tools/browser-lab-controller/src/windows-runner-execution.mjs",
  "tools/browser-lab-controller/src/zip-artifact.mjs",
];

export function computeLabConfiguration({ repositoryRoot }) {
  const files = labConfigurationFiles.map((path) => ({
    path,
    sha256: sha256Hex(readFileSync(join(repositoryRoot, path))),
  }));
  const configuration = {
    schemaVersion: 1,
    files,
    versions: {
      broker: JSON.parse(
        readFileSync(join(repositoryRoot, "tools/browser-lab-broker/package.json")),
      ).version,
      controller: JSON.parse(
        readFileSync(
          join(repositoryRoot, "tools/browser-lab-controller/package.json"),
        ),
      ).version,
      runner: JSON.parse(
        readFileSync(
          join(
            repositoryRoot,
            "crates/forge3d-web/tests/infrastructure/browser-policy.json",
          ),
        ),
      ).runnerVersion,
    },
  };
  return {
    ...configuration,
    labInfrastructureDigest: sha256Hex(configuration),
  };
}

export function computeLabReadiness({
  candidateSha,
  packageRecord,
  hostCanaries,
  manualCanary,
  canaryRelease,
  repositoryTrust,
  matrix,
  configuration,
  run,
  now = new Date(),
}) {
  if (
    !/^[0-9a-f]{40}$/u.test(candidateSha ?? "") ||
    repositoryTrust?.verified !== true ||
    repositoryTrust.currentMainSha !== candidateSha ||
    repositoryTrust.targetSha !== candidateSha ||
    packageRecord.targetSha !== candidateSha ||
    packageRecord.attestation?.verified !== true ||
    packageRecord.attestation.denySelfHostedRunners !== true ||
    !/^[0-9a-f]{64}$/u.test(packageRecord.packageSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(configuration.labInfrastructureDigest ?? "")
  ) {
    throw new Error("laboratory candidate, package, or trust binding is invalid");
  }
  const requiredHosts = matrix.hosts.map((host) => host.assetId).sort();
  if (
    matrix.provisioningState !== "active" ||
    matrix.hosts.some(
      (host) =>
        host.state !== "active" ||
        host.controller.state !== "active" ||
        !host.controller.signingKeyId ||
        !host.controller.publicJwk,
    ) ||
    matrix.assets.some((asset) => asset.state !== "active")
  ) {
    throw new Error("checked laboratory inventory is not active");
  }
  if (
    hostCanaries.length !== requiredHosts.length ||
    new Set(hostCanaries.map((record) => record.hostId)).size !==
      requiredHosts.length
  ) {
    throw new Error("host canaries do not form the exact closed host set");
  }
  const acceptedHosts = requiredHosts.map((hostId) => {
    const record = hostCanaries.find((candidate) => candidate.hostId === hostId);
    validateHostCanary(record, {
      hostId,
      candidateSha,
      packageRecord,
      matrix,
    });
    return record;
  });
  validateManualCanary(manualCanary, {
    candidateSha,
    packageRecord,
    now,
  });
  const expectedTag = `browser-lab-canary-${configuration.labInfrastructureDigest}-${canaryRelease.publicationRunId}`;
  if (
    canaryRelease.tagName !== expectedTag ||
    canaryRelease.targetSha !== candidateSha ||
    canaryRelease.supportClaim !== false ||
    canaryRelease.draft !== false ||
    canaryRelease.immutableReleaseVerified !== true ||
    canaryRelease.allAssetsVerified !== true ||
    canaryRelease.intakeDeletedAfterVerification !== true ||
    canaryRelease.attestation?.verified !== true
  ) {
    throw new Error("non-support immutable laboratory canary release is invalid");
  }
  const manifest = {
    schemaVersion: 1,
    status: "LAB_INFRA_READY",
    supportClaim: false,
    repository: "milos-agathon/forge3d-web",
    workflow: ".github/workflows/browser-lab-infrastructure-readiness.yml",
    run,
    candidateSha,
    packageRunId: packageRecord.runId,
    packageSha256: packageRecord.packageSha256,
    labInfrastructureDigest: configuration.labInfrastructureDigest,
    configurationFiles: configuration.files,
    hostCanaryRunIds: acceptedHosts.map((record) => record.runId).sort(
      (left, right) => left - right,
    ),
    manualCanary: {
      runId: manualCanary.runId,
      intakeReleaseId: manualCanary.intakeReleaseId,
      hardwareJobId: manualCanary.hardwareJobId,
    },
    canaryReleaseId: canaryRelease.id,
    createdAt: new Date(now).toISOString(),
  };
  return {
    manifest,
    canonical: canonicalJson(manifest),
    sha256: sha256Hex(manifest),
  };
}

export function verifyLabReadinessForPromotion({
  manifest,
  readinessRun,
  dispatch,
  packageManifest,
  attestation,
}) {
  if (
    manifest.status !== "LAB_INFRA_READY" ||
    manifest.supportClaim !== false ||
    manifest.candidateSha !== dispatch.trustedSha ||
    manifest.packageRunId !== dispatch.packageRunId ||
    manifest.packageSha256 !== packageManifest.packageSha256 ||
    readinessRun.id !== dispatch.labReadinessRunId ||
    readinessRun.path !==
      ".github/workflows/browser-lab-infrastructure-readiness.yml" ||
    readinessRun.headSha !== dispatch.trustedSha ||
    readinessRun.headBranch !== "main" ||
    readinessRun.conclusion !== "success" ||
    attestation.repository !== "milos-agathon/forge3d-web" ||
    attestation.signerWorkflow !==
      "milos-agathon/forge3d-web/.github/workflows/browser-lab-infrastructure-readiness.yml" ||
    attestation.sourceRef !== "refs/heads/main" ||
    attestation.sourceDigest !== dispatch.trustedSha ||
    attestation.denySelfHostedRunners !== true
  ) {
    throw new Error("laboratory readiness does not unlock this exact product lane");
  }
  return manifest.labInfrastructureDigest;
}

function validateHostCanary(record, expected) {
  const host = expected.matrix.hosts.find(
    (candidate) => candidate.assetId === expected.hostId,
  );
  if (
    record?.lane !== "infrastructure-canary" ||
    record.canaryMode !== "host" ||
    record.hostId !== expected.hostId ||
    record.assetId !== expected.hostId ||
    record.trustedSha !== expected.candidateSha ||
    record.packageRunId !== expected.packageRecord.runId ||
    record.packageSha256 !== expected.packageRecord.packageSha256 ||
    record.result !== "PASS" ||
    record.supportAssertionsExecuted !== false ||
    record.adapter?.isFallbackAdapter !== false ||
    record.adapter?.deviceCreated !== true ||
    record.adapter?.surfacePresented !== true ||
    record.authorization?.attested !== true ||
    record.controller?.signatureVerified !== true ||
    record.runner?.acceptedJobCount !== 1 ||
    record.runner?.absentAfterRun !== true ||
    record.cleanup?.complete !== true ||
    record.inventory?.hostId !== expected.hostId ||
    !sameSet(record.inventory.attachedAssetIds, host.attachedAssetIds) ||
    record.route?.httpsVerified !== true ||
    record.route?.corsRangeControlsPassed !== true ||
    record.attestation?.verified !== true
  ) {
    throw new Error(`host infrastructure canary is invalid: ${expected.hostId}`);
  }
}

function validateManualCanary(record, expected) {
  if (
    record?.lane !== "infrastructure-canary" ||
    record.canaryMode !== "manual" ||
    record.checklistId !== "infrastructure-manual-canary" ||
    record.supportClaim !== false ||
    record.trustedSha !== expected.candidateSha ||
    record.packageRunId !== expected.packageRecord.runId ||
    record.packageSha256 !== expected.packageRecord.packageSha256 ||
    record.session?.durationMinutes !== 20 ||
    record.session?.controllerSignatureVerified !== true ||
    record.session?.runnerAbsent !== true ||
    record.session?.cleanupComplete !== true ||
    record.media?.authenticatedUploader !== true ||
    record.media?.challengeMatched !== true ||
    record.media?.digestsVerified !== true ||
    record.productAssertionsExecuted !== false ||
    record.attestation?.verified !== true ||
    new Date(record.expiresAt) <= new Date(expected.now)
  ) {
    throw new Error("generic manual infrastructure canary is invalid");
  }
}

function sameSet(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const repositoryRoot = resolve(process.argv[4] ?? "../../..");
  input.configuration = computeLabConfiguration({ repositoryRoot });
  const output = computeLabReadiness(input);
  writeFileSync(process.argv[3], `${output.canonical}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, sha256: output.sha256 }));
}
