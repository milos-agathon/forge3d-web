export const FFX04_LANES = Object.freeze({
  "firefox-macos-m2": Object.freeze({ assetId: "FW-MAC-M2-01", platform: "darwin" }),
  "firefox-windows-intel12": Object.freeze({ assetId: "FW-WIN-I12-01", platform: "win32" }),
});

export function isFfx04Lane(lane) {
  return Object.hasOwn(FFX04_LANES, lane);
}
