import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertJsonSchema } from "../tests/browser/json-schema-validator.mjs";
import { validateHardwareMatrix } from "./validate-hardware-matrix.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const checklistDirectory = join(packageRoot, "tests", "manual");
const hardwareMatrixSchema = readJson(
  join(packageRoot, "tests", "infrastructure", "hardware-matrix.schema.json"),
);
const deviceMatrixSchema = readJson(
  join(packageRoot, "tests", "device", "device-matrix.schema.json"),
);
const trackpadModel = "Apple Magic Trackpad USB-C (2024), A3120";
const mobileAssetIds = new Set([
  "FW-AND-QCOM-01",
  "FW-AND-MALI-01",
  "FW-AND-PEN-01",
  "FW-IOS-OLD-01",
  "FW-IOS-NEW-01",
  "FW-IPAD-01",
]);
const checklistFiles = {
  "infrastructure-manual-canary": "infrastructure-manual-canary.md",
  "mobile-multitouch": "mobile-multitouch.md",
  "safari-trackpad": "safari-trackpad.md",
};
const mediaTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webm", "video/webm"],
  [".mp4", "video/mp4"],
]);

export function checklistDefinition(checklistId) {
  const file = checklistFiles[checklistId];
  if (!file) throw new Error(`checklist is not a closed value: ${checklistId}`);
  const bytes = readFileSync(join(checklistDirectory, file));
  const text = bytes.toString("utf8");
  const stepIds = [...text.matchAll(/^- \[ \] `([A-Z0-9_]+)`/gmu)].map(
    (match) => match[1],
  );
  if (stepIds.length < 4 || new Set(stepIds).size !== stepIds.length) {
    throw new Error(`checklist has missing or duplicate step IDs: ${checklistId}`);
  }
  return {
    checklistId,
    file,
    sha256: sha256(bytes),
    stepIds,
    supportClaim: checklistId !== "infrastructure-manual-canary",
  };
}

export function createIntakeManifest({
  trustedSha,
  packageRunId,
  packageSha256,
  checklistId,
  assetId,
  hardwareMatrix,
  deviceMatrix,
  expectedTester,
  prepareRun,
  now = new Date(),
  random = randomBytes,
}) {
  if (
    !/^[0-9a-f]{40}$/u.test(trustedSha ?? "") ||
    !Number.isInteger(packageRunId) ||
    packageRunId < 1 ||
    !/^[0-9a-f]{64}$/u.test(packageSha256 ?? "") ||
    !/^FW-(?:TRACKPAD|AND|IOS|IPAD)-[A-Z0-9-]+$/u.test(assetId ?? "") ||
    !/^[A-Za-z0-9-]+$/u.test(expectedTester ?? "")
  ) {
    throw new Error("manual intake binding is invalid");
  }
  const checklist = checklistDefinition(checklistId);
  const selection = validateIntakeSelection({
    hardwareMatrix,
    deviceMatrix,
    checklistId,
    assetId,
  });
  const mediaChallenge = random(16).toString("hex");
  if (!/^[0-9a-f]{32}$/u.test(mediaChallenge)) {
    throw new Error("media challenge must contain 128 random bits");
  }
  const createdAt = new Date(now);
  return {
    schemaVersion: 1,
    repository: "milos-agathon/forge3d-web",
    prepareWorkflow: ".github/workflows/prepare-browser-manual-evidence.yml",
    prepareRun,
    trustedSha,
    packageRunId,
    packageSha256,
    checklistId,
    checklistSha256: checklist.sha256,
    stepIds: checklist.stepIds,
    assetId,
    hostId: selection.host.assetId,
    expectedTester,
    mediaChallenge,
    supportClaim: checklist.supportClaim,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function validateIntakeSelection({
  hardwareMatrix,
  deviceMatrix,
  checklistId,
  assetId,
}) {
  assertJsonSchema(hardwareMatrix, hardwareMatrixSchema);
  assertJsonSchema(deviceMatrix, deviceMatrixSchema);
  validateHardwareMatrix(hardwareMatrix);
  const deviceIds = deviceMatrix.devices.map((value) => value.assetId);
  if (
    new Set(deviceIds).size !== mobileAssetIds.size ||
    [...mobileAssetIds].some((value) => !deviceIds.includes(value))
  ) {
    throw new Error("checked Appium device matrix must contain each public asset once");
  }

  const assets = hardwareMatrix.assets.filter(
    (value) => value.assetId === assetId,
  );
  if (assets.length !== 1 || assets[0].state !== "active") {
    throw new Error("selected manual asset is not uniquely active in the checked matrix");
  }
  const asset = assets[0];
  const hosts = hardwareMatrix.hosts.filter(
    (value) => value.assetId === asset.hostAssetId,
  );
  if (
    hosts.length !== 1 ||
    hosts[0].state !== "active" ||
    hosts[0].maintenanceReason !== null ||
    hosts[0].controller.state !== "online"
  ) {
    throw new Error("selected manual asset owning host/controller is not active");
  }
  const host = hosts[0];
  if (
    host.attachedAssetIds.filter((value) => value === asset.assetId).length !== 1 ||
    asset.hostAssetId !== host.assetId
  ) {
    throw new Error("selected manual asset/host attachment is not reciprocal");
  }

  const isMobile = ["android", "ios", "ipados"].includes(asset.kind);
  const isTrackpad =
    asset.assetId === "FW-TRACKPAD-01" &&
    asset.kind === "trackpad" &&
    asset.model === trackpadModel &&
    asset.appiumId === null;
  if (
    (checklistId === "mobile-multitouch" && !isMobile) ||
    (checklistId === "safari-trackpad" && !isTrackpad) ||
    (checklistId === "infrastructure-manual-canary" && !isMobile && !isTrackpad)
  ) {
    throw new Error("asset/checklist pair is not checked");
  }

  const matchingDevices = deviceMatrix.devices.filter(
    (value) => value.assetId === asset.assetId,
  );
  if (isMobile) {
    const device = matchingDevices[0];
    const expected =
      asset.kind === "android"
        ? ["Android", "UiAutomator2", "Chrome"]
        : asset.kind === "ios"
          ? ["iOS", "XCUITest", "Safari"]
          : ["iPadOS", "XCUITest", "Safari"];
    if (
      matchingDevices.length !== 1 ||
      deviceMatrix.hostAssetId !== host.assetId ||
      asset.appiumId !== device?.appiumId ||
      [device?.platformName, device?.automationName, device?.browserName].some(
        (value, index) => value !== expected[index],
      )
    ) {
      throw new Error("selected mobile Appium alias/model binding is not exact");
    }
  } else if (matchingDevices.length !== 0) {
    throw new Error("checked trackpad must not have an Appium device binding");
  }
  return { asset, host, device: matchingDevices[0] ?? null };
}

export function validateStepResults(stepResults, intake) {
  if (
    intake.checklistId === "infrastructure-manual-canary" ||
    !["mobile-multitouch", "safari-trackpad"].includes(intake.checklistId)
  ) {
    throw new Error("product evidence accepts only product manual checklists");
  }
  const supplied = Object.keys(stepResults).sort();
  const expected = [...intake.stepIds].sort();
  if (
    supplied.length !== expected.length ||
    supplied.some((key, index) => key !== expected[index]) ||
    Object.values(stepResults).some((value) => !["pass", "fail"].includes(value))
  ) {
    throw new Error("step_results must equal the complete checked-in step-ID set");
  }
  return Object.fromEntries(
    intake.stepIds.map((stepId) => [stepId, stepResults[stepId]]),
  );
}

export function validateMediaAssets({
  selectedAssets,
  releaseAssets,
  intakeManifestAssetId,
  intake,
  session,
  actor,
}) {
  if (actor !== intake.expectedTester) {
    throw new Error("authenticated actor is not the expected tester");
  }
  const selectedIds = new Set(selectedAssets.map((asset) => asset.id));
  if (
    selectedIds.size !== selectedAssets.length ||
    releaseAssets.length !== selectedAssets.length + 1 ||
    !releaseAssets.some((asset) => asset.id === intakeManifestAssetId) ||
    releaseAssets.some(
      (asset) =>
        asset.id !== intakeManifestAssetId && !selectedIds.has(asset.id),
    )
  ) {
    throw new Error("draft release asset inventory is not the closed selected set");
  }
  let total = 0;
  return selectedAssets.map((asset) => {
    const extension = asset.name
      .slice(asset.name.lastIndexOf("."))
      .toLowerCase();
    const expectedMime = mediaTypes.get(extension);
    const createdAt = new Date(asset.createdAt);
    if (
      !expectedMime ||
      asset.mimeType !== expectedMime ||
      asset.size < 1 ||
      asset.size > 100 * 1024 * 1024 ||
      asset.uploader !== intake.expectedTester ||
      asset.uploader !== actor ||
      !/^[0-9a-f]{64}$/u.test(asset.apiSha256 ?? "") ||
      asset.apiSha256 !== asset.sha256 ||
      createdAt < new Date(session.startedAt) ||
      createdAt > new Date(session.endedAt)
    ) {
      throw new Error(`manual media asset is invalid: ${asset.id}`);
    }
    total += asset.size;
    return {
      id: asset.id,
      name: asset.name,
      uploader: asset.uploader,
      size: asset.size,
      mimeType: asset.mimeType,
      createdAt: asset.createdAt,
      apiSha256: asset.apiSha256,
      sha256: asset.sha256,
    };
  }).map((asset, index, validated) => {
    if (index === validated.length - 1 && total > 500 * 1024 * 1024) {
      throw new Error("manual checklist media exceeds 500 MiB");
    }
    return asset;
  });
}

export function createManualEvidence({
  intake,
  session,
  stepResults,
  media,
  actor,
  approver,
  implementationActors,
  submissionRun,
  intakeReleaseId,
  controllerSignatureSha256,
  now = new Date(),
}) {
  if (
    actor !== intake.expectedTester ||
    implementationActors.has(actor) ||
    approver.login === actor ||
    implementationActors.has(approver.login)
  ) {
    throw new Error("tester and approver must be independent of implementation actors");
  }
  if (
    session.trustedSha !== intake.trustedSha ||
    session.package.runId !== intake.packageRunId ||
    session.package.sha256 !== intake.packageSha256 ||
    session.assetId !== intake.assetId ||
    session.hostId !== intake.hostId ||
    session.mediaChallenge !== intake.mediaChallenge ||
    session.intakeManifestSha256 !== intake.sha256
  ) {
    throw new Error("manual session does not match the intake binding");
  }
  assertProductSessionProvenance(session, intake.checklistId);
  return {
    schemaVersion: 1,
    repository: "milos-agathon/forge3d-web",
    workflow: ".github/workflows/submit-browser-manual-evidence.yml",
    run: submissionRun,
    trustedSha: intake.trustedSha,
    packageRunId: session.package.runId,
    packageSha256: intake.packageSha256,
    labInfrastructureDigest: session.labReadiness?.labInfrastructureDigest,
    labReadiness: { ...session.labReadiness },
    checklistId: intake.checklistId,
    stepResults: validateStepResults(stepResults, intake),
    assetId: intake.assetId,
    hostId: session.hostId,
    system: structuredClone(session.system),
    browser: structuredClone(session.browser),
    driver: structuredClone(session.driver),
    hostInventory: session.hostInventory
      ? structuredClone(session.hostInventory)
      : null,
    actor,
    approver,
    intakeReleaseId,
    manualSessionRunId: session.run.id,
    manualSessionJobId: session.hardwareJobId,
    authorizationSha256: session.authorizationSha256,
    controllerSignatureSha256,
    routeBasePath: session.routeBasePath,
    mediaChallenge: session.mediaChallenge,
    media,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(
      new Date(session.endedAt).getTime() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString(),
  };
}

function assertProductSessionProvenance(session, checklistId) {
  const identity = session.labReadiness;
  if (
    identity === null ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join(",") !==
      "labInfrastructureDigest,manifestSha256,runId" ||
    !Number.isInteger(identity.runId) ||
    identity.runId < 1 ||
    !/^[0-9a-f]{64}$/u.test(identity.manifestSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(identity.labInfrastructureDigest ?? "") ||
    !nonEmpty(session.system?.os) ||
    !nonEmpty(session.system?.build) ||
    !nonEmpty(session.browser?.name) ||
    !nonEmpty(session.browser?.channel) ||
    !nonEmpty(session.browser?.version) ||
    !nonEmpty(session.driver?.name) ||
    !nonEmpty(session.driver?.version)
  ) {
    throw new Error("manual session runtime or laboratory provenance is incomplete");
  }
  if (checklistId === "safari-trackpad") {
    const trackpad = session.hostInventory?.trackpad;
    if (
      session.hostId !== "FW-MAC-M2-01" ||
      session.assetId !== "FW-TRACKPAD-01" ||
      session.browser.name.toLowerCase() !== "safari" ||
      session.system.os !== session.hostInventory?.platform ||
      session.system.build !== session.hostInventory?.osBuild ||
      trackpad?.assetId !== "FW-TRACKPAD-01" ||
      !nonEmpty(trackpad.model) ||
      !nonEmpty(trackpad.firmware) ||
      trackpad.transport !== "Bluetooth" ||
      trackpad.topology?.pairingAndCharging !== "direct-usb-c-to-usb-c" ||
      trackpad.topology.gestures !== "bluetooth" ||
      trackpad.topology.hubPresent !== false
    ) {
      throw new Error("Safari trackpad session provenance is incomplete");
    }
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    result.set(key, value);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const operation = args.get("--operation");
  const input = JSON.parse(readFileSync(args.get("--input"), "utf8"));
  let result;
  if (operation === "create-intake") {
    result = createIntakeManifest(input);
  } else if (operation === "create-evidence") {
    result = createManualEvidence({
      ...input,
      implementationActors: new Set(input.implementationActors),
    });
  } else {
    throw new Error("--operation must be create-intake or create-evidence");
  }
  writeFileSync(args.get("--output"), `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, operation }));
}
