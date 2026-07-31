import { signControllerRecord } from "./controller-signing.mjs";
import { assertCompleteHostInventory } from "./controller-evidence-inputs.mjs";
import { validateDiagnosticRetentionReceipt } from "./diagnostic-retention.mjs";

export function createHostLabCanary({
  authorization,
  browserEvidence,
  adapterAttestation,
  inventory,
  route,
  originPolicy,
  mobileRouteReadiness = null,
  deviceMatrix = null,
  execution,
  installations,
  diagnosticRetention,
  controllerCompletion,
  privateKey,
  signingKeyId,
}) {
  assertCompleteHostInventory(inventory, { authorization });
  validateDiagnosticRetentionReceipt(diagnosticRetention, {
    authorizationDigest: authorization.sha256,
    hostId: authorization.hostId,
    run: authorization.run,
    runnerNonce: authorization.runnerNonce,
  });
  if (
    authorization.lane !== "infrastructure-canary" ||
    authorization.manualSession !== null ||
    browserEvidence.result !== "PASS" ||
    browserEvidence.assertions?.supportAssertionsExecuted !== false ||
    browserEvidence.adapter?.isFallbackAdapter !== false ||
    browserEvidence.adapter?.deviceCreated !== true ||
    browserEvidence.adapter?.surfacePresented !== true ||
    !completeRouteReadiness(browserEvidence.routeReadiness) ||
    adapterAttestation?.result !== "PASS" ||
    adapterAttestation.required !== true ||
    adapterAttestation.binding?.runId !== authorization.run.id ||
    adapterAttestation.binding?.assetId !== authorization.assetId ||
    adapterAttestation.binding?.commit !== authorization.trustedSha ||
    adapterAttestation.binding?.packageSha256 !== browserEvidence.packageSha256 ||
    adapterAttestation.host?.hostId !== authorization.hostId ||
    adapterAttestation.host?.expectedGpuPresent !== true ||
    adapterAttestation.host?.headedSessionAvailable !== true ||
    execution.acceptedJobCount !== 1 ||
    execution.cleanupComplete !== true ||
    controllerCompletion?.state !== "completed" ||
    controllerCompletion.hostLockReleased !== true ||
    controllerCompletion.quarantined !== false ||
    installations?.controller?.component !== "controller" ||
    installations.controller.instanceId !== authorization.hostId ||
    installations?.broker?.component !== "broker" ||
    !validHostRoute(route, originPolicy, authorization, browserEvidence.packageSha256) ||
    !sameBrowserRoute(browserEvidence.route, route, browserEvidence.packageSha256) ||
    inventory.assetId !== authorization.hostId ||
    !Number.isFinite(Date.parse(controllerCompletion.completedAt)) ||
    Date.parse(inventory.capturedAt) >
      Date.parse(controllerCompletion.completedAt) ||
    (authorization.hostId === "FW-MAC-M2-01"
      ? !validMobileRouteReadiness(
          mobileRouteReadiness,
          authorization,
          inventory,
          deviceMatrix,
          route,
          browserEvidence.packageSha256,
          controllerCompletion.completedAt,
        )
      : mobileRouteReadiness !== null || deviceMatrix !== null)
  ) {
    throw new Error("host laboratory canary observations are incomplete");
  }
  return signControllerRecord({
    record: {
      schemaVersion: 1,
      recordType: "host-lab-canary",
      runId: authorization.run.id,
      runAttempt: authorization.run.attempt,
      lane: authorization.lane,
      canaryMode: "host",
      hostId: authorization.hostId,
      assetId: authorization.assetId,
      trustedSha: authorization.trustedSha,
      packageRunId: authorization.packageRunId,
      packageSha256: browserEvidence.packageSha256,
      result: "PASS",
      supportAssertionsExecuted: false,
      adapter: browserEvidence.adapter,
      adapterAttestation,
      authorization: {
        sha256: authorization.sha256,
        attested: true,
      },
      controller: { signatureVerified: true },
      runner: {
        id: execution.runnerId,
        name: execution.runnerName,
        acceptedJobCount: 1,
        absentAfterRun: execution.runnerAbsent === true,
      },
      cleanup: { complete: true },
      diagnosticRetention,
      controllerCompletion,
      installations,
      inventory,
      route,
      browserRouteReadiness: browserEvidence.routeReadiness,
      mobileRouteReadiness,
      completedAt: new Date(controllerCompletion.completedAt).toISOString(),
      attestation: { verified: false },
    },
    privateKey,
    signingKeyId,
  });
}

function validMobileRouteReadiness(
  evidence,
  authorization,
  inventory,
  deviceMatrix,
  hostRoute,
  packageSha256,
  controllerCompletedAt,
) {
  const inventoryDevices = inventory.attachedAssets
    .filter((asset) => asset.appiumId !== null)
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const expected = [...(deviceMatrix?.devices ?? [])].sort((left, right) =>
    left.assetId.localeCompare(right.assetId),
  );
  const probes = [...(evidence?.probes ?? [])].sort((left, right) =>
    left.assetId.localeCompare(right.assetId),
  );
  return (
    evidence?.schemaVersion === 1 &&
    evidence.recordType === "mobile-device-route-readiness" &&
    evidence.supportClaim === false &&
    evidence.hostId === authorization.hostId &&
    evidence.binding?.runId === authorization.run.id &&
    evidence.binding?.jobId === authorization.queuedHardwareJob.id &&
    evidence.binding?.assetId === authorization.assetId &&
    evidence.binding?.commit === authorization.trustedSha &&
    evidence.binding?.packageSha256 === packageSha256 &&
    evidence.route?.expectedPackageSha256 === packageSha256 &&
    deviceMatrix?.hostAssetId === authorization.hostId &&
    evidence.route?.applicationHost === hostRoute.applicationHost &&
    evidence.route?.assetHost === hostRoute.assetHost &&
    evidence.route?.basePath === hostRoute.basePath &&
    evidence.route?.applicationUrl === hostRoute.applicationUrl &&
    evidence.route?.assetUrl === hostRoute.assetUrl &&
    new RegExp(
      `^/runs/${authorization.run.id}/${authorization.queuedHardwareJob.id}/[0-9a-f]{32}/$`,
      "u",
    ).test(evidence.route?.basePath ?? "") &&
    evidence.route?.applicationUrl ===
      `https://${evidence.route?.applicationHost}${evidence.route?.basePath}` &&
    evidence.route?.assetUrl ===
      `https://${evidence.route?.assetHost}${evidence.route?.basePath}` &&
    evidence.route?.applicationHost !== evidence.route?.assetHost &&
    inventoryDevices.length === 6 &&
    expected.length === inventoryDevices.length &&
    probes.length === expected.length &&
    new Set(probes.map((probe) => probe.assetId)).size === probes.length &&
    new Set(probes.map((probe) => probe.appiumId)).size === probes.length &&
    probes.every(
      (probe, index) =>
        probe.assetId === expected[index].assetId &&
        probe.appiumId === expected[index].appiumId &&
        inventoryDevices[index].assetId === expected[index].assetId &&
        inventoryDevices[index].appiumId === expected[index].appiumId &&
        probe.platformName === expected[index].platformName &&
        probe.automationName === expected[index].automationName &&
        probe.browserName === expected[index].browserName &&
        probe.appiumVersion === deviceMatrix.appium.version &&
        probe.driverVersion ===
          deviceMatrix.appium.drivers[
            expected[index].automationName === "XCUITest"
              ? "xcuitest"
              : "uiautomator2"
          ] &&
        probe.hostId === authorization.hostId &&
        probe.routeUrl === evidence.route.applicationUrl &&
        probe.connected === true &&
        probe.unlocked === true &&
        probe.trusted === true &&
        probe.acceptInsecureCerts === false &&
        typeof probe.browserVersion === "string" &&
        probe.browserVersion.length > 0 &&
        probe.browserVersion.toLowerCase() !== "unknown" &&
        typeof probe.platformVersion === "string" &&
        probe.platformVersion.length > 0 &&
        completeRouteReadiness(probe.routeReadiness) &&
        Number.isFinite(Date.parse(probe.observedAt)),
    ) &&
    Number.isFinite(Date.parse(evidence.startedAt)) &&
    Number.isFinite(Date.parse(evidence.completedAt)) &&
    Date.parse(evidence.startedAt) <= Date.parse(evidence.completedAt) &&
    Date.parse(evidence.completedAt) <= Date.parse(controllerCompletedAt) &&
    probes.every(
      (probe) =>
        Date.parse(probe.observedAt) >= Date.parse(evidence.startedAt) &&
        Date.parse(probe.observedAt) <= Date.parse(evidence.completedAt),
    )
  );
}

function validHostRoute(route, originPolicy, authorization, packageSha256) {
  const checked = originPolicy?.hosts?.find(
    (candidate) => candidate.hostAssetId === authorization.hostId,
  );
  const expectedBasePath = new RegExp(
    `^/runs/${authorization.run.id}/${authorization.queuedHardwareJob.id}/[0-9a-f]{32}/$`,
    "u",
  );
  return (
    originPolicy?.schemaVersion === 1 &&
    checked?.applicationHost === route?.applicationHost &&
    checked?.assetHost === route?.assetHost &&
    expectedBasePath.test(route?.basePath ?? "") &&
    route.applicationUrl ===
      `https://${checked.applicationHost}${route.basePath}` &&
    route.assetUrl === `https://${checked.assetHost}${route.basePath}` &&
    route.packageSha256 === packageSha256 &&
    route.httpsVerified === true &&
    route.corsRangeControlsPassed === true &&
    route.certificates?.application?.authorized === true &&
    route.certificates.application.authorizationError === null &&
    route.certificates?.asset?.authorized === true &&
    route.certificates.asset.authorizationError === null
  );
}

function sameBrowserRoute(browserRoute, controllerRoute, packageSha256) {
  return (
    browserRoute?.applicationHost === controllerRoute.applicationHost &&
    browserRoute?.assetHost === controllerRoute.assetHost &&
    browserRoute?.basePath === controllerRoute.basePath &&
    browserRoute?.applicationUrl === controllerRoute.applicationUrl &&
    browserRoute?.assetUrl === controllerRoute.assetUrl &&
    browserRoute?.expectedPackageSha256 === packageSha256
  );
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
