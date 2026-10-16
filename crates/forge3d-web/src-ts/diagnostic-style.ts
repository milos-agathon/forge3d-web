import { LayerSummary, ValidationReport, type SupportLevel } from './diagnostics.js';
import { experimentalFeatureDiagnostic, unsupportedStyleFieldDiagnostic, unsupportedStyleLayerTypeDiagnostic } from './diagnostic-paths.js';
export interface DiagnosticStyleLayer {
    id?: string;
    type?: string;
    layer_type?: string;
    paint?: Record<string, unknown>;
    layout?: Record<string, unknown>;
    unsupported_paint_fields?: readonly string[];
    unsupported_layout_fields?: readonly string[];
}
const paint: Record<string, readonly string[]> = { fill: ['fill-color', 'fill-opacity', 'fill-outline-color'], line: ['line-color', 'line-width', 'line-opacity'], circle: ['circle-color', 'circle-radius', 'circle-opacity'] };
/** Native support assessment only. Style evaluation and render mapping belong to W19. */
export function validateStyleSupport(style: {
    layers?: readonly DiagnosticStyleLayer[];
}): ValidationReport {
    const diagnostics = [], summaries: LayerSummary[] = [], unsupported: Record<string, SupportLevel> = { 'style.streamed_mvt': 'non-goal', 'style.full_mapbox_spec': 'unsupported' };
    for (const [i, layer] of (style.layers ?? []).entries()) {
        const id = layer.id || `layer_${i}`, type = layer.type ?? layer.layer_type ?? '', codes: string[] = [];
        let level: SupportLevel = 'supported';
        if (type === 'symbol') {
            diagnostics.push(experimentalFeatureDiagnostic('symbol text layer', { layer_id: id }));
            codes.push('experimental_feature');
            level = 'underdeveloped';
            unsupported['style.layer.symbol'] = 'underdeveloped';
        }
        else if (!(type in paint)) {
            diagnostics.push(unsupportedStyleLayerTypeDiagnostic(id, type));
            codes.push('unsupported_style_layer_type');
            level = 'unsupported';
        }
        else
            for (const section of ['paint', 'layout'] as const) {
                const allowed = section === 'paint' ? paint[type]! : ['visibility'], fields = [...new Set([...layer[section === 'paint' ? 'unsupported_paint_fields' : 'unsupported_layout_fields'] ?? [], ...Object.keys(layer[section] ?? {}).filter(k => !allowed.includes(k))])];
                if (fields.length) {
                    diagnostics.push(unsupportedStyleFieldDiagnostic(id, fields, section));
                    codes.push('unsupported_style_field');
                }
            }
        summaries.push(new LayerSummary({ layer_id: id, layer_type: type, support_level: level, diagnostic_codes: codes }));
    }
    return new ValidationReport({ diagnostics, layer_summaries: summaries, supported_features: { 'style.local_provided_features': 'supported', 'style.layer.fill': 'supported', 'style.layer.line': 'supported', 'style.layer.circle': 'supported' }, unsupported_features: unsupported });
}
