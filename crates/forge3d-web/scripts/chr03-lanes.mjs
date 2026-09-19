export const CHR03_STABLE_LANES = Object.freeze({
  "chrome-macos-m2": "FW-MAC-M2-01",
  "chrome-linux-intel12": "FW-LNX-I12-01",
  "chrome-linux-rtx3070": "FW-LNX-NV-01",
});

export const CHR03_BETA_LANES = Object.freeze({
  "chrome-beta-macos-m2": "FW-MAC-M2-01",
  "chrome-beta-linux-intel12": "FW-LNX-I12-01",
  "chrome-beta-linux-rtx3070": "FW-LNX-NV-01",
});

export const CHR03_LANES = Object.freeze({ ...CHR03_STABLE_LANES, ...CHR03_BETA_LANES });

export function isChr03Lane(lane) {
  return Object.hasOwn(CHR03_LANES, lane);
}
