import { validChr03HardwareProof } from "./chr03-hardware-proof-fixture.mjs";

export function validFfx03Proof({
  lane = "firefox-macos-m2", assetId = "FW-MAC-M2-01", platform = "darwin",
  architecture = "arm64", version = "147.0", commit = "a".repeat(40),
  packageSha256 = "b".repeat(64),
  adapter = null,
} = {}) {
  const workload = validChr03HardwareProof({ lane, assetId, commit, packageSha256 });
  workload.kind = "forge3d-ffx03-firefox-workload-v1";
  workload.visibility.cycleCount = 1;
  workload.screenshot.pixels = { decoded: true, nonBlank: true };
  return {
    schemaVersion: 1, kind: "forge3d-ffx03-firefox-hardware-proof-v1",
    classification: "required", required: true, experimental: false,
    binding: { lane, assetId, platform, architecture, channel: "release", commit, packageSha256 },
    browser: { name: "firefox", channel: "release", version },
    driver: { name: "selenium-firefox", version: "0.36.0", executable: "/opt/forge3d/geckodriver",
      clientName: "selenium-webdriver", clientVersion: "4.35.0" },
    system: { platform, architecture, osBuild: "fixture-build" },
    launch: { observed: true, source: `${platform}-live-browser-process`, browserProcessId: 42,
      executable: "/Applications/Firefox.app/Contents/MacOS/firefox", arguments: ["-profile", "/tmp/profile"] },
    configuration: { source: "geckodriver-generated-profile-observation", freshProfile: true,
      profilePathSha256: "c".repeat(64), requestedOverrides: {}, observedWebGpuUserOverrides: {}, afterWorkload: {} },
    adapter: adapter ?? validFfxAdapter({ assetId, commit, packageSha256 }), workload, errors: [],
    cleanup: { sessionDeleted: true, driverStopped: true, driverAbsent: true, browserAbsent: true, ok: true },
  };
}

export function validFfx03NightlyOutcome({ outcome = "PROBE_PASS" } = {}) {
  return {
    schemaVersion: 1, kind: "forge3d-ffx03-firefox-nightly-probe-v1", classification: "probe",
    required: false, experimental: true, outcome,
    binding: { lane: "firefox-nightly-linux-intel12", assetId: "FW-LNX-I12-01", platform: "linux",
      architecture: "x64", channel: "nightly", commit: "a".repeat(40), packageSha256: "b".repeat(64) },
    browser: { name: "firefox", channel: "nightly", version: "148.0a1" },
    driver: { name: "selenium-firefox", version: "0.36.0", executable: "/opt/geckodriver",
      clientName: "selenium-webdriver", clientVersion: "4.35.0" },
    system: { platform: "linux", architecture: "x64", osBuild: "fixture-build" },
    launch: { observed: true, source: "linux-live-browser-process", browserProcessId: 42,
      executable: "/opt/firefox-nightly/firefox", arguments: ["-profile", "/tmp/profile"] },
    configuration: { source: "geckodriver-generated-profile-observation", freshProfile: true,
      profilePathSha256: "c".repeat(64), requestedOverrides: { "dom.webgpu.enabled": true },
      observedWebGpuUserOverrides: { "dom.webgpu.enabled": true }, afterWorkload: { "dom.webgpu.enabled": true } },
    route: "https://fixture.example/run/", adapter: outcome === "PROBE_PASS"
      ? validFfxAdapter({ assetId: "FW-LNX-I12-01", commit: "a".repeat(40), packageSha256: "b".repeat(64) }) : null,
    diagnostic: outcome === "PROBE_PASS" ? null : "WebGPU adapter unavailable",
    cleanup: { sessionDeleted: true, driverStopped: true, driverAbsent: true, browserAbsent: true, ok: true },
  };
}

export function validFfxAdapter({ assetId, commit, packageSha256 }) {
  return { schemaVersion: 1, runId: 11, jobId: 12, assetId, commit, packageSha256,
    secureContext: true, navigatorGpu: true, adapterInfoAvailable: true,
    adapterInfo: { vendor: "fixture" }, isFallbackAdapter: false,
    deviceAdapterInfo: { vendor: "fixture" }, limits: { maxTextureDimension2D: 8192 },
    deviceCreated: true, surfaceCreated: true, surfacePresented: true,
    presentedFrameLumaSamples: [0.1, 0.6], presentedFrameLumaDelta: 0.5,
    lumaChanged: true, effectiveLaunchArguments: ["-profile", "/tmp/profile"] };
}
