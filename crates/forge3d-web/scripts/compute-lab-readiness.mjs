import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";
import { validateHostInventory } from "./capture-host-inventory.mjs";
import { validateHardwareMatrix } from "./validate-hardware-matrix.mjs";
import { verifyRunnerPolicy } from "./verify-runner-distribution.mjs";
import { validateDiagnosticRetentionReceipt } from "../../../tools/browser-lab-controller/src/diagnostic-retention.mjs";
import { assertJsonSchema } from "../tests/browser/json-schema-validator.mjs";

const labCanaryPublicationSchema = JSON.parse(
  readFileSync(
    new URL(
      "../tests/infrastructure/lab-canary-publication-record.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const browserLabInfrastructureReadinessSchema = JSON.parse(
  readFileSync(
    new URL(
      "../tests/infrastructure/browser-lab-infrastructure-readiness.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const serviceInstallationSchema = JSON.parse(
  readFileSync(
    new URL(
      "../tests/infrastructure/lab-service-installation.schema.json",
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
  ".github/workflows/web.yml",
  "crates/forge3d-web/docs/browser-lab-runbook.md",
  "crates/forge3d-web/docs/release-checklist.md",
  "crates/forge3d-web/tests/device/device-matrix.json",
  "crates/forge3d-web/tests/device/device-matrix.schema.json",
  "crates/forge3d-web/tests/manual/infrastructure-manual-canary.md",
  "crates/forge3d-web/tests/manual/mobile-multitouch.md",
  "crates/forge3d-web/tests/manual/safari-trackpad.md",
  "crates/forge3d-web/tests/browser/adapter-attestation.ts",
  "crates/forge3d-web/tests/browser/adapter-attestation.schema.json",
  "crates/forge3d-web/tests/browser/hardware-page-harness.js",
  "crates/forge3d-web/tests/browser/json-schema-validator.mjs",
  "crates/forge3d-web/tests/infrastructure/broker-lifecycle.schema.json",
  "crates/forge3d-web/tests/infrastructure/broker-protocol.schema.json",
  "crates/forge3d-web/tests/infrastructure/browser-hardware-release-readiness.schema.json",
  "crates/forge3d-web/tests/infrastructure/browser-lab-infrastructure-readiness.schema.json",
  "crates/forge3d-web/tests/infrastructure/browser-policy.json",
  "crates/forge3d-web/tests/infrastructure/browser-policy.schema.json",
  "crates/forge3d-web/tests/infrastructure/browser-release-manifest.schema.json",
  "crates/forge3d-web/tests/infrastructure/browser-release-publication-record.schema.json",
  "crates/forge3d-web/tests/infrastructure/controller-health-endpoints.json",
  "crates/forge3d-web/tests/infrastructure/controller-health-endpoints.schema.json",
  "crates/forge3d-web/tests/infrastructure/controller-protocol.schema.json",
  "crates/forge3d-web/tests/infrastructure/hardware-matrix.json",
  "crates/forge3d-web/tests/infrastructure/hardware-matrix.schema.json",
  "crates/forge3d-web/tests/infrastructure/host-inventory.schema.json",
  "crates/forge3d-web/tests/infrastructure/host-lab-canary.schema.json",
  "crates/forge3d-web/tests/infrastructure/https-origin-policy.json",
  "crates/forge3d-web/tests/infrastructure/https-origin-policy.schema.json",
  "crates/forge3d-web/tests/infrastructure/manual-evidence-intake.schema.json",
  "crates/forge3d-web/tests/infrastructure/manual-evidence.schema.json",
  "crates/forge3d-web/tests/infrastructure/manual-media-sources.schema.json",
  "crates/forge3d-web/tests/infrastructure/manual-session.schema.json",
  "crates/forge3d-web/tests/infrastructure/mobile-device-route-readiness.schema.json",
  "crates/forge3d-web/tests/infrastructure/lab-canary-publication-record.schema.json",
  "crates/forge3d-web/tests/infrastructure/lab-service-installation.schema.json",
  "crates/forge3d-web/tests/infrastructure/release-publication-preflight.schema.json",
  "crates/forge3d-web/tests/infrastructure/repository-trust-observation.schema.json",
  "crates/forge3d-web/tests/infrastructure/repository-trust-policy.json",
  "crates/forge3d-web/tests/infrastructure/repository-trust-policy.schema.json",
  "crates/forge3d-web/tests/infrastructure/runner-distribution-manifest.json",
  "crates/forge3d-web/tests/infrastructure/runner-distribution-manifest.schema.json",
  "crates/forge3d-web/tests/infrastructure/runner-diagnostic-retention.schema.json",
  "crates/forge3d-web/tests/infrastructure/runner-transient-path-policy.json",
  "crates/forge3d-web/tests/infrastructure/runner-transient-path-policy.schema.json",
  "crates/forge3d-web/tests/infrastructure/workflow-actions-lock.json",
  "crates/forge3d-web/tests/infrastructure/workflow-actions-lock.schema.json",
  "crates/forge3d-web/tests/infrastructure/runner-authorization.schema.json",
  "crates/forge3d-web/scripts/assemble-browser-package-artifact.mjs",
  "crates/forge3d-web/scripts/authorize-hardware-runner.mjs",
  "crates/forge3d-web/scripts/browser-lane-runtime.mjs",
  "crates/forge3d-web/scripts/browser-launch-provenance.mjs",
  "crates/forge3d-web/scripts/browser-process-registry.mjs",
  "crates/forge3d-web/scripts/browser-run-provenance.mjs",
  "crates/forge3d-web/scripts/browser-session-runtime.mjs",
  "crates/forge3d-web/scripts/canonical-json.mjs",
  "crates/forge3d-web/scripts/capture-host-gpu-evidence.mjs",
  "crates/forge3d-web/scripts/capture-host-inventory.mjs",
  "crates/forge3d-web/scripts/capture-trackpad-inventory.mjs",
  "crates/forge3d-web/scripts/cleanup-browser-hardware.mjs",
  "crates/forge3d-web/scripts/compute-lab-readiness.mjs",
  "crates/forge3d-web/scripts/create-browser-matrix-record.mjs",
  "crates/forge3d-web/scripts/create-run-nonce.mjs",
  "crates/forge3d-web/scripts/emit-repository-trust-observation.mjs",
  "crates/forge3d-web/scripts/finalize-host-lab-canary.mjs",
  "crates/forge3d-web/scripts/finalize-manual-session.mjs",
  "crates/forge3d-web/scripts/hardware-orchestration.mjs",
  "crates/forge3d-web/scripts/generate-runner-distribution-manifest.mjs",
  "crates/forge3d-web/scripts/infrastructure-manual-canary.mjs",
  "crates/forge3d-web/scripts/join-adapter-attestation.mjs",
  "crates/forge3d-web/scripts/lab-canary-publication.mjs",
  "crates/forge3d-web/scripts/manual-evidence.mjs",
  "crates/forge3d-web/scripts/manage-browser-route.mjs",
  "crates/forge3d-web/scripts/manage-browser-update-window.mjs",
  "crates/forge3d-web/scripts/materialize-browser-fixture.mjs",
  "crates/forge3d-web/scripts/merge-browser-evidence.mjs",
  "crates/forge3d-web/scripts/mint-github-app-token.mjs",
  "crates/forge3d-web/scripts/prepare-manual-submission.mjs",
  "crates/forge3d-web/scripts/probe-browser-fixture.mjs",
  "crates/forge3d-web/scripts/probe-mobile-device-routes.mjs",
  "crates/forge3d-web/scripts/release-publication.mjs",
  "crates/forge3d-web/scripts/resolve-host-runtime.mjs",
  "crates/forge3d-web/scripts/resolve-hardware-promotion.mjs",
  "crates/forge3d-web/scripts/resolve-implementation-actors.mjs",
  "crates/forge3d-web/scripts/resolve-manual-intake.mjs",
  "crates/forge3d-web/scripts/resolve-package-bootstrap.mjs",
  "crates/forge3d-web/scripts/serve-browser-fixture.mjs",
  "crates/forge3d-web/scripts/validate-hardware-matrix.mjs",
  "crates/forge3d-web/scripts/validate-manual-evidence.mjs",
  "crates/forge3d-web/scripts/verify-controller-record.mjs",
  "crates/forge3d-web/scripts/verify-repository-trust-observation.mjs",
  "crates/forge3d-web/scripts/verify-repository-trust.mjs",
  "crates/forge3d-web/scripts/verify-runner-distribution.mjs",
  "crates/forge3d-web/scripts/verify-workflow-action-pins.mjs",
  "crates/forge3d-web/scripts/webdriver-client.mjs",
  "tools/browser-lab-broker/package.json",
  "tools/browser-lab-broker/scripts/create-package-manifest.mjs",
  "tools/browser-lab-broker/services/browser-lab-broker.env.example",
  "tools/browser-lab-broker/services/browser-lab-broker.service",
  "tools/browser-lab-broker/src/authorization-verifier.mjs",
  "tools/browser-lab-broker/src/broker.mjs",
  "tools/browser-lab-broker/src/canonical-json.mjs",
  "tools/browser-lab-broker/src/controller-reachability.mjs",
  "tools/browser-lab-broker/src/github-client.mjs",
  "tools/browser-lab-broker/src/installation-evidence.mjs",
  "tools/browser-lab-broker/src/ledger.mjs",
  "tools/browser-lab-broker/src/protocol.mjs",
  "tools/browser-lab-broker/src/runner-authorization.mjs",
  "tools/browser-lab-broker/src/server.mjs",
  "tools/browser-lab-controller/package.json",
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
  "tools/browser-lab-controller/src/broker-client.mjs",
  "tools/browser-lab-controller/src/broker-lifecycle-store.mjs",
  "tools/browser-lab-controller/src/controller-daemon.mjs",
  "tools/browser-lab-controller/src/controller-evidence-inputs.mjs",
  "tools/browser-lab-controller/src/controller-health-service.mjs",
  "tools/browser-lab-controller/src/controller-job-files.mjs",
  "tools/browser-lab-controller/src/controller-receipt-store.mjs",
  "tools/browser-lab-controller/src/controller-service.mjs",
  "tools/browser-lab-controller/src/controller-signing.mjs",
  "tools/browser-lab-controller/src/controller.mjs",
  "tools/browser-lab-controller/src/diagnostic-retention.mjs",
  "tools/browser-lab-controller/src/host-lock.mjs",
  "tools/browser-lab-controller/src/github-actions-client.mjs",
  "tools/browser-lab-controller/src/installation-evidence.mjs",
  "tools/browser-lab-controller/src/lab-canary.mjs",
  "tools/browser-lab-controller/src/manual-session.mjs",
  "tools/browser-lab-controller/src/production-dependencies.mjs",
  "tools/browser-lab-controller/src/runner-execution.mjs",
  "tools/browser-lab-controller/src/unix-runner-execution.mjs",
  "tools/browser-lab-controller/src/windows-runner-execution.mjs",
  "tools/browser-lab-controller/src/zip-artifact.mjs",
];

export function validateLabConfigurationInventory({
  repositoryRoot,
  files = labConfigurationFiles,
}) {
  const root = resolve(repositoryRoot);
  const included = new Set(files);
  if (included.size !== files.length) {
    throw new Error("laboratory configuration file inventory contains duplicates");
  }
  for (const path of files) {
    const absolute = resolve(root, path);
    const normalized = relative(root, absolute).replaceAll("\\", "/");
    if (
      normalized !== path ||
      normalized.startsWith("../") ||
      !existsSync(absolute) ||
      !statSync(absolute).isFile()
    ) {
      throw new Error(`laboratory configuration file is invalid: ${path}`);
    }
  }

  const workflowDirectory = join(root, ".github", "workflows");
  const repositoryWorkflows = readdirSync(workflowDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
  const configuredWorkflows = files
    .filter((path) => /^\.github\/workflows\/[^/]+\.yml$/u.test(path))
    .sort();
  if (canonicalJson(repositoryWorkflows) !== canonicalJson(configuredWorkflows)) {
    throw new Error(
      "laboratory configuration does not contain the exact workflow inventory",
    );
  }

  for (const sourcePath of files.filter((path) =>
    /\.(?:js|mjs|ts)$/u.test(path),
  )) {
    const source = readFileSync(join(root, sourcePath), "utf8");
    for (const specifier of localModuleSpecifiers(source)) {
      const dependency = resolveLocalModule({ root, sourcePath, specifier });
      if (!included.has(dependency)) {
        throw new Error(
          `laboratory configuration omits local dependency: ${sourcePath} -> ${dependency}`,
        );
      }
    }
  }
}

export function computeLabConfiguration({ repositoryRoot }) {
  validateLabConfigurationInventory({ repositoryRoot });
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

export function computeEffectiveLabInfrastructure({
  configuration,
  serviceInstallations,
}) {
  const configurationDigest = configuration?.labInfrastructureDigest;
  if (
    !/^[0-9a-f]{64}$/u.test(configurationDigest ?? "") ||
    !serviceInstallations ||
    typeof serviceInstallations !== "object" ||
    Array.isArray(serviceInstallations)
  ) {
    throw new Error("effective laboratory infrastructure inputs are invalid");
  }
  const serviceInstallationDigest = sha256Hex(serviceInstallations);
  return {
    configurationDigest,
    serviceInstallationDigest,
    labInfrastructureDigest: sha256Hex({
      schemaVersion: 1,
      configurationDigest,
      serviceInstallationDigest,
    }),
  };
}

function localModuleSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of [
    /\bfrom\s*["'](\.{1,2}\/[^"']+)["']/gu,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gu,
    /^\s*import\s*["'](\.{1,2}\/[^"']+)["']/gmu,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

function resolveLocalModule({ root, sourcePath, specifier }) {
  const unresolved = resolve(dirname(join(root, sourcePath)), specifier);
  const resolved = [
    unresolved,
    `${unresolved}.mjs`,
    `${unresolved}.js`,
    `${unresolved}.json`,
    specifier.endsWith(".js") ? `${unresolved.slice(0, -3)}.ts` : null,
  ].find(
    (candidate) =>
      candidate !== null && existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (!resolved) {
    throw new Error(
      `laboratory configuration dependency cannot be resolved: ${sourcePath} -> ${specifier}`,
    );
  }
  const dependency = relative(root, resolved).replaceAll("\\", "/");
  if (dependency.startsWith("../")) {
    throw new Error(
      `laboratory configuration dependency escapes repository: ${sourcePath} -> ${specifier}`,
    );
  }
  return dependency;
}

export function computeLabReadiness({
  candidateSha,
  packageRecord,
  hostCanaries,
  manualCanary,
  selectedRuns,
  canaryPublication,
  repositoryTrust,
  matrix,
  deviceMatrix,
  httpsOriginPolicy,
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
  validateHardwareMatrix(matrix, { requireProvisioned: true });
  verifyRunnerPolicy({
    browserPolicy,
    manifest: runnerDistributionManifest,
    transientPolicy: runnerTransientPathPolicy,
    requireCanary: true,
  });
  const requiredHosts = matrix.hosts.map((host) => host.assetId).sort();
  if (
    hostCanaries.length !== requiredHosts.length ||
    new Set(hostCanaries.map((record) => record.hostId)).size !==
      requiredHosts.length ||
    selectedRuns?.hosts?.length !== requiredHosts.length ||
    new Set(selectedRuns.hosts.map((record) => record.hostId)).size !==
      requiredHosts.length ||
    new Set(selectedRuns.hosts.map((record) => record.selectedRunId)).size !==
      requiredHosts.length
  ) {
    throw new Error("selected host canaries do not form the exact closed host set");
  }
  const acceptedHosts = requiredHosts.map((hostId) => {
    const record = hostCanaries.find((candidate) => candidate.hostId === hostId);
    const selection = selectedRuns.hosts.find(
      (candidate) => candidate.hostId === hostId,
    );
    validateHostCanary(record, {
      hostId,
      candidateSha,
      packageRecord,
      matrix,
      deviceMatrix,
      httpsOriginPolicy,
      browserPolicy,
      now,
      selection,
    });
    return record;
  });
  const serviceInstallations = validateServiceInstallations({
    hostCanaries: acceptedHosts,
    requiredHosts,
    candidateSha,
    configuration,
    browserPolicy,
  });
  const effectiveInfrastructure = computeEffectiveLabInfrastructure({
    configuration,
    serviceInstallations,
  });
  validateManualCanary(manualCanary, {
    candidateSha,
    packageRecord,
    now,
    selection: selectedRuns?.manual,
  });
  const canaryPublicationEvidence = validateLabCanaryPublicationForReadiness(
    canaryPublication,
    {
      candidateSha,
      labInfrastructureDigest: effectiveInfrastructure.labInfrastructureDigest,
      manualIntakeReleaseId: manualCanary.intakeReleaseId,
      now,
    },
  );
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
    configurationDigest: effectiveInfrastructure.configurationDigest,
    labInfrastructureDigest: effectiveInfrastructure.labInfrastructureDigest,
    configurationFiles: configuration.files,
    serviceInstallations,
    serviceInstallationDigest:
      effectiveInfrastructure.serviceInstallationDigest,
    diagnosticRetentions: acceptedHosts
      .map((record) => ({
        hostId: record.hostId,
        runId: record.runId,
        receiptSha256: record.diagnosticRetention.sha256,
        filesSha256: record.diagnosticRetention.filesSha256,
      }))
      .sort((left, right) => left.hostId.localeCompare(right.hostId)),
    hostCanaryRunIds: acceptedHosts.map((record) => record.runId).sort(
      (left, right) => left - right,
    ),
    hostCanaryFreshness: acceptedHosts
      .map((record) => {
        const selection = selectedRuns.hosts.find(
          (candidate) => candidate.hostId === record.hostId,
        );
        return {
          hostId: record.hostId,
          runId: record.runId,
          inventoryCapturedAt: record.inventory.capturedAt,
          hardwareJobCompletedAt: record.hardwareJob.completedAt,
          controllerCompletedAt: record.completedAt,
          finalizerObservedAt: record.finalizer.observedAt,
          selectedRunCompletedAt: selection.completedAt,
          acceptanceWindowHours: browserPolicy.acceptanceWindowHours,
        };
      })
      .sort((left, right) => left.hostId.localeCompare(right.hostId)),
    mobileRouteReadiness: summarizeMobileRouteReadiness(
      acceptedHosts.find((record) => record.hostId === "FW-MAC-M2-01"),
    ),
    manualCanary: {
      runId: manualCanary.runId,
      intakeReleaseId: manualCanary.intakeReleaseId,
      hardwareJobId: manualCanary.hardwareJobId,
    },
    canaryReleaseId: canaryPublication.record.release.id,
    canaryPublication: canaryPublicationEvidence,
    createdAt: new Date(now).toISOString(),
  };
  return {
    manifest,
    canonical: canonicalJson(manifest),
    sha256: sha256Hex(manifest),
  };
}

export function validateServiceInstallations({
  hostCanaries,
  requiredHosts,
  candidateSha,
  configuration,
  browserPolicy,
}) {
  const controllers = requiredHosts.map((hostId) => {
    const receipt = hostCanaries.find((record) => record.hostId === hostId)
      ?.installations?.controller;
    validateServiceInstallation(receipt, {
      component: "controller",
      instanceId: hostId,
      candidateSha,
      version: configuration.versions.controller,
      browserPolicy,
      inventory:
        hostCanaries.find((record) => record.hostId === hostId).inventory,
    });
    return receipt;
  });
  const brokers = hostCanaries.map((record) => record.installations?.broker);
  for (const broker of brokers) {
    validateServiceInstallation(broker, {
      component: "broker",
      instanceId: "browser-lab-broker",
      candidateSha,
      version: configuration.versions.broker,
      browserPolicy,
    });
  }
  if (
    brokers.some(
      (broker) => canonicalJson(broker) !== canonicalJson(brokers[0]),
    )
  ) {
    throw new Error("host canaries did not observe one exact broker deployment");
  }
  return { broker: brokers[0], controllers };
}

function validateServiceInstallation(receipt, expected) {
  assertJsonSchema(receipt, serviceInstallationSchema);
  const expectedPackage =
    expected.component === "broker"
      ? "@forge3d/browser-lab-broker"
      : "@forge3d/browser-lab-controller";
  const expectedSigner =
    `milos-agathon/forge3d-web/.github/workflows/browser-lab-${expected.component}.yml`;
  const files = receipt.installed.files;
  const roles = files.map((file) => file.role);
  const identities = files.map((file) => file.identity);
  const requiredControllerHelpers = [
    "FORGE3D_BROWSER_INVENTORY_HELPER",
    "FORGE3D_CONTROLLER_RUNNER_VERIFY_HELPER",
    "FORGE3D_CONTROLLER_HOST_CLEANUP_HELPER",
    "FORGE3D_UPDATE_CONTROL_HELPER",
    "FORGE3D_DEVICE_CONTROL_HELPER",
    "FORGE3D_CLOUDFLARED_EXECUTABLE",
    "FORGE3D_CONTROLLER_GH_EXECUTABLE",
    "FORGE3D_PLAYWRIGHT_MODULE",
    "FORGE3D_GECKODRIVER_EXECUTABLE",
    "FORGE3D_APPIUM_EXECUTABLE",
    expected.inventory?.platform === "win32"
      ? "FORGE3D_CONTROLLER_WINDOWS_SESSION_BRIDGE"
      : "FORGE3D_CONTROLLER_UNIX_SESSION_BRIDGE",
  ];
  if (
    receipt.component !== expected.component ||
    receipt.instanceId !== expected.instanceId ||
    receipt.package.name !== expectedPackage ||
    receipt.package.version !== expected.version ||
    receipt.package.targetSha !== expected.candidateSha ||
    receipt.package.workflowSha !== expected.candidateSha ||
    receipt.package.protocols.broker !== expected.browserPolicy.brokerProtocolVersion ||
    receipt.attestation.signerWorkflow !== expectedSigner ||
    receipt.attestation.sourceDigest !== expected.candidateSha ||
    receipt.attestation.archiveSha256 !== receipt.package.archive.sha256 ||
    receipt.attestation.manifestSha256 !== receipt.package.manifestSha256 ||
    receipt.installed.filesSha256 !== sha256Hex(files) ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    new Set(identities).size !== identities.length ||
    canonicalJson(files) !==
      canonicalJson([...files].sort((left, right) => left.path.localeCompare(right.path))) ||
    roles.filter((role) => role === "service").length !== 1 ||
    (expected.component === "controller" &&
      (requiredControllerHelpers.some((identity) => !identities.includes(identity)) ||
        expected.inventory.browsers.some((browser) => {
          const installed = files.find(
            (file) => file.identity === `browser:${browser.id}`,
          );
          return (
            installed?.path !== browser.executable ||
            installed.version !== browser.version
          );
        }) ||
        files.find((file) => file.identity === "FORGE3D_PLAYWRIGHT_MODULE")
          ?.version !== expected.browserPolicy.tools.playwright ||
        files.find((file) => file.identity === "FORGE3D_GECKODRIVER_EXECUTABLE")
          ?.version !== expected.browserPolicy.tools.geckodriver ||
        files.find((file) => file.identity === "FORGE3D_APPIUM_EXECUTABLE")
          ?.version !== expected.browserPolicy.tools.appium)) ||
    (expected.component === "broker" && !roles.includes("configuration"))
  ) {
    throw new Error(
      `installed ${expected.component} evidence is not exact for ${expected.instanceId}`,
    );
  }
}

export function validateLabCanaryPublicationForReadiness(
  publication,
  { candidateSha, labInfrastructureDigest, manualIntakeReleaseId, now },
) {
  const record = publication?.record;
  assertJsonSchema(record, labCanaryPublicationSchema);

  const candidate = publication.candidateManifest;
  const candidateRecord = candidate?.record;
  const intakeBinding = publication.intakeBinding;
  const intakeBindingRecord = intakeBinding?.record;
  const preflight = publication.preflight;
  const preflightRecord = preflight?.record;
  const release = publication.release;
  const proof = publication.proof;
  const selection = publication.selection;
  const attestation = publication.attestation;
  const freshVerification = publication.freshVerification;
  const expectedTag =
    `browser-lab-canary-${labInfrastructureDigest}-${record.publicationRunId}`;
  const recordAssets = sortedAssets(record.assets);
  const releaseAssets = sortedAssets(release?.assets);
  const preflightAssets = sortedAssets(preflightRecord?.assets);
  const pageAssets = sortedAssets(proof?.assetPages?.pages?.flat());
  const recordProofs = sortedProofs(record.assetVerifications);
  const retainedProofs = sortedProofs(proof?.assetVerifications);
  const freshProofs = sortedProofs(freshVerification?.assetVerifications);
  const candidateAsset = recordAssets.find(
    (asset) => asset.name === "browser-lab-canary-manifest.json",
  );
  const intakeBindingAsset = recordAssets.find(
    (asset) => asset.name === "manual-intake-binding.json",
  );
  const published = new Date(record.release.publishedAt);
  const verified = new Date(record.verifiedAt);
  const deleted = new Date(record.intake.deletedAt);
  const created = new Date(record.createdAt);
  const freshlyVerified = new Date(freshVerification?.verifiedAt);
  const verificationBundle = [
    { name: "release", sha256: record.releaseVerification.outputSha256 },
    ...recordProofs.map(({ name, outputSha256 }) => ({
      name,
      sha256: outputSha256,
    })),
  ];
  if (
    record.candidateSha !== candidateSha ||
    record.labInfrastructureDigest !== labInfrastructureDigest ||
    record.tag !== expectedTag ||
    record.publicationRun?.id !== record.publicationRunId ||
    record.publicationRun.id !== selection?.run?.apiRunId ||
    record.publicationRun.attempt !== selection?.run?.runAttempt ||
    record.publicationRun.workflowPath !== selection?.run?.workflowPath ||
    !Number.isInteger(selection?.run?.selectedRunId) ||
    selection.run.selectedRunId < 1 ||
    !Number.isInteger(selection.run.apiRunId) ||
    selection.run.apiRunId < 1 ||
    !Number.isInteger(selection.run.runAttempt) ||
    selection.run.runAttempt < 1 ||
    selection?.run?.selectedRunId !== selection?.run?.apiRunId ||
    selection.run.workflowPath !==
      ".github/workflows/publish-browser-lab-canary.yml" ||
    selection.run.headSha !== candidateSha ||
    selection.run.headBranch !== "main" ||
    selection.run.conclusion !== "success" ||
    !Number.isInteger(selection?.artifact?.id) ||
    selection.artifact.id < 1 ||
    selection.artifact.name !==
      `lab-canary-publication-${selection.run.apiRunId}-${selection.run.runAttempt}` ||
    !/^[0-9a-f]{64}$/u.test(selection.artifact.archiveSha256 ?? "") ||
    selection.artifact.digest !==
      `sha256:${selection.artifact.archiveSha256}` ||
    attestation?.verified !== true ||
    attestation.repository !== "milos-agathon/forge3d-web" ||
    attestation.signerWorkflow !==
      "milos-agathon/forge3d-web/.github/workflows/publish-browser-lab-canary.yml" ||
    attestation.sourceRef !== "refs/heads/main" ||
    attestation.sourceDigest !== candidateSha ||
    attestation.denySelfHostedRunners !== true ||
    !/^[0-9a-f]{64}$/u.test(publication.recordSha256 ?? "") ||
    publication.recordSha256 !== sha256Hex(`${canonicalJson(record)}\n`) ||
    candidate?.sha256 !== record.candidateManifestSha256 ||
    candidateAsset?.sha256 !== record.candidateManifestSha256 ||
    candidateRecord?.schemaVersion !== 1 ||
    candidateRecord.recordType !== "lab-canary-publication-candidate" ||
    candidateRecord.supportClaim !== false ||
    candidateRecord.candidateSha !== candidateSha ||
    candidateRecord.labInfrastructureDigest !== labInfrastructureDigest ||
    candidateRecord.publicationRunId !== record.publicationRunId ||
    candidateRecord.tag !== expectedTag ||
    candidateRecord.manualIntakeReleaseId !== manualIntakeReleaseId ||
    candidateRecord.intakeDeletionPlannedAfterVerification !== true ||
    intakeBinding?.sha256 !== record.intake.bindingSha256 ||
    !isExactJsonDocument(intakeBinding) ||
    intakeBindingRecord?.schemaVersion !== 1 ||
    intakeBindingRecord.recordType !== "lab-canary-manual-intake-binding" ||
    intakeBindingRecord.supportClaim !== false ||
    intakeBindingRecord.candidateSha !== candidateSha ||
    intakeBindingRecord.release?.id !== manualIntakeReleaseId ||
    intakeBindingRecord.release.tagName !== record.intake.tagName ||
    intakeBindingRecord.release.targetCommitish !== candidateSha ||
    intakeBindingRecord.release.draft !== true ||
    intakeBindingRecord.release.prerelease !== false ||
    !Array.isArray(intakeBindingRecord.media) ||
    intakeBindingRecord.media.length < 1 ||
    new Set(intakeBindingRecord.media.map((asset) => asset.releaseName)).size !==
      intakeBindingRecord.media.length ||
    intakeBindingRecord.media.some((asset) => {
      const retainedAsset = recordAssets.find(
        (candidateAsset) => candidateAsset.name === asset.releaseName,
      );
      return (
        !Number.isInteger(asset.id) ||
        asset.id < 1 ||
        typeof asset.name !== "string" ||
        asset.name.length < 1 ||
        asset.releaseName !== `manual-media-${asset.id}` ||
        !Number.isInteger(asset.size) ||
        asset.size < 1 ||
        typeof asset.mimeType !== "string" ||
        asset.mimeType.length < 1 ||
        !/^[0-9a-f]{64}$/u.test(asset.sha256 ?? "") ||
        asset.apiDigest !== `sha256:${asset.sha256}` ||
        retainedAsset?.size !== asset.size ||
        retainedAsset?.sha256 !== asset.sha256 ||
        retainedAsset?.apiDigest !== asset.apiDigest
      );
    }) ||
    preflight?.sha256 !== record.preflightSha256 ||
    preflight.sha256 !== sha256Hex(canonicalJson(preflightRecord)) ||
    preflightRecord?.mode !== "laboratory-canary" ||
    preflightRecord.supportClaim !== false ||
    preflightRecord.targetSha !== candidateSha ||
    preflightRecord.tag !== expectedTag ||
    preflightRecord.run?.id !== record.publicationRunId ||
    preflightRecord.run.attempt !== record.publicationRun.attempt ||
    preflightRecord.workflow !== record.publicationRun.workflowPath ||
    preflightRecord.readiness?.status !== "LAB_CANARY_PREFLIGHT_READY" ||
    preflightRecord.readiness?.sha256 !== labInfrastructureDigest ||
    release?.id !== record.release.id ||
    release.tagName !== record.release.tagName ||
    release.targetCommitish !== record.release.targetCommitish ||
    release.draft !== record.release.draft ||
    release.prerelease !== record.release.prerelease ||
    release.immutable !== record.release.immutable ||
    release.targetCommitish !== candidateSha ||
    release.tagName !== expectedTag ||
    !sameInstant(release.publishedAt, record.release.publishedAt) ||
    record.intake.releaseId !== manualIntakeReleaseId ||
    intakeBindingAsset?.sha256 !== record.intake.bindingSha256 ||
    record.intake.deletedAfterVerification !== true ||
    record.assetApiPagination.pageCount !== proof?.assetPages?.pages?.length ||
    record.assetApiPagination.totalAssets !== recordAssets.length ||
    record.assetApiPagination.totalAssets !== pageAssets.length ||
    proof?.assetPages?.sha256 !== record.assetApiPagination.pagesSha256 ||
    proof?.releaseVerification?.outputSha256 !==
      record.releaseVerification.outputSha256 ||
    canonicalJson(proof?.releaseVerification?.output) !==
      canonicalJson(record.releaseVerification.output) ||
    !isNonEmptyJsonObject(proof?.releaseVerification?.output) ||
    !isNonEmptyJsonObject(record.releaseVerification.output) ||
    sha256Hex(verificationBundle) !== record.verificationBundleSha256 ||
    Number.isNaN(published.getTime()) ||
    Number.isNaN(verified.getTime()) ||
    Number.isNaN(deleted.getTime()) ||
    Number.isNaN(created.getTime()) ||
    published > verified ||
    verified > deleted ||
    deleted > created ||
    !hasUniqueAssetIdentity(recordAssets) ||
    !hasUniqueAssetIdentity(releaseAssets) ||
    !hasUniqueAssetIdentity(pageAssets) ||
    new Set(recordProofs.map((entry) => entry.name)).size !==
      recordProofs.length ||
    !sameAssetClosure(recordAssets, releaseAssets) ||
    !sameAssetClosure(recordAssets, preflightAssets) ||
    !sameAssetClosure(recordAssets, pageAssets) ||
    !sameProofClosure(recordProofs, retainedProofs) ||
    recordProofs.some((entry) => !isNonEmptyJsonObject(entry.output)) ||
    retainedProofs.some((entry) => !isNonEmptyJsonObject(entry.output)) ||
    !sameProofNames(recordProofs, freshProofs) ||
    freshProofs.some((entry) => !isExactVerificationProof(entry)) ||
    !isExactVerificationProof(freshVerification?.releaseVerification) ||
    Number.isNaN(freshlyVerified.getTime()) ||
    freshlyVerified < created ||
    freshlyVerified > new Date(now) ||
    new Date(now) - freshlyVerified > 30 * 60 * 1000
  ) {
    throw new Error(
      "non-support immutable laboratory canary publication is invalid",
    );
  }
  const releaseVerification = retainedVerificationProof(
    freshVerification.releaseVerification,
  );
  const verification = {
    release: releaseVerification,
    assets: recordAssets.map((asset) => {
      const assetVerification = retainedVerificationProof(
        freshProofs.find((proof) => proof.name === asset.name),
      );
      return { ...asset, verification: assetVerification };
    }),
    verifiedAt: freshlyVerified.toISOString(),
  };
  return {
    run: {
      id: selection.run.apiRunId,
      attempt: selection.run.runAttempt,
      workflowPath: selection.run.workflowPath,
    },
    artifact: {
      id: selection.artifact.id,
      name: selection.artifact.name,
      digest: selection.artifact.digest,
      archiveSha256: selection.artifact.archiveSha256,
    },
    attestation: {
      verified: true,
      repository: attestation.repository,
      signerWorkflow: attestation.signerWorkflow,
      sourceRef: attestation.sourceRef,
      sourceDigest: attestation.sourceDigest,
      denySelfHostedRunners: true,
    },
    recordSha256: publication.recordSha256,
    release: {
      id: record.release.id,
      tagName: record.release.tagName,
      targetCommitish: record.release.targetCommitish,
      immutable: true,
    },
    retainedMedia: intakeBindingRecord.media
      .map((asset) => ({
        sourceAssetId: asset.id,
        sourceName: asset.name,
        releaseName: asset.releaseName,
        size: asset.size,
        mimeType: asset.mimeType,
        sha256: asset.sha256,
        sourceApiDigest: asset.apiDigest,
      }))
      .sort((left, right) => left.releaseName.localeCompare(right.releaseName)),
    verification: {
      ...verification,
      bundleSha256: sha256Hex(verification),
    },
  };
}

export function verifyLabReadinessForPromotion({
  manifest,
  manifestBytes,
  readinessRun,
  dispatch,
  packageManifest,
  attestation,
  configuration,
}) {
  const canonicalBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  const suppliedBytes = Buffer.isBuffer(manifestBytes)
    ? manifestBytes
    : Buffer.from(manifestBytes ?? "", "utf8");
  const expectedServiceInstallationDigest = sha256Hex(
    manifest.serviceInstallations,
  );
  const expectedLabInfrastructureDigest = sha256Hex({
    schemaVersion: 1,
    configurationDigest: manifest.configurationDigest,
    serviceInstallationDigest: expectedServiceInstallationDigest,
  });
  if (
    !suppliedBytes.equals(canonicalBytes) ||
    manifest.status !== "LAB_INFRA_READY" ||
    manifest.supportClaim !== false ||
    manifest.candidateSha !== dispatch.trustedSha ||
    manifest.packageRunId !== dispatch.packageRunId ||
    manifest.packageSha256 !== packageManifest.packageSha256 ||
    configuration?.labInfrastructureDigest !== manifest.configurationDigest ||
    canonicalJson(configuration?.files) !==
      canonicalJson(manifest.configurationFiles) ||
    manifest.serviceInstallationDigest !== expectedServiceInstallationDigest ||
    manifest.labInfrastructureDigest !== expectedLabInfrastructureDigest ||
    manifest.run?.id !== readinessRun.id ||
    manifest.run?.attempt !== readinessRun.attempt ||
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
  return {
    runId: readinessRun.id,
    manifestSha256: sha256Hex(suppliedBytes),
    labInfrastructureDigest: manifest.labInfrastructureDigest,
  };
}

function validateHostCanary(record, expected) {
  validateHostInventory(record?.inventory, {
    matrix: expected.matrix,
    requireTrackpad: expected.hostId === "FW-MAC-M2-01",
  });
  const now = new Date(expected.now).getTime();
  const acceptanceWindowMs =
    expected.browserPolicy?.acceptanceWindowHours * 60 * 60 * 1000;
  const inventoryCapturedAt = Date.parse(record?.inventory?.capturedAt);
  const trackpadCapturedAt = Date.parse(record?.inventory?.trackpad?.capturedAt);
  const jobStartedAt = Date.parse(record?.hardwareJob?.startedAt);
  const jobCompletedAt = Date.parse(record?.hardwareJob?.completedAt);
  const controllerCompletedAt = Date.parse(record?.completedAt);
  const finalizerObservedAt = Date.parse(record?.finalizer?.observedAt);
  const selectedCreatedAt = Date.parse(expected.selection?.createdAt);
  const selectedCompletedAt = Date.parse(expected.selection?.completedAt);
  const checkedOrigin = expected.httpsOriginPolicy?.hosts?.find(
    (candidate) => candidate.hostAssetId === expected.hostId,
  );
  const routeBasePath = new RegExp(
    `^/runs/${record?.runId}/${record?.hardwareJob?.id}/[0-9a-f]{32}/$`,
    "u",
  );
  validateDiagnosticRetentionReceipt(record?.diagnosticRetention, {
    authorizationDigest: record?.authorization?.sha256,
    hostId: expected.hostId,
    run: { id: record?.runId, attempt: record?.runAttempt },
    runnerNonce: record?.diagnosticRetention?.runnerNonce,
  });
  if (
    !Number.isInteger(expected.selection?.selectedRunId) ||
    !Number.isInteger(expected.selection?.apiRunId) ||
    !Number.isInteger(expected.selection?.runAttempt) ||
    expected.selection?.hostId !== expected.hostId ||
    expected.selection.selectedRunId !== expected.selection.apiRunId ||
    expected.selection.apiRunId !== record?.runId ||
    expected.selection.runAttempt !== record?.runAttempt ||
    expected.selection.workflowPath !== ".github/workflows/browser-hardware.yml" ||
    expected.selection.status !== "completed" ||
    expected.selection.conclusion !== "success" ||
    expected.selection.headSha !== expected.candidateSha ||
    expected.selection.headBranch !== "main" ||
    expected.selection.event !== "workflow_dispatch" ||
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
    record.runner.name !==
      `${expected.hostId}-${record.diagnosticRetention.runnerNonce}` ||
    record.cleanup?.complete !== true ||
    record.controllerCompletion?.state !== "completed" ||
    record.completedAt !== record.controllerCompletion.completedAt ||
    record.controllerCompletion.hostLockReleased !== true ||
    record.controllerCompletion.quarantined !== false ||
    record.inventory?.assetId !== expected.hostId ||
    record.route?.httpsVerified !== true ||
    record.route?.corsRangeControlsPassed !== true ||
    record.route?.applicationHost !== checkedOrigin?.applicationHost ||
    record.route?.assetHost !== checkedOrigin?.assetHost ||
    !routeBasePath.test(record.route?.basePath ?? "") ||
    record.route?.applicationUrl !==
      `https://${checkedOrigin?.applicationHost}${record.route?.basePath}` ||
    record.route?.assetUrl !==
      `https://${checkedOrigin?.assetHost}${record.route?.basePath}` ||
    record.route?.packageSha256 !== record.packageSha256 ||
    record.route?.certificates?.application?.authorized !== true ||
    record.route?.certificates?.application?.authorizationError !== null ||
    record.route?.certificates?.asset?.authorized !== true ||
    record.route?.certificates?.asset?.authorizationError !== null ||
    !completeRouteReadiness(record.browserRouteReadiness) ||
    record.attestation?.verified !== true ||
    record.finalizer?.run?.id !== record.runId ||
    record.finalizer?.run?.attempt !== record.runAttempt ||
    record.hardwareJob?.id !== expected.selection.hardwareJobId ||
    !Number.isFinite(now) ||
    !Number.isFinite(acceptanceWindowMs) ||
    acceptanceWindowMs <= 0 ||
    !isFreshWithinAcceptanceWindow(inventoryCapturedAt, now, acceptanceWindowMs) ||
    !isFreshWithinAcceptanceWindow(jobCompletedAt, now, acceptanceWindowMs) ||
    !isFreshWithinAcceptanceWindow(controllerCompletedAt, now, acceptanceWindowMs) ||
    !isFreshWithinAcceptanceWindow(finalizerObservedAt, now, acceptanceWindowMs) ||
    !isFreshWithinAcceptanceWindow(selectedCompletedAt, now, acceptanceWindowMs) ||
    !Number.isFinite(jobStartedAt) ||
    !Number.isFinite(selectedCreatedAt) ||
    selectedCreatedAt > jobStartedAt ||
    jobStartedAt > inventoryCapturedAt ||
    inventoryCapturedAt > jobCompletedAt ||
    jobCompletedAt > controllerCompletedAt ||
    controllerCompletedAt > finalizerObservedAt ||
    finalizerObservedAt > selectedCompletedAt ||
    (expected.hostId === "FW-MAC-M2-01" &&
      (!isFreshWithinAcceptanceWindow(trackpadCapturedAt, now, acceptanceWindowMs) ||
        !validateMobileRouteReadiness(record, expected, {
          now,
          acceptanceWindowMs,
          jobStartedAt,
          jobCompletedAt,
        }))) ||
    (expected.hostId !== "FW-MAC-M2-01" &&
      record.mobileRouteReadiness !== null)
  ) {
    throw new Error(`host infrastructure canary is invalid: ${expected.hostId}`);
  }
}

export function isFreshWithinAcceptanceWindow(
  value,
  now,
  acceptanceWindowMs,
) {
  return (
    Number.isFinite(value) &&
    value <= now &&
    now - value <= acceptanceWindowMs
  );
}

function validateMobileRouteReadiness(record, expected, window) {
  const evidence = record.mobileRouteReadiness;
  const host = expected.matrix.hosts.find(
    (candidate) => candidate.assetId === expected.hostId,
  );
  const assets = expected.matrix.assets
    .filter(
      (asset) =>
        asset.hostAssetId === expected.hostId && asset.appiumId !== null,
    )
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const devices = [...(expected.deviceMatrix?.devices ?? [])].sort(
    (left, right) => left.assetId.localeCompare(right.assetId),
  );
  const probes = [...(evidence?.probes ?? [])].sort((left, right) =>
    left.assetId.localeCompare(right.assetId),
  );
  const startedAt = Date.parse(evidence?.startedAt);
  const completedAt = Date.parse(evidence?.completedAt);
  const checkedOrigin = expected.httpsOriginPolicy?.hosts?.find(
    (candidate) => candidate.hostAssetId === expected.hostId,
  );
  if (
    expected.deviceMatrix?.hostAssetId !== expected.hostId ||
    evidence?.schemaVersion !== 1 ||
    evidence.recordType !== "mobile-device-route-readiness" ||
    evidence.supportClaim !== false ||
    evidence.hostId !== expected.hostId ||
    evidence.binding?.runId !== record.runId ||
    evidence.binding?.jobId !== record.hardwareJob.id ||
    evidence.binding?.assetId !== record.assetId ||
    evidence.binding?.commit !== record.trustedSha ||
    evidence.binding?.packageSha256 !== record.packageSha256 ||
    evidence.route?.expectedPackageSha256 !== record.packageSha256 ||
    !new RegExp(
      `^/runs/${record.runId}/${record.hardwareJob.id}/[0-9a-f]{32}/$`,
      "u",
    ).test(evidence.route?.basePath ?? "") ||
    evidence.route?.applicationUrl !==
      `https://${evidence.route?.applicationHost}${evidence.route?.basePath}` ||
    evidence.route?.assetUrl !==
      `https://${evidence.route?.assetHost}${evidence.route?.basePath}` ||
    evidence.route?.applicationHost === evidence.route?.assetHost ||
    evidence.route?.applicationHost !== checkedOrigin?.applicationHost ||
    evidence.route?.assetHost !== checkedOrigin?.assetHost ||
    !isFreshWithinAcceptanceWindow(
      completedAt,
      window.now,
      window.acceptanceWindowMs,
    ) ||
    startedAt < window.jobStartedAt ||
    startedAt > completedAt ||
    completedAt > window.jobCompletedAt ||
    assets.length !== 6 ||
    devices.length !== assets.length ||
    probes.length !== assets.length ||
    new Set(probes.map((probe) => probe.assetId)).size !== probes.length ||
    new Set(probes.map((probe) => probe.appiumId)).size !== probes.length
  ) {
    return false;
  }
  return probes.every((probe, index) => {
    const asset = assets[index];
    const device = devices[index];
    const observedAt = Date.parse(probe.observedAt);
    const expectedDriverVersion =
      device.automationName === "XCUITest"
        ? expected.deviceMatrix.appium.drivers.xcuitest
        : expected.deviceMatrix.appium.drivers.uiautomator2;
    return (
      host.attachedAssetIds.includes(asset.assetId) &&
      device.assetId === asset.assetId &&
      device.appiumId === asset.appiumId &&
      probe.hostId === expected.hostId &&
      probe.assetId === device.assetId &&
      probe.appiumId === device.appiumId &&
      probe.platformName === device.platformName &&
      probe.automationName === device.automationName &&
      probe.browserName === device.browserName &&
      probe.appiumVersion === expected.deviceMatrix.appium.version &&
      probe.driverVersion === expectedDriverVersion &&
      typeof probe.browserVersion === "string" &&
      probe.browserVersion.length > 0 &&
      probe.browserVersion.toLowerCase() !== "unknown" &&
      typeof probe.platformVersion === "string" &&
      probe.platformVersion.length > 0 &&
      probe.connected === true &&
      probe.unlocked === true &&
      probe.trusted === true &&
      probe.acceptInsecureCerts === false &&
      probe.routeUrl === evidence.route.applicationUrl &&
      completeRouteReadiness(probe.routeReadiness) &&
      observedAt >= startedAt &&
      observedAt <= completedAt
    );
  });
}

function completeRouteReadiness(readiness) {
  return (
    readiness?.secureContext === true &&
    readiness.trustedHttps === true &&
    readiness.applicationCertificateTrusted === true &&
    readiness.assetCertificateTrusted === true &&
    readiness.packageSha256Matched === true &&
    readiness.wasmMimePassed === true &&
    readiness.corsAllowPassed === true &&
    readiness.corsDenyPassed === true &&
    readiness.rangePassed === true &&
    readiness.wrongMimeRejected === true &&
    readiness.publicLoaderAllowedWasmPassed === true &&
    readiness.wrongMimeErrorCode === "WASM_LOAD_FAILED" &&
    readiness.corsDenyWasmErrorCode === "WASM_LOAD_FAILED" &&
    readiness.corsWrongOriginWasmErrorCode === "WASM_LOAD_FAILED"
  );
}

function summarizeMobileRouteReadiness(record) {
  const evidence = record.mobileRouteReadiness;
  return {
    hostId: record.hostId,
    hostCanaryRunId: record.runId,
    evidenceSha256: sha256Hex(evidence),
    completedAt: evidence.completedAt,
    applicationUrl: evidence.route.applicationUrl,
    assetUrl: evidence.route.assetUrl,
    basePath: evidence.route.basePath,
    packageSha256: evidence.binding.packageSha256,
    devices: evidence.probes
      .map(({ assetId, appiumId, observedAt }) => ({
        assetId,
        appiumId,
        observedAt,
      }))
      .sort((left, right) => left.assetId.localeCompare(right.assetId)),
  };
}

function validateManualCanary(record, expected) {
  if (
    !Number.isInteger(expected.selection?.selectedRunId) ||
    !Number.isInteger(expected.selection?.apiRunId) ||
    !Number.isInteger(expected.selection?.runAttempt) ||
    !Number.isInteger(expected.selection?.hardwareJobId) ||
    !Number.isInteger(expected.selection?.intakeReleaseId) ||
    expected.selection?.selectedRunId !== expected.selection.apiRunId ||
    expected.selection.apiRunId !== record?.runId ||
    expected.selection.runAttempt !== record?.runAttempt ||
    expected.selection.workflowPath !==
      ".github/workflows/submit-browser-manual-evidence.yml" ||
    expected.selection.hardwareJobId !== record?.hardwareJobId ||
    expected.selection.intakeReleaseId !== record?.intakeReleaseId ||
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
    record.session?.controllerCompletionState !== "completed" ||
    record.session?.hostLockReleased !== true ||
    record.session?.quarantined !== false ||
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

function hasUniqueAssetIdentity(assets) {
  return (
    new Set(assets.map((asset) => asset.name)).size === assets.length &&
    new Set(assets.map((asset) => asset.id)).size === assets.length
  );
}

function sortedAssets(assets) {
  return Array.isArray(assets)
    ? [...assets].sort((left, right) =>
        String(left?.name).localeCompare(String(right?.name)),
      )
    : [];
}

function sameAssetClosure(expected, actual) {
  if (expected.length !== actual.length) return false;
  return expected.every((asset, index) => {
    const candidate = actual[index];
    const candidateDigest = candidate?.apiDigest ?? candidate?.digest;
    const candidateSha256 =
      candidate?.sha256 ?? candidateDigest?.replace(/^sha256:/u, "");
    return (
      candidate?.name === asset.name &&
      candidateSha256 === asset.sha256 &&
      (candidate.id === undefined || candidate.id === asset.id) &&
      (candidate.size === undefined || candidate.size === asset.size) &&
      (candidateDigest === undefined || candidateDigest === asset.apiDigest)
    );
  });
}

function sortedProofs(proofs) {
  return Array.isArray(proofs)
    ? [...proofs].sort((left, right) =>
        String(left?.name).localeCompare(String(right?.name)),
      )
    : [];
}

function sameProofClosure(expected, actual) {
  if (expected.length !== actual.length) return false;
  return expected.every(
    (proof, index) =>
      actual[index]?.name === proof.name &&
      actual[index].outputSha256 === proof.outputSha256 &&
      canonicalJson(actual[index].output) === canonicalJson(proof.output),
  );
}

function sameProofNames(expected, actual) {
  return (
    expected.length === actual.length &&
    expected.every((proof, index) => actual[index]?.name === proof.name)
  );
}

function isNonEmptyJsonObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

function isExactVerificationProof(proof) {
  const bytes = exactBase64Bytes(proof?.outputBytesBase64);
  if (
    bytes === null ||
    bytes.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(proof.outputSha256 ?? "") ||
    sha256Hex(bytes) !== proof.outputSha256 ||
    !isNonEmptyJsonObject(proof.output)
  ) {
    return false;
  }
  try {
    return (
      canonicalJson(JSON.parse(bytes.toString("utf8"))) ===
      canonicalJson(proof.output)
    );
  } catch {
    return false;
  }
}

function isExactJsonDocument(document) {
  const bytes = exactBase64Bytes(document?.bytesBase64);
  if (
    bytes === null ||
    bytes.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(document?.sha256 ?? "") ||
    sha256Hex(bytes) !== document.sha256 ||
    !isNonEmptyJsonObject(document.record)
  ) {
    return false;
  }
  try {
    return (
      canonicalJson(JSON.parse(bytes.toString("utf8"))) ===
      canonicalJson(document.record)
    );
  } catch {
    return false;
  }
}

function exactBase64Bytes(value) {
  if (typeof value !== "string" || value.length < 4) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function retainedVerificationProof(proof) {
  const { name: _name, ...retained } = proof;
  return retained;
}

function sameInstant(left, right) {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return !Number.isNaN(leftTime) && leftTime === rightTime;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const repositoryRoot = resolve(process.argv[4] ?? "../../..");
  input.configuration = computeLabConfiguration({ repositoryRoot });
  const output = computeLabReadiness(input);
  assertJsonSchema(output.manifest, browserLabInfrastructureReadinessSchema);
  writeFileSync(process.argv[3], `${output.canonical}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, sha256: output.sha256 }));
}
