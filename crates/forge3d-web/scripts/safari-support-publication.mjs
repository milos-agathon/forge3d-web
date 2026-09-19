import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";
import {
  assertSafeLaunchArguments,
  validateHostInventory,
} from "./capture-host-inventory.mjs";
import {
  mergeBrowserEvidence,
  requiredEvidenceRows,
} from "./merge-browser-evidence.mjs";
import { checklistDefinition } from "./manual-evidence.mjs";
import { verifyPackageManifestProvenance } from "./resolve-hardware-promotion.mjs";
import { assertJsonSchema } from "../tests/browser/json-schema-validator.mjs";

const readinessSchema = readJson(
  new URL(
    "../tests/infrastructure/browser-hardware-release-readiness.schema.json",
    import.meta.url,
  ),
);
const labReadinessSchema = readJson(
  new URL(
    "../tests/infrastructure/browser-lab-infrastructure-readiness.schema.json",
    import.meta.url,
  ),
);
const safariKey = "automated:FW-MAC-M2-01:safari-macos-m2";
const manualKey = "manual:FW-TRACKPAD-01:safari-trackpad";
const semanticSteps = Object.freeze([
  "SESSION_CHALLENGE_VISIBLE",
  "TRACKPAD_ORBIT",
  "TRACKPAD_PAN",
  "TRACKPAD_TWO_FINGER_SCROLL_ZOOM",
  "TRACKPAD_MOMENTUM_END",
  "TRACKPAD_PAGE_SCROLL_ISOLATION",
  "TRACKPAD_CLEANUP",
]);

export function createSafariSupportPublication({
  targetSha,
  tag,
  readiness,
  readinessBytes,
  readinessArtifact,
  readinessRun,
  labReadiness,
  labReadinessBytes,
  labReadinessRun,
  packageRun,
  packageRunBytes,
  packageManifest,
  packageManifestBytes,
  packageAssetName,
  packageAssetBytes,
  records,
  recordBytes,
  matrix,
  policy,
  manualMediaPlan,
  now = new Date(),
  repository = "milos-agathon/forge3d-web",
}) {
  assertJsonSchema(readiness, readinessSchema);
  assertJsonSchema(labReadiness, labReadinessSchema);
  assertCanonicalBytes(readiness, readinessBytes, "release readiness");
  assertCanonicalBytes(labReadiness, labReadinessBytes, "laboratory readiness");
  assertCanonicalBytes(packageRun, packageRunBytes, "package run");
  assertCanonicalRecordBytes(records, recordBytes);
  const current = validDate(now, "publication time");
  const created = validDate(readiness.createdAt, "release readiness createdAt");
  if (created > current) throw new Error("release readiness is from the future");
  if (
    !/^[0-9a-f]{40}$/u.test(targetSha ?? "") ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(tag ?? "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    readiness.status !== "RELEASE_MATRIX_READY" ||
    readiness.supportClaim !== true ||
    readiness.targetSha !== targetSha
  ) {
    throw new Error("Safari publication target or release readiness is invalid");
  }
  validateReadinessRun(readinessRun, {
    id: readinessArtifact?.workflow_run?.id,
    path: ".github/workflows/browser-hardware-release-readiness.yml",
    targetSha,
  });
  if (
    !Number.isInteger(readinessArtifact?.id) ||
    readinessArtifact.id < 1 ||
    readinessArtifact.name !== "browser-hardware-release-readiness" ||
    readinessArtifact.expired !== false ||
    readinessArtifact.workflow_run?.id !== readinessRun.id ||
    readinessArtifact.workflow_run?.head_sha !== targetSha ||
    !/^sha256:[0-9a-f]{64}$/u.test(readinessArtifact.digest ?? "")
  ) {
    throw new Error("release readiness artifact identity is invalid");
  }
  validateReadinessRun(labReadinessRun, {
    id: readiness.labReadiness.runId,
    path: ".github/workflows/browser-lab-infrastructure-readiness.yml",
    targetSha,
  });
  if (
    sha256Hex(Buffer.from(labReadinessBytes)) !==
      readiness.labReadiness.manifestSha256 ||
    labReadiness.status !== "LAB_INFRA_READY" ||
    labReadiness.run?.id !== readiness.labReadiness.runId ||
    labReadiness.run?.attempt !== labReadinessRun.run_attempt ||
    labReadiness.run?.workflowSha !== targetSha ||
    labReadiness.candidateSha !== targetSha ||
    labReadiness.packageRunId !== readiness.packageRunId ||
    labReadiness.packageSha256 !== readiness.packageSha256 ||
    labReadiness.labInfrastructureDigest !==
      readiness.labReadiness.labInfrastructureDigest
  ) {
    throw new Error("laboratory readiness binding is invalid");
  }
  validatePackageRun(packageRun, {
    repository,
    runId: readiness.packageRunId,
    targetSha,
  });
  validatePackageAsset({
    packageManifest,
    packageManifestBytes,
    packageAssetName,
    packageAssetBytes,
    packageRun,
    packageSha256: readiness.packageSha256,
    repository,
    targetSha,
  });

  const expectedRows = requiredEvidenceRows(matrix);
  if (
    expectedRows.length !== 24 ||
    records.length !== 24 ||
    new Set(records.map((record) => record.key)).size !== 24
  ) {
    throw new Error("Safari publication requires the exact unique 24-row matrix");
  }
  const digests = new Map(
    readiness.recordDigests.map((entry) => [entry.key, entry]),
  );
  for (const record of records) {
    const expected = digests.get(record.key);
    if (
      !expected ||
      expected.workflowRunId !== record.workflow?.runId ||
      expected.artifactId !== record.workflow?.artifactId ||
      expected.sha256 !== sha256Hex(record)
    ) {
      throw new Error(`finalized record digest or artifact drift: ${record.key}`);
    }
  }
  const replay = mergeBrowserEvidence({
    targetSha,
    packageSha256: readiness.packageSha256,
    labReadiness: {
      status: "LAB_INFRA_READY",
      run: { id: readiness.labReadiness.runId },
      runId: readiness.labReadiness.runId,
      packageRunId: readiness.packageRunId,
      candidateSha: targetSha,
      packageSha256: readiness.packageSha256,
      manifestSha256: readiness.labReadiness.manifestSha256,
      labInfrastructureDigest: readiness.labReadiness.labInfrastructureDigest,
    },
    records,
    matrix,
    now: created,
  });
  if (canonicalJson(replay.manifest) !== canonicalJson(readiness)) {
    throw new Error("release readiness disagrees with exact-time matrix replay");
  }
  validateCurrentManualFreshness(records, current);

  const automated = records.find((record) => record.key === safariKey);
  const manual = records.find((record) => record.key === manualKey);
  const safari = validateSafariPair({
    automated,
    manual,
    matrix,
    policy,
    targetSha,
    packageSha256: readiness.packageSha256,
    now: current,
  });
  const media = validateMediaPlan({ manualMediaPlan, manual, targetSha });
  if (!/^package-[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(packageAssetName ?? "")) {
    throw new Error("exact release tarball asset name is invalid");
  }
  const document = renderDocument({
    repository,
    tag,
    targetSha,
    readiness,
    readinessArtifact,
    readinessRun,
    labReadinessRun,
    packageRun,
    packageAssetName,
    safari,
    automated,
    manual,
    media,
  });
  if (
    document.endsWith("\n") ||
    document.includes("\r") ||
    document.charCodeAt(0) === 0xfeff
  ) {
    throw new Error("Safari support text must be UTF-8 LF without BOM or trailing LF");
  }
  return { document, sha256: sha256Hex(Buffer.from(document, "utf8")) };
}

function validateSafariPair({
  automated,
  manual,
  matrix,
  policy,
  targetSha,
  packageSha256,
  now,
}) {
  const host = matrix.hosts?.find((entry) => entry.assetId === "FW-MAC-M2-01");
  const version = parseStableVersion(automated?.browser?.version);
  const manualVersion = parseStableVersion(manual?.browser?.version);
  const mac = /^(macOS) ([1-9][0-9]*(?:\.[0-9]+){1,2}) build ([0-9]{2}[A-Z][0-9A-Z]+)$/u.exec(
    automated?.system?.osBuild ?? "",
  );
  const checklist = checklistDefinition("safari-trackpad");
  validateHostInventory(automated?.hostInventory, {
    matrix,
    requireTrackpad: true,
  });
  validateHostInventory(manual?.hostInventory, {
    matrix,
    requireTrackpad: true,
  });
  validateSafariInventoryBinding(automated, policy);
  validateSafariInventoryBinding(manual, policy);
  if (
    !automated ||
    !manual ||
    automated.kind !== "automated" ||
    automated.lane !== "safari-macos-m2" ||
    automated.hostId !== "FW-MAC-M2-01" ||
    automated.assetId !== "FW-MAC-M2-01" ||
    manual.hostId !== "FW-MAC-M2-01" ||
    manual.assetId !== "FW-TRACKPAD-01" ||
    automated.trustedSha !== targetSha ||
    automated.packageSha256 !== packageSha256 ||
    normalizedSafariName(automated.browser.name) !== "safari" ||
    automated.browser.channel !== "stable" ||
    version.major < 26 ||
    normalizedSafariName(manual.browser.name) !== "safari" ||
    manual.browser.channel !== "stable" ||
    manualVersion.text !== version.text ||
    automated.driver.name !== "safaridriver" ||
    manual.driver.name !== "safaridriver" ||
    automated.driver.version !== manual.driver.version ||
    automated.system.platform !== "darwin" ||
    !mac ||
    Number(mac[2].split(".")[0]) !== 26 ||
    manual.system.os !== "darwin" ||
    manual.system.build !== automated.system.osBuild ||
    host?.model !== "Mac mini (2023)" ||
    host.cpu !== "Apple M2" ||
    host.gpu !== "Apple M2 integrated GPU" ||
    automated.hostInventory?.model !== host.model ||
    automated.hostInventory?.cpu !== host.cpu ||
    automated.hostInventory?.gpu !== host.gpu ||
    automated.hostInventory?.platform !== "darwin" ||
    policy.tools?.safaridriverPath !== "/usr/bin/safaridriver" ||
    canonicalJson(stableHostIdentity(automated.hostInventory)) !==
      canonicalJson(stableHostIdentity(manual.hostInventory)) ||
    checklist.stepIds.length !== semanticSteps.length ||
    checklist.stepIds.some((step, index) => step !== semanticSteps[index]) ||
    Object.keys(manual.stepResults ?? {}).sort().join(",") !==
      [...semanticSteps].sort().join(",") ||
    Object.values(manual.stepResults).some((result) => result !== "pass") ||
    Object.hasOwn(manual.stepResults, "TRACKPAD_PINCH_ZOOM")
  ) {
    throw new Error("stable Safari/macOS/M2 automation and manual evidence is invalid");
  }
  assertSafeLaunchArguments(automated.effectiveLaunchArguments ?? [], policy);
  if ((automated.effectiveLaunchArguments ?? []).length !== 0) {
    throw new Error("shipping Safari evidence must use an empty safe launch argument set");
  }
  return {
    version: version.text,
    macOSVersion: mac[2],
    macOSBuild: mac[3],
    model: host.model,
    cpu: host.cpu,
    gpu: host.gpu,
    driver: `${automated.driver.name} ${automated.driver.version}`,
    driverPath: automated.hostInventory.tools.safaridriverPath,
    trackpad: automated.hostInventory.trackpad,
  };
}

function validateSafariInventoryBinding(record, policy) {
  const inventory = record?.hostInventory;
  const matches = inventory?.browsers?.filter(
    (browser) => browser.id === "safari-stable",
  );
  assertSafeLaunchArguments(inventory?.effectiveLaunchArguments ?? [], policy);
  if (
    inventory?.effectiveLaunchArguments?.length !== 0 ||
    inventory?.tools?.safaridriverPath !== "/usr/bin/safaridriver" ||
    inventory?.tools?.safaridriverVersion !== record?.driver?.version ||
    matches?.length !== 1 ||
    matches[0].channel !== "stable" ||
    matches[0].classification !== "required" ||
    matches[0].automation !== "safaridriver" ||
    matches[0].version !== record?.browser?.version ||
    matches[0].executable !== "/Applications/Safari.app/Contents/MacOS/Safari"
  ) {
    throw new Error("Safari record does not match its independently captured inventory");
  }
}

function validateMediaPlan({ manualMediaPlan, manual, targetSha }) {
  if (
    manualMediaPlan?.schemaVersion !== 1 ||
    manualMediaPlan.targetSha !== targetSha ||
    !Array.isArray(manualMediaPlan.intakes)
  ) {
    throw new Error("manual media source plan is invalid");
  }
  const matches = manualMediaPlan.intakes.filter(
    (intake) => intake.evidenceArtifactId === manual.workflow.artifactId,
  );
  if (
    matches.length !== 1 ||
    matches[0].targetCommitish !== targetSha ||
    matches[0].draft !== true ||
    !Array.isArray(matches[0].media) ||
    matches[0].media.length < 1 ||
    matches[0].media.some(
      (media) =>
        !Number.isInteger(media.assetId) ||
        media.assetId < 1 ||
        !/^manual-media-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(media.finalName ?? "") ||
        !/^[0-9a-f]{64}$/u.test(media.sha256 ?? "") ||
        media.apiSha256 !== media.sha256,
    )
  ) {
    throw new Error("Safari manual media is missing or substituted");
  }
  return matches[0].media;
}

function renderDocument(input) {
  const runLink = (id, attempt) =>
    `https://github.com/${input.repository}/actions/runs/${id}/attempts/${attempt}`;
  const artifactLink = (record) =>
    `https://github.com/${input.repository}/actions/runs/${record.workflow.runId}/artifacts/${record.workflow.artifactId}`;
  const releaseLink = (name) =>
    `https://github.com/${input.repository}/releases/download/${input.tag}/${encodeURIComponent(name)}`;
  return [
    "# Safari support evidence",
    "",
    "This exact release is qualified only for the row below. Repository documentation remains Unsupported/`NOT_PROVEN` until a real `RELEASE_MATRIX_READY` publication completes; this generated file cannot be created from source, WebKit, Safari Technology Preview, or partial evidence.",
    "",
    `- Target commit: [\`${input.targetSha}\`](https://github.com/${input.repository}/commit/${input.targetSha})`,
    `- Package SHA-256: \`${input.readiness.packageSha256}\``,
    `- Package tarball: [${markdown(input.packageAssetName, "package asset name")}](${releaseLink(input.packageAssetName)})`,
    `- Package run: [${input.packageRun.packageRunId} attempt ${input.packageRun.packageRunAttempt}](${runLink(input.packageRun.packageRunId, input.packageRun.packageRunAttempt)})`,
    `- Laboratory-readiness run: [${input.readiness.labReadiness.runId} attempt ${input.labReadinessRun.run_attempt}](${runLink(input.readiness.labReadiness.runId, input.labReadinessRun.run_attempt)})`,
    `- Release-readiness run: [${input.readinessRun.id} attempt ${input.readinessRun.run_attempt}](${runLink(input.readinessRun.id, input.readinessRun.run_attempt)})`,
    `- Release-readiness artifact: [${input.readinessArtifact.id}](https://github.com/${input.repository}/actions/runs/${input.readinessRun.id}/artifacts/${input.readinessArtifact.id})`,
    `- Laboratory manifest SHA-256: \`${input.readiness.labReadiness.manifestSha256}\``,
    `- Laboratory infrastructure digest: \`${input.readiness.labReadiness.labInfrastructureDigest}\``,
    "",
    "## Qualified row",
    "",
    "| Browser | Operating system | Hardware | Driver | Automation evidence | Manual trackpad evidence |",
    "|---|---|---|---|---|---|",
    `| Safari ${markdown(input.safari.version, "Safari version")} stable | macOS ${markdown(input.safari.macOSVersion, "macOS version")} build ${markdown(input.safari.macOSBuild, "macOS build")} | FW-MAC-M2-01; ${markdown(input.safari.model, "host model")}; ${markdown(input.safari.cpu, "host CPU")}; ${markdown(input.safari.gpu, "host GPU")}; Apple Silicon | ${markdown(input.safari.driver, "Safari driver")}; ${markdown(input.safari.driverPath, "Safari driver path")} | [run ${input.automated.workflow.runId} attempt ${input.automated.workflow.runAttempt}; artifact ${input.automated.workflow.artifactId}](${artifactLink(input.automated)}) | [run ${input.manual.workflow.runId} attempt ${input.manual.workflow.runAttempt}; artifact ${input.manual.workflow.artifactId}](${artifactLink(input.manual)}) |`,
    "",
    "The manual checklist proves two-finger scroll zoom, inertial termination, page-scroll isolation inside and outside the canvas, orbit, pan, cleanup, and visible challenge provenance. Trackpad pinch is explicitly not a Forge3D viewer control and is not claimed.",
    "",
    `Trackpad: ${markdown(input.safari.trackpad.model, "trackpad model")}; firmware ${markdown(input.safari.trackpad.firmware, "trackpad firmware")}; Bluetooth gestures; direct USB-C pairing/charging; no hub.`,
    "",
    "## Immutable manual media",
    "",
    ...input.media.map(
      (media) =>
        `- [${markdown(media.finalName, "manual media name")}](${releaseLink(media.finalName)}) — asset ${media.assetId}, SHA-256 \`${media.sha256}\``,
    ),
    "",
    "## Explicit exclusions",
    "",
    "Safari Technology Preview, Playwright WebKit, Safari on macOS versions other than major 26, Safari on Intel Mac, older macOS, unlisted hardware, substituted hosts or trackpads, unsafe launch arguments, and mobile Safari remain `NOT_PROVEN`. Playwright WebKit is engine preflight only and is never cited as shipping Safari proof.",
  ].join("\n");
}

function validateCurrentManualFreshness(records, now) {
  const manualRecords = records.filter((record) => record.kind === "manual");
  if (manualRecords.length !== 7) {
    throw new Error("Safari publication requires all seven manual evidence rows");
  }
  for (const record of manualRecords) {
    if (validDate(record.expiresAt, `manual expiry ${record.key}`) <= now) {
      throw new Error(`manual evidence is not currently fresh: ${record.key}`);
    }
  }
}

function validatePackageAsset({
  packageManifest,
  packageManifestBytes,
  packageAssetName,
  packageAssetBytes,
  packageRun,
  packageSha256,
  repository,
  targetSha,
}) {
  verifyPackageManifestProvenance({ manifest: packageManifest, packageRun });
  const tarball = packageManifest?.tarball;
  const files = packageManifest?.files;
  const matchingFiles = Array.isArray(files)
    ? files.filter((file) => file?.name === tarball)
    : [];
  if (
    !Buffer.isBuffer(packageManifestBytes) ||
    !Buffer.isBuffer(packageAssetBytes) ||
    !/^forge3d-web-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\.tgz$/u.test(tarball ?? "") ||
    packageAssetName !== `package-${tarball}` ||
    packageManifest.repository !== repository ||
    packageManifest.workflowPath !== packageRun.packageWorkflowPath ||
    packageManifest.workflowSha !== targetSha ||
    packageManifest.runId !== packageRun.packageRunId ||
    packageManifest.runAttempt !== packageRun.packageRunAttempt ||
    packageManifest.targetSha !== targetSha ||
    packageManifest.packageSha256 !== packageSha256 ||
    packageManifest.sourceTreeClean !== true ||
    matchingFiles.length !== 1 ||
    matchingFiles[0].sha256 !== packageSha256 ||
    sha256Hex(packageAssetBytes) !== packageSha256
  ) {
    throw new Error("package manifest, tarball name, or tarball bytes are invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(packageManifestBytes);
  } catch {
    throw new Error("package manifest bytes are invalid JSON");
  }
  if (canonicalJson(parsed) !== canonicalJson(packageManifest)) {
    throw new Error("package manifest bytes disagree with the attested manifest");
  }
}

function normalizedSafariName(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function stableHostIdentity(inventory) {
  const attachedAssetIds = [...(inventory?.attachedAssetIds ?? [])].sort();
  const attachedAssets = [...(inventory?.attachedAssets ?? [])].sort((left, right) =>
    String(left?.assetId).localeCompare(String(right?.assetId)),
  );
  return {
    schemaVersion: inventory?.schemaVersion,
    assetId: inventory?.assetId,
    platform: inventory?.platform,
    model: inventory?.model,
    cpu: inventory?.cpu,
    gpu: inventory?.gpu,
    ramGiB: inventory?.ramGiB,
    osBuild: inventory?.osBuild,
    headed: inventory?.headed,
    displayServer: inventory?.displayServer,
    attachedAssetIds,
    attachedAssets,
    trackpad: inventory?.trackpad && {
      assetId: inventory.trackpad.assetId,
      model: inventory.trackpad.model,
      firmware: inventory.trackpad.firmware,
      transport: inventory.trackpad.transport,
      topology: inventory.trackpad.topology,
    },
  };
}

function markdown(value, label) {
  const text = String(value ?? "");
  if (text.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error(`${label} contains empty or control text`);
  }
  return text.replace(/([\\|`<>\[\]()!])/gu, "\\$1");
}

function assertCanonicalRecordBytes(records, recordBytes) {
  if (!Array.isArray(recordBytes) || recordBytes.length !== records.length) {
    throw new Error("finalized record bytes are incomplete");
  }
  records.forEach((record, index) =>
    assertCanonicalBytes(record, recordBytes[index], `finalized record ${index}`),
  );
}

function assertCanonicalBytes(value, bytes, label) {
  const supplied = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "", "utf8");
  if (!supplied.equals(Buffer.from(`${canonicalJson(value)}\n`, "utf8"))) {
    throw new Error(`${label} is not canonical JSON with one LF`);
  }
}

function validateReadinessRun(run, { id, path, targetSha }) {
  if (
    !Number.isInteger(id) ||
    id < 1 ||
    run?.id !== id ||
    run.path !== path ||
    run.head_sha !== targetSha ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.event !== "workflow_dispatch" ||
    !Number.isInteger(run.run_attempt) ||
    run.run_attempt < 1
  ) {
    throw new Error(`protected-main run is invalid: ${path}`);
  }
}

function validatePackageRun(packageRun, { repository, runId, targetSha }) {
  if (
    Object.keys(packageRun ?? {}).sort().join(",") !==
      "packageArtifactDigest,packageArtifactId,packageArtifactName,packageRunAttempt,packageRunId,packageWorkflowPath,packageWorkflowSha,repository" ||
    packageRun.repository !== repository ||
    packageRun.packageRunId !== runId ||
    !Number.isInteger(packageRun.packageRunAttempt) ||
    packageRun.packageRunAttempt < 1 ||
    packageRun.packageWorkflowPath !== ".github/workflows/browser-package.yml" ||
    packageRun.packageWorkflowSha !== targetSha ||
    !Number.isInteger(packageRun.packageArtifactId) ||
    packageRun.packageArtifactId < 1 ||
    packageRun.packageArtifactName !== `browser-package-${targetSha}` ||
    !/^sha256:[0-9a-f]{64}$/u.test(packageRun.packageArtifactDigest ?? "")
  ) {
    throw new Error("package run or artifact provenance is invalid");
  }
}

function parseStableVersion(value) {
  if (!/^[1-9][0-9]*(?:\.[0-9]+){1,3}$/u.test(value ?? "")) {
    throw new Error("Safari version must be a stable numeric version");
  }
  return { text: value, major: Number(value.split(".")[0]) };
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (
    Number.isNaN(date.valueOf()) ||
    (!(value instanceof Date) && date.toISOString() !== value)
  ) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return date;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    values.set(key, value);
  }
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const recordPaths = readdirSync(args.get("--records-directory"))
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => Number.parseInt(left) - Number.parseInt(right))
    .map((name) => `${args.get("--records-directory")}/${name}`);
  const recordBytes = recordPaths.map((path) => readFileSync(path));
  const records = recordBytes.map((bytes) => JSON.parse(bytes));
  const readinessBytes = readFileSync(args.get("--readiness"));
  const labReadinessBytes = readFileSync(args.get("--lab-readiness"));
  const packageRunBytes = readFileSync(args.get("--package-run"));
  const packageManifestBytes = readFileSync(args.get("--package-manifest"));
  const packageAssetBytes = readFileSync(args.get("--package-asset"));
  const result = createSafariSupportPublication({
    targetSha: args.get("--target-sha"),
    tag: args.get("--tag"),
    readiness: JSON.parse(readinessBytes),
    readinessBytes,
    readinessArtifact: readJson(args.get("--readiness-artifact")),
    readinessRun: readJson(args.get("--readiness-run")),
    labReadiness: JSON.parse(labReadinessBytes),
    labReadinessBytes,
    labReadinessRun: readJson(args.get("--lab-readiness-run")),
    packageRun: JSON.parse(packageRunBytes),
    packageRunBytes,
    packageManifest: JSON.parse(packageManifestBytes),
    packageManifestBytes,
    packageAssetName: args.get("--package-asset-name"),
    packageAssetBytes,
    records,
    recordBytes,
    matrix: readJson(args.get("--matrix")),
    policy: readJson(args.get("--policy")),
    manualMediaPlan: readJson(args.get("--manual-media-plan")),
    repository: args.get("--repository"),
  });
  writeFileSync(args.get("--output"), result.document, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, sha256: result.sha256 }));
}
