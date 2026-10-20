import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root, inventory, manifestPath } from '../../../../scripts/w23-coverage.mjs';
import { assetFiles, assetBytes, assetManifestPath,validateAssets } from '../../../../scripts/w23-assets.mjs';
import { assetDerivation, generatorOutputProof } from '../../../../scripts/w23-provenance.mjs';
import { createHash } from 'node:crypto';
const load=p=>JSON.parse(readFileSync(join(root,p),'utf8'));
const prefix='crates/forge3d-web/';

test('regional numerical controls belong to each original example, including Platte and PNOA',()=>{
  const catalog=load(prefix+'examples/migration/catalog.json');
  const fixtures=load(prefix+'examples/migration/applications.json');
  for(const e of catalog.filter(e=>e.workflows.includes('application'))){
    const control=fixtures.examples?.[e.name];
    assert(control,e.name+' needs its own input and native computation control');
    assert.equal(control.source.path,e.nativePath,e.name+' must not borrow another example\'s algorithm');
    assert(control.operations.length>0,e.name+' must name its actual preprocessing operations');
  }
});

test('whole-word source subjects distinguish accepts/depth/constructible from EPT/IBL',()=>{
  const routes=new Map(load(manifestPath).records.map(r=>[r.artifactId,r.row]));
  const expected={test_set_license_key_accepts_well_formed_key:'M08',test_enterprise_tier_accepted:'M08',test_camera_keyframe_constructible:'C03',test_sdf_scene_constructible:'G10',test_sdf_primitive_sphere_constructible:'G10',test_volumetrics_scattering_validation:'P09',test_history_texture_format:'P14',test_gbuffer_velocity_texture_created:'P14',test_point_cloud_layer_reports_underdeveloped_render_path_before_render:'G03'};
  for(const [name,row]of Object.entries(expected))for(const r of inventory().records.filter(r=>r.kind==='native-test-definition'&&r.name===name))assert.equal(routes.get(r.id),row,r.source.path+'::'+name);
});

test('point-cloud documentation headings are routed by subject as well as filename',()=>{
  const routes=new Map(load(manifestPath).records.map(r=>[r.artifactId,r.row]));
  for(const r of inventory().records.filter(r=>r.kind==='native-doc-feature'&&r.name==='Point Clouds'))assert.equal(routes.get(r.id),'G03',r.source.path);
});

test('migration executable files are admitted to the checked asset set',()=>{
  for(const name of ['workflows.js','application-analysis.js','gallery.js','interactive-view.js','guide-examples.js','checks.js','index.html'])assert(assetFiles().includes(prefix+'examples/migration/'+name),name+' must not escape integrity verification');
});

test('the bundled mini DEM identifies its exact native data source',()=>{
  const asset=load(assetManifestPath).assets.find(a=>a.path===prefix+'assets/datasets/mini_dem.npy');
  assert.equal(asset.origin,'native-byte-preserved');
  assert.equal(asset.native.path,'python/forge3d/data/mini_dem.npy');
});

test('tree links cannot retain the wrong provenance repository',()=>{
  const page=readFileSync(join(root,prefix+'docs/w21-evidence.md'),'utf8');
  assert(!/https:\/\/github\.com\/milos-agathon\/forge3d\/(tree|blob)\//.test(page));
});

test('derivation is required in addition to a file creation commit',()=>{
  const data=load(assetManifestPath),target=data.assets.find(a=>a.path.endsWith('/glacier_heights.f32'));
  assert(target.derivation.generator.path.endsWith('/generate-w07-material-goldens.py'));
  delete target.derivation;assert(validateAssets(data).some(e=>e.includes('Missing asset derivation')));
});

test('an existing unrelated generator cannot substitute for the writer',()=>{
  const target=structuredClone(load(assetManifestPath).assets.find(a=>a.path.endsWith('/glacier_heights.f32')));
  const path=prefix+'scripts/generate-w18-native.py';
  target.derivation.generator={path,hashMode:'utf8-lf',sha256:createHash('sha256').update(assetBytes(path)).digest('hex')};
  const errors=validateAssets({assets:[target]},{paths:[target.path]});
  assert(errors.some(e=>e.includes('Generator does not declare asset output')));
  assert(!errors.some(e=>e.includes('Derivation input digest mismatch')),'negative control uses a real current script and matching digest');
});

test('a directory manifest proves output only with both its generator and exact listed file',()=>{
  const temporary=mkdtempSync(join(tmpdir(),'w23-output-proof-'));
  try{
    const generator=prefix+'scripts/writer.py',other=prefix+'scripts/unrelated.py',asset=prefix+'tests/fixtures/control/frame.png';
    mkdirSync(join(temporary,prefix+'scripts'),{recursive:true});
    mkdirSync(join(temporary,prefix+'tests/fixtures/control'),{recursive:true});
    writeFileSync(join(temporary,generator),'# writer with directory manifest\n');
    writeFileSync(join(temporary,other),'# unrelated script\n');
    const manifest=join(temporary,prefix+'tests/fixtures/control/manifest.json');
    writeFileSync(manifest,JSON.stringify({generator:'scripts/writer.py',files:[{path:'frame.png'}]}));
    assert(generatorOutputProof(asset,generator,temporary));
    assert.equal(generatorOutputProof(asset,other,temporary),null);
    writeFileSync(manifest,JSON.stringify({generator:'scripts/writer.py',files:[{path:'other.png'}]}));
    assert.equal(generatorOutputProof(asset,generator,temporary),null);
  }finally{assert(temporary.startsWith(join(tmpdir(),'w23-output-proof-')));rmSync(temporary,{recursive:true,force:true});}
});

test('W10 native renders name their writer and W18 URL inputs do not claim a native generator',()=>{
  const assets=load(assetManifestPath).assets;
  for(const name of ['baseline.png','cloud.png','heights.f32','manifest.json']){
    const path=prefix+'tests/golden/w10/native/'+name;
    assert.equal(assetDerivation(path,{root}).generator.path,prefix+'scripts/generate-w10-render-goldens.py');
    assert.equal(assets.find(a=>a.path===path).origin,'native-derived');
  }
  for(const name of ['ortho.png','dem.f32','triangle.obj','labels.json','roads.json']){
    const derivation=assetDerivation(prefix+'tests/fixtures/w18/'+name,{root});
    assert.equal(derivation.kind,'authored-contract-input');
    assert.equal(derivation.generator,undefined);
    assert(derivation.inputs.some(i=>i.path.endsWith('/tests/playwright/w18_mapscene.spec.ts')));
  }
});

test('native kernel capture references cannot substitute an unrelated existing Git source',()=>{
  const target=structuredClone(load(assetManifestPath).assets.find(a=>a.derivation?.kind==='native-kernel-capture'));
  target.derivation.inputs[0].sha256='0'.repeat(64);
  const errors=validateAssets({assets:[target]},{paths:[target.path]});
  assert(errors.some(e=>e.includes('Unrelated native kernel derivation')));
  assert(errors.some(e=>e.includes('Native derivation source bytes mismatch')));
});

test('COG provenance names its source DEM and conversion rather than its copied truth JSON alone',()=>{
  const asset=load(assetManifestPath).assets.find(a=>a.path.endsWith('/examples/migration/rainier-cog.tif'));
  assert.equal(asset.derivation.upstream.sourceSha256,'875b243474b151175f76037acd60c2149ac2e46fba9ba2bbce0c9a6998015dd3');
  assert.equal(asset.derivation.upstream.window.size,1024);
});

test('the routing contract describes its lock semantics and records its generator and audit',()=>{
  const lock=load('docs/parity/w23-source-contracts.json');
  assert(lock.meaning.includes('does not independently prove'));
  assert.equal(lock.provenance.reviewRecord,'docs/parity/w23-routing-review.json');
  assert(lock.provenance.generator.includes('--capture'));
});
