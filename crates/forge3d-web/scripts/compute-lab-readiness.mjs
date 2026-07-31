import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";
import { validateHardwareMatrix } from "./validate-hardware-matrix.mjs";
import { verifyRunnerPolicy } from "./verify-runner-distribution.mjs";
import { assertJsonSchema } from "../tests/browser/json-schema-validator.mjs";
import { assertBrokerPackageManifest } from "../../../tools/browser-lab-broker/src/deployment-provenance.mjs";
import { assertControllerPackageManifest } from "../../../tools/browser-lab-controller/src/deployment-provenance.mjs";

const hostCanarySchema = JSON.parse(
  readFileSync(
    new URL(
      "../tests/infrastructure/lab-host-canary.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const manualCanarySchema = JSON.parse(
  readFileSync(
    new URL("../tests/infrastructure/manual-canary.schema.json", import.meta.url),
    "utf8",
  ),
);
const readinessSchema = JSON.parse(
  readFileSync(
    new URL(
      "../tests/infrastructure/browser-lab-infrastructure-readiness.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

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
  "crates/forge3d-web/tests/infrastructure/lab-host-canary.schema.json",
  "crates/forge3d-web/tests/infrastructure/lab-deployment-provenance.schema.json",
  "crates/forge3d-web/tests/infrastructure/manual-canary.schema.json",
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
  "crates/forge3d-web/scripts/create-deployment-package-proof.mjs",
  "crates/forge3d-web/scripts/create-browser-matrix-record.mjs",
  "crates/forge3d-web/scripts/create-run-nonce.mjs",
  "crates/forge3d-web/scripts/finalize-host-lab-canary.mjs",
  "crates/forge3d-web/scripts/finalize-deployment-provenance.mjs",
  "crates/forge3d-web/scripts/finalize-manual-session.mjs",
  "crates/forge3d-web/scripts/generate-runner-distribution-manifest.mjs",
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
  "crates/forge3d-web/scripts/selected-workflow-record.mjs",
  "crates/forge3d-web/scripts/serve-browser-fixture.mjs",
  "crates/forge3d-web/scripts/validate-hardware-matrix.mjs",
  "crates/forge3d-web/scripts/validate-manual-evidence.mjs",
  "crates/forge3d-web/scripts/verify-controller-record.mjs",
  "crates/forge3d-web/scripts/verify-runner-distribution.mjs",
  "crates/forge3d-web/scripts/webdriver-client.mjs",
  "tools/browser-lab-broker/package.json",
  "tools/browser-lab-broker/schemas/broker-package-manifest.schema.json",
  "tools/browser-lab-broker/schemas/lab-service-deployment-provenance.schema.json",
  "tools/browser-lab-broker/scripts/create-package-manifest.mjs",
  "tools/browser-lab-broker/services/browser-lab-broker.env.example",
  "tools/browser-lab-broker/services/browser-lab-broker.service",
  "tools/browser-lab-broker/src/authorization-verifier.mjs",
  "tools/browser-lab-broker/src/broker.mjs",
  "tools/browser-lab-broker/src/bootstrap.mjs",
  "tools/browser-lab-broker/src/canonical-json.mjs",
  "tools/browser-lab-broker/src/controller-reachability.mjs",
  "tools/browser-lab-broker/src/deployment-provenance.mjs",
  "tools/browser-lab-broker/src/github-client.mjs",
  "tools/browser-lab-broker/src/ledger.mjs",
  "tools/browser-lab-broker/src/protocol.mjs",
  "tools/browser-lab-broker/src/runner-authorization.mjs",
  "tools/browser-lab-broker/src/server.mjs",
  "tools/browser-lab-controller/package.json",
  "tools/browser-lab-controller/schemas/controller-deployment-provenance-receipt.schema.json",
  "tools/browser-lab-controller/schemas/controller-package-manifest.schema.json",
  "tools/browser-lab-controller/schemas/lab-service-deployment-provenance.schema.json",
  "tools/browser-lab-controller/scripts/create-package-manifest.mjs",
  "tools/browser-lab-controller/services/browser-lab-controller.env.example",
  "tools/browser-lab-controller/services/browser-lab-controller.service",
  "tools/browser-lab-controller/services/browser-lab-controller.sudoers-linux",
  "tools/browser-lab-controller/services/browser-lab-controller.sudoers-macos",
  "tools/browser-lab-controller/services/com.forge3d.browser-lab-controller.plist",
  "tools/browser-lab-controller/services/forge3d-browser-lab-controller.xml",
  "tools/browser-lab-controller/services/unix-interactive-session-bridge.mjs",
  "tools/browser-lab-controller/services/unix-interactive-session-contract.mjs",
  "tools/browser-lab-controller/services/unix-runner-transient-paths.mjs",
  "tools/browser-lab-controller/services/windows-interactive-session-bridge.ps1",
  "tools/browser-lab-controller/src/appium-session.mjs",
  "tools/browser-lab-controller/src/authorization-source.mjs",
  "tools/browser-lab-controller/src/bootstrap.mjs",
  "tools/browser-lab-controller/src/broker-lifecycle-store.mjs",
  "tools/browser-lab-controller/src/broker-client.mjs",
  "tools/browser-lab-controller/src/controller-daemon.mjs",
  "tools/browser-lab-controller/src/controller-evidence-inputs.mjs",
  "tools/browser-lab-controller/src/controller-health-service.mjs",
  "tools/browser-lab-controller/src/controller-job-files.mjs",
  "tools/browser-lab-controller/src/controller-receipt-store.mjs",
  "tools/browser-lab-controller/src/controller-service.mjs",
  "tools/browser-lab-controller/src/controller-signing.mjs",
  "tools/browser-lab-controller/src/controller.mjs",
  "tools/browser-lab-controller/src/deployment-provenance.mjs",
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
  deploymentProvenance,
  deploymentPackageProofs,
  manualCanary,
  canaryRelease,
  repositoryTrust,
  matrix,
  browserPolicy,
  runnerDistributionManifest,
  runnerTransientPathPolicy,
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
  if (
    !browserPolicy ||
    !runnerDistributionManifest ||
    !runnerTransientPathPolicy
  ) {
    throw new Error("checked runner policy inputs are required");
  }
  verifyRunnerPolicy({
    browserPolicy,
    manifest: runnerDistributionManifest,
    transientPolicy: runnerTransientPathPolicy,
    requireCanary: true,
  });
  try {
    validateHardwareMatrix(matrix, { requireProvisioned: true });
  } catch {
    throw new Error("checked laboratory inventory is not active");
  }
  const requiredHosts = matrix.hosts.map((host) => host.assetId).sort();
  if (!Array.isArray(hostCanaries)) {
    throw new Error("host canaries do not form the exact closed host set");
  }
  for (const record of hostCanaries) {
    assertJsonSchema(record, hostCanarySchema);
  }
  assertJsonSchema(manualCanary, manualCanarySchema);
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
  validateDeploymentProvenance({
    records: deploymentProvenance,
    packageProofs: deploymentPackageProofs,
    acceptedHosts,
    requiredHosts,
    candidateSha,
    matrix,
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
  manifestBytes,
  readinessRun,
  dispatch,
  packageManifest,
  packageResolution,
  attestation,
  expectedConfiguration,
}) {
  try {
    assertJsonSchema(manifest, readinessSchema);
  } catch {
    throwPromotionFailure();
  }
  let canonicalFiles;
  let expectedConfigurationDigest;
  try {
    canonicalFiles = canonicalJson(expectedConfiguration?.files);
    expectedConfigurationDigest = sha256Hex({
      schemaVersion: expectedConfiguration?.schemaVersion,
      files: expectedConfiguration?.files,
      versions: expectedConfiguration?.versions,
    });
  } catch {
    throwPromotionFailure();
  }
  const canonicalManifestBytes = Buffer.from(
    `${canonicalJson(manifest)}\n`,
    "utf8",
  );
  // GitHub's workflow-run REST response does not expose workflow_dispatch
  // inputs. The strict attested manifest remains the source of truth for the
  // exact host, manual-canary, and canary-release IDs.
  if (
    !Buffer.isBuffer(manifestBytes) ||
    !manifestBytes.equals(canonicalManifestBytes) ||
    !hasExactKeys(readinessRun, [
      "id",
      "attempt",
      "path",
      "ref",
      "headSha",
      "headBranch",
      "event",
      "status",
      "conclusion",
    ]) ||
    !hasExactKeys(dispatch, [
      "trustedSha",
      "packageRunId",
      "labReadinessRunId",
    ]) ||
    !hasExactKeys(attestation, [
      "verified",
      "repository",
      "signerWorkflow",
      "sourceRef",
      "sourceDigest",
      "denySelfHostedRunners",
      "subjectSha256",
    ]) ||
    manifest.repository !== "milos-agathon/forge3d-web" ||
    manifest.workflow !==
      ".github/workflows/browser-lab-infrastructure-readiness.yml" ||
    manifest.run.id !== readinessRun.id ||
    manifest.run.attempt !== readinessRun.attempt ||
    manifest.run.workflowSha !== readinessRun.headSha ||
    manifest.candidateSha !== dispatch.trustedSha ||
    manifest.packageRunId !== dispatch.packageRunId ||
    readinessRun.id !== dispatch.labReadinessRunId ||
    readinessRun.path !== manifest.workflow ||
    readinessRun.ref !== "refs/heads/main" ||
    readinessRun.headSha !== dispatch.trustedSha ||
    readinessRun.headBranch !== "main" ||
    readinessRun.event !== "workflow_dispatch" ||
    readinessRun.status !== "completed" ||
    readinessRun.conclusion !== "success" ||
    !Number.isInteger(readinessRun.attempt) ||
    readinessRun.attempt < 1 ||
    !strictlyIncreasingPositiveIntegers(manifest.hostCanaryRunIds) ||
    !isExactBrowserPackageManifest(packageManifest) ||
    packageManifest.runId !== manifest.packageRunId ||
    packageManifest.runId !== packageResolution?.packageRunId ||
    packageManifest.runAttempt !== packageResolution.packageRunAttempt ||
    packageManifest.repository !== manifest.repository ||
    packageManifest.workflowPath !== ".github/workflows/browser-package.yml" ||
    packageManifest.workflowSha !== dispatch.trustedSha ||
    packageManifest.workflowSha !== packageResolution.packageWorkflowSha ||
    packageManifest.targetSha !== dispatch.trustedSha ||
    packageManifest.packageSha256 !== manifest.packageSha256 ||
    !isExactPackageResolution(packageResolution, dispatch.trustedSha) ||
    attestation?.verified !== true ||
    attestation.repository !== "milos-agathon/forge3d-web" ||
    attestation.signerWorkflow !==
      "milos-agathon/forge3d-web/.github/workflows/browser-lab-infrastructure-readiness.yml" ||
    attestation.sourceRef !== "refs/heads/main" ||
    attestation.sourceDigest !== dispatch.trustedSha ||
    attestation.sourceDigest !== manifest.run.workflowSha ||
    attestation.denySelfHostedRunners !== true ||
    attestation.subjectSha256 !== sha256Hex(manifestBytes) ||
    !hasExactKeys(expectedConfiguration, [
      "schemaVersion",
      "files",
      "versions",
      "labInfrastructureDigest",
    ]) ||
    expectedConfiguration.schemaVersion !== 1 ||
    expectedConfiguration.labInfrastructureDigest !==
      expectedConfigurationDigest ||
    manifest.labInfrastructureDigest !==
      expectedConfiguration.labInfrastructureDigest ||
    canonicalJson(manifest.configurationFiles) !== canonicalFiles
  ) {
    throwPromotionFailure();
  }
  return manifest.labInfrastructureDigest;
}

function isExactBrowserPackageManifest(manifest) {
  if (
    !hasExactKeys(manifest, [
      "schemaVersion",
      "repository",
      "workflowPath",
      "workflowSha",
      "runId",
      "runAttempt",
      "targetSha",
      "packageName",
      "packageVersion",
      "tarball",
      "packageSha256",
      "sourceTreeClean",
      "files",
    ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.repository !== "milos-agathon/forge3d-web" ||
    manifest.workflowPath !== ".github/workflows/browser-package.yml" ||
    !/^[0-9a-f]{40}$/u.test(manifest.workflowSha ?? "") ||
    !Number.isInteger(manifest.runId) ||
    manifest.runId < 1 ||
    !Number.isInteger(manifest.runAttempt) ||
    manifest.runAttempt < 1 ||
    !/^[0-9a-f]{40}$/u.test(manifest.targetSha ?? "") ||
    manifest.packageName !== "@forge3d/web" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(
      manifest.packageVersion ?? "",
    ) ||
    manifest.tarball !== `forge3d-web-${manifest.packageVersion}.tgz` ||
    !/^[0-9a-f]{64}$/u.test(manifest.packageSha256 ?? "") ||
    manifest.sourceTreeClean !== true ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1
  ) {
    return false;
  }
  const names = new Set();
  for (const file of manifest.files) {
    if (
      !hasExactKeys(file, ["name", "sha256"]) ||
      typeof file.name !== "string" ||
      file.name.length < 1 ||
      !/^[0-9a-f]{64}$/u.test(file.sha256 ?? "") ||
      names.has(file.name)
    ) {
      return false;
    }
    names.add(file.name);
  }
  return manifest.files.some(
    (file) =>
      file.name === manifest.tarball &&
      file.sha256 === manifest.packageSha256,
  );
}

function isExactPackageResolution(resolution, trustedSha) {
  return (
    hasExactKeys(resolution, [
      "packageRunId",
      "packageArtifactId",
      "packageArtifactName",
      "packageArtifactDigest",
      "packageWorkflowSha",
      "packageRunAttempt",
      "packageRunPath",
      "packageRunHeadBranch",
      "packageRunRef",
      "packageRunEvent",
      "packageRunStatus",
      "packageRunConclusion",
    ]) &&
    Number.isInteger(resolution.packageRunId) &&
    resolution.packageRunId > 0 &&
    Number.isInteger(resolution.packageArtifactId) &&
    resolution.packageArtifactId > 0 &&
    resolution.packageArtifactName === `browser-package-${trustedSha}` &&
    /^sha256:[0-9a-f]{64}$/u.test(resolution.packageArtifactDigest ?? "") &&
    resolution.packageWorkflowSha === trustedSha &&
    Number.isInteger(resolution.packageRunAttempt) &&
    resolution.packageRunAttempt > 0 &&
    resolution.packageRunPath === ".github/workflows/browser-package.yml" &&
    resolution.packageRunHeadBranch === "main" &&
    resolution.packageRunRef === "refs/heads/main" &&
    ["push", "workflow_dispatch"].includes(resolution.packageRunEvent) &&
    resolution.packageRunStatus === "completed" &&
    resolution.packageRunConclusion === "success"
  );
}

function strictlyIncreasingPositiveIntegers(values) {
  return (
    Array.isArray(values) &&
    values.length === 4 &&
    values.every(
      (value, index) =>
        Number.isInteger(value) &&
        value > 0 &&
        (index === 0 || values[index - 1] < value),
    )
  );
}

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") ===
      [...expected].sort().join("\n")
  );
}

function throwPromotionFailure() {
  throw new Error("laboratory readiness does not unlock this exact product lane");
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

function validateDeploymentProvenance({
  records,
  packageProofs,
  acceptedHosts,
  requiredHosts,
  candidateSha,
  matrix,
}) {
  if (
    !Array.isArray(records) ||
    records.length !== requiredHosts.length ||
    new Set(records.map((record) => record?.hostId)).size !==
      requiredHosts.length ||
    !Array.isArray(packageProofs) ||
    packageProofs.length !== requiredHosts.length + 1
  ) {
    throw new Error(
      "deployment provenance does not form the exact closed host set",
    );
  }
  const brokerCanonical = new Set();
  for (const hostId of requiredHosts) {
    const record = records.find((candidate) => candidate.hostId === hostId);
    const hostCanary = acceptedHosts.find(
      (candidate) => candidate.hostId === hostId,
    );
    const host = matrix.hosts.find((candidate) => candidate.assetId === hostId);
    if (
      record?.recordType !==
        "lab-service-deployment-provenance-receipt" ||
      record.runId !== hostCanary.runId ||
      record.runAttempt !== hostCanary.runAttempt ||
      record.trustedSha !== candidateSha ||
      record.controllerIdentity !== `controller:${hostId}` ||
      record.controllerSignature?.verified !== true ||
      record.controllerSignature.signingKeyId !==
        host.controller.signingKeyId ||
      record.attestation?.verified !== true ||
      record.attestation.denySelfHostedRunners !== true ||
      record.attestation.repository !== "milos-agathon/forge3d-web" ||
      record.attestation.signerWorkflow !==
        "milos-agathon/forge3d-web/.github/workflows/browser-hardware.yml" ||
      record.attestation.sourceRef !== "refs/heads/main" ||
      record.attestation.sourceDigest !== candidateSha ||
      record.finalizer?.run?.id !== record.runId ||
      record.finalizer.run.attempt !== record.runAttempt ||
      record.finalizer.job !== "finalize-hardware-evidence" ||
      record.finalizer.environment !== "forge3d-trust-observer" ||
      record.broker?.service !== "broker" ||
      record.broker.serviceIdentity !== "broker:forge3d-browser-lab" ||
      record.broker.source.targetSha !== candidateSha ||
      record.controller?.service !== "controller" ||
      record.controller.serviceIdentity !== `controller:${hostId}` ||
      record.controller.source.targetSha !== candidateSha ||
      record.broker.source.workflowSha !==
        record.controller.source.workflowSha ||
      record.broker.protocols?.broker !==
        "forge3d-browser-lab-broker/v1" ||
      record.broker.protocols.cleanup !==
        "forge3d-browser-lab-cleanup/v1" ||
      canonicalJson(record.broker.protocols) !==
        canonicalJson(record.controller.protocols)
    ) {
      throw new Error(
        `host deployment provenance is invalid: ${hostId}`,
      );
    }
    brokerCanonical.add(canonicalJson(record.broker));
    validatePackageProof(
      packageProofs.find(
        (proof) => proof.serviceIdentity === `controller:${hostId}`,
      ),
      record.controller,
    );
  }
  if (brokerCanonical.size !== 1) {
    throw new Error("host deployments do not share one exact broker");
  }
  const broker = records[0].broker;
  validatePackageProof(
    packageProofs.find(
      (proof) => proof.serviceIdentity === "broker:forge3d-browser-lab",
    ),
    broker,
  );
  if (
    new Set(packageProofs.map((proof) => proof?.serviceIdentity)).size !==
    requiredHosts.length + 1
  ) {
    throw new Error("deployment package proofs are not an exact identity set");
  }
}

function validatePackageProof(proof, deployment) {
  if (
    proof?.service !== deployment.service ||
    proof.serviceIdentity !== deployment.serviceIdentity ||
    proof.run?.id !== deployment.packageRun.id ||
    proof.run.attempt !== deployment.packageRun.attempt ||
    proof.run.path !==
      `.github/workflows/browser-lab-${deployment.service}.yml` ||
    proof.run.headSha !== deployment.source.targetSha ||
    proof.run.status !== "completed" ||
    proof.run.conclusion !== "success" ||
    canonicalJson(proof.artifact) !==
      canonicalJson(deployment.packageRun.artifact) ||
    proof.packageManifest?.sha256 !==
      deployment.packageManifest.sha256 ||
    proof.archive?.name !== deployment.archive.name ||
    proof.archive.sha256 !== deployment.archive.sha256 ||
    proof.hostedAttestationVerification?.verified !== true ||
    proof.hostedAttestationVerification.repository !==
      "milos-agathon/forge3d-web" ||
    proof.hostedAttestationVerification.signerWorkflow !==
      deployment.packageManifest.attestation.signerWorkflow ||
    proof.hostedAttestationVerification.sourceRef !==
      "refs/heads/main" ||
    proof.hostedAttestationVerification.sourceDigest !==
      deployment.source.targetSha ||
    proof.hostedAttestationVerification.denySelfHostedRunners !== true
  ) {
    throw new Error(
      `deployed package proof is invalid: ${deployment.serviceIdentity}`,
    );
  }
  const manifest = proof.packageManifest.value;
  if (deployment.service === "broker") {
    assertBrokerPackageManifest(manifest);
    if (
      manifest.targetSha !== deployment.source.targetSha ||
      manifest.workflowSha !== deployment.source.workflowSha ||
      manifest.archive.name !== deployment.archive.name ||
      manifest.archive.sha256 !== deployment.archive.sha256 ||
      manifest.configurationSha256 !==
        deployment.configuration.sha256 ||
      manifest.brokerProtocolVersion !== deployment.protocols.broker ||
      manifest.cleanupProtocolVersion !== deployment.protocols.cleanup
    ) {
      throw new Error("deployed broker manifest proof is invalid");
    }
    return;
  }
  assertControllerPackageManifest(manifest);
  if (
    manifest.targetSha !== deployment.source.targetSha ||
    manifest.workflowSha !== deployment.source.workflowSha ||
    manifest.archive !== deployment.archive.name ||
    manifest.archiveSha256 !== deployment.archive.sha256 ||
    sha256Hex(manifest.files) !== deployment.configuration.sha256
  ) {
    throw new Error(
      `deployed controller manifest proof is invalid: ${deployment.serviceIdentity}`,
    );
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
  const infrastructureRoot = join(
    repositoryRoot,
    "crates/forge3d-web/tests/infrastructure",
  );
  input.browserPolicy = JSON.parse(
    readFileSync(join(infrastructureRoot, "browser-policy.json"), "utf8"),
  );
  input.runnerDistributionManifest = JSON.parse(
    readFileSync(
      join(infrastructureRoot, "runner-distribution-manifest.json"),
      "utf8",
    ),
  );
  input.runnerTransientPathPolicy = JSON.parse(
    readFileSync(
      join(infrastructureRoot, "runner-transient-path-policy.json"),
      "utf8",
    ),
  );
  input.configuration = computeLabConfiguration({ repositoryRoot });
  const output = computeLabReadiness(input);
  writeFileSync(process.argv[3], `${output.canonical}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, sha256: output.sha256 }));
}
