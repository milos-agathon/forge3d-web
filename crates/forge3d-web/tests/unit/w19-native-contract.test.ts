import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateStyleExpression } from '../../src-ts/style-expressions.js';
import { parseStyleColor } from '../../src-ts/map-style.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/w19/native-contract.json', import.meta.url), 'utf8'));
describe('W19 independently executed native contracts', () => {
    for (const test of fixture.expressions) it(`native expression ${JSON.stringify(test.input)}`, () => expect(evaluateStyleExpression(test.input, fixture.context)).toEqual(test.expected));
    for (const test of fixture.colors) it(`native color ${test.input}`, () => {
        const output = parseStyleColor(test.input); if (test.expected === null) expect(output).toBeNull(); else test.expected.forEach((n: number, i: number) => expect(output![i]).toBeCloseTo(n, 12));
    });
    it('pins source/test bytes to the monolithic baseline and inventories every named test', () => {
        expect(fixture.commit).toBe('bf8db93233e5158f6d226991fc5d230832c2d806');
        for (const source of fixture.sources) { const raw = readFileSync(new URL('../fixtures/w19/native/' + source.path, import.meta.url)); expect(createHash('sha256').update(raw).digest('hex')).toBe(source.sha256); for (const name of source.tests) expect(raw.toString()).toContain('def ' + name + '('); }
        expect(fixture.sources.reduce((n: number, s: any) => n + s.tests.length, 0)).toBeGreaterThan(65);
    });
});
