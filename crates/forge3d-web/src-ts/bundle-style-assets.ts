import type { SceneStateInput } from './scene-review.js';
import { evaluateStyleExpression } from './style-expressions.js';
import { StyleSpec } from './map-style.js';
import { ValidationReport } from './diagnostics.js';

/** Opaque streamed-source intent still needs a support diagnostic in plain archives. */
export function assessBundleStyle(state: SceneStateInput): void {
    if (!state.style) return;
    const previous = new ValidationReport(state.validationReport ?? {}).toJSON(), assessed = new StyleSpec(state.style).validate().toJSON();
    const diagnostics = [...new Map([...previous.diagnostics, ...assessed.diagnostics].map(d => [JSON.stringify(d), d])).values()];
    const summaries = [...new Map([...assessed.layer_summaries, ...previous.layer_summaries].map(s => [s.layer_id, s])).values()];
    const report = new ValidationReport({ ...previous, diagnostics, layer_summaries: summaries, supported_features: { ...previous.supported_features, ...assessed.supported_features }, unsupported_features: { ...previous.unsupported_features, ...assessed.unsupported_features } });
    state.validationReport = report.toJSON();
    if (report.hasErrors) state.reviewRecord = { renderable: false, render_status: 'blocked_by_diagnostics', last_render: null };
}

/** The finite glyph inventory used by this scene, plus the sprite pair. */
export function styleAssetUrls(state: SceneStateInput, supplied: readonly string[]): string[] {
    const style = state.style, urls = new Set<string>();
    if (!style) return [];
    if (style.sprite) { urls.add(style.sprite + '.json'); urls.add(style.sprite + '.png'); }
    if (!style.glyphs) return [...urls];
    const requests = [...state.styleGlyphRequests ?? []];
    for (const layer of style.layers ?? []) {
        if (layer.type !== 'symbol' || !layer.layout?.['text-field']) continue;
        const source = style.sources?.[layer.source ?? ''] as {type?: string; data?: unknown} | undefined;
        const data = source?.type === 'geojson' && typeof source.data === 'object' ? source.data as { features?: { properties?: Record<string, unknown> }[] } : null;
        for (const feature of data?.features ?? [{ properties: {} }]) {
            const properties = feature.properties ?? {};
            const raw = evaluateStyleExpression(layer.layout['text-field'], { properties });
            const text = typeof raw === 'string' ? raw.replace(/\{([^}]+)\}/g, (_, key: string) => String(properties[key] ?? '')) : '';
            const font = layer.layout['text-font'];
            const fontStack = Array.isArray(font) && font.every(v => typeof v === 'string') ? font.join(',') : 'Open Sans Regular,Arial Unicode MS Regular';
            if (text) requests.push({ fontStack, text });
        }
    }
    for (const { fontStack, text } of requests) for (const c of text) {
        const start = Math.floor(c.codePointAt(0)! / 256) * 256;
        urls.add(style.glyphs.replaceAll('{fontstack}', encodeURIComponent(fontStack)).replaceAll('{range}', `${start}-${start + 255}`));
    }
    const pattern = new RegExp('^' + style.glyphs.split(/(\{fontstack\}|\{range\})/).map(p => p === '{fontstack}' ? '[^/]+' : p === '{range}' ? '\\d+-\\d+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
    const glyphs = supplied.filter(url => pattern.test(url));
    glyphs.forEach(url => urls.add(url));
    // A declared template is metadata until text actually needs a glyph range.
    // In particular, fill/line styles do not acquire or require font assets.
    return [...urls].sort();
}
