export const CHR04_LANES = Object.freeze({
  "edge-windows-intel12": Object.freeze({ assetId: "FW-WIN-I12-01", platform: "win32", requirement: "required" }),
  "edge-macos-m2": Object.freeze({ assetId: "FW-MAC-M2-01", platform: "darwin", requirement: "required" }),
  "edge-linux-intel12": Object.freeze({ assetId: "FW-LNX-I12-01", platform: "linux", requirement: "conditional" }),
  "edge-linux-rtx3070": Object.freeze({ assetId: "FW-LNX-NV-01", platform: "linux", requirement: "conditional" }),
});

export function isChr04Lane(lane) {
  return Object.hasOwn(CHR04_LANES, lane);
}
