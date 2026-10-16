import { test, expect } from "../browser/webgpu-fixture";
import * as ed from '@noble/ed25519';
declare global { interface Window { __w23: any } }
for (const source of [true, false]) test(`W23 ${source ? 'source' : 'dist'}: all 54 migrated example workflows execute`, async ({ page }, info) => {
  test.setTimeout(300_000);
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/examples/migration/index.html' + (source ? '?source' : ''));
  await page.waitForFunction(() => window.__w23?.ready);
  const secret = ed.utils.randomSecretKey(), publicKey = await ed.getPublicKeyAsync(secret), message = 'F3D-PRO-w23-example-test-20991231';
  const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const license = { publicKey: hex(publicKey), key: message + '-' + hex(await ed.signAsync(new TextEncoder().encode(message), secret)) };
  await page.evaluate(async value => { const { api } = window.__w23; api.configureLicenseIssuer(value.publicKey); await api.setLicenseKey(value.key); }, license);
  const report = await page.evaluate(() => window.__w23.run('all'));
  expect(report.examples).toHaveLength(54);
  expect(new Set(report.examples.map((e: any) => e.name)).size).toBe(54);
  for (const example of report.examples) {
    expect(example.status).toBe('executed');
    expect(example.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const workflow of example.workflows) expect(report.workflows[workflow], example.name + ': ' + workflow).toBeDefined();
  }
  expect(Object.keys(report.workflows)).toHaveLength(29);
  expect(report.workflows.png.exact).toBe(true);
  expect(report.workflows.render.coveragePixels).toBeGreaterThan(500);
  expect(report.workflows.animation.timestamps).toEqual([0, 500000, 1000000]);
  expect(report.workflows.pointcloud.points).toBe(110000);
  expect(report.workflows.cog.values).toBe(256);
  expect(failures).toEqual([]);
  await info.attach('w23-workflows.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
});
