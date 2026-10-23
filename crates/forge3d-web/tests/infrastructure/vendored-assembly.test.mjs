import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {VendoredAssembly} from '../../scripts/vendored-assembly.mjs';
test('assembly rejects missing notices, changed upstream bytes and dangling destinations',()=>{
 const root=mkdtempSync(join(tmpdir(),'vendor-plan-'));
 mkdirSync(join(root,'node_modules/fixture'),{recursive:true});mkdirSync(join(root,'dist'));
 writeFileSync(join(root,'node_modules/fixture/package.json'),JSON.stringify({version:'1.0.0'}));
 const upstream='export const value=42;';
 writeFileSync(join(root,'node_modules/fixture/index.js'),upstream);
 writeFileSync(join(root,'dist/app.js'),`export {value} from 'fixture';const lazy=()=>import("fixture");`);
 const record={id:'fixture',package:'fixture',version:'1.0.0',ecosystem:'npm',source:{integrity:'locked'},build:{artifacts:[{name:'index.js',sha256:createHash('sha256').update(upstream).digest('hex')}]}};
 const create=()=>new VendoredAssembly({root,lock:{assets:[record]},npmLock:{packages:{'node_modules/fixture':{version:'1.0.0',integrity:'locked'}}}});
 const spec={files:[{from:'index.js',to:'dist/vendor/fixture.js'},{from:'LICENSE',to:'dist/vendor/fixture.LICENSE'}],imports:{fixture:'dist/vendor/fixture.js'}};
 try {
  assert.throws(()=>create().dependency('fixture',spec),/ENOENT/);assert.equal(existsSync(join(root,'dist/vendor/fixture.js')),false);
  writeFileSync(join(root,'node_modules/fixture/LICENSE'),'license');
  writeFileSync(join(root,'node_modules/fixture/index.js'),'changed');
  assert.throws(()=>create().dependency('fixture',spec),/digest mismatch/);
  writeFileSync(join(root,'node_modules/fixture/index.js'),upstream);
  const broken=create();broken.dependency('fixture',{...spec,imports:{fixture:'dist/vendor/missing.js'}});assert.throws(()=>broken.finish(),/Dangling/);
  const assembly=create();assembly.dependency('fixture',spec);const manifest=assembly.finish();
  assert.equal(manifest.length,2);assert(manifest.every(a=>a.source==='fixture@1.0.0'));
  assert.equal(readFileSync(join(root,'dist/vendor/fixture.js'),'utf8'),upstream);
  assert.equal(readFileSync(join(root,'dist/app.js'),'utf8'),`export {value} from './vendor/fixture.js';const lazy=()=>import("./vendor/fixture.js");`);
 } finally {rmSync(root,{recursive:true,force:true});}
});
