import { resolveW16Lane } from './w16-lanes.mjs';
import { captureW16Soak } from './w16-host-state.mjs';
export async function runW16HardwareAcceptance(context, { lane, binding, platform, route }) {
  const expected = resolveW16Lane({ lane, assetId: binding.assetId, platform, required: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.goto(new URL('examples/pointcloud-tiles.html?dist', route.applicationUrl).href);
    await page.waitForFunction(() => !!window.__w16);
    const soak = await captureW16Soak(() => page.evaluate(profile => window.__w16.soak(600000, profile), expected.profile),
      { binding: { ...binding, lane, platform } });
    const proof = { schemaVersion: 1, kind: 'forge3d-w16-traversal-v1', binding: { ...binding, lane, platform }, soak };
    if (errors.length) {
      const error = new Error(errors.join('\n'));
      error.w16Observation = { w16Proof: proof, pageErrors: errors };
      throw error;
    }
    return proof;
  } finally { await page.close(); }
}
