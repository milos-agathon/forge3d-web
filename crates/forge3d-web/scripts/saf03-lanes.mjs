export const SAF03_STABLE_LANE = Object.freeze({
  lane: "safari-macos-m2",
  assetId: "FW-MAC-M2-01",
  hostId: "FW-MAC-M2-01",
  platform: "darwin",
  browserId: "safari-stable",
  channel: "stable",
  minimumMajor: 26,
  architecture: "arm64",
});

export const SAF03_STP_CHANNEL = Object.freeze({
  browserId: "safari-technology-preview",
  channel: "technology-preview",
  classification: "probe",
  minimumMajor: 26,
});

export function isSaf03Lane(lane) {
  return lane === SAF03_STABLE_LANE.lane;
}
