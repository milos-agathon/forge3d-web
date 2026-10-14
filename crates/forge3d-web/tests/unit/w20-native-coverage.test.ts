import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
it('W20 ports all 82 original test identities with executable evidence', () => {
  const fixture = readFileSync(new URL('../fixtures/w20/native-oracle.json', import.meta.url));
  const oracle = JSON.parse(fixture.toString()), coverage = JSON.parse(readFileSync(new URL('../../docs/w20-native-test-coverage.json', import.meta.url), 'utf8'));
  expect(createHash('sha256').update(fixture).digest('hex')).toBe(coverage.fixtureSha256);
  expect(coverage.tests).toHaveLength(82);
  expect(coverage.tests.map((r: any) => `${r.source}::${r.class}::${r.test}`).sort()).toEqual(oracle.tests.map((r: any) => `${r.source}::${r.class}::${r.test}`).sort());
  for (const c of coverage.tests) {
    const body = readFileSync(new URL('../../' + c.evidence.file, import.meta.url), 'utf8');
    expect(body).toContain(c.disposition === 'browser-equivalent' ? `'${c.class}::${c.test}'` : `native('${c.class}', '${c.test}'`);
    expect(c.adaptation.length).toBeGreaterThan(30);
  }
});
it('W20 public guides are valid UTF-8 on every checkout platform', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const file of ['README.md', 'docs/browser-api.md', 'docs/support-matrix.md', 'docs/cartography.md', 'docs/w20-evidence.md']) {
    expect(() => decoder.decode(readFileSync(new URL('../../' + file, import.meta.url)))).not.toThrow();
  }
});
