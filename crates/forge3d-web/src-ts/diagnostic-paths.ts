import { Diagnostic, type DiagnosticInput, type DiagnosticSeverity, type SupportLevel, ValidationReport } from './diagnostics.js';
import { diagnosticTemplates } from './diagnostic-templates.js';
export const REQUIRED_DIAGNOSTIC_CODES = ['crs_mismatch', 'missing_glyphs', 'unsupported_style_field', 'unsupported_style_layer_type', 'pro_gated_path', 'placeholder_fallback', 'experimental_feature', 'vt_unsupported_family', 'python_public_3dtiles_incomplete', 'estimated_gpu_memory', 'label_rejection_summary'] as const;
export const P1_FEATURE_DIAGNOSTIC_CODES = ['missing_label_field', 'unicode_coverage_gap', 'unsupported_tile_format', 'unsupported_tile_feature', 'missing_external_asset', 'unavailable_terrain_sampler'] as const;
export const P2_FEATURE_DIAGNOSTIC_CODES = ['missing_texture_path', 'missing_uvs', 'unsupported_texture_format', 'unavailable_cache_lod_stats', 'unsupported_instancing_path'] as const;
export type DiagnosticScope = Pick<DiagnosticInput, 'layer_id' | 'object_id'>;
export function diagnosticFor(code: keyof typeof diagnosticTemplates, details: Record<string, unknown> = {}, scope: DiagnosticScope = {}): Diagnostic {
    const template = diagnosticTemplates[code];
    let severity: DiagnosticSeverity = template.severity, message: string = template.message, remediation: string = template.remediation;
    if (code === 'missing_glyphs')
        message = `${details.count} glyphs are missing from the active atlas.`;
    if (code === 'label_rejection_summary')
        message = `${details.total} label candidates were rejected during placement.`;
    if (code === 'estimated_gpu_memory') {
        const exceeds = typeof details.budget_bytes === 'number' && Number(details.estimated_bytes) > details.budget_bytes;
        severity = exceeds ? 'warning' : 'info';
        message = exceeds ? 'Estimated GPU memory use exceeds the configured budget.' : 'Estimated GPU memory use is available for review.';
        remediation = exceeds ? 'Reduce layer resolution, simplify inputs, or increase the configured GPU memory budget.' : 'No action is required unless other diagnostics indicate risk.';
    }
    return new Diagnostic({ ...template, severity, message, remediation, details, ...scope });
}
export function crsMismatchDiagnostic(scene: string, layer: string, scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('crs_mismatch', { layer_crs: layer, scene_crs: scene }, scope); }
export function missingGlyphsDiagnostic(glyphs: readonly string[], scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('missing_glyphs', { count: glyphs.length, missing_glyphs: [...glyphs].sort() }, scope); }
export function unicodeCoverageGapDiagnostic(glyphs: readonly string[], scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('unicode_coverage_gap', { count: glyphs.length, missing_glyphs: [...glyphs].sort() }, scope); }
export function unsupportedStyleFieldDiagnostic(layer: string, fields: readonly string[], section?: string): Diagnostic { return diagnosticFor('unsupported_style_field', { fields: [...fields].sort(), ...(section ? { section } : {}) }, { layer_id: layer }); }
export function unsupportedStyleLayerTypeDiagnostic(layer: string, type: string): Diagnostic { return diagnosticFor('unsupported_style_layer_type', { layer_type: type }, { layer_id: layer }); }
export function proGatedPathDiagnostic(feature: string, scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('pro_gated_path', { feature }, scope); }
export function placeholderFallbackDiagnostic(feature: string, scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('placeholder_fallback', { feature }, scope); }
export function experimentalFeatureDiagnostic(feature: string, scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('experimental_feature', { feature }, scope); }
export function vtUnsupportedFamilyDiagnostic(family: string, scope: DiagnosticScope = {}, supportedFamily = 'albedo'): Diagnostic { return diagnosticFor('vt_unsupported_family', { family, supported_family: supportedFamily }, scope); }
export function pythonPublic3dtilesIncompleteDiagnostic(scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('python_public_3dtiles_incomplete', {}, scope); }
export function estimatedGpuMemoryDiagnostic(estimated: number, budget: number | null, scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('estimated_gpu_memory', { budget_bytes: budget, estimated_bytes: estimated }, scope); }
export function labelRejectionSummaryDiagnostic(counts: Record<string, number>, scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('label_rejection_summary', { rejection_counts: counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }, scope); }
export function missingLabelFieldDiagnostic(field: string, scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('missing_label_field', { field }, scope); }
export function unsupportedTileFormatDiagnostic(format: string, scope: DiagnosticScope = {}, supported = ['tileset.json', 'b3dm']): Diagnostic { return diagnosticFor('unsupported_tile_format', { format, supported_formats: [...supported].sort() }, scope); }
export function unsupportedTileFeatureDiagnostic(feature: string, scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('unsupported_tile_feature', { feature }, scope); }
export function missingExternalAssetDiagnostic(type: string, path: string, scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('missing_external_asset', { layer_type: type, path }, scope); }
export function missingTexturePathDiagnostic(path: string, scope: DiagnosticScope = {}, materialId?: string): Diagnostic { return diagnosticFor('missing_texture_path', { path, ...(materialId === undefined ? {} : { material_id: materialId }) }, scope); }
export function missingUvsDiagnostic(scope: DiagnosticScope = {}, materialId?: string): Diagnostic { return diagnosticFor('missing_uvs', materialId === undefined ? {} : { material_id: materialId }, scope); }
export function unsupportedTextureFormatDiagnostic(format: string, scope: DiagnosticScope = {}, path?: string, supported = ['jpg', 'jpeg', 'png', 'tif', 'tiff']): Diagnostic { return diagnosticFor('unsupported_texture_format', { format: format.toLowerCase().replace(/^\./, ''), supported_formats: supported.map(s => s.toLowerCase().replace(/^\./, '')).sort(), ...(path === undefined ? {} : { path }) }, scope); }
export function unavailableCacheLodStatsDiagnostic(type: string, stats: readonly string[], scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('unavailable_cache_lod_stats', { layer_type: type, unavailable_stats: [...stats].sort() }, scope); }
export function unsupportedInstancingPathDiagnostic(path: string, scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('unsupported_instancing_path', { path }, scope); }
export function unavailableTerrainSamplerDiagnostic(scope: DiagnosticScope = {}): Diagnostic { return diagnosticFor('unavailable_terrain_sampler', {}, scope); }
export function supportDiagnostic(feature: string, level: SupportLevel, scope: DiagnosticScope = {}): Diagnostic | null {
    if (level === 'supported')
        return null;
    if (level === 'Pro-gated')
        return proGatedPathDiagnostic(feature, scope);
    if (level === 'placeholder/fallback')
        return placeholderFallbackDiagnostic(feature, scope);
    if (level === 'experimental')
        return experimentalFeatureDiagnostic(feature, scope);
    return new Diagnostic({ code: 'unsupported_feature', severity: 'error', message: 'Requested workflow is not supported by the active render path.', remediation: 'Use a supported render adapter or retain the blocking diagnostic.', support_level: level, details: { feature }, ...scope });
}
export function validateLabelSupport(labels: readonly {
    id?: string | number;
    kind?: string;
    text: string;
}[], options: {
    atlasGlyphs?: readonly string[];
    layerId?: string;
} = {}): ValidationReport {
    const diagnostics: Diagnostic[] = [];
    for (const label of labels) {
        const scope = { layer_id: options.layerId ?? null, object_id: label.id === undefined ? null : String(label.id) };
        if (label.kind === 'line' || label.kind === 'curved')
            diagnostics.push(experimentalFeatureDiagnostic(`${label.kind} labels`, scope));
        if (options.atlasGlyphs) {
            const missing = [...new Set([...label.text].filter(c => !options.atlasGlyphs!.includes(c)))];
            if (missing.length)
                diagnostics.push(missingGlyphsDiagnostic(missing, scope));
        }
    }
    return new ValidationReport({ diagnostics });
}
