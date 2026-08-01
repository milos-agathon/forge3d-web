import { sha256Hex } from "../../scripts/canonical-json.mjs";

export function serviceInstallationFixture({
  component,
  instanceId,
  targetSha = "a".repeat(40),
  inventory = null,
  browserPolicy = null,
}) {
  const packageName = `@forge3d/browser-lab-${component}`;
  const files = [
    installedFile({
      role: "service",
      identity: "service",
      path: `/opt/forge3d/browser-lab-${component}/src/${component === "broker" ? "server" : "controller-service"}.mjs`,
      packagePath: `src/${component === "broker" ? "server" : "controller-service"}.mjs`,
    }),
    installedFile({
      role: "configuration",
      identity: "config:crates/forge3d-web/tests/infrastructure/browser-policy.json",
      path: `/etc/forge3d/${component}-browser-policy.json`,
      packagePath: "crates/forge3d-web/tests/infrastructure/browser-policy.json",
    }),
  ];
  if (component === "controller") {
    files.push(
      installedFile({
        role: "configuration",
        identity:
          "config:crates/forge3d-web/tests/infrastructure/controller-helper-digest-policy.json",
        path: "/etc/forge3d/controller-helper-digest-policy.json",
        packagePath:
          "crates/forge3d-web/tests/infrastructure/controller-helper-digest-policy.json",
      }),
    );
    const helperVersions = new Map([
      ["FORGE3D_PLAYWRIGHT_MODULE", browserPolicy?.tools?.playwright ?? "1.56.1"],
      ["FORGE3D_GECKODRIVER_EXECUTABLE", browserPolicy?.tools?.geckodriver ?? "0.36.0"],
      ["FORGE3D_APPIUM_EXECUTABLE", browserPolicy?.tools?.appium ?? "3.0.2"],
    ]);
    for (const identity of [
      "FORGE3D_BROWSER_INVENTORY_HELPER",
      "FORGE3D_CONTROLLER_RUNNER_VERIFY_HELPER",
      "FORGE3D_CONTROLLER_HOST_CLEANUP_HELPER",
      "FORGE3D_UPDATE_CONTROL_HELPER",
      "FORGE3D_DEVICE_CONTROL_HELPER",
      "FORGE3D_CLOUDFLARED_EXECUTABLE",
      "FORGE3D_CONTROLLER_GH_EXECUTABLE",
      "FORGE3D_CONTROLLER_SIGNING_PROVIDER",
      "FORGE3D_PLAYWRIGHT_MODULE",
      "FORGE3D_GECKODRIVER_EXECUTABLE",
      "FORGE3D_APPIUM_EXECUTABLE",
      inventory?.platform === "win32"
        ? "FORGE3D_CONTROLLER_WINDOWS_SESSION_BRIDGE"
        : "FORGE3D_CONTROLLER_UNIX_SESSION_BRIDGE",
    ]) {
      files.push(
        installedFile({
          role: "helper",
          identity,
          path: `/opt/forge3d/helpers/${identity.toLowerCase()}`,
          packagePath:
            identity === "FORGE3D_CONTROLLER_UNIX_SESSION_BRIDGE"
              ? "services/unix-interactive-session-bridge.mjs"
              : identity === "FORGE3D_CONTROLLER_WINDOWS_SESSION_BRIDGE"
                ? "services/windows-interactive-session-bridge.ps1"
                : null,
          version: helperVersions.get(identity) ?? null,
        }),
      );
    }
    for (const browser of inventory?.browsers ?? []) {
      files.push(
        installedFile({
          role: "helper",
          identity: `browser:${browser.id}`,
          path: browser.executable,
          packagePath: null,
          version: browser.version,
        }),
      );
    }
    if (inventory?.tools?.safaridriverPath) {
      files.push(
        installedFile({
          role: "helper",
          identity: "driver:safaridriver",
          path: inventory.tools.safaridriverPath,
          packagePath: null,
          version: inventory.tools.safaridriverVersion,
        }),
      );
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const archive = {
    name: `browser-lab-${component}-1.0.0.tar.gz`,
    sha256: sha256Hex(`${component}-archive`),
  };
  const manifestSha256 = sha256Hex(`${component}-manifest`);
  return {
    schemaVersion: 1,
    recordType: "lab-service-installation",
    component,
    instanceId,
    repository: "milos-agathon/forge3d-web",
    package: {
      name: packageName,
      version: "1.0.0",
      targetSha,
      workflowSha: targetSha,
      archive,
      manifestSha256,
      configurationSha256: sha256Hex(`${component}-configuration`),
      protocols: {
        controller: "forge3d-browser-lab-controller/v1",
        broker: "forge3d-browser-lab-broker/v1",
        cleanup: "forge3d-browser-lab-cleanup/v1",
      },
    },
    attestation: {
      verified: true,
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        `milos-agathon/forge3d-web/.github/workflows/browser-lab-${component}.yml`,
      sourceRef: "refs/heads/main",
      sourceDigest: targetSha,
      denySelfHostedRunners: true,
      archiveSha256: archive.sha256,
      manifestSha256,
    },
    installed: {
      root: `/opt/forge3d/browser-lab-${component}`,
      files,
      filesSha256: sha256Hex(files),
    },
    verifiedAt: "2026-07-29T09:00:00.000Z",
  };
}

function installedFile({
  role,
  identity,
  path,
  packagePath,
  version = null,
}) {
  return {
    role,
    identity,
    path,
    packagePath,
    version,
    sha256: sha256Hex(`${identity}:${path}`),
  };
}

export function checkedHostRouteFixture({
  originPolicy,
  hostId,
  runId,
  jobId,
  packageSha256,
}) {
  const checked = originPolicy.hosts.find(
    (origin) => origin.hostAssetId === hostId,
  );
  const basePath = `/runs/${runId}/${jobId}/${"d".repeat(32)}/`;
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
    packageSha256,
    certificates: { application: certificate, asset: certificate },
    httpsVerified: true,
    corsRangeControlsPassed: true,
  };
}

export function completeRouteReadinessFixture() {
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

export function diagnosticRetentionFixture({
  authorizationDigest = "b".repeat(64),
  hostId = "FW-LNX-NV-01",
  run = { id: 10, attempt: 1 },
  runnerNonce = "c".repeat(32),
  retainedAt = "2026-07-29T10:00:00.000Z",
} = {}) {
  const files = [
    {
      name: "Runner_20260729-100000.log",
      size: 12,
      sha256: sha256Hex("runner-diagnostic"),
    },
    {
      name: "Worker_20260729-100001.log",
      size: 12,
      sha256: sha256Hex("worker-diagnostic"),
    },
  ];
  const record = {
    schemaVersion: 1,
    storage: "protected-controller-external",
    storageKey:
      `${hostId}-${run.id}-${run.attempt}-${authorizationDigest}`,
    hostId,
    run,
    runnerNonce,
    authorizationDigest,
    files,
    filesSha256: sha256Hex(files),
    retainedAt,
  };
  return { ...record, sha256: sha256Hex(record) };
}
