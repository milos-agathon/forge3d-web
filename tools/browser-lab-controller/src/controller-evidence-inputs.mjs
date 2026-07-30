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
  return {
    browserEvidence: evidence,
    adapterAttestation,
    inventory: {
      ...inventory,
      hostId: authorization.hostId,
      attachedAssetIds: inventory.attachedAssetIds ?? [],
    },
    route: {
      ...route,
      httpsVerified: route.ok === true,
      corsRangeControlsPassed: route.ok === true,
    },
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
  };
}
