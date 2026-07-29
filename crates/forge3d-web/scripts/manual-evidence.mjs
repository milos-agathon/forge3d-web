import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const checklistDirectory = join(packageRoot, "tests", "manual");
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
  if (
    (checklistId === "mobile-multitouch" &&
      !/^FW-(?:AND|IOS|IPAD)-/u.test(assetId)) ||
    (checklistId === "safari-trackpad" && assetId !== "FW-TRACKPAD-01")
  ) {
    throw new Error("asset/checklist pair is not checked");
  }
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
    hostId: "FW-MAC-M2-01",
    expectedTester,
    mediaChallenge,
    supportClaim: checklist.supportClaim,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
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
    session.package.sha256 !== intake.packageSha256 ||
    session.assetId !== intake.assetId ||
    session.hostId !== intake.hostId ||
    session.mediaChallenge !== intake.mediaChallenge ||
    session.intakeManifestSha256 !== intake.sha256
  ) {
    throw new Error("manual session does not match the intake binding");
  }
  return {
    schemaVersion: 1,
    repository: "milos-agathon/forge3d-web",
    workflow: ".github/workflows/submit-browser-manual-evidence.yml",
    run: submissionRun,
    trustedSha: intake.trustedSha,
    packageSha256: intake.packageSha256,
    labInfrastructureDigest: session.labReadiness?.labInfrastructureDigest,
    checklistId: intake.checklistId,
    stepResults: validateStepResults(stepResults, intake),
    assetId: intake.assetId,
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
