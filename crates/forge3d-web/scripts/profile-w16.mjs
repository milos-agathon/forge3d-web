import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch({args: ['--enable-unsafe-webgpu', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])]});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:57883/examples/pointcloud-tiles.html' + (process.env.FORGE3D_W16_DIST === '1' ? '?dist' : ''));
  await page.waitForFunction(() => !!window.__w16);
  const duration = Number(process.env.FORGE3D_W16_PROFILE_MS ?? 60000);
  if (!Number.isFinite(duration) || duration < 1000 || duration > 600000) throw new Error('Profile duration must be 1000..600000 ms');
  const timeout = setTimeout(() => void browser.close(), duration + 120000);
  const result = await page.evaluate(ms => window.__w16.soak(ms), duration);
  clearTimeout(timeout);
  writeFileSync(process.env.FORGE3D_W16_OUTPUT ?? 'test-results/w16-profile.json', JSON.stringify({...result, browserVersion: browser.version()}, null, 2) + '\n');
  console.log(JSON.stringify({durationMs: result.durationMs, frameP95Ms: result.frameP95Ms, phases: result.phases, frames: result.frames, adapter: result.adapter, browserVersion: browser.version()}));
} finally { await browser.close(); }
