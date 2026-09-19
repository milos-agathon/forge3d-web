import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../../scripts/canonical-json.mjs";
import { createChromiumSupportPublication } from "../../scripts/chromium-support-publication.mjs";
import { validPublicationInput } from "./chromium-support-publication-fixture.mjs";

function publish(input) {
  return createChromiumSupportPublication({
    ...input,
    readinessBytes: Buffer.from(`${canonicalJson(input.readiness)}\n`, "utf8"),
  });
}

test("support publication is deterministic across record order and closes all 24 runs", () => {
  const input = validPublicationInput();
  const first = publish(input);
  const second = publish({ ...input, records: [...input.records].reverse() });
  assert.equal(first.document, second.document);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.document.endsWith("\n"), false);
  assert.equal(first.document.includes("\r"), false);
  assert.equal(first.document.charCodeAt(0) === 0xfeff, false);
  assert.equal((first.document.match(/attempt 2\]/gu) ?? []).length, 24);
  assert.match(
    first.document,
    new RegExp(sha256Hex(Buffer.from(`${canonicalJson(input.readiness)}\n`, "utf8")), "u"),
  );
  for (const value of [
    "chrome-windows-intel12",
    "chrome-macos-m2",
    "chrome-linux-intel12",
    "chrome-linux-rtx3070",
    "edge-windows-intel12",
    "edge-macos-m2",
    "Edge on Linux remains conditional/P2",
    "Intel Mac",
    "AMD/Linux",
    "non-Wayland Linux",
    "derivative Chromium brands",
    "regression-only",
    "NOT_PROVEN",
  ]) assert.match(first.document, new RegExp(value.replaceAll("/", "\\/"), "u"));
  assert.doesNotMatch(first.document, /minimumMajor|minimum major/iu);
});

test("support publication fails closed on readiness, set, target, package, run, digest, artifact, and attempt substitutions", () => {
  const mutations = [
    (value) => { value.readiness.status = "NOT_READY"; },
    (value) => { value.readiness.supportClaim = false; },
    (value) => { value.readiness.targetSha = "e".repeat(40); },
    (value) => { value.readiness.packageSha256 = "f".repeat(64); },
    (value) => { value.readinessArtifact.id = 0; },
    (value) => { value.readinessArtifact.workflow_run.id = 899; },
    (value) => { value.readinessArtifact.digest = "sha256:bad"; },
    (value) => { value.readinessRun.head_sha = "e".repeat(40); },
    (value) => { value.readinessRun.conclusion = "failure"; },
    (value) => { value.readinessRun.run_attempt = 0; },
    (value) => { value.labReadinessRun.run_attempt = 0; },
    (value) => { value.labReadinessRun.run_attempt += 1; },
    (value) => { value.labReadiness.run.attempt += 1; value.labReadinessBytes = Buffer.from(`${canonicalJson(value.labReadiness)}\n`); },
    (value) => { value.labReadiness.packageRunId += 1; value.labReadinessBytes = Buffer.from(`${canonicalJson(value.labReadiness)}\n`); },
    (value) => { value.packageRun.packageRunId = 51; },
    (value) => { value.records = value.records.slice(1); },
    (value) => { value.records = [...value.records, value.records[0]]; },
    (value) => { value.records[0].trustedSha = "e".repeat(40); },
    (value) => { value.records[0].packageSha256 = "f".repeat(64); },
    (value) => { value.records[0].workflow.runId += 1; },
    (value) => { value.records[0].workflow.artifactId += 1; },
    (value) => { value.records[0].workflow.runAttempt = 0; },
  ];
  for (const mutate of mutations) {
    const input = validPublicationInput();
    mutate(input);
    assert.throws(() => publish(input));
  }
});

test("raw manifest bytes and the laboratory same-commit tuple cannot be bypassed", () => {
  const missingLf = validPublicationInput();
  assert.throws(
    () => createChromiumSupportPublication({
      ...missingLf,
      readinessBytes: Buffer.from(canonicalJson(missingLf.readiness), "utf8"),
    }),
    /release-readiness identity, digest, artifact, or target is invalid/u,
  );

  const changedLabBytes = validPublicationInput();
  changedLabBytes.labReadinessBytes = Buffer.concat([
    changedLabBytes.labReadinessBytes,
    Buffer.from("\n"),
  ]);
  assert.throws(() => publish(changedLabBytes), /laboratory readiness identity or digest/u);

  const priorTarget = validPublicationInput();
  priorTarget.labReadiness.run.workflowSha = "e".repeat(40);
  priorTarget.labReadiness.candidateSha = "e".repeat(40);
  priorTarget.labReadinessBytes = Buffer.from(
    `${canonicalJson(priorTarget.labReadiness)}\n`,
    "utf8",
  );
  priorTarget.readiness.labReadiness.manifestSha256 = sha256Hex(
    priorTarget.labReadinessBytes,
  );
  assert.throws(() => publish(priorTarget), /laboratory readiness identity or digest/u);
});

test("primary Chromium provenance rejects nonstable, placeholder, malformed, unsafe, fallback, platform, display, and injected hardware rows", () => {
  const primary = (value, lane = "chrome-windows-intel12") =>
    value.records.find((record) => record.lane === lane);
  const mutations = [
    [(value) => { primary(value).browser.name = "chromium"; }, /Chromium support provenance/u],
    [(value) => { primary(value).browser.channel = "beta"; }, /Chromium support provenance/u],
    [(value) => { primary(value).browser.version = "150.0"; }, /Chromium support provenance/u],
    [(value) => { primary(value).browser.version = "unknown"; }, /Chromium support provenance/u],
    [(value) => { primary(value).driver.name = "placeholder"; }, /Chromium support provenance/u],
    [(value) => { primary(value).driver.version = "1.55.0"; }, /Chromium support provenance/u],
    [(value) => { primary(value).system.platform = "linux"; }, /Chromium support provenance/u],
    [(value) => { primary(value).system.osBuild = JSON.stringify({ caption: "Microsoft Windows 11 Pro", productType: 1, version: "10.0.22000", buildNumber: "22000", displayVersion: "21H2", editionId: "Professional", ubr: 2538, registryProductName: "Windows 10 Pro" }); }, /observed Windows 11/u],
    [(value) => { primary(value).system.osBuild = JSON.stringify({ caption: "Microsoft Windows 10 Pro", productType: 1, version: "10.0.26200", buildNumber: "26200", displayVersion: "25H2", editionId: "Professional", ubr: 1000, registryProductName: "Windows 11 Pro" }); }, /observed Windows 11/u],
    [(value) => { primary(value).system.osBuild = JSON.stringify({ caption: "Microsoft Windows Server 2025 Standard", productType: 3, version: "10.0.26200", buildNumber: "26200", displayVersion: "25H2", editionId: "ServerStandard", ubr: 1000, registryProductName: "Windows Server 2025 Standard" }); }, /observed Windows 11/u],
    [(value) => { primary(value).system.osBuild = "Windows 11 Pro 25H2 build 26200.1000"; }, /observed Windows 11/u],
    [(value) => { primary(value, "chrome-macos-m2").system.osBuild = "macOS 25.0 (24A123)"; }, /observed macOS 26/u],
    [(value) => { primary(value, "chrome-linux-intel12").system.osBuild = "Ubuntu 22.04.5 LTS"; }, /observed Ubuntu 24.04 LTS/u],
    [(value) => { primary(value, "edge-macos-m2").system.displayServer = "XQuartz"; }, /display does not match/u],
    [(value) => { primary(value).effectiveLaunchArguments = null; }, /array of strings/u],
    [(value) => { primary(value).effectiveLaunchArguments = [1]; }, /array of strings/u],
    [(value) => { primary(value).effectiveLaunchArguments = ["--enable-unsafe-webgpu"]; }, /prohibited browser launch arguments/u],
    [(value) => { primary(value).effectiveLaunchArguments = ["-enable-unsafe-webgpu"]; }, /prohibited browser launch arguments/u],
    [(value) => { primary(value).effectiveLaunchArguments = ["--ignore-gpu-blocklist"]; }, /prohibited browser launch arguments/u],
    [(value) => { primary(value).effectiveLaunchArguments = ["--use-angle=swiftshader"]; }, /prohibited browser launch arguments/u],
    [(value) => { primary(value).effectiveLaunchArguments = ["--enable-vulkan"]; }, /prohibited browser launch arguments/u],
    [(value) => { primary(value).effectiveLaunchArguments = ["--enable-features=Foo,Vulkan,Bar"]; }, /prohibited browser launch arguments/u],
    [(value) => { primary(value).effectiveLaunchArguments = ["-enable-features=Vulkan"]; }, /prohibited browser launch arguments/u],
    [(value) => { primary(value).effectiveLaunchArguments = ["/use-angle=swiftshader"]; }, /prohibited browser launch arguments/u],
    [(value) => { primary(value).adapter.isFallbackAdapter = true; }, /automated hardware evidence is incomplete/u],
    [(value) => { primary(value).adapter.surfacePresented = false; }, /automated hardware evidence is incomplete/u],
    [(value) => { primary(value, "chrome-linux-intel12").system.displayServer = "X11"; }, /GNOME Wayland/u],
  ];
  for (const [mutate, error] of mutations) {
    const input = validPublicationInput();
    mutate(input);
    rebindReadiness(input);
    assert.throws(() => publish(input), error);
  }

  for (const [lane, assetId] of [
    ["chrome-macos-intel", "FW-MAC-INTEL-01"],
    ["chrome-linux-amd", "FW-LNX-AMD-01"],
  ]) {
    const input = validPublicationInput();
    input.records[0] = { ...input.records[0], lane, assetId, hostId: assetId };
    assert.throws(() => publish(input));
  }
});

test("a semantically changed record with stale readiness bindings fails closed", () => {
  const input = validPublicationInput();
  input.records.find((record) => record.lane === "chrome-windows-intel12")
    .browser.version = "151.0.1.2";
  assert.throws(
    () => publish(input),
    /canonical merge of the supplied records/u,
  );
});

test("dynamic evidence is Markdown-escaped and cannot add rows or links", () => {
  const input = validPublicationInput();
  input.matrix.hosts.find((host) => host.assetId === "FW-WIN-I12-01").model =
    "NUC | forged\n[click](https://invalid.example) https://invalid.example www.invalid.example `code`";
  const { document } = publish(input);
  assert.match(document, /https&#58;\/\/invalid\.example/u);
  assert.equal(document.includes("https://invalid.example"), false);
  assert.equal(document.includes("www.invalid.example"), false);
  assert.match(document, /www&#46;invalid\.example/u);
  assert.match(document, /\]\(https:\/\/github\.com\/milos-agathon\/forge3d-web\/actions\/runs\//u);
  assert.equal(document.includes("NUC | forged\n"), false);
});

test("CLI consumes canonical readiness and finalized records and writes exact deterministic bytes", () => {
  const input = validPublicationInput();
  const directory = mkdtempSync(join(tmpdir(), "forge3d-chromium-support-"));
  try {
    const recordsDirectory = join(directory, "records");
    mkdirSync(recordsDirectory);
    input.records.forEach((record, index) =>
      writeFileSync(join(recordsDirectory, `${index}.json`), JSON.stringify(record)),
    );
    const paths = {
      readiness: join(directory, "readiness.json"),
      readinessArtifact: join(directory, "readiness-artifact.json"),
      readinessRun: join(directory, "readiness-run.json"),
      packageRun: join(directory, "package-run.json"),
      labReadinessRun: join(directory, "lab-readiness-run.json"),
      labReadiness: join(directory, "lab-readiness.json"),
      matrix: join(directory, "matrix.json"),
      policy: join(directory, "policy.json"),
      output: join(directory, "chromium-support.md"),
    };
    writeFileSync(paths.readiness, `${canonicalJson(input.readiness)}\n`);
    writeFileSync(paths.readinessArtifact, JSON.stringify(input.readinessArtifact));
    writeFileSync(paths.readinessRun, JSON.stringify(input.readinessRun));
    writeFileSync(paths.packageRun, JSON.stringify(input.packageRun));
    writeFileSync(paths.labReadinessRun, JSON.stringify(input.labReadinessRun));
    writeFileSync(paths.labReadiness, input.labReadinessBytes);
    writeFileSync(paths.matrix, JSON.stringify(input.matrix));
    writeFileSync(paths.policy, JSON.stringify(input.policy));
    const result = spawnSync(process.execPath, [
      fileURLToPath(
        new URL("../../scripts/chromium-support-publication.mjs", import.meta.url),
      ),
      "--target-sha", input.targetSha,
      "--readiness", paths.readiness,
      "--readiness-artifact", paths.readinessArtifact,
      "--readiness-run", paths.readinessRun,
      "--package-run", paths.packageRun,
      "--lab-readiness-run", paths.labReadinessRun,
      "--lab-readiness", paths.labReadiness,
      "--records-directory", recordsDirectory,
      "--matrix", paths.matrix,
      "--policy", paths.policy,
      "--repository", input.repository,
      "--output", paths.output,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(paths.output, "utf8"), publish(input).document);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function rebindReadiness(input) {
  input.readiness = {
    ...input.readiness,
    recordDigests: [...input.records]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((record) => ({
        key: record.key,
        workflowRunId: record.workflow.runId,
        artifactId: record.workflow.artifactId,
        sha256: sha256Hex(record),
      })),
    evidenceRunIds: [...new Set(input.records.map((record) => record.workflow.runId))]
      .sort((left, right) => left - right),
  };
}
