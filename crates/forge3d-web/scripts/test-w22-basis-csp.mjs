// Pure codec conformance, without rendering. The pristine pinned upstream glue
// is the oracle; the adapter runs with dynamic string compilation disabled.
import './prepare-basis-csp.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
async function decode(name,strings) {
  const factory=vm.runInNewContext(readFileSync(new URL('assets/basis/'+name,root),'utf8')+';BASIS;',
    { require:createRequire(import.meta.url),process,console,__dirname:fileURLToPath(new URL('assets/basis/',root)) },
    { codeGeneration:{strings,wasm:true} });
  const module=await factory({wasmBinary:readFileSync(new URL('assets/basis/basis_transcoder.wasm',root))});
  module.initializeBasis();
  const file=new module.KTX2File(new Uint8Array(readFileSync(new URL('tests/fixtures/w22/kodim23.ktx2',root))));
  try {
    assert.equal(file.isValid(),true);assert.equal(file.startTranscoding(),1);
    const format=module.transcoder_texture_format.cTFRGBA32.value;
    const data=new Uint8Array(file.getImageTranscodedSizeInBytes(0,0,0,format));
    assert.equal(file.transcodeImage(data,0,0,0,format,0,-1,-1),1);
    return data;
  } finally { file.close();file.delete(); }
}
const original=await decode('basis_transcoder.js',true), adapted=await decode('basis_transcoder.csp.js',false);
assert.deepEqual(adapted,original,'CSP adapter must retain every decoded RGBA byte');
const fixture=JSON.parse(readFileSync(new URL('tests/fixtures/w22/manifest.json',root),'utf8')).fixtures.find(f=>f.file==='kodim23.ktx2');
const sha256=createHash('sha256').update(original).digest('hex');
assert.equal(sha256,fixture.expected.rgbaSha256,'Pinned fixture oracle changed');
console.log(`Basis original/CSP byte-exact: ${original.length} bytes, SHA-256 ${sha256}`);
