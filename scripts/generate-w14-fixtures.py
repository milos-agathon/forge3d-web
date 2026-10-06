"""Freeze native CRS controls and bundled data without importing Forge3D.

Run with numpy and pyproj. The runtime does not use either dependency.
"""
import ast
import hashlib
import json
import re
from pathlib import Path
import subprocess
import urllib.request
import numpy as np
import pyproj

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'crates/forge3d-web'
COMMIT = '1f4084af428dc699bdcd108b029736cb73903926'

def native(path):
    return subprocess.check_output(['git', 'show', f'{COMMIT}:{path}'], cwd=ROOT)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')

assets = WEB / 'assets/datasets'
assets.mkdir(parents=True, exist_ok=True)
provenance = []
for name in ['mini_dem.npy', 'sample_boundaries.geojson']:
    path = 'python/forge3d/data/' + name
    data = native(path)
    if data.startswith(b'version https://git-lfs'):
        expected = re.search(rb'oid sha256:([0-9a-f]{64})',data).group(1).decode()
        expected_size = int(re.search(rb'size (\d+)',data).group(1))
        data = urllib.request.urlopen(f'https://media.githubusercontent.com/media/milos-agathon/forge3d/main/{path}').read()
        if digest(data) != expected or len(data) != expected_size:
            raise RuntimeError('Native LFS fixture differs from the pinned Git pointer')
    (assets / name).write_bytes(data)
    provenance.append({'path': name, 'commit': COMMIT, 'nativePath': path, 'sha256': digest(data), 'byteLength': len(data)})
source = ast.parse(native('python/forge3d/datasets.py').decode())
records = []
for node in ast.walk(source):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == '_RemoteDataset':
        records.append({arg.arg: ast.literal_eval(arg.value) for arg in node.keywords})
write_json(assets / 'provenance.json', {'schemaVersion': 1, 'sourceCommit': COMMIT, 'bundled': provenance, 'remote': records})
catalog = [dict(name='mini_dem', kind='dem', bundled=True, filename='mini_dem.npy', relativeUrl='mini_dem.npy', sha256=provenance[0]['sha256'], byteLength=provenance[0]['byteLength'], description='Native synthetic 256×256 float32 DEM.', format='npy'), dict(name='sample_boundaries', kind='vector', bundled=True, filename='sample_boundaries.geojson', relativeUrl='sample_boundaries.geojson', sha256=provenance[1]['sha256'], byteLength=provenance[1]['byteLength'], description='Native tutorial boundary polygons in normalized terrain coordinates.', format='geojson', coordinateSpace='normalized')]
for record in sorted(records, key=lambda r:r['name']):
    storage = json.loads((assets / 'remote-storage.json').read_text())['entries'][record['name']]
    lfs, size = storage['gitLfs'], storage['byteLength']
    native_hash = record['known_hash'].split(':')[1]
    served_hash = native_hash if lfs else digest(native('assets/' + record['relative_url']))
    entry = dict(name=record['name'], kind=record['kind'], bundled=False, filename=record['filename'], relativeUrl=record['relative_url'], sha256=served_hash, byteLength=size, gitLfs=lfs, description=record['description'], format=record['filename'].split('.')[-1])
    if native_hash != served_hash:
        entry['nativeSha256'] = native_hash
    catalog.append(entry)
(WEB / 'src-ts/dataset-catalog.ts').write_text('// Generated from native datasets.py by scripts/generate-w14-fixtures.py.\nimport type { DatasetMetadata } from "./dataset-types.js";\nexport const DATASET_CATALOG: readonly DatasetMetadata[] = ' + json.dumps(catalog, indent=2, ensure_ascii=False) + ';\n', encoding='utf-8', newline='\n')
fixture_dir = WEB / 'tests/fixtures/w14'
fixture_dir.mkdir(parents=True, exist_ok=True)
coords = [[float(lon), float(lat)] for lat in [0, 20, 40, 60] for lon in np.linspace(6.1, 11.9, 8)]
cases = []
for target in ['EPSG:3857', 'EPSG:32632', 'EPSG:32654', 'EPSG:32732']:
    points = coords if target != 'EPSG:32654' else [[138.7274,35.3606],[138.73,35.37]]
    if target == 'EPSG:32732':
        points = [[lon, -lat] for lon, lat in coords]
    transformer = pyproj.Transformer.from_crs('EPSG:4326',target,always_xy=True)
    expected = [list(transformer.transform(*p)) for p in points]
    cases.append(dict(source='EPSG:4326',target=target,points=points,expected=expected))
    # Independent inverse inputs are rounded map coordinates, never output from
    # the browser (or its forward transformation).
    inverse_points = [[round(x, 2), round(y, 2)] for x, y in expected]
    inverse = pyproj.Transformer.from_crs(target, 'EPSG:4326', always_xy=True)
    cases.append(dict(source=target, target='EPSG:4326', points=inverse_points,
                      expected=[list(inverse.transform(*p)) for p in inverse_points]))
grid = WEB / 'assets/proj/us_noaa_conus.tif'
if not grid.exists():
    raise RuntimeError('Prepare the pinned W14 PROJ/grid assets before generating controls')
pipeline = '+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=hgridshift +grids=us_noaa_conus.tif +step +proj=unitconvert +xy_in=rad +xy_out=deg'
grid_points = [[-100,40],[-90,35],[-110,45]]
grid_transformer = pyproj.Transformer.from_pipeline(pipeline.replace('us_noaa_conus.tif',grid.as_posix()))
grid_reference = dict(name=grid.name,sha256=digest(grid.read_bytes()),pipeline=pipeline,points=grid_points,expected=[list(grid_transformer.transform(*p)) for p in grid_points])
grid_crs = '+proj=longlat +ellps=clrk66 +nadgrids=us_noaa_conus.tif +type=crs'
grid_system = pyproj.Transformer.from_crs(grid_crs.replace(grid.name, grid.as_posix()), 'EPSG:4326', always_xy=True)
grid_reference['crsControl'] = dict(source=grid_crs, target='EPSG:4326', points=grid_points,
                                  expected=[list(grid_system.transform(*p)) for p in grid_points])
origin_northing = pyproj.Transformer.from_crs(4326,32632,always_xy=True).transform(9,40)[1]
terrain_xy = [[500000,origin_northing],[499920,origin_northing+40],[500080,origin_northing-40]]
terrain_inverse = pyproj.Transformer.from_crs(32632,4326,always_xy=True)
terrain_control = dict(crs='EPSG:32632', transform=[499835,10,0,origin_northing+165,0,-10],
    width=33,height=33,spacing=[10,10],points=[list(terrain_inverse.transform(*p)) for p in terrain_xy],
    world=[[0,0],[-80,-40],[80,40]])
write_json(fixture_dir / 'crs-epsg-v1.json', {'id':'crs-epsg-v1','oracle':{'implementation':'pyproj','version':pyproj.__version__,'projVersion':pyproj.proj_version_str,'nativeSource':COMMIT+':python/forge3d/crs.py'},'tolerances':{'geographicDegrees':1e-7,'projectedMeters':.01,'roundTripMeters':.02},'cases':cases,'grid':grid_reference,'projJson':pyproj.CRS(32632).to_json_dict(),'wkt':{'wgs84':pyproj.CRS(4326).to_wkt(),'utm32':pyproj.CRS(32632).to_wkt(),'utm32NoId':pyproj.CRS(32632).to_wkt(version='WKT1_GDAL')}})
fixture_path=fixture_dir / 'crs-epsg-v1.json'
fixture_value=json.loads(fixture_path.read_text())
fixture_value['terrain']=terrain_control
# Published EPSG Guidance Note 7-2 examples, independent of pyproj generation.
fixture_value['published']=dict(source='https://www.iogp.org/bookstore/wp-content/uploads/sites/2/woocommerce_uploads/2017/01/373-07-02.pdf',
    edition='December 2024', cases=[
      dict(page=53,source='EPSG:4326',target='EPSG:3857',points=[[-100-20/60,24+22/60+54.433/3600]],expected=[[-11169055.58,2800000.00]]),
      dict(page=63,source='EPSG:4277',target='EPSG:27700',points=[[.5,50.5]],expected=[[577274.99,69740.50]]),
      dict(page=63,source='EPSG:27700',target='EPSG:4277',points=[[577274.99,69740.50]],expected=[[.5,50.5]])])
write_json(fixture_path,fixture_value)
write_json(fixture_dir / 'provenance.json', dict(schemaVersion=1, role='Supplemental W14 controls; the W00 crs-epsg-v1 contract is unchanged',
    path='crs-epsg-v1.json', sha256=digest((fixture_dir / 'crs-epsg-v1.json').read_bytes()), encoding='UTF-8 LF',
    generator='scripts/generate-w14-fixtures.py', oracle=dict(pyproj=pyproj.__version__, proj=pyproj.proj_version_str)))
for path in ['python/forge3d/crs.py','python/forge3d/datasets.py','tests/test_crs_reproject.py','tests/test_crs_auto.py','tests/test_datasets.py','src/geo/reproject.rs']:
    out = WEB / 'tests/golden/w14/native' / path.replace('/', '__')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(native(path))

crs_unit = 'crates/forge3d-web/tests/unit/w14-crs.test.ts'
data_unit = 'crates/forge3d-web/tests/unit/w14-datasets.test.ts'
browser = 'crates/forge3d-web/tests/playwright/w14_foundation.spec.ts'
record_test = 'crates/forge3d-web/tests/unit/w14-native-contract.test.ts'
crs_ports = {
    'test_returns_bool': ('reports unavailable worker backends and never returns a silent identity', crs_unit),
    'test_empty_array': ('supports empty arrays, copied identity, XYZ/T and 10000 points', crs_unit),
    'test_same_crs_returns_copy': ('supports empty arrays, copied identity, XYZ/T and 10000 points', crs_unit),
    'test_invalid_shape_raises': ('W14 CRS controls, WKT and axis order', browser),
    'test_wgs84_to_utm': ('matches independent projected and geographic controls', crs_unit),
    'test_roundtrip': ('matches independent projected and geographic controls', crs_unit),
    'test_multiple_points': ('retains the native Fuji multipoint ordering and range', crs_unit),
    'test_no_backend_raises': ('reports unavailable worker backends and never returns a silent identity', crs_unit),
    'test_float32_input': ('W14 CRS controls, WKT and axis order', browser),
    'test_list_input': ('supports empty arrays, copied identity, XYZ/T and 10000 points', crs_unit),
    'test_large_batch': ('supports empty arrays, copied identity, XYZ/T and 10000 points', crs_unit),
    'test_crs_module_importable': ('exports the public native-equivalent ESM CRS and dataset surface', record_test),
    'test_proj_available_accessible': ('reports unavailable worker backends and never returns a silent identity', crs_unit),
    'test_transform_coords_identity': ('supports empty arrays, copied identity, XYZ/T and 10000 points', crs_unit),
    'test_legacy_render_polygons_removed': ('exports the public native-equivalent ESM CRS and dataset surface', record_test),
}
data_ports = {
    'test_mini_dem_loads_with_expected_shape_and_dtype': 'loads native DEM and boundaries exactly, with defensive typed buffers',
    'test_mini_dem_path_exists': 'preserves the complete native registry, kinds, descriptions and known hashes',
    'test_sample_boundaries_load_as_geojson': 'loads native DEM and boundaries exactly, with defensive typed buffers',
    'test_registry_lists_bundled_and_remote_datasets': 'preserves the complete native registry, kinds, descriptions and known hashes',
    'test_list_datasets_returns_named_records': 'preserves the complete native registry, kinds, descriptions and known hashes',
    'test_fetch_returns_bundled_path_for_bundled_dataset': 'caches exact bytes across instances, refuses offline misses and corrupted entries',
    'test_fetch_dem_prefers_local_asset_checkout': 'serves each native fetch-kind through the verified browser cache adapter',
    'test_fetch_cityjson_prefers_local_asset_checkout': 'serves each native fetch-kind through the verified browser cache adapter',
    'test_fetch_copc_prefers_local_asset_checkout': 'serves each native fetch-kind through the verified browser cache adapter',
    'test_fetch_rejects_unknown_dataset': 'preserves the complete native registry, kinds, descriptions and known hashes',
    'test_fetch_kind_validation_rejects_wrong_registry_kind': 'loads native DEM and boundaries exactly, with defensive typed buffers',
    'test_default_dataset_base_url_uses_live_repository_path': 'preserves the complete native registry, kinds, descriptions and known hashes',
    'test_default_dataset_base_url_uses_github_lfs_media_endpoint': 'preserves the complete native registry, kinds, descriptions and known hashes',
}
definitions = []
for path in ['tests/test_crs_reproject.py','tests/test_crs_auto.py','tests/test_datasets.py']:
    source_bytes = native(path)
    for node in ast.walk(ast.parse(source_bytes.decode())):
        if not isinstance(node, ast.FunctionDef) or not node.name.startswith('test_'):
            continue
        if path.endswith('test_datasets.py'):
            title, port = data_ports[node.name], data_unit
            adaptation = 'Native filesystem paths/local checkout become package URLs and digest-verified cache bytes; the live native LFS repository endpoint serves bytes pinned by the native SHA-256. Kind loader success uses small verified fixtures with the native kinds and filenames.'
        elif node.name.startswith('test_terrain_crs_'):
            title, port = 'retains the native terrain CRS default and explicit state', crs_unit
            adaptation = 'TerrainDataset.crs retains optional metadata and supplies the automatic layer target CRS.'
        elif node.name.startswith('test_epsg_') or node.name in ['test_lowercase_epsg','test_invalid_format','test_invalid_number','test_crs_to_epsg_parses_wgs84']:
            title, port = 'extracts raster/vector metadata without inventing a projected CRS', crs_unit
            adaptation = 'Synchronous lexical EPSG parsing and asynchronous PROJ database/WKT identification are explicit browser APIs.'
        else:
            title, port = crs_ports[node.name]
            adaptation = 'ESM, worker capability and typed float/nested arrays replace Python imports, optional native/pyproj backends and NumPy. The stronger W00 numerical tolerances apply.'
        definitions.append(dict(nativeFile=path,definition=node.name,nativeFileSha256=digest(source_bytes),nativeContract=ast.get_docstring(node),adaptation=adaptation,ports=[dict(file=port,test=title)]))
snapshots = [dict(nativePath=path.name.replace('__','/'),sha256=digest(path.read_bytes())) for path in sorted((WEB/'tests/golden/w14/native').iterdir())]
for snapshot in snapshots:
    deep_bytes = subprocess.check_output(['git','show',f'bf8db93233e5158f6d226991fc5d230832c2d806:{snapshot["nativePath"]}'],cwd=ROOT)
    if digest(deep_bytes) != snapshot['sha256']:
        raise RuntimeError('Deep-native/reconciliation W14 source mismatch: '+snapshot['nativePath'])
    snapshot['deepNativeSha256'] = digest(deep_bytes)
write_json(ROOT/'docs/parity/w14-native-test-coverage.json',dict(schemaVersion=1,baseline=COMMIT,deepNative='bf8db93233e5158f6d226991fc5d230832c2d806',nativeTestFiles=3,policy='Every native test definition has an explicit tested browser outcome. The CRS/data source blobs are identical at the deep-native and reconciliation commits. Filesystem paths adapt to URLs/content-addressed storage; no native fallback or silent identity is admitted.',snapshots=snapshots,definitions=definitions))
print('W14 native dataset and CRS fixtures generated')
