export const FFX03_LANES = Object.freeze({
  "firefox-windows-intel12": Object.freeze({
    assetId: "FW-WIN-I12-01", platform: "win32", architecture: "x64",
    channel: "release", classification: "required", required: true,
    experimental: false, minimumMajor: 142,
  }),
  "firefox-macos-m2": Object.freeze({
    assetId: "FW-MAC-M2-01", platform: "darwin", architecture: "arm64",
    channel: "release", classification: "required", required: true,
    experimental: false, minimumMajor: 147,
  }),
  "firefox-nightly-linux-intel12": Object.freeze({
    assetId: "FW-LNX-I12-01", platform: "linux", architecture: "x64",
    channel: "nightly", classification: "probe", required: false,
    experimental: true, minimumMajor: 142,
  }),
  "firefox-nightly-linux-rtx3070": Object.freeze({
    assetId: "FW-LNX-NV-01", platform: "linux", architecture: "x64",
    channel: "nightly", classification: "probe", required: false,
    experimental: true, minimumMajor: 142,
  }),
});

export const FFX03_STABLE_LANES = Object.freeze(Object.fromEntries(
  Object.entries(FFX03_LANES).filter(([, lane]) => lane.required),
));

export const FFX03_NIGHTLY_LANES = Object.freeze(Object.fromEntries(
  Object.entries(FFX03_LANES).filter(([, lane]) => lane.experimental),
));

export function isFfx03Lane(lane) {
  return Object.hasOwn(FFX03_LANES, lane);
}

export function resolveFfx03Lane({ lane, assetId, platform, architecture, required }) {
  const contract = FFX03_LANES[lane];
  if (!contract) throw new Error(`FFX-03 lane is not a checked closed value: ${lane}`);
  if (assetId !== contract.assetId || platform !== contract.platform ||
      architecture !== contract.architecture) {
    throw new Error("FFX-03 lane does not match its exact asset, platform, and architecture");
  }
  if (typeof required === "boolean" && required !== contract.required) {
    throw new Error("FFX-03 lane required classification does not match the closed contract");
  }
  return contract;
}

export function assertFfx03BrowserVersion(version, contract) {
  const release = /^[0-9]+(?:\.[0-9]+){1,3}$/u;
  const nightly = /^[0-9]+(?:\.[0-9]+){1,3}a[0-9]+$/u;
  if (typeof version !== "string" || !(contract.channel === "release" ? release : nightly).test(version)) {
    throw new Error(`Firefox ${contract.channel} version syntax is invalid`);
  }
  if (Number(version.split(".")[0]) < contract.minimumMajor) {
    throw new Error(`Firefox ${contract.channel} is below the lane minimum ${contract.minimumMajor}`);
  }
  return version;
}
