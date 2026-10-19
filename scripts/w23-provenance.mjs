import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
const prefix='crates/forge3d-web/';
const digest=b=>createHash('sha256').update(b).digest('hex');
const capturedSources=new Map();
export function resetDerivationInputs(){capturedSources.clear();}
const source=(root,path)=>{if(!capturedSources.has(path)){const binary=/\.(?:laz|tif|npy|bin|glb|png|f32)$/.test(path),raw=readFileSync(join(root,path));capturedSources.set(path,{path,sha256:digest(binary?raw:raw.toString('utf8').replace(/\r\n?/g,'\n')),hashMode:binary?'raw':'utf8-lf'});}return {...capturedSources.get(path)};};
const generators=[
  [/tests\/golden\/w05-camera-native/,'scripts/generate-w05-camera-fixture.py',[],'unchanged historical camera implementation executed on the recorded camera cases'],
  [/tests\/golden\/(w06-aov-native|w04-terrain-pbr-native)/,'scripts/generate-w06-aov-fixture.py',[],'native terrain/AOV readback and explicit frame channel layouts'],
  [/tests\/fixtures\/w16\/workload-ept\//,'scripts/w16_fixture_workload.py',['tests/fixtures/w16/autzen_trim.laz'],'build_branching_ept: spatial buckets, little-endian point records and EPT hierarchy'],
  [/tests\/fixtures\/w16\//,'scripts/generate-w16-fixtures.py',['tests/fixtures/w16/autzen_trim.laz','tests/fixtures/w16/ellipsoid.copc.laz'],'laspy/lazrs native decode controls and byte-defined OGC tiles'],
  [/tests\/golden\/w07\//,'scripts/generate-w07-material-goldens.py',[],'native material scene definitions, float32 height fields and native render variants'],
  [/tests\/golden\/w08\/(vt-|vt\.)/,'scripts/generate-w08-vt-goldens.py',[],'native virtual-texture render and albedo controls'],
  [/tests\/golden\/w08\//,'scripts/generate-w08-fixtures.py',[],'GDAL COG conversion, predictor fixtures and independent raster truth'],
  [/tests\/golden\/w10\/(cloud|sky|water|volumetric)/,'scripts/generate-w10-render-goldens.py',[],'native WGSL render/readback controls'],
  [/tests\/golden\/w10\//,'scripts/generate-w10-native-fixtures.py',[],'native ephemeris, density and environment controls'],
  [/tests\/fixtures\/w15\//,'scripts/generate-w15-fixtures.mjs',[],'byte-defined mesh formats, CityJSON and native test snapshots'],
  [/tests\/fixtures\/w17\//,'scripts/generate-w17-fixture.py',[],'historical native source and tracing/SDF reference cases'],
  [/tests\/fixtures\/w18\//,'scripts/generate-w18-native.py',[],'native recipe contracts and bounded map resources'],
  [/tests\/fixtures\/w19\//,'scripts/generate-w19-native-fixtures.py',[],'native styles, bundles and replay cases'],
  [/tests\/fixtures\/w20\/text-layout/,'scripts/generate-w20-text-oracle.py',['assets/fonts/DejaVuSans.ttf'],'independent native text metrics and raster/layout controls'],
  [/tests\/fixtures\/w20\//,'scripts/generate-w20-native-fixture.py',[],'native colormap, vector export and cartography controls'],
  [/tests\/fixtures\/w22\//,'scripts/generate-w22-fixtures.mjs',[],'pinned codec inputs and independent encoded/decoded fixture metadata'],
  [/tests\/golden\/w11\//,'scripts/generate-w11-native-fixtures.py',[],'native post-processing controls and source identities'],
  [/tests\/golden\/w12\//,'scripts/generate-w12-native-fixtures.py',[],'native vector and camera controls and source identities'],
  [/tests\/fixtures\/w12\//,'scripts/generate-w12-native-fixtures.py',[],'native vector fixtures'],
  [/tests\/golden\/w23\/applications|examples\/migration\/applications/,'scripts/generate-w23-application-fixtures.py',['assets/datasets/mini_dem.npy','scripts/w23_regional_fixtures.py','tests/fixtures/w23/regional-dem-inputs.json'],'unchanged original Python helper ASTs and separately recorded example inputs'],
  [/tests\/golden\/w23\/|examples\/migration\/(terrain-single-tile|single-tile-oracle)/,'scripts/generate-w23-goldens.py',['assets/datasets/mini_dem.npy'],'unchanged native single-tile main and NumPy float32 normalization'],
];

export function assetDerivation(path,{root,nativeByDigest=new Map()}={}){
  const rel=path.slice(prefix.length),name=basename(path);
  if(rel==='assets/w12/luxembourg-rail.json'){
    const value=JSON.parse(readFileSync(join(root,path),'utf8'));
    return {kind:'converted-native-data',generator:source(root,prefix+'scripts/generate-w12-native-fixtures.py'),inputs:[{ref:value.source.commit,path:value.source.path,sha256:value.source.sha256}],recipe:'Read native GeoPackage WKB rail lines, project to EPSG:3035, center/scale to 500 world units and round positions to six decimal places, as specified by the archived generator.'};
  }
  if(rel.startsWith('tests/fixtures/w13/'))return {kind:'generated-control',generator:source(root,'scripts/generate-w13-native-oracles.py'),inputs:[],recipe:'Execute the original pinned Python label tests with their original bodies; record native label plan/feature results. The baseline and per-case native test identifiers are embedded in each control.'};
  if(rel.startsWith('tests/fixtures/w14/'))return {kind:'generated-control',generator:source(root,'scripts/generate-w14-fixtures.py'),inputs:[source(root,'docs/parity/forge3d-composite-baseline.json')],recipe:'Pinned W00 CRS contract and supplemental pyproj 3.7.2/PROJ 9.5.1 coordinate, terrain and grid controls. The oracle version, parameters and native source identity are embedded in these records.'};
  if(rel==='tests/fixtures/w21/native-contract.json'){
    const value=JSON.parse(readFileSync(join(root,path),'utf8'));
    return {kind:'native-source-inventory',inputs:value.files.map(v=>({...v,ref:value.commit})),recipe:'Exact historical source SHA-256 inventory for license, PNG, benchmark and diagnostic contract comparisons; not a generated pixel oracle.'};
  }
  if(rel==='tests/fixtures/w21/licenses.json'||rel==='tests/fixtures/w21/png-fixtures.mjs')return {kind:'authored-contract-input',inputs:[source(root,prefix+'tests/unit/w21-license.test.ts'),source(root,prefix+'tests/unit/w21-images.test.ts')],recipe:'Deterministic test-only license signatures/date cases or byte-defined PNG edge cases used by the named W21 suites. These are authored boundary controls, not native-generated outputs or product entitlements.'};
  if(/assets\/(datasets|fonts|harfbuzz|laz|proj)\/(?:.*provenance|remote-storage)\.json$/.test(rel)){
    const value=JSON.parse(readFileSync(join(root,path),'utf8'));
    return {kind:'upstream-manifest',inputs:[source(root,prefix+'package-lock.json'),source(root,'docs/parity/dependency-lock.json')],upstream:value,recipe:'Upstream source/version/archive and per-file digests are recorded in this metadata itself and checked by the owning dependency/asset suites. The dependency locks pin runtime packages; this record is provenance metadata, not a numerical golden.'};
  }
  if(path.includes('/docs/evidence-sources/')&&name!=='provenance.json'){
    const original=prefix+path.split('/docs/evidence-sources/')[1].slice(0,-4);
    return {kind:'source-copy',transform:'utf8-lf',inputs:[source(root,original)],purpose:'Exact review snapshot of the named source; not an executed installed test suite.'};
  }
  if(rel==='assets/datasets/mini_dem.npy')throw Error('Native mini_dem must be recognized before derived asset admission');
  if(rel==='tests/fixtures/w23/regional-dem-inputs.json'){
    const value=JSON.parse(readFileSync(join(root,path),'utf8'));
    return {kind:'converted-native-data',generator:source(root,prefix+'scripts/capture-w23-dem-inputs.py'),inputs:[],upstream:Object.fromEntries(Object.entries(value.examples).map(([name,v])=>[name,v.source])),recipe:'Recorded finite 16x16 windows of seven actual original example DEMs. Source-file hashes, CRS, bounds and float32 window hashes are retained; numerical rechecks use the committed windows without the external archive.'};
  }
  if(/^assets\/(fonts|harfbuzz|laz|proj|datasets)\//.test(rel)&&!/(provenance|remote-storage).*\.json$/.test(name)){
    const folder=path.slice(0,path.lastIndexOf('/')),manifests=['provenance.json','dejavu-provenance.json'].map(n=>folder+'/'+n).filter(p=>p!==path&&existsSync(join(root,p)));
    if(manifests.length)return {kind:'upstream-dependency',inputs:manifests.map(p=>source(root,p)),recipe:'Preserved upstream library, database, dataset or license from the versioned source/archive and digest records in the adjacent provenance manifests. This is an upstream input, not a browser-created numerical golden.'};
  }
  if(/tests\/fixtures\/w16\/(?:autzen_trim\.laz|ellipsoid\.copc\.laz|copc-js\.LICENSE|laz-perf\.LICENSE)/.test(rel))return {kind:'upstream-dependency',inputs:[source(root,prefix+'tests/fixtures/w16/upstream.json')],recipe:'Preserved upstream LAZ/COPC project test data or license. The upstream project commit identities are retained in upstream.json; generated EPT/OGC fixtures use these as inputs.'};
  if(rel==='examples/migration/rainier-cog.tif'||rel==='examples/migration/rainier-cog.json'){
    const metadata=JSON.parse(readFileSync(join(root,prefix+'tests/golden/w08/w08-fixtures.json'),'utf8'));
    return {kind:'converted-native-data',generator:source(root,prefix+'scripts/generate-w08-fixtures.py'),inputs:[{path:prefix+'tests/golden/w08/'+name,sha256:digest(readFileSync(join(root,prefix+'tests/golden/w08/'+name))),hashMode:'raw'}],upstream:metadata.provenance['rainier-cog.tif'],recipe:'Center crop of the recorded source DEM; GDAL COG DEFLATE/predictor-3, 256 tiles and power-of-two overviews. Gallery copy preserves the encoded TIFF.'};
  }
  if(rel.startsWith('tests/golden/w09/')){
    const value=JSON.parse(readFileSync(join(root,path),'utf8')),digests=typeof value.sourceSha256==='string'?[value.sourceSha256]:Object.values(value.sourceSha256??{}),inputs=digests.map(sha=>nativeByDigest.get(sha)).filter(Boolean);
    if(inputs.length)return {kind:'native-kernel-capture',inputs,parameters:Object.fromEntries(Object.entries(value).filter(([k,v])=>/baseline|width|height|terrainWidth|zScale|rays|resolution|reflectionSamples|numpy|scope|input/.test(k))),recipe:'Historical native numerical/shader capture. The source digests embedded in the control identify the original kernels; this does not claim the missing W09 authoring harness is archived.'};
    return {kind:'browser-observation',inputs:[source(root,prefix+'examples/test-w09.html'),source(root,prefix+'tests/playwright/w09_scatter_probes.spec.ts')],recipe:'Recorded Chromium preflight render hashes; hardware and workload are recorded in this observation, not native reference qualification.'};
  }
  for(const [pattern,generator,inputs,recipe]of generators){
    if(pattern.test(rel))return {kind:'generated-control',generator:source(root,prefix+generator),inputs:inputs.filter(p=>existsSync(join(root,prefix+p))&&prefix+p!==path).map(p=>source(root,prefix+p)),recipe};
  }
  if(rel.startsWith('docs/evidence-sources/')||rel.startsWith('examples/migration/'))return {kind:'browser-migration-source',inputs:[source(root,'scripts/w23-coverage.mjs'),source(root,'scripts/w23-catalog.mjs')],recipe:'Authored browser workflow adapter or generated migration input. Native sources and exact per-example operations are recorded in the migration catalog and application controls; this program/input is not a native oracle.'};
  if(rel.startsWith('assets/basis/')||rel.startsWith('assets/licenses/'))return {kind:'upstream-dependency',inputs:[source(root,prefix+'package-lock.json'),source(root,prefix+'scripts/generate-codec-catalog.mjs')],recipe:'Vendored dependency/license bytes from the package or codec dependency lock; patched Basis CSP glue is produced and checked by scripts/test-w22-basis-csp.mjs.'};
  // Explicitly distinguish authored API/format test inputs from converted
  // native goldens. A creation commit is storage history, not their oracle.
  return {kind:'authored-contract-input',inputs:[source(root,prefix+'types/index.d.ts'),source(root,'docs/parity/forge3d-composite-baseline.json')],recipe:`Hand-authored ${rel.startsWith('tests/golden/')?'browser regression control':'typed fixture'} for ${rel.split('/').slice(0,3).join('/')}; ${name} is not presented as a native-derived oracle. Native behavior is established by the owning capability tests and source references, not this file's Git ancestry.`};
}
