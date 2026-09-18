import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";
import { assertSafeLaunchArguments } from "./capture-host-inventory.mjs";
import { CHR03_STABLE_LANES } from "./chr03-lanes.mjs";
import { CHR04_LANES } from "./chr04-lanes.mjs";
import {
  mergeBrowserEvidence,
  requiredEvidenceRows,
} from "./merge-browser-evidence.mjs";
import { assertJsonSchema } from "../tests/browser/json-schema-validator.mjs";

const readinessSchema = JSON.parse(
  readFileSync(
    new URL(
      "../tests/infrastructure/browser-hardware-release-readiness.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const labReadinessSchema = JSON.parse(
  readFileSync(
    new URL(
      "../tests/infrastructure/browser-lab-infrastructure-readiness.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export const CHROMIUM_PRIMARY_ROWS = Object.freeze({
  "chrome-windows-intel12": "FW-WIN-I12-01",
  ...CHR03_STABLE_LANES,
  "edge-windows-intel12": "FW-WIN-I12-01",
  "edge-macos-m2": "FW-MAC-M2-01",
});

const ARCHITECTURE_BY_ASSET = Object.freeze({
  "FW-MAC-M2-01": "arm64",
  "FW-WIN-I12-01": "x86-64",
  "FW-LNX-I12-01": "x86-64",
  "FW-LNX-NV-01": "x86-64",
});

const PLATFORM_BY_LANE = Object.freeze({
  "chrome-windows-intel12": "win32",
  "chrome-macos-m2": "darwin",
  "chrome-linux-intel12": "linux",
  "chrome-linux-rtx3070": "linux",
  "edge-windows-intel12": "win32",
  "edge-macos-m2": "darwin",
  "edge-linux-intel12": "linux",
  "edge-linux-rtx3070": "linux",
});

export function createChromiumSupportPublication({
  targetSha,
  readiness,
  readinessBytes,
  readinessArtifact,
  readinessRun,
  labReadiness,
  labReadinessBytes,
  labReadinessRun,
  packageRun,
  records,
  matrix,
  policy,
  repository = "milos-agathon/forge3d-web",
}) {
  assertJsonSchema(readiness, readinessSchema);
  assertJsonSchema(labReadiness, labReadinessSchema);
  const canonicalReadinessBytes = Buffer.from(`${canonicalJson(readiness)}\n`, "utf8");
  const suppliedReadinessBytes = Buffer.isBuffer(readinessBytes)
    ? readinessBytes
    : Buffer.from(readinessBytes ?? "", "utf8");
  const canonicalLabReadinessBytes = Buffer.from(
    `${canonicalJson(labReadiness)}\n`,
    "utf8",
  );
  const suppliedLabReadinessBytes = Buffer.isBuffer(labReadinessBytes)
    ? labReadinessBytes
    : Buffer.from(labReadinessBytes ?? "", "utf8");
  const readinessSha256 = sha256Hex(suppliedReadinessBytes);
  if (
    !/^[0-9a-f]{40}$/u.test(targetSha ?? "") ||
    readiness.status !== "RELEASE_MATRIX_READY" ||
    readiness.supportClaim !== true ||
    readiness.targetSha !== targetSha ||
    !suppliedReadinessBytes.equals(canonicalReadinessBytes) ||
    !Number.isInteger(readinessArtifact?.id) ||
    readinessArtifact.id < 1 ||
    readinessArtifact.name !== "browser-hardware-release-readiness" ||
    readinessArtifact.expired !== false ||
    readinessArtifact.workflow_run?.id !== readinessRun?.id ||
    readinessArtifact.workflow_run?.head_sha !== targetSha ||
    !/^sha256:[0-9a-f]{64}$/u.test(readinessArtifact.digest ?? "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
  ) {
    throw new Error("release-readiness identity, digest, artifact, or target is invalid");
  }
  assertSuccessfulRun(readinessRun, {
    id: readinessRun?.id,
    path: ".github/workflows/browser-hardware-release-readiness.yml",
    targetSha,
  });
  assertSuccessfulRun(labReadinessRun, {
    id: readiness.labReadiness.runId,
    path: ".github/workflows/browser-lab-infrastructure-readiness.yml",
    targetSha,
  });
  if (
    !suppliedLabReadinessBytes.equals(canonicalLabReadinessBytes) ||
    sha256Hex(suppliedLabReadinessBytes) !== readiness.labReadiness.manifestSha256 ||
    labReadiness.run.id !== readiness.labReadiness.runId ||
    labReadiness.run.attempt !== labReadinessRun.run_attempt ||
    labReadiness.run.workflowSha !== targetSha ||
    labReadiness.candidateSha !== targetSha ||
    labReadiness.packageRunId !== readiness.packageRunId ||
    labReadiness.packageSha256 !== readiness.packageSha256 ||
    labReadiness.labInfrastructureDigest !==
      readiness.labReadiness.labInfrastructureDigest
  ) {
    throw new Error("attested laboratory readiness identity or digest is invalid");
  }
  assertSuccessfulRun(packageRun, {
    id: readiness.packageRunId,
    path: ".github/workflows/browser-package.yml",
    targetSha,
  });
  if (
    packageRun.packageArtifactId !== undefined &&
    (!Number.isInteger(packageRun.packageArtifactId) || packageRun.packageArtifactId < 1)
  ) {
    throw new Error("package artifact identity is invalid");
  }

  const expectedRows = requiredEvidenceRows(matrix);
  if (
    expectedRows.length !== 24 ||
    records.length !== expectedRows.length ||
    new Set(records.map((record) => record.key)).size !== records.length ||
    records.some(
      (record) =>
        !Number.isInteger(record.workflow?.runAttempt) ||
        record.workflow.runAttempt < 1 ||
        !Number.isInteger(record.workflow?.artifactId) ||
        record.workflow.artifactId < 1,
    )
  ) {
    throw new Error("support publication requires the exact unique closed evidence set");
  }
  const merged = mergeBrowserEvidence({
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
    now: new Date(readiness.createdAt),
  });
  if (canonicalJson(merged.manifest) !== canonicalJson(readiness)) {
    throw new Error("release readiness is not the canonical merge of the supplied records");
  }

  const byLane = new Map(records.map((record) => [record.lane, record]));
  const primaryRows = Object.entries(CHROMIUM_PRIMARY_ROWS).map(
    ([lane, assetId]) => validateChromiumRow({
      lane,
      assetId,
      record: byLane.get(lane),
      matrix,
      policy,
      primary: true,
    }),
  );
  const conditionalRows = Object.entries(CHR04_LANES)
    .filter(([, configuration]) => configuration.requirement === "conditional")
    .map(([lane, configuration]) => validateChromiumRow({
      lane,
      assetId: configuration.assetId,
      record: byLane.get(lane),
      matrix,
      policy,
      primary: false,
    }));

  const document = renderDocument({
    repository,
    targetSha,
    readiness,
    readinessSha256,
    readinessArtifactId: readinessArtifact.id,
    readinessRun,
    labReadinessRun,
    packageRun,
    primaryRows,
    conditionalRows,
    records: [...records].sort((left, right) => left.key.localeCompare(right.key)),
  });
  if (document.endsWith("\n") || document.includes("\r") || document.charCodeAt(0) === 0xfeff) {
    throw new Error("support publication text must be UTF-8 LF without BOM or trailing newline");
  }
  if (/minimum\s+major|minimumMajor/iu.test(document)) {
    throw new Error("support publication must not infer a minimum-major support floor");
  }
  return { document, sha256: sha256Hex(Buffer.from(document, "utf8")) };
}

function validateChromiumRow({ lane, assetId, record, matrix, policy, primary }) {
  const host = matrix.hosts?.find((candidate) => candidate.assetId === assetId);
  const expectedPlatform = PLATFORM_BY_LANE[lane];
  const edge = lane.startsWith("edge-");
  const expectedBrowser = edge ? "msedge" : "chrome";
  const expectedDriver = edge ? "playwright-edge" : "playwright-chrome";
  const channelPolicy = policy.channels?.find(
    (entry) => entry.id === (edge ? "edge-stable" : "chrome-stable"),
  );
  if (
    !record ||
    !host ||
    record.kind !== "automated" ||
    record.assetId !== assetId ||
    record.hostId !== assetId ||
    record.result !== "PASS" ||
    record.infrastructureError !== null ||
    record.browser?.name !== expectedBrowser ||
    record.browser.channel !== "stable" ||
    !/^[1-9]\d*\.\d+\.\d+\.\d+$/u.test(record.browser.version ?? "") ||
    record.driver?.name !== expectedDriver ||
    !/^[1-9]\d*\.\d+\.\d+$/u.test(record.driver.version ?? "") ||
    record.driver.version !== policy.tools?.playwright ||
    record.system?.platform !== expectedPlatform ||
    typeof record.system.osBuild !== "string" ||
    record.system.osBuild.trim() === "" ||
    typeof record.system.displayServer !== "string" ||
    record.system.displayServer.trim() === "" ||
    channelPolicy?.channel !== "stable" ||
    channelPolicy.classification !== "required" ||
    channelPolicy.automation !== "playwright" ||
    !ARCHITECTURE_BY_ASSET[assetId]
  ) {
    throw new Error(`Chromium support provenance is invalid: ${lane}`);
  }
  if (
    expectedPlatform === "linux" &&
    (host.displayServer !== "GNOME Wayland" ||
      record.system.displayServer !== "GNOME Wayland")
  ) {
    throw new Error(`Linux Chromium support requires observed GNOME Wayland: ${lane}`);
  }
  validateObservedOperatingSystem({ lane, host, record });
  assertSafeLaunchArguments(record.effectiveLaunchArguments, policy);
  if (
    record.adapter?.isFallbackAdapter !== false ||
    record.adapter?.surfacePresented !== true ||
    record.adapter?.secureContext !== true ||
    record.adapter?.deviceCreated !== true
  ) {
    throw new Error(`Chromium support requires nonfallback presentation: ${lane}`);
  }
  if (!primary && CHR04_LANES[lane]?.requirement !== "conditional") {
    throw new Error(`unexpected conditional Chromium row: ${lane}`);
  }
  return {
    lane,
    assetId,
    tier: primary ? "primary" : "conditional/P2",
    evidenceStatus: primary ? "REQUIRED_EVIDENCE_PASS" : "EVIDENCE_PASS_NOT_PRIMARY_SUPPORT",
    browser: `${record.browser.name} ${record.browser.version}`,
    osBuild: record.system.osBuild,
    displayServer: record.system.displayServer,
    model: host.model,
    cpu: host.cpu,
    gpu: host.gpu,
    architecture: ARCHITECTURE_BY_ASSET[assetId],
    driver: `${record.driver.name} ${record.driver.version}`,
    key: record.key,
    runId: record.workflow.runId,
    runAttempt: record.workflow.runAttempt,
    artifactId: record.workflow.artifactId,
  };
}

function validateObservedOperatingSystem({ lane, host, record }) {
  const observed = record.system.osBuild;
  const display = record.system.displayServer;
  if (display !== host.displayServer) {
    throw new Error(`Chromium support display does not match the checked asset: ${lane}`);
  }
  if (
    host.os?.family === "Windows" &&
    (host.os.baseline !== "Windows 11 25H2 latest security patch" ||
      !isObservedWindows25H2(observed))
  ) {
    throw new Error(`Chromium support requires observed Windows 11: ${lane}`);
  }
  if (
    host.os?.family === "macOS" &&
    (host.os.baseline !== "macOS 26 latest security patch" ||
      !/(?:\bmacOS 26(?:\.\d+)?\b|\bmacOS build 25[A-Z0-9.]+\b)/iu.test(observed))
  ) {
    throw new Error(`Chromium support requires observed macOS 26: ${lane}`);
  }
  if (
    host.os?.family === "Ubuntu" &&
    (host.os.baseline !== "Ubuntu 24.04 LTS latest security patch" ||
      !/\bUbuntu 24\.04(?:\.\d+)?(?: LTS)?\b/iu.test(observed))
  ) {
    throw new Error(`Chromium support requires observed Ubuntu 24.04 LTS: ${lane}`);
  }
}

function isObservedWindows25H2(value) {
  let identity;
  try {
    identity = JSON.parse(value);
  } catch {
    return false;
  }
  if (
    !identity ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join(",") !==
      "buildNumber,caption,displayVersion,editionId,productType,registryProductName,ubr,version"
  ) {
    return false;
  }
  return (
    /^Microsoft Windows 11(?:\s+[A-Za-z0-9][A-Za-z0-9 ()-]*)?$/u.test(identity.caption ?? "") &&
    identity.productType === 1 &&
    identity.version === "10.0.26200" &&
    identity.buildNumber === "26200" &&
    typeof identity.editionId === "string" &&
    identity.editionId.trim() !== "" &&
    identity.displayVersion === "25H2" &&
    Number.isSafeInteger(identity.ubr) &&
    identity.ubr >= 0 &&
    typeof identity.registryProductName === "string" &&
    identity.registryProductName.trim() !== ""
  );
}

function assertSuccessfulRun(run, expected) {
  const normalizedPackageRun = Number.isInteger(run?.packageRunId);
  const runId = run?.id ?? run?.packageRunId;
  const attempt = run?.run_attempt ?? run?.packageRunAttempt;
  const path = run?.path ?? run?.packageWorkflowPath;
  const sha = run?.head_sha ?? run?.packageWorkflowSha;
  if (
    !Number.isInteger(expected.id) ||
    expected.id < 1 ||
    runId !== expected.id ||
    path !== expected.path ||
    sha !== expected.targetSha ||
    (!normalizedPackageRun && run.head_branch !== "main") ||
    (!normalizedPackageRun && run.status !== "completed") ||
    (!normalizedPackageRun && run.conclusion !== "success") ||
    (!normalizedPackageRun && run.event !== "workflow_dispatch") ||
    !Number.isInteger(attempt) ||
    attempt < 1
  ) {
    throw new Error(`successful protected-main run identity is invalid: ${expected.path}`);
  }
}

function renderDocument(input) {
  const runLink = (id, attempt) =>
    `https://github.com/${input.repository}/actions/runs/${id}/attempts/${attempt}`;
  const lines = [
    "# Chromium support evidence",
    "",
    "This release artifact is generated only from the exact closed hardware release matrix. It records evidence; it does not define a browser-version floor.",
    "",
    `- Target commit: \`${input.targetSha}\``,
    `- Package SHA-256: \`${input.readiness.packageSha256}\``,
    `- Release-readiness manifest SHA-256: \`${input.readinessSha256}\``,
    `- Release-readiness artifact: \`${input.readinessArtifactId}\``,
    `- Package run: [${input.readiness.packageRunId} attempt ${packageAttempt(input.packageRun)}](${runLink(input.readiness.packageRunId, packageAttempt(input.packageRun))})`,
    `- Laboratory-readiness run: [${input.readiness.labReadiness.runId} attempt ${input.labReadinessRun.run_attempt}](${runLink(input.readiness.labReadiness.runId, input.labReadinessRun.run_attempt)})`,
    `- Release-readiness run: [${input.readinessRun.id} attempt ${input.readinessRun.run_attempt}](${runLink(input.readinessRun.id, input.readinessRun.run_attempt)})`,
    `- Laboratory manifest SHA-256: \`${input.readiness.labReadiness.manifestSha256}\``,
    `- Laboratory infrastructure digest: \`${input.readiness.labReadiness.labInfrastructureDigest}\``,
    "",
    "## Primary supported configurations",
    "",
    "| Lane | Asset | Browser | Observed OS build | Observed display | Configured model / CPU / GPU / architecture | Driver | Tier | Evidence |",
    "|---|---|---|---|---|---|---|---|---|",
    ...input.primaryRows.map(renderRow),
    "",
    "Windows support requires the exact Windows 11 Intel Iris Xe hardware row above. Linux support requires the exact listed Ubuntu hardware in a real GNOME Wayland session. Architecture is a configured constraint from the checked asset profile; browser version, OS build, and display are observed evidence.",
    "",
    "## Conditional Chromium evidence",
    "",
    "| Lane | Asset | Browser | Observed OS build | Observed display | Configured model / CPU / GPU / architecture | Driver | Tier | Evidence |",
    "|---|---|---|---|---|---|---|---|---|",
    ...input.conditionalRows.map(renderRow),
    "",
    "Edge on Linux remains conditional/P2 and is outside primary support even when its matrix evidence passes. Intel Mac, AMD/Linux, unlisted hardware, non-Wayland Linux, Brave, Opera, Vivaldi, Electron, and other derivative Chromium brands remain `NOT_PROVEN`. Chrome Beta and all other preflight/probe channels are regression signals only and cannot promote support.",
    "",
    "Bundled Playwright Chromium (`chromium-preflight`) remains regression-only. Primary support requires branded stable Chrome or Edge on the exact hardware rows, without unsafe WebGPU, GPU-blocklist, ANGLE, or Vulkan-forcing arguments, and with nonfallback hardware presentation.",
    "",
    "## Closed 24-key evidence run index",
    "",
    "| Key | Lane | Asset | Result | Run | Artifact |",
    "|---|---|---|---|---|---|",
    ...input.records.map((record) =>
      `| ${escapeMarkdown(record.key)} | ${escapeMarkdown(record.lane)} | ${escapeMarkdown(record.assetId)} | ${escapeMarkdown(record.result)} | [${record.workflow.runId} attempt ${record.workflow.runAttempt}](${runLink(record.workflow.runId, record.workflow.runAttempt)}) | ${record.workflow.artifactId} |`,
    ),
  ];
  return lines.join("\n");
}

function renderRow(row) {
  const hardware = `${row.model} / ${row.cpu} / ${row.gpu} / ${row.architecture}`;
  return `| ${escapeMarkdown(row.lane)} | ${escapeMarkdown(row.assetId)} | ${escapeMarkdown(row.browser)} | ${escapeMarkdown(row.osBuild)} | ${escapeMarkdown(row.displayServer)} | ${escapeMarkdown(hardware)} | ${escapeMarkdown(row.driver)} | ${escapeMarkdown(row.tier)} | ${escapeMarkdown(row.evidenceStatus)} |`;
}

function escapeMarkdown(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll(/\bwww\./giu, "www&#46;")
    .replaceAll(":", "&#58;")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("`", "\\`")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll(/\r?\n|\r/gu, " ");
}

function packageAttempt(value) {
  return value.run_attempt ?? value.packageRunAttempt;
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
  const recordsDirectory = args.get("--records-directory");
  const records = readdirSync(recordsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => JSON.parse(readFileSync(`${recordsDirectory}/${entry.name}`, "utf8")));
  const readinessBytes = readFileSync(args.get("--readiness"));
  const readiness = JSON.parse(readinessBytes);
  if (readinessBytes.toString("utf8") !== `${canonicalJson(readiness)}\n`) {
    throw new Error("release readiness file is not canonical JSON with one LF");
  }
  const labReadinessBytes = readFileSync(args.get("--lab-readiness"));
  const labReadiness = JSON.parse(labReadinessBytes);
  const result = createChromiumSupportPublication({
    targetSha: args.get("--target-sha"),
    readiness,
    readinessBytes,
    readinessArtifact: JSON.parse(
      readFileSync(args.get("--readiness-artifact"), "utf8"),
    ),
    readinessRun: JSON.parse(readFileSync(args.get("--readiness-run"), "utf8")),
    labReadiness,
    labReadinessBytes,
    labReadinessRun: JSON.parse(
      readFileSync(args.get("--lab-readiness-run"), "utf8"),
    ),
    packageRun: JSON.parse(readFileSync(args.get("--package-run"), "utf8")),
    records,
    matrix: JSON.parse(readFileSync(args.get("--matrix"), "utf8")),
    policy: JSON.parse(readFileSync(args.get("--policy"), "utf8")),
    repository: args.get("--repository"),
  });
  writeFileSync(args.get("--output"), result.document, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, sha256: result.sha256 }));
}
