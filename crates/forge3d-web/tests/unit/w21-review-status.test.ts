import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
it('keeps M08 unresolved and W21 partial until W20 product gates are integrated and tested', () => {
  const plan = readFileSync(new URL('../../../../docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md', import.meta.url), 'utf8');
  expect(plan.split('\n').find(line => line.startsWith('| M08 |'))).toMatch(/\| E \| W21 \|/);
  expect(plan.split('\n').find(line => line.startsWith('| M09 |'))).toMatch(/\| I \| W21 \|/);
  expect(plan.split('\n').find(line => line.startsWith('| W21 |'))).toContain('| Partial |');
  const section = plan.split('### W21 —')[1]!.split('### W22')[0]!;
  expect(section).toContain('**Partial**'); expect(section).toMatch(/W20/);
  const manifest = JSON.parse(readFileSync(new URL('../../../../docs/parity/forge3d-composite-baseline.json', import.meta.url), 'utf8'));
  expect(manifest.capabilities.find((r: any) => r.id === 'M08').status).toBe('E');
  expect(manifest.capabilities.find((r: any) => r.id === 'M09').status).toBe('I');
});
