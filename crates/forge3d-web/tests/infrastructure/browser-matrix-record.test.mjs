import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createAutomatedMatrixRecord,
  createManualMatrixRecord,
  finalizeMatrixRecord,
} from "../../scripts/create-browser-matrix-record.mjs";
import { exactHostInventory } from "./host-inventory-fixture.mjs";

const matrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const labReadiness = {
  runId: 9,
  manifestSha256: "9".repeat(64),
  labInfrastructureDigest: "c".repeat(64),
};

test("automated and manual sources derive closed matrix keys without artifact claims", () => {
  const automated = createAutomatedMatrixRecord({
    promotion: {
      lane: "chrome-linux-rtx3070",
      mode: "automated",
      hostId: "FW-LNX-NV-01",
      assetId: "FW-LNX-NV-01",
      trustedSha: "a".repeat(40),
      packageRunId: 8,
      packageManifestSha256: "b".repeat(64),
      labInfrastructureDigest: "c".repeat(64),
      labReadiness,
    },
    evidence: {
      result: "PASS",
      lane: "chrome-linux-rtx3070",
      trustedSha: "a".repeat(40),
      packageSha256: "d".repeat(64),
      packageManifestSha256: "b".repeat(64),
      system: {
        platform: "linux",
        osBuild: "Ubuntu 24.04.1",
        displayServer: "GNOME Wayland",
      },
      browser: { name: "chrome", channel: "stable", version: "150.0" },
      driver: { name: "playwright-chrome", version: "1.56.1" },
      adapter: {
        isFallbackAdapter: false,
        secureContext: true,
        deviceCreated: true,
        surfacePresented: true,
        presentedFrameLumaSamples: [0.1, 0.8],
        presentedFrameLumaDelta: 0.7,
        lumaChanged: true,
      },
    },
    attestation: {
      result: "PASS",
      required: true,
      binding: {
        runId: 10,
        assetId: "FW-LNX-NV-01",
        commit: "a".repeat(40),
        packageSha256: "d".repeat(64),
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
        hostId: "FW-LNX-NV-01",
        expectedGpuPresent: true,
        headedSessionAvailable: true,
      },
    },
    run: { id: 10, attempt: 2 },
  });
  assert.equal(automated.key, "automated:FW-LNX-NV-01:chrome-linux-rtx3070");
  assert.equal(automated.packageRunId, 8);
  assert.equal(automated.workflow.runAttempt, 2);
  const manual = createManualMatrixRecord({
    evidence: {
      checklistId: "safari-trackpad",
      run: { id: 20, attempt: 1 },
      assetId: "FW-TRACKPAD-01",
      hostId: "FW-MAC-M2-01",
      trustedSha: "a".repeat(40),
      packageRunId: 8,
      packageSha256: "d".repeat(64),
      labInfrastructureDigest: "c".repeat(64),
      labReadiness,
      system: {
        os: "darwin",
        build: exactHostInventory(matrix, "FW-MAC-M2-01").osBuild,
      },
      browser: { name: "Safari", channel: "stable", version: "26.0" },
      driver: { name: "safaridriver", version: "26.0" },
      hostInventory: exactHostInventory(matrix, "FW-MAC-M2-01"),
      stepResults: { A: "pass", B: "pass", C: "pass", D: "pass" },
      manualSessionRunId: 21,
      manualSessionJobId: 22,
      authorizationSha256: "e".repeat(64),
      controllerSignatureSha256: "f".repeat(64),
      routeBasePath: `/runs/21/22/${"1".repeat(32)}/`,
      mediaChallenge: "2".repeat(32),
      expiresAt: "2026-08-01T00:00:00Z",
    },
    run: { id: 20, attempt: 1 },
  });
  assert.equal(manual.key, "manual:FW-TRACKPAD-01:safari-trackpad");
  assert.equal(manual.packageRunId, 8);
  assert.equal(manual.session.packageRunId, 8);
  assert.deepEqual(manual.labReadiness, labReadiness);
  assert.equal(manual.browser.version, "26.0");
  assert.equal(manual.hostInventory.trackpad.assetId, "FW-TRACKPAD-01");
  const final = finalizeMatrixRecord({
    source: manual,
    artifactId: 30,
    attestation: { verified: true, denySelfHostedRunners: true },
    selectedRun: {
      id: 20,
      attempt: 1,
      path: ".github/workflows/submit-browser-manual-evidence.yml",
    },
  });
  assert.equal(final.workflow.artifactId, 30);
  assert.equal(final.workflow.runAttempt, 1);
});

test("infrastructure canary, fallback adapter, failed identity, and unattested artifact fail", () => {
  assert.throws(() =>
    createAutomatedMatrixRecord({
      promotion: { lane: "infrastructure-canary", mode: "canary-host" },
      evidence: {},
      run: {},
    }),
  );
  assert.throws(
    () =>
      createAutomatedMatrixRecord({
        promotion: {
          lane: "chrome-linux-rtx3070",
          mode: "automated",
          hostId: "FW-LNX-NV-01",
          assetId: "FW-LNX-NV-01",
          trustedSha: "a".repeat(40),
          packageRunId: 8,
          packageManifestSha256: "b".repeat(64),
          labInfrastructureDigest: "c".repeat(64),
          labReadiness,
        },
        evidence: {
          result: "PASS",
          lane: "chrome-linux-rtx3070",
          trustedSha: "a".repeat(40),
          packageSha256: "d".repeat(64),
          packageManifestSha256: "b".repeat(64),
          system: {
            platform: "linux",
            osBuild: "Ubuntu 24.04.1",
            displayServer: "GNOME Wayland",
          },
          browser: { name: "chrome", channel: "stable", version: "150.0" },
          driver: { name: "playwright-chrome", version: "1.56.1" },
          adapter: {
            isFallbackAdapter: false,
            secureContext: true,
            deviceCreated: true,
            surfacePresented: true,
            presentedFrameLumaSamples: [0.1, 0.8],
            presentedFrameLumaDelta: 0.7,
            lumaChanged: true,
          },
        },
        run: { id: 10, attempt: 1 },
      }),
    /does not match/u,
  );
  assert.throws(
    () =>
      createAutomatedMatrixRecord({
        promotion: { packageRunId: 0 },
        run: { id: 10, attempt: 1 },
      }),
    /package run ID/u,
  );
  assert.throws(
    () =>
      createManualMatrixRecord({
        evidence: { packageRunId: null },
        run: { id: 20, attempt: 1 },
      }),
    /package run ID/u,
  );
  assert.throws(() =>
    finalizeMatrixRecord({
      source: {},
      artifactId: 1,
      attestation: { verified: false, denySelfHostedRunners: true },
      selectedRun: {
        id: 1,
        attempt: 1,
        path: ".github/workflows/browser-hardware.yml",
      },
    }),
  );
});

test("finalization rejects stale embedded workflow run identity", () => {
  const source = {
    workflow: {
      runId: 20,
      runAttempt: 3,
      path: ".github/workflows/submit-browser-manual-evidence.yml",
    },
  };
  const valid = {
    source,
    artifactId: 30,
    attestation: { verified: true, denySelfHostedRunners: true },
    selectedRun: {
      id: 20,
      attempt: 3,
      path: ".github/workflows/submit-browser-manual-evidence.yml",
    },
  };
  assert.equal(finalizeMatrixRecord(valid).workflow.artifactId, 30);
  for (const workflow of [
    { ...source.workflow, runId: 21 },
    { ...source.workflow, runAttempt: 2 },
    { ...source.workflow, path: ".github/workflows/browser-hardware.yml" },
  ]) {
    assert.throws(
      () =>
        finalizeMatrixRecord({
          ...valid,
          source: { ...source, workflow },
        }),
      /does not match the selected workflow run/u,
    );
  }
});
