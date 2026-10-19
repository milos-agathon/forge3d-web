import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root,inventory,createCoverage } from './w23-coverage.mjs';
const prior='efba9305',data=createCoverage(),old=JSON.parse(execFileSync('git',['show',prior+':docs/parity/w23-coverage.json'],{cwd:root,maxBuffer:16*1024*1024}));
const native=new Map(inventory().records.map(r=>[r.id,r])),previous=new Map(old.records.map(r=>[r.artifactId,r])),rows=new Map(data.rows.map(r=>[r.id,r]));
for(const record of data.records){const n=native.get(record.artifactId),path=n.source.path,name=n.name;
  if(n.kind==='native-test-definition'){
    for(const [pattern,row]of [[/^tests\/test_license\./,'M08'],[/^tests\/test_3dtiles/,'G04'],[/^tests\/test_diagnostics_contract\./,'M01'],[/^tests\/test_taa|^tests\/test_motion_vectors/,'P14'],[/^tests\/test_volumetrics|^tests\/test_fog/,'P09']])if(pattern.test(path))assert.equal(record.row,row,path+'::'+name);
    if(name==='test_camera_keyframe_constructible')assert.equal(record.row,'C03');
    if(/test_sdf_.*constructible/.test(name))assert.equal(record.row,'G10');
    if(/point_cloud_layer/.test(name))assert.equal(record.row,'G03');
  }
  if(n.kind==='native-doc-feature'&&name==='Point Clouds')assert.equal(record.row,'G03',path);
  if(n.kind.startsWith('changelog-')&&record.row==='G02')assert(/\b(copc|laz|ept)\b|point.?cloud.*(?:load|decode|hierarch)/i.test((n.details?.context??n.name).replaceAll('_',' ')),n.name);
}
const changes=data.records.filter(r=>r.row!==previous.get(r.artifactId)?.row||r.tombstone!==previous.get(r.artifactId)?.tombstone).map(r=>{const n=native.get(r.artifactId);return {artifactId:r.artifactId,nativeSource:n.source,kind:n.kind,name:n.name,context:n.details?.context??null,previous:previous.get(r.artifactId),disposition:r,evidenceTests:rows.get(r.row).tests};});
const review={schemaVersion:1,against:prior,method:'Source ownership and whole-word subject audit. Native file/symbol expectations are checked separately from the generated routing lock; corrections retain original source contexts for review.',rules:['LAZ/COPC/EPT and IBL are tokens, not substrings of accepts/depth/constructible.','Source file ownership precedes generic texture/water/scatter words.','Point-cloud names/headings are distinct from atmospheric clouds.','Dataset and PNG exports use E06 and E07 respectively.'],changes};
const destination=join(root,'docs/parity/w23-routing-review.json');
if(process.argv.includes('--capture'))writeFileSync(destination,JSON.stringify(review,null,2)+'\n');else if(JSON.stringify(JSON.parse(readFileSync(destination,'utf8')))!==JSON.stringify(review))throw Error('Stale source routing review; rerun the source audit capture after inspecting corrections');
console.log(JSON.stringify({sourceDispositionsAudited:data.records.length,corrections:changes.length}));
