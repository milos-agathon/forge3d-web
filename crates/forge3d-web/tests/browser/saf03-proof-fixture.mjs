import { validChr03HardwareProof } from "./chr03-hardware-proof-fixture.mjs";

const initialView = Object.freeze({ target: [0, 0, 0], distance: 2.72, yawDegrees: 0, pitchDegrees: 24, fovYDegrees: 46, near: 0.01, far: 100 });
const changedView = Object.freeze({ ...initialView, yawDegrees: 10 });
const liveOwnership = Object.freeze({ activeRuntimes: 1, ownedListeners: 12, activeObservers: 1, activePointers: 0, pendingAnimationFrame: false, ownedAnimationFrameCount: 0 });
const disposedOwnership = Object.freeze({ activeRuntimes: 0, ownedListeners: 0, activeObservers: 0, activePointers: 0, pendingAnimationFrame: false, ownedAnimationFrameCount: 0 });

export function validSaf03Proof({ commit = "a".repeat(40), packageSha256 = "b".repeat(64) } = {}) {
  const pixels = (salt) => ({ decoded: true, nonBlank: true, sampleCount: 4096, terrainPixelCount: 2048,
    lumaMinimum: 0.1, lumaMaximum: 0.8, sha256: salt.repeat(64) });
  const snapshot = (view, frame, salt) => ({ view: structuredClone(view), submittedFrames: frame, pixels: pixels(salt) });
  const visibilityCycles = Array.from({ length: 30 }, (_, index) => ({
    cycle: index + 1, documentIdentityBefore: "document-stable", documentIdentityAfter: "document-stable", viewerIdentityBefore: "viewer-stable", viewerIdentityAfter: "viewer-stable",
    hiddenEvent: { sequence: index * 2 + 2, type: "visibilitychange", state: "hidden", persisted: null },
    visibleEvent: { sequence: index * 2 + 3, type: "visibilitychange", state: "visible", persisted: null },
    submittedFramesBefore: 20 + index, submittedFramesAfter: 21 + index, submittedFrameFresh: true,
    ownership: { ...liveOwnership }, pixels: pixels("c"),
  }));
  const bfcacheCycles = Array.from({ length: 30 }, (_, index) => ({
    cycle: index + 1, documentIdentityBefore: "document-stable", documentIdentityAfter: "document-stable", viewerIdentityBefore: "viewer-stable", viewerIdentityAfter: "viewer-stable",
    events: [
      { sequence: 62 + index * 2, type: "pagehide", state: "hidden", persisted: true },
      { sequence: 63 + index * 2, type: "pageshow", state: "visible", persisted: true },
    ],
    submittedFramesBefore: 60 + index, submittedFramesAfter: 61 + index, submittedFrameFresh: true,
    ownership: { ...liveOwnership }, pixels: pixels("d"),
  }));
  const benchmark = validChr03HardwareProof().benchmark;
  return {
    schemaVersion: 1, kind: "forge3d-saf03-safari-acceptance-v1",
    binding: { lane: "safari-macos-m2", assetId: "FW-MAC-M2-01", platform: "darwin", commit, packageSha256 },
    browser: { name: "safari", channel: "stable", version: "26.0" },
    driver: { name: "safaridriver", version: "Included with Safari 26.0", executable: "/usr/bin/safaridriver", clientName: "selenium-webdriver", clientVersion: "4.35.0" },
    system: { platform: "darwin", osVersion: "26.0", osBuild: "macOS build 25A123", architecture: "arm64" },
    secureContext: true, adapter: { isFallbackAdapter: false, secureContext: true, deviceCreated: true, surfacePresented: true },
    actions: {
      orbit: { action: "orbit", native: true, before: snapshot(initialView, 1, "a"), after: snapshot(changedView, 2, "b"), changed: true },
      pan: { action: "pan", native: true, before: snapshot(changedView, 2, "b"), after: snapshot({ ...changedView, target: [1, 0, 0] }, 3, "c"), changed: true },
      wheelZoom: { action: "wheelZoom", native: true, before: snapshot(changedView, 3, "c"), after: snapshot({ ...changedView, distance: 2 }, 4, "d"), changed: true },
      reset: { action: "reset", native: true, key: "Home", before: snapshot(changedView, 4, "d"), after: snapshot(initialView, 5, "e"), initialView: structuredClone(initialView), tolerance: 1e-9, matchedInitial: true },
      resize: { action: "resize", native: true, fixtureControl: "#resize", cssBefore: { width: 322, height: 322 }, cssAfter: { width: 242, height: 322 }, backingBefore: { width: 320, height: 320 }, backingAfter: { width: 240, height: 320 }, submittedFrameFresh: true, pixelsBefore: pixels("e"), pixelsAfter: pixels("f") },
    },
    screenshots: {
      native: { mimeType: "image/png", byteLength: 1000, sha256: "1".repeat(64), width: 900, height: 700, pixels: pixels("1") },
      viewer: { mimeType: "image/png", byteLength: 900, sha256: "2".repeat(64), width: 240, height: 320, pixels: pixels("2") },
    },
    lifecycleBaseline: { documentIdentity: "document-stable", viewerIdentity: "viewer-stable", lastEventSequence: 1, ownership: { ...liveOwnership } },
    visibilityCycles, bfcacheCycles,
    hardReload: { pageshowPersisted: false, previousDocumentIdentity: "document-stable", documentIdentity: "document-new", previousViewerIdentity: "viewer-stable", viewerIdentity: "viewer-new", submittedFrameFresh: true, ownership: { ...liveOwnership }, pixels: pixels("3") },
    disposal: { ...disposedOwnership }, benchmark,
    errorObservations: { beforeReload: [], reloadBoundary: [], afterReload: [] }, errors: [],
  };
}

export function validStpResult(inventory, { commit = "a".repeat(40), packageSha256 = "b".repeat(64) } = {}) {
  const installed = inventory.browsers.find(({ id }) => id === "safari-technology-preview");
  return { kind: "forge3d-saf03-stp-result-v1",
    binding: { lane: "safari-macos-m2", assetId: "FW-MAC-M2-01", commit, packageSha256 },
    channel: "technology-preview", classification: "probe", required: false,
    replacesStable: false, clientVersion: "4.35.0", executable: installed.executable,
    driverExecutable: inventory.tools.safariTechnologyPreviewDriverPath, driverVersion: inventory.tools.safariTechnologyPreviewDriverVersion, version: installed.version,
    browser: { name: "safari", channel: "technology-preview", version: installed.version }, result: "PASS", warning: null,
    cleanup: { notStarted: false, sessionDeleted: true, driverStopped: true, processAbsent: true, ok: true },
    probe: { schemaVersion: 1, binding: { lane: "safari-macos-m2", assetId: "FW-MAC-M2-01", commit, packageSha256 },
      route: "https://safari.example.invalid/run/", submittedFrames: 1, errors: [],
      screenshot: { mimeType: "image/png", byteLength: 900, sha256: "4".repeat(64), width: 320, height: 320,
        pixels: { decoded: true, nonBlank: true, sampleCount: 4096, terrainPixelCount: 2048, lumaMinimum: 0.1, lumaMaximum: 0.8, sha256: "5".repeat(64) } } } };
}

export function validAbsentStpResult() {
  return { kind: "forge3d-saf03-stp-result-v1",
    binding: { lane: "safari-macos-m2", assetId: "FW-MAC-M2-01", commit: "a".repeat(40), packageSha256: "b".repeat(64) },
    channel: "technology-preview", classification: "probe", required: false, replacesStable: false,
    clientVersion: "4.35.0", executable: null, driverExecutable: null, driverVersion: null,
    version: null, browser: null, result: "ABSENT",
    warning: "Safari Technology Preview is not installed on the checked host",
    cleanup: { notStarted: true, sessionDeleted: null, driverStopped: null, processAbsent: true, ok: true }, probe: null };
}
