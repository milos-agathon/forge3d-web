import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basicLatinLayout } from '../../src-ts/cartography-text-layout.js';
import { REGULAR_METRICS, BOLD_METRICS } from '../../src-ts/cartography-font-metrics.js';
const rows = JSON.parse(readFileSync(new URL('../fixtures/w20/text-layout-oracle.json', import.meta.url), 'utf8'));
it('native BASIC widths cover every font-size range and a broad independent Latin corpus', () => {
  expect(rows).toHaveLength(3050);
  expect(new Set(rows.flatMap((c: {text:string}) => [...c.text].map(ch => ch.charCodeAt(0)))).size).toBe(560);
  for (const c of rows) expect(basicLatinLayout(c.text, c.size, c.bold), JSON.stringify(c)).toBe(c.width);
});
it('metric tables bind to the actual packaged regular/bold font bytes', () => {
  for (const [name, metrics] of [['DejaVuSans.ttf', REGULAR_METRICS], ['DejaVuSans-Bold.ttf', BOLD_METRICS]] as const) {
    expect(createHash('sha256').update(readFileSync(new URL('../../assets/fonts/' + name, import.meta.url))).digest('hex')).toBe(metrics.sha256);
    expect(metrics.glyphs.length).toBe(560 * 3); expect(Object.keys(metrics.bounds).length).toBeGreaterThan(1000);
  }
});
