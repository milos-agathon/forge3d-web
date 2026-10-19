// Source-based corrections to W00. Keep these independent of the presentation
// catalog: moving a generated record to another existing row must fail validation.
import { classifyNativeSubject } from './w23-source-rules.mjs';
export function semanticRoute(record, original, tombstones) {
  const path = record.source.path.toLowerCase(), name = record.name.toLowerCase();
  const subject=(name+' '+(record.details?.context??'')).replaceAll('_',' ').toLowerCase();
  const tombstone = id => ({ row: tombstones.find(t => t.id === id).capabilityId, tombstone: id });
  if (record.kind === 'tombstone') return tombstone(record.qualifiedName);
  const historical = record.kind.startsWith('changelog-') || record.kind === 'inactive-module-root' || /test_dask_stub/.test(path);
  if (historical) {
    const subject = path + ' ' + name + ' ' + (record.details?.context ?? '').toLowerCase();
    for (const [pattern, id] of [
      [/\bply\b/, 'ply-import'], [/\bdraco\b/, 'draco-decode'],
      [/tv11|page.based.*shadow/, 'tv11-page-shadows'], [/water detection|automatic.*water/, 'automatic-dem-water'],
      [/\bhud\b/, 'hud'], [/rasterio|xarray|\bdask\b|dask_/, 'rasterio-adapters'],
      [/datashader/, 'datashader'], [/cartopy|\bwmts\b|xyz tiles/, 'xyz-wmts-cartopy'],
      [/svgf|hair.*anisotrop/, 'svgf-hair-anisotropic'], [/\bvshade\b/, 'vshade-alias'],
      [/render_raster/, 'render-raster'], [/render_polygons/, 'render-polygons'], [/render_raytrace_mesh/, 'render-raytrace-mesh'],
    ]) if (pattern.test(subject)) return tombstone(id);
  }
  if (/point[-_ ]?cloud/.test(path+' '+name)) return { row: /copc|laz_fixture|decode/.test(path+' '+name) ? 'G02' : 'G03' };
  if (record.kind.startsWith('native-test')) {
    for(const [pattern,row]of [[/test_license|pro_gating/,'M08'],[/test_3dtiles|test_tiles3d/,'G04'],[/test_diagnostics_contract/,'M01'],[/test_taa|test_motion_vectors/,'P14'],[/test_volumetrics|test_fog/,'P09'],[/test_style|test_mapbox/,'M03'],[/test_osm_city/,'G05a']])if(pattern.test(path))return {row};
  }
  if(record.kind.startsWith('native-test')&&original.capabilityId==='G02'&&!/(?:^|[\/_ -])(?:copc|laz|ept)(?:[\/_. -]|$)/.test(path+' '+name))return {row:classifyNativeSubject((path+' '+subject).replaceAll('_',' '))?.row??'R12'};
  if(record.kind.startsWith('changelog-')){
    const transport=/\b(?:copc|laz|ept)\b/.test(subject);
    if(original.capabilityId==='G02'&&!transport || original.capabilityId==='T13'&&/\bscattering\b/.test(subject)){
      return {row:classifyNativeSubject(subject)?.row??'R12'};
    }
  }
  if (/test_datasets\.py|python\/forge3d\/datasets\.py/.test(path)) return { row: 'E06' };
  if (/p2_building_texture/.test(path)) return { row: 'G05b' };
  if (/label_plan_docs/.test(path)) return { row: 'V07' };
  if (/mapscene_docs|mapscene_quickstart/.test(path)) return { row: 'M02a' };
  if (/png_io|numpy_to_png|png_to_numpy/.test(path)) return { row: 'E07' };
  if (path === 'tests/test_api_contracts.py' && record.kind === 'native-test-definition') {
    for (const [pattern,row] of [
      [/bloom|dof/,'P13'],[/ssao|ssgi|ssr/,'P11'],[/oit/,'P12'],[/(?:^|_)ibl(?:_|$)/,'P06'],
      [/water/,'T16'],[/point_spot_light|point_light/,'P01'],[/cloud_shadow/,'P10'],
      [/laz|copc|decoded|sample_coordinates/,'G02'],[/gpu_buffer|gpu_byte|point_buffer|point_count|viewer_buffer/,'G03'],
      [/slope|contour|spike_analysis/,'T03'],[/tbn|cube_vertex/,'P05'],[/label/,'V05'],[/sdf/,'G10'],
      [/camera_animation|camera_keyframe/,'C03'],[/camera/,'C01'],[/offscreen|fallback|non_native_scene|native_scene_detected/,'R11'],
      [/msaa/,'R04'],[/render_rgba|render_png|frame/,'R02'],[/ground_plane|geometry/,'G06'],[/transform/,'G07'],
    ]) if(pattern.test(name))return {row};
  }
  const exports = {
    ClipmapConfig: 'T08', ClipmapMesh: 'T08', calculate_triangle_reduction_py: 'T08', LodSettings: 'T05',
    MaterialSet: 'T05', vector_overlay_configs_from_style: 'M03', ExportBounds: 'M06', get_colormap: 'M07',
    LabelBatchResult: 'V05', TerrainRenderParams: 'T05', TerrainRenderParamsConfig: 'T05',
    MapFurnitureLayer:'M05',
    python_public_3dtiles_incomplete_diagnostic: 'M01',
  };
  if(record.kind==='package-root-export'){
    if(/^(?:available_datasets|bundled_datasets|remote_datasets|list_datasets|dataset_info|fetch_dataset|fetch_dem|fetch_cityjson|fetch_copc|mini_dem|mini_dem_path|sample_boundaries|sample_boundaries_path|datasets)$/.test(record.name))return {row:'E06'};
    if(/^(?:numpy_to_png|png_to_numpy|rgba_to_png_bytes)$/.test(record.name))return {row:'E07'};
  }
  if (record.kind === 'package-root-export' && exports[record.name]) return { row: exports[record.name] };
  return original.targetId.startsWith('target:tombstone:')
    ? tombstone(original.targetId.slice('target:tombstone:'.length)) : { row: original.capabilityId };
}

export function sameValues(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
