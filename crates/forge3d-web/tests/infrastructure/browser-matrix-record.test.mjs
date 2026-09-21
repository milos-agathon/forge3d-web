import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createAutomatedMatrixRecord,
  createManualMatrixRecord,
  finalizeMatrixRecord,
} from "../../scripts/create-browser-matrix-record.mjs";
import { exactHostInventory } from "./host-inventory-fixture.mjs";
import { validChr03HardwareProof } from "../browser/chr03-hardware-proof-fixture.mjs";
import { validChr04HardwareProof } from "../browser/chr04-hardware-proof-fixture.mjs";
import { validSaf03Proof, validStpResult } from "../browser/saf03-proof-fixture.mjs";
import { validSaf02Conformance } from "../browser/saf02-conformance-fixture.mjs";
import { validSaf04HardwareProof } from "../browser/saf04-hardware-proof-fixture.mjs";
import { validFfx04LifecycleProof } from "../browser/ffx04-lifecycle-proof-fixture.mjs";

const matrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const labReadiness = {
  runId: 9,
  manifestSha256: "9".repeat(64),
  labInfrastructureDigest: "c".repeat(64),
};

test("automated and manual sources derive closed matrix keys without artifact claims", () => {
  const automatedInput = {
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
      chr03Proof: validChr03HardwareProof({ packageSha256: "d".repeat(64) }),
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
  };
  const automated = createAutomatedMatrixRecord(automatedInput);
  assert.equal(automated.key, "automated:FW-LNX-NV-01:chrome-linux-rtx3070");
  assert.equal(automated.packageRunId, 8);
  assert.equal(automated.workflow.runAttempt, 2);
  const invalidProof = structuredClone(automatedInput);
  invalidProof.evidence.chr03Proof.systemInfo.available = "false";
  assert.throws(() => createAutomatedMatrixRecord(invalidProof), /expected type boolean/u);
  const edgeInput = structuredClone(automatedInput);
  Object.assign(edgeInput.promotion, { lane: "edge-linux-rtx3070" });
  Object.assign(edgeInput.evidence, {
    lane: "edge-linux-rtx3070",
    browser: { name: "msedge", channel: "stable", version: "150.0.1.2" },
    driver: { name: "playwright-edge", version: "1.56.1" },
    effectiveLaunchArguments: [],
    chr03Proof: null,
    chr04Proof: validChr04HardwareProof({ packageSha256: "d".repeat(64) }),
  });
  const edge = createAutomatedMatrixRecord(edgeInput);
  assert.equal(edge.key, "automated:FW-LNX-NV-01:edge-linux-rtx3070");
  assert.equal(edge.chr04Proof.kind, "forge3d-chr04-edge-hardware-proof-v1");
  for (const mutate of [
    (input) => { input.evidence.chr04Proof = null; },
    (input) => { input.evidence.browser.name = "chrome"; },
    (input) => { input.evidence.effectiveLaunchArguments = ["--ignore-gpu-blocklist"]; },
    (input) => { input.evidence.effectiveLaunchArguments = ["--ignore-certificate-errors=value"]; },
    (input) => { input.evidence.chr04Proof.edgeAcceptance.touch.viewChanged = false; },
    (input) => { input.evidence.chr04Proof.edgeAcceptance.unsupported.nullAdapter.publicCode = "WEBGPU_UNAVAILABLE"; },
    (input) => { input.evidence.chr04Proof.edgeAcceptance.unsupported.nullAdapter.unsupportedVisible = false; },
    (input) => { input.evidence.chr04Proof.edgeAcceptance.unsupported.nullAdapter.hasBypassAdvice = true; },
  ]) {
    const invalidEdge = structuredClone(edgeInput);
    mutate(invalidEdge);
    assert.throws(() => createAutomatedMatrixRecord(invalidEdge));
  }
  const safariInput = structuredClone(automatedInput);
  Object.assign(safariInput.promotion, { lane: "safari-macos-m2", hostId: "FW-MAC-M2-01", assetId: "FW-MAC-M2-01" });
  const safariProof = validSaf02Conformance({ runId: 10, jobId: 22, commit: "a".repeat(40), packageSha256: "d".repeat(64) });
  const safariRoute = {
    applicationUrl: `${safariProof.route.applicationOrigin}${safariProof.route.basePath}`,
    assetUrl: `${safariProof.route.assetOrigin}${safariProof.route.basePath}`,
  };
  Object.assign(safariInput.evidence, {
    lane: "safari-macos-m2",
    runId: 10,
    jobId: 22,
    browser: { name: "safari", channel: "stable", version: "26.0" },
    driver: { name: "safaridriver", version: "Included with Safari 26.0" },
    system: { platform: "darwin", osVersion: "26.0", osBuild: "macOS build 25A123", architecture: "arm64", displayServer: "WindowServer" },
    route: safariRoute,
    effectiveLaunchArguments: [],
    chr03Proof: null,
    saf02Proof: safariProof,
    saf04Proof: validSaf04HardwareProof({ commit: "a".repeat(40), packageSha256: "d".repeat(64) }),
    saf03Proof: validSaf03Proof({ commit: "a".repeat(40), packageSha256: "d".repeat(64) }),
  });
  safariInput.attestation.binding.assetId = "FW-MAC-M2-01";
  safariInput.attestation.host.hostId = "FW-MAC-M2-01";
  const safariInventory = exactHostInventory(matrix, "FW-MAC-M2-01");
  safariInventory.osVersion = safariInput.evidence.system.osVersion;
  safariInventory.osBuild = safariInput.evidence.system.osBuild;
  safariInventory.architecture = safariInput.evidence.system.architecture;
  safariInventory.browsers.push(
    { id: "safari-stable", channel: "stable", classification: "required", automation: "safaridriver", version: "26.0", executable: "/Applications/Safari.app/Contents/MacOS/Safari" },
    { id: "safari-technology-preview", channel: "technology-preview", classification: "probe", automation: "safaridriver", version: "26.1", executable: "/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview" },
  );
  Object.assign(safariInventory.tools, { safaridriverPath: "/usr/bin/safaridriver", safaridriverVersion: "Included with Safari 26.0", safariTechnologyPreviewDriverPath: "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver", safariTechnologyPreviewDriverVersion: "26.1" });
  safariInput.hostInventory = safariInventory;
  safariInput.matrix = matrix;
  safariInput.evidence.safariTechnologyPreview = validStpResult(safariInventory, {
    commit: "a".repeat(40), packageSha256: "d".repeat(64),
  });
  safariInput.evidence.safariTechnologyPreview.probe.route = safariRoute.applicationUrl;
  const safari = createAutomatedMatrixRecord(safariInput);
  assert.equal(safari.saf02Proof.result, "PASS");
  assert.deepEqual(safari.saf02Route, safariRoute);
  assert.equal(safari.saf03Proof.kind, "forge3d-saf03-safari-acceptance-v1");
  assert.equal(safari.safariTechnologyPreview.replacesStable, false);
  const safariFinalization = {
    artifactId: 31,
    attestation: { verified: true, denySelfHostedRunners: true },
    selectedRun: { id: 10, attempt: 2, path: ".github/workflows/browser-hardware.yml" },
  };
  assert.equal(finalizeMatrixRecord({ source: safari, ...safariFinalization }).workflow.artifactId, 31);
  const splitRoute = structuredClone(safari);
  splitRoute.route.applicationUrl = "https://unrelated.example.invalid/run/";
  splitRoute.safariTechnologyPreview.probe.route = splitRoute.route.applicationUrl;
  assert.throws(
    () => finalizeMatrixRecord({ source: splitRoute, ...safariFinalization }),
    /same exact authorized route/u,
  );
  for (const mutate of [
    (source) => { source.saf02Proof.binding.jobId += 1; },
    (source) => { source.saf02Route.applicationUrl = "https://unrelated.example.invalid/run/"; },
    (source) => { source.saf03Proof.browser.version = "26.1"; },
    (source) => { source.saf03Proof.driver.version = "wrong"; },
    (source) => { source.saf03Proof.system.osVersion = "25.6"; },
    (source) => { source.saf03Proof.system.osBuild = "macOS build 24Z999"; },
    (source) => { source.saf03Proof.system.architecture = "x64"; },
    (source) => { source.safariTechnologyPreview.probe.route = "https://unrelated.example.invalid/run/"; },
  ]) {
    const tampered = structuredClone(safari); mutate(tampered);
    assert.throws(() => finalizeMatrixRecord({ source: tampered, ...safariFinalization }));
  }
  for (const mutate of [
    (input) => { input.evidence.saf03Proof = null; },
    (input) => { input.evidence.saf03Proof.bfcacheCycles[0].events[1].persisted = false; },
    (input) => { input.evidence.safariTechnologyPreview.cleanup.ok = false; },
    (input) => { input.evidence.browser.version = "26.1"; },
    (input) => { input.evidence.driver.version = "wrong"; },
    (input) => { input.evidence.system.osVersion = "25.6"; },
    (input) => { input.evidence.system.osBuild = "macOS build 24Z999"; },
    (input) => { input.evidence.system.architecture = "x64"; },
    (input) => { input.evidence.safariTechnologyPreview.probe.route = "https://unrelated.example.invalid/run/"; },
  ]) {
    const invalidSafari = structuredClone(safariInput); mutate(invalidSafari);
    assert.throws(() => createAutomatedMatrixRecord(invalidSafari));
  }
  const replayedSafari = structuredClone(safariInput);
  replayedSafari.evidence.saf02Proof.binding.jobId = 23;
  assert.throws(() => createAutomatedMatrixRecord(replayedSafari));
  const unsafeSafari = structuredClone(safariInput);
  unsafeSafari.evidence.effectiveLaunchArguments = ["--ignore-certificate-errors=value"];
  assert.throws(() => createAutomatedMatrixRecord(unsafeSafari), /launch arguments/u);
  const compoundUnsafeSafari = structuredClone(safariInput);
  compoundUnsafeSafari.evidence.effectiveLaunchArguments = ["--enable-features=CanvasOopRasterization,WebGPU"];
  compoundUnsafeSafari.evidence.saf02Proof.environment.effectiveLaunchArguments = [...compoundUnsafeSafari.evidence.effectiveLaunchArguments];
  assert.throws(() => createAutomatedMatrixRecord({ ...compoundUnsafeSafari, hostInventory: exactHostInventory(matrix, "FW-MAC-M2-01"), matrix }), /prohibited browser launch arguments/u);
  assert.equal(safari.saf04Proof.kind, "forge3d-saf04-safari-lifecycle-proof-v1");
  const invalidSafari = structuredClone(safariInput);
  invalidSafari.evidence.saf04Proof.lifecycle.bfcacheCycles[0].pageshowPersisted = false;
  assert.throws(() => createAutomatedMatrixRecord({ ...invalidSafari, hostInventory: exactHostInventory(matrix, "FW-MAC-M2-01"), matrix }));
  const firefoxInput = structuredClone(automatedInput);
  Object.assign(firefoxInput.promotion, {
    lane: "firefox-macos-m2",
    hostId: "FW-MAC-M2-01",
    assetId: "FW-MAC-M2-01",
  });
  Object.assign(firefoxInput.evidence, {
    lane: "firefox-macos-m2",
    runId: 10,
    jobId: 20,
    system: { platform: "darwin", osBuild: "macOS 26", displayServer: "WindowServer" },
    browser: { name: "firefox", channel: "release", version: "147.0" },
    driver: { name: "selenium-firefox", version: "geckodriver 0.36.0" },
    route: { applicationUrl: `https://firefox.webgpu-ci.forge3d.dev/runs/10/20/${"c".repeat(32)}/` },
    chr03Proof: null,
    ffx04Proof: validFfx04LifecycleProof({
      commit: "a".repeat(40),
      packageSha256: "d".repeat(64),
      driverVersion: "geckodriver 0.36.0",
    }),
  });
  firefoxInput.attestation.binding.assetId = "FW-MAC-M2-01";
  firefoxInput.attestation.binding.jobId = 20;
  firefoxInput.attestation.host.hostId = "FW-MAC-M2-01";
  const firefox = createAutomatedMatrixRecord(firefoxInput);
  assert.equal(firefox.ffx04Proof.result, "PASS");
  assert.equal(firefox.fixtureApplicationUrl, firefoxInput.evidence.route.applicationUrl);
  for (const mutate of [
    (input) => { input.evidence.ffx04Proof = null; },
    (input) => { input.evidence.ffx04Proof.cycles[0].shown.persisted = false; },
    (input) => { input.evidence.runId = 11; },
    (input) => { input.evidence.jobId = 21; },
    (input) => { input.attestation.binding.jobId = 21; },
    (input) => { input.evidence.route.applicationUrl = "https://other.webgpu-ci.forge3d.dev/runs/10/20/cccccccccccccccccccccccccccccccc/"; },
  ]) {
    const invalidFirefox = structuredClone(firefoxInput);
    mutate(invalidFirefox);
    assert.throws(() => createAutomatedMatrixRecord(invalidFirefox), /FFX04/u);
  }
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
    /expected type object|does not match/u,
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
