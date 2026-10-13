import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateStyleExpression } from '../../src-ts/style-expressions.js';
import { parseStyleColor, styleToVectorStyle, styleToLabelStyle, compileStyle, parseStyle, styleFeaturesFromGeoJson } from '../../src-ts/map-style.js';
import { evaluateStyleFilter } from '../../src-ts/style-expressions.js';
import { loadBundle } from '../../src-ts/bundle.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/w19/native-contract.json', import.meta.url), 'utf8'));
describe('W19 independently executed native contracts', () => {
    for (const test of fixture.expressions) it(`native expression ${JSON.stringify(test.input)}`, () => expect(evaluateStyleExpression(test.input, fixture.context)).toEqual(test.expected));
    for (const test of fixture.edges) it(`native ${test.id} ${JSON.stringify(test.input)}`, () => expect(evaluateStyleExpression(test.input, test.context)).toEqual(test.expected));
    for (const test of fixture.paints) it(`native paint ${test.id}`, () => {
        const actual = styleToVectorStyle(test.layer, test.context), native = test.expected;
        expect(actual.color).toEqual(test.layer.type === 'line' ? native.stroke_color : native.fill_color);
        expect(actual.lineWidth).toBe(native.stroke_width); expect(actual.pointSize).toBe(native.point_size);
    });
    for (const test of fixture.labels) it(`native label ${test.id}`, () => {
        const actual = styleToLabelStyle(test.layer), native = test.expected;
        expect(actual).toEqual({ fontSize: native.size, color: native.color, haloColor: native.halo_color, haloWidth: native.halo_width, offset: native.offset });
    });
    for (const test of fixture.filters) it(`native filter ${test.id}`, () => expect(evaluateStyleFilter(test.input, { properties: test.properties })).toBe(test.expected));
    for (const test of fixture.mappings) it(`native feature ${test.id}`, () => {
        const input = styleFeaturesFromGeoJson({ type: 'FeatureCollection', features: test.features });
        const actual = compileStyle(parseStyle(test.style), { '': input }, { zoom: test.zoom }).layers.flatMap(l => l.kind === 'vector' ? l.source.data!.features.map(f => ({ layer: l.layerId, primitive: f.kind === 'line' ? 'lines' : f.kind === 'point' ? 'points' : 'triangles', positions: f.kind === 'line' ? f.positions : f.kind === 'point' ? [f.position] : f.rings[0], color: f.style!.color, lineWidth: f.kind === 'line' ? f.style!.lineWidth : null, pointSize: f.kind === 'point' ? f.style!.pointSize : null })) : []);
        expect(actual).toEqual(test.expected.map((e: any) => ({ ...e, lineWidth: e.primitive === 'lines' ? e.lineWidth : null, pointSize: e.primitive === 'points' ? e.pointSize : null })));
    });
    it('migrates a real pinned-native saver archive with base payloads, replacement presets and overriding mirrors', async () => {
        const loaded = await loadBundle(readFileSync(new URL('../fixtures/w19/native-v2.forge3d', import.meta.url)));
        expect(loaded.sceneState.value.base.postFx?.effects[0]).toMatchObject({ exposure: fixture.nativeBundle.basePreset.exposure });
        expect(loaded.sceneState.value.cameraBookmarks?.[0]?.name).toBe(fixture.nativeBundle.bookmarks[0].name);
        expect(loaded.sceneState.value.base.terrain?.source.parameters?.colormap).toBe(fixture.nativeBundle.colormap);
        for (const expected of fixture.nativeBundle.variants) {
            loaded.applyVariant(expected.id); const effective = loaded.effectiveSceneState(), layers = effective.layers ?? [];
            expect(layers.filter(l => l.kind === 'raster')).toHaveLength(expected.rasterCount);
            expect(layers.filter(l => l.kind === 'vector')).toHaveLength(expected.vectorCount);
            const labels = layers.flatMap(l => l.kind === 'labels' ? l.source.data as any[] : []);
            expect(labels.map(l => l.text)).toEqual(expected.labels.map((l: any) => l.text));
            for (const l of expected.labels.filter((l: any) => l.kind === 'callout')) expect(labels.find(a => a.text === l.text)).toMatchObject({ world_pos: l.anchor, leader_line: true });
            if (expected.preset?.exposure !== undefined) expect(effective.postFx?.effects[0]).toMatchObject({ exposure: expected.preset.exposure }); else expect(effective.postFx).toBeUndefined();
        }
        expect(loaded.validationReport?.diagnostics.some(d => d.details.field === 'preset.unknown')).toBe(true);
        vi.stubGlobal('fetch', vi.fn(async url => new Response(readFileSync(new URL('../../assets/fonts/' + new URL(String(url)).pathname.split('/').at(-1), import.meta.url)))));
        try { const resaved = await loadBundle(await loaded.save()); const url = resaved.sceneState.value.base.terrain!.source.url!; expect(resaved.asset(url.replace('forge3d-asset:', ''))).toEqual(new TextEncoder().encode('native-dem')); expect(Object.keys(resaved.manifest.asset_aliases!).some(k => k.startsWith('forge3d-asset:'))).toBe(false); resaved.dispose(); } finally { vi.unstubAllGlobals(); }
        loaded.dispose(); expect(() => loaded.validationReport).toThrow(expect.objectContaining({ code: 'RUNTIME_DISPOSED' }));
    });
    for (const test of fixture.colors) it(`native color ${test.input}`, () => {
        const output = parseStyleColor(test.input); if (test.expected === null) expect(output).toBeNull(); else test.expected.forEach((n: number, i: number) => expect(output![i]).toBeCloseTo(n, 12));
    });
    it('pins source/test bytes to the monolithic baseline and inventories every named test', () => {
        expect(fixture.commit).toBe('bf8db93233e5158f6d226991fc5d230832c2d806');
        for (const source of fixture.sources) { const raw = readFileSync(new URL('../fixtures/w19/native/' + source.path, import.meta.url)); expect(createHash('sha256').update(raw).digest('hex')).toBe(source.sha256); for (const name of source.tests) expect(raw.toString()).toContain('def ' + name + '('); }
        expect(fixture.sources.reduce((n: number, s: any) => n + s.tests.length, 0)).toBe(103);
    });
    it('requires per-test executable evidence instead of treating source inventory as behavioral coverage', () => {
        const raw = readFileSync(new URL('../fixtures/w19/native-contract.json', import.meta.url)), coverage = JSON.parse(readFileSync(new URL('../../docs/w19-native-test-coverage.json', import.meta.url), 'utf8'));
        expect(coverage.fixtureSha256).toBe(createHash('sha256').update(raw).digest('hex'));
        expect(coverage.nativeApiReplayTests).toBe(80); expect(coverage.browserEquivalentTests).toBe(23); expect(coverage.nativeOriginalTestsExecuted).toBe(89);
        const names = fixture.sources.flatMap((s: any) => s.tests.map((test: string) => `${s.path} :: ${test}`));
        expect(coverage.tests.map((t: any) => t.evidence.title).sort()).toEqual(names.sort());
        for (const row of coverage.tests) {
            if (row.disposition === 'native-api-replay') expect(fixture.testReplays.find((t: any) => t.source === row.source && t.test === row.test).calls.length).toBe(row.evidence.observedCalls);
            else { const body = readFileSync(new URL('../../' + row.evidence.file, import.meta.url), 'utf8'); expect(body).toContain(`key('${row.source.replace('tests/', '').replace('.py', '')}', '${row.test}')`); expect(row.substitution.length).toBeGreaterThan(20); }
        }
    });
});
