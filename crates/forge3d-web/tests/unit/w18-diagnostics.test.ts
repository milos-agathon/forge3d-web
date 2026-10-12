import { validateStyleSupport } from '../../src-ts/diagnostic-style.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as paths from '../../src-ts/diagnostic-paths.js';
import { Diagnostic, LayerSummary, SupportMatrixEntry, ValidationReport, SeverityPolicy, RenderFailurePolicy, SEVERITIES, SUPPORT_LEVELS, stableDiagnosticJson } from '../../src-ts/diagnostics.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/w18/contract.json', import.meta.url), 'utf8'));
describe('W18 independent native diagnostic contracts', () => {
    for (const [i, s] of fixture.styles.entries())
        it(`native style support ${i}`, () => expect(validateStyleSupport(s.input).toJSON()).toEqual(s.expected));
    for (const f of fixture.factories)
        it(`native factory ${f.code}`, () => {
            const name = f.code.replace(/_([a-z0-9])/g, (_: string, c: string) => c.toUpperCase()) + 'Diagnostic';
            const fn = (paths as unknown as Record<string, (...args: unknown[]) => Diagnostic>)[name]!;
            const scope = { layer_id: f.kwargs.layer_id ?? null, object_id: f.kwargs.object_id ?? null };
            const args = [...f.args];
            if (f.code === 'missing_external_asset')
                args.push(f.kwargs.path);
            if (f.code !== 'unsupported_style_field' && f.code !== 'unsupported_style_layer_type')
                args.push(scope);
            expect(fn(...args).toJSON()).toEqual(f.expected);
            expect(Diagnostic.fromJSON(f.expected).toJSON()).toEqual(f.expected);
        });
    it('compares full native report ordering and serialization', () => {
        const report = new ValidationReport({ diagnostics: fixture.factories.map((f: any) => f.expected).reverse() });
        expect(report.toJSON()).toEqual(fixture.report);
        expect(ValidationReport.fromJSON(JSON.stringify(report.toJSON())).toJSON()).toEqual(fixture.report);
    });
    it('checks native source bytes and every named original test inventory', () => {
        for (const source of fixture.sources) {
            const raw = readFileSync(new URL('../fixtures/w18/native/' + source.path, import.meta.url));
            expect(createHash('sha256').update(raw).digest('hex')).toBe(source.sha256);
            for (const name of source.tests)
                expect(raw.toString()).toContain('def ' + name + '(');
        }
        expect(fixture.sources.reduce((n: number, s: any) => n + s.tests.length, 0)).toBeGreaterThan(80);
    });
    it.each(SEVERITIES)('accepts severity %s', severity => { expect(new Diagnostic({ code: 'x', severity, message: 'm', remediation: 'r' }).severity).toBe(severity); });
    it.each(SUPPORT_LEVELS)('accepts support level %s', support_level => { expect(new Diagnostic({ code: 'x', severity: 'info', message: 'm', remediation: 'r', support_level }).support_level).toBe(support_level); });
    it('blocks output errors under both warning policies', () => {
        const error = new ValidationReport({ diagnostics: [paths.proGatedPathDiagnostic('native import'), paths.placeholderFallbackDiagnostic('zero geometry')] });
        expect(error.hasErrors).toBe(true);
        for (const policy of [RenderFailurePolicy.CONTINUE_ON_WARNING, RenderFailurePolicy.FAIL_ON_WARNING] as const)
            expect(error.renderBlocked(policy)).toBe(true);
        const experimental = new ValidationReport({ diagnostics: [paths.experimentalFeatureDiagnostic('line labels')] });
        expect(experimental.renderBlocked()).toBe(false);
        expect(experimental.renderBlocked(RenderFailurePolicy.FAIL_ON_WARNING)).toBe(true);
    });
    it('cannot downgrade an error with serialized status', () => {
        expect(new ValidationReport({ diagnostics: [paths.proGatedPathDiagnostic('x')], status: 'ok' }).status).toBe('error');
        expect(new ValidationReport({ status: 'fatal' }).status).toBe('fatal');
        expect(SeverityPolicy.statusFor([])).toBe('ok');
    });
    it('rejects invalid severity, support, policy, details and counts', () => {
        expect(() => new Diagnostic({ code: 'x', severity: 'debug' as never, message: 'm', remediation: 'r' })).toThrow('severity');
        expect(() => new ValidationReport({ supported_features: { x: 'partial' as never } })).toThrow('support level');
        expect(() => SeverityPolicy.renderBlocked('warning', 'ignore')).toThrow('policy');
        for (const details of [{ v: () => 0 }, { v: NaN }, { v: Infinity }, { v: new Map() }])
            expect(() => new Diagnostic({ code: 'x', severity: 'info', message: 'm', remediation: 'r', details })).toThrow();
        const cyclic: any = {};
        cyclic.a = cyclic;
        expect(() => stableDiagnosticJson(cyclic)).toThrow();
        expect(() => new LayerSummary({ layer_id: 'x', layer_type: 'mesh', support_level: 'supported', object_count: -1 })).toThrow();
    });
    it('normalizes details, layer summaries, support matrices and empty reports', () => {
        expect(stableDiagnosticJson({ z: [{ b: 2, a: 1 }], a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":[{"a":1,"b":2}]}');
        const layer = new LayerSummary({ layer_id: 'roads', layer_type: 'vector', support_level: 'underdeveloped', diagnostic_codes: ['z', 'a'], object_count: 12, bounds: [0, 1, 2, 3], memory_estimate_bytes: 4096 });
        expect(layer.toJSON().diagnostic_codes).toEqual(['a', 'z']);
        expect(LayerSummary.fromJSON(layer.toJSON()).toJSON()).toEqual(layer.toJSON());
        const entry = new SupportMatrixEntry({ area: 'style', capability: 'line layers', support_level: 'supported', scope: 'provided features', evidence: ['b', 'a'] });
        expect(SupportMatrixEntry.fromJSON(entry.toJSON()).toJSON()).toEqual(entry.toJSON());
        expect(new ValidationReport().toJSON()).toEqual({ status: 'ok', diagnostics: [], layer_summaries: [], estimated_gpu_memory_bytes: null, supported_features: {}, unsupported_features: {}, render_blocked: false });
    });
    it('preserves per-label glyph IDs and experimental diagnostics', () => {
        const report = paths.validateLabelSupport([{ id: 'city-a', text: 'Aé' }, { id: 'city-b', text: 'Bß' }], { atlasGlyphs: ['A', 'B'], layerId: 'cities' });
        expect(report.diagnostics.map(d => [d.object_id, d.details.missing_glyphs])).toEqual([['city-a', ['é']], ['city-b', ['ß']]]);
        expect(paths.validateLabelSupport([{ id: 'bend', kind: 'curved', text: 'B' }]).diagnostics[0]?.code).toBe('experimental_feature');
    });
    it('accounts for every retained native definition with an existing browser port or explicit W19 owner', () => {
        const ledger = JSON.parse(readFileSync(new URL('../../docs/w18-native-test-coverage.json', import.meta.url), 'utf8'));
        const native = fixture.sources.flatMap((s: any) => s.tests.map((name: string) => `${s.path}:${name}`));
        expect(ledger.cases.map((c: any) => `${c.nativeFile}:${c.nativeTest}`).sort()).toEqual(native.sort());
        for (const c of ledger.cases) {
            expect(['W18', 'W19']).toContain(c.owner);
            expect(c.adaptation.length).toBeGreaterThan(20);
            for (const path of c.webEvidence)
                expect(readFileSync(new URL('../../' + path, import.meta.url), 'utf8').length).toBeGreaterThan(0);
        }
    });
});
