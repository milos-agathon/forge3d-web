import type {SupportLevel} from './diagnostics.js';
import {placeholderFallbackDiagnostic,pythonPublic3dtilesIncompleteDiagnostic} from './diagnostic-paths.js';
const scopes: Record<string, [
    string,
    string[]
]> = {
    terrain: ['W03/W07/W08 heightfields, PBR, streaming, overlays and albedo VT', ['One terrain per scene; matching explicit CRS required.']],
    raster: ['W08 RGBA terrain overlays', ['Requires a terrain; maximum eight visible overlays.']],
    vector: ['W12 points, lines and polygons; W19 local Mapbox style mapping', ['Typed local features; streamed MVT is outside the style contract.']],
    labels: ['W13 shaped glyphs and LabelPlan', ['Experimental cases preserve W13 exact diagnostics.']],
    buildings: ['W15 GeoJSON/CityJSON/mesh buildings', ['Texture intent must pass W15 diagnostics.']],
    mesh: ['W15 mesh buffers and OBJ/STL/glTF/GLB', ['Plain glTF only; unsupported extensions diagnose.']],
    'point-cloud': ['W16 inline points, LAS/LAZ/COPC/EPT', ['Depth composed with scene using the same camera.']],
    tiles3d: ['W16 b3dm and pnts tilesets', ['Implicit/i3dm/cmpt and unsupported extensions diagnose.']],
    nodes: ['W02 ground planes, real triangle text meshes, overlays and groups', ['Terrain uses the recipe TerrainSource; custom node/pass intent is blocked.']],
    scatter: ['W09 instancing and wind', ['Product-only instancing paths remain diagnostic.']],
    trace: ['W17 mesh/SDF WebGPU path tracing', ['Dedicated output backend; raster and trace layers cannot be mixed.']],
};
const formats: Record<string, readonly string[]> = { terrain: ['heightmap', 'heightmap-json', 'f32', 'geotiff'], raster: ['rgba', 'png', 'jpg', 'jpeg', 'webp'], vector: ['vector', 'json'], labels: ['labels', 'json'], buildings: ['buildings', 'geojson', 'cityjson'], mesh: ['mesh', 'obj', 'stl', 'gltf', 'glb'], 'point-cloud': ['points', 'las', 'laz', 'copc', 'ept'], tiles3d: ['tileset.json', 'json'] };
const layerFields: Record<string, string[]> = { raster: ['source', 'options'], vector: ['source'], labels: ['source', 'style', 'plan', 'priorityRules', 'typography', 'atlasGlyphs', 'keepouts', 'coordinateSpace'], buildings: ['source', 'options', 'transforms'], mesh: ['source', 'transforms'], 'point-cloud': ['source', 'style', 'traversal', 'origin'], tiles3d: ['source', 'traversal', 'origin'], nodes: ['nodes'], scatter: ['batches'], trace: ['triangles', 'sdf', 'materials', 'lights', 'environment', 'medium', 'samples', 'maxBounces'], diagnostic: ['feature'] };

export const MAP_SCENE_LAYER_KINDS = ['raster', 'vector', 'labels', 'buildings', 'mesh', 'point-cloud', 'tiles3d', 'nodes', 'scatter', 'trace', 'diagnostic'] as const;
export function mapKindPolicy(kind:string){
 const blocked=kind==='point-cloud'||kind==='tiles3d';
 const level:SupportLevel=kind==='point-cloud'?'placeholder/fallback':kind==='tiles3d'?'underdeveloped':'supported';
 const [scope,limitations]=scopes[kind]??['Explicit diagnostic contract',[]];
 return {known:kind==='terrain'||(MAP_SCENE_LAYER_KINDS as readonly string[]).includes(kind),eligible:!blocked,level,scope,limitations:blocked?[...limitations,'MapScene rendering is blocked because MapScene integration of G02-G04 is not yet implemented and tested. Standalone W16 APIs remain separate.']:limitations,formats:formats[kind],fields:['kind','layerId','supportLevel','metadata','instancingPath','requestedStats',...layerFields[kind]??[]],diagnosticCodes:kind==='point-cloud'?['placeholder_fallback']:kind==='tiles3d'?['python_public_3dtiles_incomplete']:['missing_renderable_data','invalid_layer','crs_mismatch']};
}
export function mapIntegrationDiagnostic(kind:string,layerId:string){return kind==='point-cloud'?placeholderFallbackDiagnostic('point cloud MapScene render path',{layer_id:layerId}):kind==='tiles3d'?pythonPublic3dtilesIncompleteDiagnostic({layer_id:layerId}):undefined;}
export const mapSupportKinds=Object.keys(scopes);
