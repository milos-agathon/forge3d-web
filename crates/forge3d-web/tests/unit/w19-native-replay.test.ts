import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStyle, parseStyleColor, styleToVectorStyle, styleToLabelStyle, styleLayerVisible, compileStyle, styleFeaturesFromGeoJson } from '../../src-ts/map-style.js';
import { evaluateStyleExpression, evaluateStyleFilter } from '../../src-ts/style-expressions.js';
import { Diagnostic, ValidationReport } from '../../src-ts/diagnostics.js';
import { validateStyleSupport } from '../../src-ts/diagnostic-style.js';
import { loadBundle } from '../../src-ts/bundle.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/w19/native-contract.json', import.meta.url), 'utf8'));
const paintKeys = 'fill-color fill-opacity fill-outline-color line-color line-width line-opacity text-color text-halo-color text-halo-width text-opacity circle-color circle-radius circle-opacity background-color'.split(' ');
const layoutKeys = 'visibility text-field text-size text-font text-anchor text-offset text-max-width line-cap line-join'.split(' ');
const section = (value: any, keys: string[]) => Object.fromEntries(keys.filter(k => value?.[k] != null).map(k => [k, value[k]]));
function parsed(input: any) {
    const spec = parseStyle(input).value;
    return { version: spec.version, name: spec.name ?? '', sources: spec.sources ?? {}, sprite: spec.sprite ?? null, glyphs: spec.glyphs ?? null,
        layers: spec.layers!.map(l => ({ id: l.id, type: l.type, source: l.source ?? null, 'source-layer': l['source-layer'] ?? null, paint: section(l.paint, paintKeys), layout: section(l.layout, layoutKeys), filter: l.filter ?? null, minzoom: l.minzoom ?? null, maxzoom: l.maxzoom ?? null })) };
}
async function replay(call: any) {
    switch (call.operation) {
        case 'parse': expect(parsed(call.input)).toEqual(call.expected); break;
        case 'query': {
            const spec = parseStyle({ ...call.input, layers: call.input.layers.map((l: any) => ({ ...l, minzoom: l.minzoom ?? undefined, maxzoom: l.maxzoom ?? undefined })) }); const out = call.method === 'layer_by_id' ? spec.layerById(call.argument)?.id ?? null : call.method === 'layers_for_source_layer' ? spec.layersForSourceLayer(call.argument).map(l => l.id) : spec.layersByType(call.method.split('_')[0]).map(l => l.id);
            expect(out).toEqual(call.expected); break;
        }
        case 'parse-error': expect(() => parseStyle(call.input)).toThrow(); break;
        case 'color': expect(parseStyleColor(call.input)).toEqual(call.expected); break;
        case 'expression': expect(evaluateStyleExpression(call.input, call.context)).toEqual(call.expected); break;
        case 'filter': expect(evaluateStyleFilter(call.input, { properties: call.properties })).toBe(call.expected); break;
        case 'visible': expect(styleLayerVisible({ ...call.layer, minzoom: undefined, maxzoom: undefined })).toBe(call.expected); break;
        case 'zoom-range': expect(styleLayerVisible({ ...call.layer, layout: { visibility: 'visible' } }, call.zoom)).toBe(call.expected); break;
        case 'paint': {
            const layer = { id: 'paint', type: 'fill', paint: call.paint }, fill = styleToVectorStyle(layer, call.context), stroke = styleToVectorStyle({ ...layer, type: 'line' }, call.context);
            expect(fill.color).toEqual(call.expected.fill_color); expect(stroke.color).toEqual(call.expected.stroke_color);
            expect(stroke.lineWidth).toBe(call.expected.stroke_width); expect(fill.pointSize).toBe(call.expected.point_size); break;
        }
        case 'label': {
            const out = styleToLabelStyle({ id: 'label', type: 'symbol', paint: call.paint, layout: call.layout }, call.context);
            expect(out).toEqual({ fontSize: call.expected.size, color: call.expected.color, haloColor: call.expected.halo_color, haloWidth: call.expected.halo_width, offset: call.expected.offset }); break;
        }
        case 'support': expect(validateStyleSupport(call.input).toJSON()).toEqual(call.expected); break;
        case 'diagnostic': expect(Diagnostic.fromJSON(call.expected).toJSON()).toEqual(call.expected); break;
        case 'report': expect(ValidationReport.fromJSON(call.expected).toJSON()).toEqual(call.expected); break;
        case 'label-contract': {
            const out = parseStyle(call.input).layersByType('symbol').filter(l => styleLayerVisible(l)).map(l => {
                const s = styleToLabelStyle(l);
                return { layer_id: l.id, source_layer: l['source-layer'] ?? null, text_field: l.layout?.['text-field'] ?? null, support_level: 'underdeveloped', label_style: { size: s.fontSize, color: s.color, halo_color: s.haloColor, halo_width: s.haloWidth, offset: s.offset } };
            }); expect(out).toEqual(call.expected); break;
        }
        case 'overlay': {
            const out = compileStyle(parseStyle(call.input), { '': styleFeaturesFromGeoJson({ type: 'FeatureCollection', features: call.features }) }).layers.flatMap(l => l.kind === 'vector' ? l.source.data!.features.map(f => ({ layer: l.layerId, primitive: f.kind === 'line' ? 'lines' : f.kind === 'point' ? 'points' : 'triangles', positions: f.kind === 'line' ? f.positions : f.kind === 'point' ? [f.position] : f.rings[0], color: f.style!.color, lineWidth: f.kind === 'line' ? f.style!.lineWidth : null, pointSize: f.kind === 'point' ? f.style!.pointSize : null })) : []);
            expect(out).toEqual(call.expected); break;
        }
        case 'mutation': case 'mutation-error': {
            const loaded = await loadBundle(readFileSync(new URL('../fixtures/w19/' + call.archive, import.meta.url)));
            try {
                const apply = (c: any) => c.method === 'apply_variant' ? loaded.applyVariant(c.args[0]) : loaded.setReviewLayerVisible(c.args[0], c.args[1]);
                const commands = [...call.commands], invalid = call.operation === 'mutation-error' ? commands.pop() : null;
                commands.forEach(apply);
                if (invalid) expect(() => apply(invalid)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
                else {
                    const recipe = loaded.effectiveSceneState(), layers = recipe.layers ?? [];
                    expect(loaded.getActiveVariantId()).toBe(call.active);
                    expect(layers.flatMap(l => l.kind === 'labels' ? (l.source.data as any[]).map(d => d.text) : [])).toEqual(call.labels);
                    expect(layers.filter(l => l.kind === 'raster')).toHaveLength(call.rasterCount); expect(layers.filter(l => l.kind === 'vector')).toHaveLength(call.vectorCount);
                    if (call.preset?.exposure !== undefined) expect(recipe.postFx?.effects[0]).toMatchObject({ exposure: call.preset.exposure });
                }
            } finally { loaded.dispose(); } break;
        }
        case 'bundle-save': {
            const loaded = await loadBundle(readFileSync(new URL('../fixtures/w19/' + call.archive, import.meta.url)));
            try {
                expect(loaded.manifest.version).toBe(call.manifest.version); expect(loaded.manifest.name).toBe(call.manifest.name);
                expect((loaded.sceneState.value.nativeSceneState as any).scene).toEqual(call.expected);
                const base = call.expected.base_state, state = loaded.sceneState.value;
                expect(state.base.layers!.filter(l => l.kind === 'raster')).toHaveLength(base.raster_overlays?.length ?? 0);
                expect(state.base.layers!.filter(l => l.kind === 'vector')).toHaveLength(base.vector_overlays?.length ?? 0);
                expect(state.base.layers!.flatMap(l => l.kind === 'labels' ? (l.source.data as any[]).map(d => d.text) : [])).toEqual((base.labels ?? []).map((l: any) => l.text));
                if (base.preset?.exposure !== undefined) expect(state.base.postFx?.effects[0]).toMatchObject({ exposure: base.preset.exposure });
                for (const [key] of Object.entries(base.preset ?? {})) if (key !== 'exposure') expect(loaded.validationReport!.diagnostics.some(d => d.code === 'unsupported_bundle_field' && d.details.field === 'preset.' + key)).toBe(true);
                expect(state.cameraBookmarks?.map(b => b.name)).toEqual((base.camera_bookmarks ?? []).map((b: any) => b.name));
                expect(loaded.listVariants().map(v => v.id)).toEqual((call.expected.variants ?? []).map((v: any) => v.id));
                expect(loaded.listReviewLayers().map(l => l.id)).toEqual((call.expected.review_layers ?? []).map((l: any) => l.id));
                expect(loaded.getActiveVariantId()).toBe(call.expected.active_variant_id ?? null);
                for (const diagnostic of call.expected.validation_report?.diagnostics ?? []) expect(loaded.validationReport!.toJSON().diagnostics).toContainEqual(diagnostic);
            } finally { loaded.dispose(); } break;
        }
        default: throw Error('Unimplemented native replay operation: ' + call.operation);
    }
}
describe('W19 per-test native behavioral replay', () => {
    // Empty traces are explicitly assigned browser equivalents in the coverage
    // ledger. They are never counted as behavioral replay tests.
    for (const test of fixture.testReplays.filter((t: any) => t.calls.length)) it(`${test.source} :: ${test.test}`, async () => {
        for (const call of test.calls) await replay(call);
    });
});
