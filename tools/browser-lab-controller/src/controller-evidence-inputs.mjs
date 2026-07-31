import { readUniqueJson } from "./controller-job-files.mjs";

export function readHostCanaryInput({ jobRoot, authorization }) {
  const evidence = readUniqueJson(
    jobRoot.jobDirectory,
    "browser-hardware-evidence.json",
  );
  const adapterAttestation = readUniqueJson(
    jobRoot.jobDirectory,
    "adapter-attestation.json",
  );
  const inventory = readUniqueJson(
    jobRoot.jobDirectory,
    "host-inventory.json",
  );
  const route = readUniqueJson(jobRoot.jobDirectory, "route-probe.json");
  const originPolicy = readUniqueJson(
    jobRoot.jobDirectory,
    "https-origin-policy.json",
  );
  const mobileRouteReadiness =
    authorization.hostId === "FW-MAC-M2-01"
      ? readUniqueJson(
          jobRoot.jobDirectory,
          "mobile-device-route-readiness.json",
        )
      : null;
  const deviceMatrix =
    authorization.hostId === "FW-MAC-M2-01"
      ? readUniqueJson(jobRoot.jobDirectory, "device-matrix.json")
      : null;
  assertCompleteHostInventory(inventory, { authorization });
  return {
    browserEvidence: evidence,
    adapterAttestation,
    inventory,
    route: {
      ...route,
      applicationUrl: `https://${route.applicationHost}${route.basePath}`,
      assetUrl: `https://${route.assetHost}${route.basePath}`,
      httpsVerified: route.ok === true,
      corsRangeControlsPassed: route.ok === true,
    },
    originPolicy,
    mobileRouteReadiness,
    deviceMatrix,
    execution: {},
  };
}

export function readManualSessionInput({ jobRoot, authorization }) {
  const session = readUniqueJson(
    jobRoot.jobDirectory,
    "manual-session-input.json",
  );
  const inventory = readUniqueJson(jobRoot.jobDirectory, "host-inventory.json");
  const cleanup = readUniqueJson(
    jobRoot.jobDirectory,
    "browser-hardware-cleanup.json",
  );
  const manifest = readUniqueJson(
    jobRoot.jobDirectory,
    "browser-package-manifest.json",
  );
  const harness = manifest.files?.find(
    (entry) => entry.name === "consumer-fixture.tar.gz",
  );
  const requireTrackpadInventory = requiresTrackpadInventory(authorization);
  if (requireTrackpadInventory) {
    assertCompleteHostInventory(inventory, { authorization });
  }
  if (
    session.binding?.runId !== authorization.run.id ||
    session.binding?.jobId !== authorization.queuedHardwareJob.id ||
    session.binding?.assetId !== authorization.assetId ||
    session.binding?.commit !== authorization.trustedSha ||
    session.binding?.packageSha256 !== manifest.packageSha256 ||
    session.watermark?.visible !== true ||
    session.watermark.mediaChallenge !==
      authorization.manualSession.mediaChallenge ||
    inventory.assetId !== authorization.hostId ||
    inventory.session?.interactive !== true ||
    inventory.session.locked !== false ||
    inventory.session.remote !== false ||
    !/^[0-9a-f]{64}$/u.test(harness?.sha256 ?? "")
  ) {
    throw new Error("manual session input does not match authorization");
  }
  return {
    system: {
      os: inventory.platform,
      build: inventory.osBuild,
    },
    loginSession: {
      interactive: inventory.session.interactive,
      locked: inventory.session.locked,
      remote: inventory.session.remote,
    },
    browser: session.browser,
    driver: session.driver,
    origins: {
      application: new URL(session.route.applicationUrl).origin,
      asset: new URL(session.route.assetUrl).origin,
    },
    routeBasePath: session.route.basePath,
    packageRecord: {
      runId: authorization.packageRunId,
      sha256: manifest.packageSha256,
      harnessSha256: harness.sha256,
    },
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    cleanup: {
      browserStopped: cleanup.browserDriversStopped === true,
      driverStopped: cleanup.browserDriversStopped === true,
      fixtureStopped: cleanup.fixturesStopped === true,
      tunnelStopped: cleanup.tunnelsStopped === true,
      updatesRestored: cleanup.updatesRestored === true,
    },
    ...(requireTrackpadInventory ? { hostInventory: inventory } : {}),
  };
}

export function assertCompleteHostInventory(inventory, { authorization }) {
  const ids = inventory?.attachedAssetIds;
  const attachments = inventory?.attachedAssets;
  if (
    inventory?.assetId !== authorization.hostId ||
    !nonEmpty(inventory.model) ||
    !nonEmpty(inventory.cpu) ||
    !nonEmpty(inventory.gpu) ||
    !Number.isInteger(inventory.ramGiB) ||
    inventory.ramGiB < 16 ||
    !nonEmpty(inventory.displayServer) ||
    !Array.isArray(ids) ||
    !Array.isArray(attachments) ||
    new Set(ids).size !== ids.length ||
    new Set(attachments.map((asset) => asset?.assetId)).size !==
      attachments.length ||
    !sameSet(ids, attachments.map((asset) => asset?.assetId)) ||
    attachments.some(
      (asset) =>
        !asset ||
        !nonEmpty(asset.assetId) ||
        !nonEmpty(asset.model) ||
        (asset.appiumId !== null && !nonEmpty(asset.appiumId)) ||
        Object.keys(asset).sort().join(",") !== "appiumId,assetId,model",
    )
  ) {
    throw new Error("controller host inventory is incomplete or duplicated");
  }
  rejectStableIdentifiers(inventory);
  if (requiresTrackpadInventory(authorization)) {
    const trackpad = inventory.trackpad;
    if (
      trackpad?.assetId !== "FW-TRACKPAD-01" ||
      !nonEmpty(trackpad.model) ||
      !nonEmpty(trackpad.firmware) ||
      trackpad.transport !== "Bluetooth" ||
      !nonEmpty(trackpad.batteryState) ||
      !nonEmpty(trackpad.capturedAt) ||
      trackpad.topology?.pairingAndCharging !== "direct-usb-c-to-usb-c" ||
      trackpad.topology.gestures !== "bluetooth" ||
      trackpad.topology.hubPresent !== false
    ) {
      throw new Error("controller trackpad inventory is missing or unsafe");
    }
  } else if (inventory.trackpad !== null) {
    throw new Error("unexpected trackpad inventory for this controller path");
  }
  return inventory;
}

function requiresTrackpadInventory(authorization) {
  return (
    authorization.hostId === "FW-MAC-M2-01" &&
    (authorization.lane === "infrastructure-canary" ||
      authorization.lane === "manual-safari-trackpad")
  );
}

function sameSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function rejectStableIdentifiers(value) {
  const serialized = JSON.stringify(value);
  if (
    /"[^"]*(?:serial|udid|bluetooth.?address|device.?address|location.?id)[^"]*"\s*:/iu.test(
      serialized,
    ) ||
    /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/iu.test(serialized)
  ) {
    throw new Error("controller host inventory contains a stable identifier");
  }
}
