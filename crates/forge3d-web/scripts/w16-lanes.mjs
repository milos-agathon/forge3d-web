export const W16_LANES = Object.freeze({
  'w16-reference-discrete': Object.freeze({ assetId: 'FW-LNX-NV-01', platform: 'linux', profile: 'reference-discrete', p95Ms: 16.7, cpuBudgetBytes: 1610612736, gpuBudgetBytes: 3221225472 }),
  'w16-reference-integrated': Object.freeze({ assetId: 'FW-WIN-I12-01', platform: 'win32', profile: 'reference-integrated', p95Ms: 33.3, cpuBudgetBytes: 1073741824, gpuBudgetBytes: 2147483648 }),
});
export const isW16Lane = lane => Object.hasOwn(W16_LANES, lane);
export function resolveW16Lane({ lane, assetId, platform, required }) {
  const expected = W16_LANES[lane];
  if (!expected || expected.assetId !== assetId || expected.platform !== platform || required !== true)
    throw new Error('W16 requires its exact physical host/platform and required:true');
  return expected;
}
