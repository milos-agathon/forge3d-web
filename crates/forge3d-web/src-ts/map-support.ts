import { SupportMatrixEntry } from './diagnostics.js';
export const MAP_SCENE_LAYER_KINDS = ['raster', 'vector', 'labels', 'buildings', 'mesh', 'point-cloud', 'tiles3d', 'nodes', 'scatter', 'trace', 'diagnostic'] as const;
const scopes: Record<string, [
    string,
    string[]
]> = {
    terrain: ['W03/W07/W08 heightfields, PBR, streaming, overlays and albedo VT', ['One terrain per scene; matching explicit CRS required.']],
    raster: ['W08 RGBA terrain overlays', ['Requires a terrain; maximum eight visible overlays.']],
    vector: ['W12 points, lines and polygons', ['Typed local features; Mapbox style loading is W19.']],
    labels: ['W13 shaped glyphs and LabelPlan', ['Experimental cases preserve W13 exact diagnostics.']],
    buildings: ['W15 GeoJSON/CityJSON/mesh buildings', ['Texture intent must pass W15 diagnostics.']],
    mesh: ['W15 mesh buffers and OBJ/STL/glTF/GLB', ['Plain glTF only; unsupported extensions diagnose.']],
    'point-cloud': ['W16 inline points, LAS/LAZ/COPC/EPT', ['Depth composed with scene using the same camera.']],
    tiles3d: ['W16 b3dm and pnts tilesets', ['Implicit/i3dm/cmpt and unsupported extensions diagnose.']],
    nodes: ['W02 ground planes, real triangle text meshes, overlays and groups', ['Terrain uses the recipe TerrainSource; custom node/pass intent is blocked.']],
    scatter: ['W09 instancing and wind', ['Product-only instancing paths remain diagnostic.']],
    trace: ['W17 mesh/SDF WebGPU path tracing', ['Dedicated output backend; raster and trace layers cannot be mixed.']],
};
export function getMapSceneSupportMatrix(): SupportMatrixEntry[] {
    const entries = Object.entries(scopes).map(([capability, [scope, limitations]]) => new SupportMatrixEntry({ area: 'mapscene', capability, support_level: capability === 'point-cloud' ? 'placeholder/fallback' : capability === 'tiles3d' ? 'underdeveloped' : 'supported', scope, limitations: capability === 'point-cloud' || capability === 'tiles3d' ? [...limitations, 'MapScene rendering is blocked until G02-G04/W16 acceptance, including the independent laz-perf security sign-off. Standalone W16 APIs remain separate.'] : limitations, diagnostic_codes: capability === 'point-cloud' ? ['placeholder_fallback'] : capability === 'tiles3d' ? ['python_public_3dtiles_incomplete'] : ['missing_renderable_data', 'invalid_layer', 'crs_mismatch'], remediation: 'Provide a validated typed resource in the documented scope.', evidence: ['tests/unit/w18-mapscene.test.ts', 'tests/playwright/w18_mapscene.spec.ts', 'test:package-consumer:w18'] }));
    for (const [capability, level, code] of [['mapbox-style', 'missing', 'unsupported_style_field'], ['map-furniture', 'missing', 'unsupported_feature'], ['product-instancing', 'unsupported', 'unsupported_instancing_path'], ['legacy-python-3dtiles', 'underdeveloped', 'python_public_3dtiles_incomplete'], ['Pro', 'Pro-gated', 'pro_gated_path'], ['placeholder', 'placeholder/fallback', 'placeholder_fallback'], ['experimental', 'experimental', 'experimental_feature']] as const)
        entries.push(new SupportMatrixEntry({ area: 'mapscene', capability, support_level: level, scope: 'Explicit diagnostic contract', diagnostic_codes: [code], limitations: ['Cannot imply successful rendering of unavailable output.'], remediation: 'Use a supported adapter.', evidence: ['tests/unit/w18-diagnostics.test.ts'] }));
    return entries.sort((a, b) => a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0);
}
