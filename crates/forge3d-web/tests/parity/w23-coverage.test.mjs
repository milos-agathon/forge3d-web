import assert from 'node:assert/strict';
import test from 'node:test';
import './w23-public-contracts.test.mjs';
import './w23-application-analysis.test.mjs';
import './w23-review-regressions.test.mjs';
import { changedPixels, requirePixelChange } from '../../examples/migration/checks.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditHistoricalSources, root, manifestPath, validateCoverage, createCoverage } from '../../../../scripts/w23-coverage.mjs';
import { exampleWorkflows } from '../../../../scripts/w23-catalog.mjs';
import { assetManifestPath, validateAssets } from '../../../../scripts/w23-assets.mjs';
import { verifyW23, verifyPublicApis } from '../../../../scripts/verify-w23.mjs';
const load = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const mutate = edit => { const data = load(manifestPath); edit(data); return data; };
test('W23 covers immutable sources, documentation, workflows, APIs and assets', () => { assert.equal(auditHistoricalSources().sources, 541); assert.equal(verifyW23().records, 6531); });
test('an omitted native test definition is rejected', () => { const data = mutate(d => d.records.splice(d.records.findIndex(r => r.artifactId.startsWith('native-test-definition:')), 1)); assert(validateCoverage(data).some(e => e.includes('Unmapped artifact'))); });
test('duplicate artifact ownership is rejected', () => { assert(validateCoverage(mutate(d => d.records.push(d.records[0]))).some(e => e.includes('Duplicate artifact'))); });
test('each native example needs an executable workflow', () => { assert(validateCoverage(mutate(d => d.examples[0].workflows = [])).some(e => e.includes('Missing executable workflow'))); });
test('invented workflow names are rejected', () => { assert(validateCoverage(mutate(d => d.examples[0].workflows = ['invented'])).some(e => e.includes('Missing executable workflow'))); });
test('each row needs a real suite and API', () => { assert(validateCoverage(mutate(d => { d.rows[0].tests = []; d.rows[0].apis = []; })).some(e => e.includes('No concrete test evidence'))); });
test('invented TypeScript migration names are rejected', () => { assert(verifyPublicApis(mutate(d => d.rows[0].apis.push('inventedAPI'))).some(e => e.includes('inventedAPI'))); });
test('stale test content is rejected', () => { assert(validateCoverage(mutate(d => d.tests[0].sha256 = '0'.repeat(64))).some(e => e.includes('Stale test digest'))); });
test('native source provenance changes are rejected', () => { assert(validateCoverage(mutate(d => d.examples[0].source.sha256 = '0'.repeat(64))).some(e => e.includes('provenance mismatch'))); });
test('a missing tombstone is rejected', () => { assert(validateCoverage(mutate(d => d.tombstones.pop())).some(e => e.includes('Unmapped tombstone'))); });
test('every Python root export has a truthful browser destination', () => {
  const data = load(manifestPath), byName = new Map(data.pythonExports.map(e => [e.native, e]));
  assert.deepEqual(byName.get('numpy_to_png').apis, ['arrayToPng']);
  assert.deepEqual(byName.get('Scene').apis, ['Forge3DScene']);
  assert.deepEqual(byName.get('available_datasets').apis, ['DatasetRegistry']);
  assert.equal(byName.get('__version__').kind, 'npm-metadata');
  data.pythonExports.pop(); assert(validateCoverage(data).some(e => e.includes('Unmapped Python export')));
});
test('untracked golden bytes and fixture corruption are rejected', () => {
  const assets = load(assetManifestPath); assets.assets[0].sha256 = '0'.repeat(64);
  assert(validateAssets(assets).some(e => e.includes('digest mismatch')));
  assets.assets.pop(); assert(validateAssets(assets).some(e => e.includes('Untracked asset')));
});

test('semantic routing changes are rejected even when every destination exists', () => {
  const apiIds = new Set(load('crates/forge3d-web/tests/parity/composite-inventory.json').records.filter(r => r.source.path === 'tests/test_api_contracts.py').map(r => r.id));
  const edits = [
    d => d.records.forEach(r => r.row = 'E07'),
    d => d.records.filter(r => apiIds.has(r.artifactId)).forEach(r => r.row = 'M07'),
    d => d.pythonExports.find(r => r.native === 'numpy_to_png').apis = ['exportPdf'],
    d => d.examples.forEach(e => e.workflows = ['esm']),
    d => d.rows.find(r => r.id === 'R12').tests = d.rows.find(r => r.id === 'E05').tests,
    d => d.tests.forEach(t => t.declarations = t.declarations.slice(0, 1)),
  ];
  for (const edit of edits) assert(validateCoverage(mutate(edit)).length > 0, String(edit));
  assert(verifyPublicApis(mutate(edits[2])).length > 0, 'Existing but unrelated API must be rejected');
});

test('known semantic migration destinations are explicit', () => {
  const byName = new Map(load(manifestPath).pythonExports.map(e => [e.native, e]));
  assert.deepEqual(byName.get('calculate_triangle_reduction_py').apis, ['calculateTriangleReduction']);
  assert.deepEqual(byName.get('ClipmapConfig').apis, ['TerrainClipmapInput']);
  assert.deepEqual(byName.get('LodSettings').apis, ['TerrainLodInput']);
  assert.deepEqual(byName.get('MaterialSet').apis, ['TerrainMaterialInput']);
  assert.deepEqual(byName.get('ExportBounds').apis, ['Bounds']);
  assert.deepEqual(byName.get('get_colormap').apis, ['colormaps']);
});

test('point-cloud tests and documentation never route to atmospheric clouds', () => {
  const data = load(manifestPath), native = load('crates/forge3d-web/tests/parity/composite-inventory.json');
  const routes = new Map(data.records.map(r => [r.artifactId, r]));
  const points = native.records.filter(r => /test_pointcloud_(lod|gpu_integration)|point_cloud|pointcloud/i.test(r.source.path));
  assert(points.length > 20);
  for (const r of points) assert.notEqual(routes.get(r.id).row, 'P10', r.qualifiedName);
});

test('all asset provenance is concrete and source links use the actual repository', () => {
  const assets = load(assetManifestPath);
  assert(assets.assets.every(a => a.native || a.provenance?.length > 0), 'Every asset needs native or generator/source provenance');
  const source = readFileSync(join(root, 'scripts/w23-coverage.mjs'), 'utf8');
  assert(!source.includes('https://github.com/milos-agathon/forge3d/blob/'), 'Wrong repository in source links');
});

test('opaque clear frames and terrain-only layer regressions fail the RGB checks', () => {
  const clear=Uint8Array.from({length:400},(_,i)=>i%4===3?255:0);
  assert.equal(changedPixels(clear,clear),0);
  assert.throws(()=>requirePixelChange(clear,clear,'material'),/RGB pixels/);
  const terrain=clear.slice();for(let i=0;i<terrain.length;i+=4)terrain[i]=80;
  assert.throws(()=>requirePixelChange(terrain,terrain,'vector layer'),/RGB pixels/);
  const contributed=terrain.slice();for(let i=0;i<40;i+=4)contributed[i+1]=200;
  assert.equal(requirePixelChange(terrain,contributed,'visible layer'),10);
});

test('missing or invented asset provenance is rejected', () => {
  const data=load(assetManifestPath),target=data.assets.find(a=>!a.native);
  target.provenance=[];assert(validateAssets(data).some(e=>e.includes('Missing concrete provenance')));
  target.provenance=['git:'+ '0'.repeat(40)+':crates/forge3d-web/not-there'];
  assert(validateAssets(data).some(e=>e.includes('Missing Git asset provenance')));
});

test('editing the catalog cannot turn Colorado into an unrelated PNG-only workflow', () => {
  const original=exampleWorkflows['colorado_rem_forge3d.py'];
  try{exampleWorkflows['colorado_rem_forge3d.py']=['png'];assert(validateCoverage(createCoverage()).some(e=>e.includes('Semantic workflow mismatch examples/colorado_rem_forge3d.py')));}
  finally{exampleWorkflows['colorado_rem_forge3d.py']=original;}
});

test('native camera/AOV/beauty oracles retain generator provenance', () => {
  const data=load(assetManifestPath);
  for(const name of ['w05-camera-native.json','w06-aov-native.bin','w06-aov-native.json','w04-terrain-pbr-native.png']){
    const asset=data.assets.find(a=>a.path.endsWith('/'+name));
    assert(name==='w04-terrain-pbr-native.png'?['native-byte-preserved','native-derived'].includes(asset.origin):asset.origin==='native-derived',name);
    assert(asset.provenance.some(p=>p.includes('/scripts/generate-w0')),name);
  }
});

test('an existing but unrelated native source cannot be used as asset provenance', () => {
  const data=load(assetManifestPath),native=data.assets.filter(a=>a.origin==='native-byte-preserved'&&a.native?.gitBlob),first=native[0],other=native.find(a=>a.sha256!==first.sha256);
  first.native=other.native;assert(validateAssets(data).some(e=>e.includes('Native source bytes mismatch')));
});

test('installed asset hashes include shipped test-source snapshots and exclude repository test controls', () => {
  const all=load(assetManifestPath).assets,shipped=load('crates/forge3d-web/docs/migration-assets.json').assets;
  assert(shipped.some(a=>a.path.includes('/docs/evidence-sources/tests/')), 'Shipped evidence snapshots need installed hash verification');
  assert(!shipped.some(a=>a.path.startsWith('crates/forge3d-web/tests/')), 'Repository-only controls must not enter the installed manifest');
  assert.deepEqual(shipped.map(a=>a.path),all.filter(a=>!a.path.startsWith('crates/forge3d-web/tests/')).map(a=>a.path));
});
