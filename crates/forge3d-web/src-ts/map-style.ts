import {VectorIdentity} from "./vector-identity.js";
import { requirePro, PRO_FEATURES } from './license.js';
import { type BrowserByteSource } from "./index.js";
import { Forge3DError } from "./runtime-failure.js";
import { readByteSource } from './browser-io.js';
import { validateStyleSupport } from './diagnostic-style.js';
import { Diagnostic, ValidationReport } from './diagnostics.js';
import { STYLE_EXPRESSION_OPERATORS, evaluateStyleExpression, evaluateStyleFilter, type StyleEvalContext } from './style-expressions.js';
import type { VectorFeature, VectorColor, VectorStyle } from './vector-types.js';
import type { LabelRecord, LabelStyleInput } from './label-types.js';
import type { MapSceneLayerInput } from './map-scene-types.js';
export interface StyleLayer { id: string; type: string; source?: string; 'source-layer'?: string; paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown[]; minzoom?: number; maxzoom?: number; }
export interface StyleSpecInput { version?: number; name?: string; sources?: Record<string, unknown>; layers?: readonly StyleLayer[]; sprite?: string; glyphs?: string; [key: string]: unknown; }
export class StyleSpec {
    readonly #input: StyleSpecInput;
    constructor(input: StyleSpecInput) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || (input.version ?? 8) !== 8 || !Array.isArray(input.layers ?? [])) throw new Forge3DError('INVALID_INPUT', 'Unsupported or invalid style version (expected 8)');
        const ids = new Set<string>();
        for (const l of input.layers ?? []) {
            if (!l || typeof l.id !== 'string' || !l.id || ids.has(l.id) || typeof l.type !== 'string') throw new Forge3DError('INVALID_INPUT', 'Style layers need unique IDs and types');
            ids.add(l.id);
            for (const section of [l.paint, l.layout]) if (section && (typeof section !== 'object' || Array.isArray(section))) throw new Forge3DError('INVALID_INPUT', 'Style paint and layout must be objects');
            for (const z of [l.minzoom, l.maxzoom]) if (z !== undefined && !Number.isFinite(z)) throw new Forge3DError('INVALID_INPUT', 'Invalid style zoom range');
        }
        this.#input = structuredClone({ ...input, version: 8, layers: input.layers ?? [] });
    }
    get value(): StyleSpecInput { return structuredClone(this.#input); }
    get layers(): StyleLayer[] { return structuredClone([...this.#input.layers ?? []]); }
    layerById(id: string): StyleLayer | undefined { return this.layers.find(l => l.id === id); }
    layersForSourceLayer(name: string): StyleLayer[] { return this.layers.filter(l => l['source-layer'] === name); }
    layersByType(type: string): StyleLayer[] { return this.layers.filter(l => l.type === type); }
    toJSON(): StyleSpecInput { return this.value; }
    validate(): ValidationReport {
        const base = validateStyleSupport(this.value), extra: Diagnostic[] = [];
        const warn = (layer: string | null, field: string, value: unknown) => extra.push(new Diagnostic({ code: 'unsupported_style_field', severity: 'warning', message: `Unsupported style field: ${field}`, remediation: 'Use the documented local feature style subset.', support_level: 'unsupported', layer_id: layer, details: { fields: [field], value } }));
        for (const field of Object.keys(this.#input)) if (!['version', 'name', 'sources', 'layers', 'sprite', 'glyphs', 'metadata'].includes(field)) warn(null, field, this.#input[field]);
        const check = (value: unknown, layer: string, path: string, depth = 0): void => {
            if (depth > 64) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Style expression depth exceeds limit');
            if (!Array.isArray(value)) return;
            const op = value[0];
            if (typeof op !== 'string' || !STYLE_EXPRESSION_OPERATORS.has(op)) { warn(layer, path, op); return; }
            if (op === 'literal') return;
            if (op === 'interpolate-hcl' || op === 'interpolate-lab') warn(layer, path, 'native numeric interpolation only; perceptual color interpolation unavailable');
            let nested = value.slice(1);
            if (op.startsWith('interpolate')) nested = value.slice(2);
            if (op === 'match') nested = [value[1], ...value.slice(3).filter((_, i) => i % 2 === 0), value.at(-1)];
            nested.forEach(v => check(v, layer, path, depth + 1));
        };
        for (const l of this.layers) {
            for (const field of Object.keys(l)) if (!['id', 'type', 'source', 'source-layer', 'paint', 'layout', 'filter', 'minzoom', 'maxzoom', 'metadata'].includes(field)) warn(l.id, field, (l as unknown as Record<string, unknown>)[field]);
            for (const [key, value] of Object.entries(l.paint ?? {})) check(value, l.id, `paint.${key}`);
            const filterCheck = (v: unknown, depth = 0): void => {
                if (!Array.isArray(v)) return;
                if (depth > 64) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Filter depth exceeds limit');
                if (['all', 'any', '!', 'not'].includes(v[0])) v.slice(1).forEach(f => filterCheck(f, depth + 1));
                else if (!['==', 'eq', '!=', 'neq', 'in', 'has'].includes(v[0])) warn(l.id, 'filter', v[0]);
            };
            filterCheck(l.filter);
        }
        for (const [id, source] of Object.entries(this.#input.sources ?? {})) if (source && typeof source === 'object' && (source as { type?: string }).type !== 'geojson') warn(null, `sources.${id}`, 'streamed sources are outside the provided-feature contract');
        return new ValidationReport({ ...base.toJSON(), diagnostics: [...base.diagnostics, ...extra] });
    }
}
export function parseStyle(input: StyleSpecInput | string): StyleSpec { return new StyleSpec(typeof input === 'string' ? JSON.parse(input) : input); }
export async function loadStyle(source: BrowserByteSource | FileSystemFileHandle, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<StyleSpec> {
    requirePro(PRO_FEATURES.styleLoad);
    const bytes = await readByteSource(typeof source === 'object' && 'getFile' in source ? await source.getFile() : source, options);
    return parseStyle(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export function parseStyleColor(input: unknown): VectorColor | null {
    if (Array.isArray(input) && (input.length === 3 || input.length === 4) && input.every(v => typeof v === 'number' && Number.isFinite(v))) return [input[0], input[1], input[2], input[3] ?? 1];
    if (typeof input !== 'string') return null;
    const s = input.toLowerCase().trim(), nativeNamed: Record<string, VectorColor> = { green: [0, .5, 0, 1], gray: [.5, .5, .5, 1], grey: [.5, .5, .5, 1], orange: [1, .647, 0, 1] }, named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', transparent: '#00000000' };
    if (Object.hasOwn(nativeNamed, s)) return [...nativeNamed[s]!] as VectorColor;
    if (Object.hasOwn(named, s)) return parseStyleColor(named[s]);
    if (/^#[\da-f]{3}$/.test(s)) return parseStyleColor('#' + [...s.slice(1)].map(c => c + c).join(''));
    if (/^#[\da-f]{4}$/.test(s)) return parseStyleColor('#' + [...s.slice(1)].map(c => c + c).join(''));
    if (/^#[\da-f]{6}([\da-f]{2})?$/.test(s)) return [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255, s.length === 9 ? parseInt(s.slice(7, 9), 16) / 255 : 1];
    const rgb = /^rgba?\s*\(\s*([-\d.]+%?)\s*,\s*([-\d.]+%?)\s*,\s*([-\d.]+%?)(?:\s*,\s*([-\d.]+))?\s*\)$/.exec(s);
    if (rgb) { const percent = rgb[1]!.endsWith('%'), channels = rgb.slice(1, 4).map(v => Number(v!.replace('%', '')) / (percent ? 100 : 255)); return channels.every(Number.isFinite) ? [channels[0]!, channels[1]!, channels[2]!, Number(rgb[4] ?? 1)] : null; }
    const hsl = /^hsla?\(\s*([-\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+))?\s*\)$/.exec(s);
    if (hsl) { const h = ((Number(hsl[1]) % 360) + 360) % 360 / 30, sat = Number(hsl[2]) / 100, l = Number(hsl[3]) / 100, a = sat * Math.min(l, 1 - l), f = (n: number) => l - a * Math.max(-1, Math.min((n + h) % 12 - 3, 9 - (n + h) % 12, 1)); return [f(0), f(8), f(4), Number(hsl[4] ?? 1)]; }
    return null;
}
export function styleLayerVisible(layer: StyleLayer, zoom = 10): boolean { return layer.layout?.visibility !== 'none' && zoom >= (layer.minzoom ?? -Infinity) && zoom <= (layer.maxzoom ?? Infinity); }
export function styleToVectorStyle(layer: StyleLayer, context: StyleEvalContext = {}): VectorStyle {
    const p = layer.paint ?? {}, number = (key: string, fallback: number) => { const v = evaluateStyleExpression(p[key], context); return (typeof v === 'number' || typeof v === 'boolean') && Number.isFinite(Number(v)) ? Number(v) : fallback; };
    let fill: VectorColor = [.2, .4, .8, 1], stroke: VectorColor = [0, 0, 0, 1];
    const color = (key: string) => parseStyleColor(evaluateStyleExpression(p[key], context));
    fill = color('fill-color') ?? fill; fill[3] *= number('fill-opacity', 1);
    stroke = color('fill-outline-color') ?? stroke;
    const line = color('line-color'); if (line) { fill = [...line]; stroke = [...line]; }
    stroke[3] *= number('line-opacity', 1); fill = color('circle-color') ?? fill;
    return { color: layer.type === 'line' ? stroke : fill, opacity: 1, lineWidth: number('line-width', 1), pointSize: 2 * number('circle-radius', 2), shape: 'circle' };
}
export function styleToLabelStyle(layer: StyleLayer, context: StyleEvalContext = {}): LabelStyleInput {
    const p = layer.paint ?? {}, l = layer.layout ?? {}, value = (e: unknown, fallback: number) => { const v = evaluateStyleExpression(e, context); return typeof v === 'number' && Number.isFinite(v) ? v : fallback; };
    const color = parseStyleColor(evaluateStyleExpression(p['text-color'], context)) ?? [.1, .1, .1, 1]; color[3] *= value(p['text-opacity'], 1);
    const size = value(l['text-size'], 14), offset = l['text-offset'];
    return { fontSize: size, color, haloColor: parseStyleColor(evaluateStyleExpression(p['text-halo-color'], context)) ?? [1, 1, 1, .8], haloWidth: value(p['text-halo-width'], 1.5), offset: Array.isArray(offset) && offset.length >= 2 && offset.slice(0, 2).every(v => typeof v === 'number') ? [Number(offset[0]) * size, Number(offset[1]) * size] : [0, 0] };
}
export function styleLabelRecords(layer: StyleLayer, features: readonly VectorFeature[], zoom = 10): LabelRecord[] {
    if (!styleLayerVisible(layer, zoom)) return [];
    return features.filter(f => f.kind === 'point' && evaluateStyleFilter(layer.filter, { properties: f.properties ?? {}, zoom, geometryType: 'Point' })).map(f => {
        const field = layer.layout?.['text-field'], props = f.properties ?? {}, text = typeof field === 'string' ? field.replace(/\{([^}]+)\}/g, (_, key: string) => String(props[key] ?? '')) : String(evaluateStyleExpression(field, { properties: props, zoom }) ?? '');
        return { id: f.id, text, world_pos: f.kind === 'point' ? f.position : [], typography: { font_size: styleToLabelStyle(layer, { properties: props, zoom }).fontSize } };
    });
}
/** Each feature uses its first matching native layer. Symbols retain their native diagnostic. */
export function compileStyle(spec: StyleSpec, sources: Record<string, readonly VectorFeature[]>, options: { zoom?: number; crs?: string } = {}): { layers: MapSceneLayerInput[]; report: ValidationReport } {
    requirePro(PRO_FEATURES.styleApply);
    const zoom = options.zoom ?? 10, layers: MapSceneLayerInput[] = [], report = spec.validate(), diagnostics: Diagnostic[] = [], assigned = new Map<string, Set<number>>(), identity=new VectorIdentity();
    for (const [zOrder, layer] of spec.layers.entries()) {
        if (!styleLayerVisible(layer, zoom) || !['fill', 'line', 'circle'].includes(layer.type)) continue;
        const key = layer['source-layer'] ?? layer.source ?? '', source = sources[key];
        if (!source) { diagnostics.push(new Diagnostic({ code: 'missing_external_asset', severity: 'error', message: `Missing provided features: ${key}`, remediation: 'Supply features for each source or source-layer.', support_level: 'missing', layer_id: layer.id, details: { path: key } })); continue; }
        const features: VectorFeature[] = [];
        for (const feature of source) {
            const geometryType = feature.kind === 'point' ? 'Point' : feature.kind === 'line' ? 'LineString' : 'Polygon', ctx = { properties: feature.properties ?? {}, zoom, geometryType };
            if (assigned.get(key)?.has(feature.id) || feature.kind !== (layer.type === 'fill' ? 'polygon' : layer.type === 'line' ? 'line' : 'point') || !evaluateStyleFilter(layer.filter, ctx)) continue;
            if (!assigned.has(key)) assigned.set(key, new Set()); assigned.get(key)!.add(feature.id);
            const copy = identity.imported(feature,`style:${key}`,feature.id); copy.properties = { ...copy.properties, forge3d_source_id: feature.id, forge3d_style_layer: layer.id }; copy.style = { ...copy.style, ...styleToVectorStyle(layer) }; features.push(copy);
            copy.style.lineWidth = Math.max(copy.style.lineWidth ?? 1, .1); copy.style.pointSize = Math.max(copy.style.pointSize ?? 4, .1);
        }
        if (features.length) layers.push({ kind: 'vector', layerId: layer.id, source: { id: `style:${layer.id}`, format: 'vector', ...(options.crs ? { crs: options.crs } : {}), data: { name: layer.id, features, zOrder } } });
    }
    return { layers, report: new ValidationReport({ ...report.toJSON(), diagnostics: [...report.diagnostics, ...diagnostics] }) };
}
/** GeoJSON [x,z,elevation] maps to the engine's [x,elevation,z] convention. Multi-geometries retain source identity in properties. */
export function styleFeaturesFromGeoJson(input: unknown): VectorFeature[] {
    const object = input as { type?: string; features?: unknown[] }, features = object?.type === 'FeatureCollection' ? object.features : object?.type === 'Feature' ? [object] : undefined;
    if (!Array.isArray(features)) throw new Forge3DError('INVALID_INPUT', 'Style data must be GeoJSON features');
    const output: VectorFeature[] = [],identity=new VectorIdentity();
    const position = (p: unknown): [number, number, number] => { if (!Array.isArray(p) || p.length < 2 || p.slice(0, 3).some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Forge3DError('INVALID_INPUT', 'Invalid GeoJSON coordinate'); return [p[0], p[2] ?? 0, p[1]]; };
    for (const item of features) {
        const f = item as { type?: string; id?: string | number; properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } | null };
        if (!f || f.type !== 'Feature') throw new Forge3DError('INVALID_INPUT', 'Invalid GeoJSON feature');
        if (!f.geometry) continue;
        const properties = { ...f.properties, forge3d_geojson_id: f.id ?? null, forge3d_identity: {source:"geojson",sourceId:f.id??features.indexOf(item)} }, geometry = f.geometry;
        const add = (type: string, coordinates: unknown) => {
            if (type === 'Point') output.push({ id: identity.allocate(), kind: 'point', position: position(coordinates), properties });
            else if (type === 'LineString' && Array.isArray(coordinates)) output.push({ id: identity.allocate(), kind: 'line', positions: coordinates.map(position), properties });
            else if (type === 'Polygon' && Array.isArray(coordinates)) output.push({ id: identity.allocate(), kind: 'polygon', rings: coordinates.map(r => { if (!Array.isArray(r)) throw new Forge3DError('INVALID_INPUT', 'Invalid polygon ring'); return r.map(position); }), properties });
            else throw new Forge3DError('UNSUPPORTED_FEATURE', `Unsupported style geometry: ${type}`);
        };
        if (geometry.type.startsWith('Multi') && Array.isArray(geometry.coordinates)) for (const part of geometry.coordinates) add(geometry.type.slice(5), part); else add(geometry.type, geometry.coordinates);
    }
    return output;
}
/** Load only GeoJSON sources. Streamed MVT sources retain the explicit unsupported contract. */
export async function loadStyleLayers(spec: StyleSpec, options: { signal?: AbortSignal; maxBytes?: number; baseUrl?: string; zoom?: number; crs?: string } = {}): Promise<ReturnType<typeof compileStyle>> {
    requirePro(PRO_FEATURES.styleApply);
    const provided: Record<string, VectorFeature[]> = Object.create(null); let used = 0;
    for (const [id, raw] of Object.entries(spec.value.sources ?? {})) {
        const source = raw as { type?: string; data?: unknown };
        if (source?.type !== 'geojson') continue;
        let data = source.data;
        if (typeof data === 'string') { const url = options.baseUrl ? new URL(data, options.baseUrl) : data, bytes = await readByteSource(url, { ...(options.signal ? { signal: options.signal } : {}), maxBytes: (options.maxBytes ?? 64 * 1024 * 1024) - used }); used += bytes.length; data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        if (data !== undefined) provided[id] = styleFeaturesFromGeoJson(data);
    }
    return compileStyle(spec, provided, options);
}
