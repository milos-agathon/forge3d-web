import { readFileSync } from "node:fs";

import { validChr03HardwareProof } from "../browser/chr03-hardware-proof-fixture.mjs";
import { validChr04HardwareProof } from "../browser/chr04-hardware-proof-fixture.mjs";
import { validSaf02Conformance } from "../browser/saf02-conformance-fixture.mjs";
import { CHR04_LANES } from "../../scripts/chr04-lanes.mjs";
import { canonicalJson, sha256Hex } from "../../scripts/canonical-json.mjs";
import {
  mergeBrowserEvidence,
  requiredEvidenceRows,
} from "../../scripts/merge-browser-evidence.mjs";
import { exactHostInventory } from "./host-inventory-fixture.mjs";

export const targetSha = "a".repeat(40);
export const packageSha256 = "b".repeat(64);
export const matrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
export const policy = JSON.parse(
  readFileSync(new URL("./browser-policy.json", import.meta.url), "utf8"),
);

export function validPublicationInput({ skipMerge = false } = {}) {
  const labReadiness = validLabReadiness();
  const labReadinessBytes = Buffer.from(`${canonicalJson(labReadiness)}\n`, "utf8");
  const labIdentity = {
    runId: 80,
    manifestSha256: sha256Hex(labReadinessBytes),
    labInfrastructureDigest: "c".repeat(64),
  };
  const macInventory = exactHostInventory(matrix, "FW-MAC-M2-01");
  const rows = requiredEvidenceRows(matrix);
  const records = rows.map((row, index) => {
    const safariTrackpad =
      row.lane === "safari-macos-m2" || row.checklistId === "safari-trackpad";
    const edge = row.lane.startsWith("edge-");
    const chrome = row.lane.startsWith("chrome-");
    const edgePlatform = edge ? CHR04_LANES[row.lane].platform : null;
    const inferredPlatform = row.lane.includes("windows")
      ? "win32"
      : row.lane.includes("macos")
        ? "darwin"
        : "linux";
    const platform = safariTrackpad ? "darwin" : edgePlatform ?? inferredPlatform;
    const system = row.kind === "manual"
      ? { os: "darwin", build: safariTrackpad ? macInventory.osBuild : "25A456" }
      : {
          platform,
          osBuild: safariTrackpad
            ? macInventory.osBuild
            : platform === "win32"
            ? JSON.stringify({ caption: "Microsoft Windows 11 Pro", productType: 1, version: "10.0.26200", buildNumber: "26200", displayVersion: "25H2", editionId: "Professional", ubr: 1000, registryProductName: "Windows 10 Pro" })
            : platform === "darwin"
              ? "macOS 26.0 (25A456)"
              : "Ubuntu 24.04.1 LTS",
          displayServer: platform === "win32"
            ? "Desktop Window Manager"
            : platform === "darwin"
              ? "WindowServer"
              : "GNOME Wayland",
        };
    const browser = safariTrackpad
      ? { name: "Safari", channel: "stable", version: "26.0" }
      : edge
        ? { name: "msedge", channel: "stable", version: "150.0.1.2" }
        : chrome
          ? { name: "chrome", channel: "stable", version: "150.0.7339.12" }
          : { name: "firefox", channel: "release", version: "150.0.1" };
    const driver = safariTrackpad
      ? { name: "safaridriver", version: "26.0" }
      : edge
        ? { name: "playwright-edge", version: "1.56.1" }
        : chrome
          ? { name: "playwright-chrome", version: "1.56.1" }
          : { name: "selenium-firefox", version: "4.35.0" };
    const hostInventory = safariTrackpad ? structuredClone(macInventory) : null;
    const workflow = {
      runId: 100 + index,
      runAttempt: 2,
      artifactId: 200 + index,
      path: row.kind === "manual"
        ? ".github/workflows/submit-browser-manual-evidence.yml"
        : ".github/workflows/browser-hardware.yml",
      ref: "refs/heads/main",
      conclusion: "success",
    };
    const record = {
      schemaVersion: 1,
      ...row,
      trustedSha: targetSha,
      packageRunId: 50,
      packageSha256,
      labInfrastructureDigest: labIdentity.labInfrastructureDigest,
      labReadiness: { ...labIdentity },
      system,
      browser,
      driver,
      hostInventory,
      result: "PASS",
      infrastructureError: null,
      workflow,
      attestation: { verified: true, denySelfHostedRunners: true },
    };
    if (row.kind === "manual") {
      return {
        ...record,
        stepResults: { A: "pass", B: "pass", C: "pass", D: "pass" },
        session: {
          trustedSha: targetSha,
          packageRunId: 50,
          packageSha256,
          assetId: row.assetId,
          hostId: row.hostId,
          labReadiness: { ...labIdentity },
          system: structuredClone(system),
          browser: structuredClone(browser),
          driver: structuredClone(driver),
          hostInventory: hostInventory ? structuredClone(hostInventory) : null,
          result: "success",
        },
        expiresAt: "2026-10-05T00:00:00.000Z",
      };
    }
    const adapter = {
      isFallbackAdapter: false,
      secureContext: true,
      deviceCreated: true,
      surfacePresented: true,
      presentedFrameLumaSamples: [0.1, 0.8],
      presentedFrameLumaDelta: 0.7,
      lumaChanged: true,
    };
    const saf02Proof = row.lane === "safari-macos-m2"
      ? validSaf02Conformance({
          runId: workflow.runId,
          jobId: 300 + index,
          commit: targetSha,
          packageSha256,
        })
      : null;
    return {
      ...record,
      effectiveLaunchArguments: [],
      adapter,
      adapterAttestation: {
        result: "PASS",
        required: true,
        binding: {
          runId: workflow.runId,
          assetId: row.assetId,
          commit: targetSha,
          packageSha256,
        },
        page: {
          isFallbackAdapter: false,
          secureContext: true,
          surfacePresented: true,
          presentedFrameLumaSamples: [0.1, 0.8],
          presentedFrameLumaDelta: 0.7,
          lumaChanged: true,
        },
        host: {
          hostId: row.hostId,
          expectedGpuPresent: true,
          headedSessionAvailable: true,
        },
      },
      ...(chrome && row.lane !== "chrome-windows-intel12"
        ? { chr03Proof: validChr03HardwareProof({ lane: row.lane, assetId: row.assetId, commit: targetSha, packageSha256 }) }
        : {}),
      ...(edge
        ? { chr04Proof: validChr04HardwareProof({ lane: row.lane, assetId: row.assetId, platform, commit: targetSha, packageSha256 }) }
        : {}),
      ...(saf02Proof
        ? {
            hardwareJobId: saf02Proof.binding.jobId,
            saf02Proof,
            saf02Route: {
              applicationUrl: `${saf02Proof.route.applicationOrigin}${saf02Proof.route.basePath}`,
              assetUrl: `${saf02Proof.route.assetOrigin}${saf02Proof.route.basePath}`,
            },
          }
        : {}),
    };
  });
  if (skipMerge) return { records, matrix, policy };
  const readiness = mergeBrowserEvidence({
    targetSha,
    packageSha256,
    labReadiness: {
      status: "LAB_INFRA_READY",
      run: { id: 80, attempt: 1, workflowSha: targetSha },
      runId: 80,
      packageRunId: 50,
      candidateSha: targetSha,
      packageSha256,
      manifestSha256: labIdentity.manifestSha256,
      labInfrastructureDigest: labIdentity.labInfrastructureDigest,
    },
    records,
    matrix,
    now: new Date("2026-09-18T00:00:00.000Z"),
  }).manifest;
  return {
    targetSha,
    readiness,
    readinessArtifact: {
      id: 901,
      name: "browser-hardware-release-readiness",
      expired: false,
      digest: `sha256:${"9".repeat(64)}`,
      workflow_run: { id: 900, head_sha: targetSha },
    },
    readinessRun: {
      id: 900,
      run_attempt: 3,
      path: ".github/workflows/browser-hardware-release-readiness.yml",
      head_sha: targetSha,
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
    },
    labReadinessRun: {
      id: 80,
      run_attempt: 5,
      path: ".github/workflows/browser-lab-infrastructure-readiness.yml",
      head_sha: targetSha,
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
    },
    labReadiness,
    labReadinessBytes,
    packageRun: {
      packageRunId: 50,
      packageRunAttempt: 4,
      packageWorkflowPath: ".github/workflows/browser-package.yml",
      packageWorkflowSha: targetSha,
      packageArtifactId: 49,
    },
    records,
    matrix,
    policy,
    repository: "milos-agathon/forge3d-web",
  };
}

function validLabReadiness() {
  const digest = "c".repeat(64);
  const timestamp = "2026-09-17T23:00:00.000Z";
  const verification = {
    outputBytesBase64: "e30=",
    outputSha256: digest,
    output: {},
  };
  return {
    schemaVersion: 1,
    status: "LAB_INFRA_READY",
    supportClaim: false,
    repository: "milos-agathon/forge3d-web",
    workflow: ".github/workflows/browser-lab-infrastructure-readiness.yml",
    run: { id: 80, attempt: 5, workflowSha: targetSha },
    candidateSha: targetSha,
    packageRunId: 50,
    packageSha256,
    configurationDigest: digest,
    labInfrastructureDigest: digest,
    configurationFiles: Array.from({ length: 16 }, (_, index) => ({
      path: `config-${index}`,
      sha256: digest,
    })),
    serviceInstallations: { broker: {}, controllers: [{}, {}, {}, {}] },
    serviceInstallationDigest: digest,
    diagnosticRetentions: ["FW-MAC-M2-01", "FW-WIN-I12-01", "FW-LNX-I12-01", "FW-LNX-NV-01"].map((hostId, index) => ({
      hostId,
      runId: 10 + index,
      receiptSha256: digest,
      filesSha256: digest,
    })),
    hostCanaryRunIds: [10, 11, 12, 13],
    hostCanaryFreshness: ["FW-MAC-M2-01", "FW-WIN-I12-01", "FW-LNX-I12-01", "FW-LNX-NV-01"].map((hostId, index) => ({
      hostId,
      runId: 10 + index,
      inventoryCapturedAt: timestamp,
      hardwareJobCompletedAt: timestamp,
      controllerCompletedAt: timestamp,
      finalizerObservedAt: timestamp,
      selectedRunCompletedAt: timestamp,
      acceptanceWindowHours: 24,
    })),
    mobileRouteReadiness: {
      hostId: "FW-MAC-M2-01",
      hostCanaryRunId: 10,
      evidenceSha256: digest,
      completedAt: timestamp,
      applicationUrl: "https://example.test/app",
      assetUrl: "https://example.test/asset",
      basePath: `/runs/1/1/${"a".repeat(32)}/`,
      packageSha256,
      devices: ["AND-1", "AND-2", "AND-3", "IOS-1", "IOS-2", "IPAD-1"].map((id) => ({
        assetId: `FW-${id}`,
        appiumId: id,
        observedAt: timestamp,
      })),
    },
    manualCanary: {
      runId: 20,
      intakeReleaseId: 21,
      hardwareJobId: 22,
      createdAt: timestamp,
      selectedRunCreatedAt: timestamp,
      selectedRunCompletedAt: timestamp,
      acceptanceWindowHours: 24,
    },
    canaryReleaseId: 30,
    canaryPublication: {
      run: { id: 31, attempt: 1, workflowPath: ".github/workflows/publish-browser-lab-canary.yml" },
      artifact: { id: 32, name: "lab-canary-publication-31-1", digest: `sha256:${digest}`, archiveSha256: digest },
      attestation: { verified: true, repository: "milos-agathon/forge3d-web", signerWorkflow: "milos-agathon/forge3d-web/.github/workflows/publish-browser-lab-canary.yml", sourceRef: "refs/heads/main", sourceDigest: targetSha, denySelfHostedRunners: true },
      recordSha256: digest,
      release: { id: 30, tagName: "lab-canary", targetCommitish: targetSha, immutable: true },
      retainedMedia: [{ sourceAssetId: 33, sourceName: "proof.png", releaseName: "manual-media-33", size: 1, mimeType: "image/png", sha256: digest, sourceApiDigest: `sha256:${digest}` }],
      verification: {
        release: verification,
        assets: [{ id: 33, name: "proof.png", size: 1, apiDigest: `sha256:${digest}`, sha256: digest, verification }],
        bundleSha256: digest,
        verifiedAt: timestamp,
      },
    },
    createdAt: timestamp,
  };
}
