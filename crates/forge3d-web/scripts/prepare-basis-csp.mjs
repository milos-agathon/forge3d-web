// Keep the upstream assets immutable. Replace only the two JS code-generation
// bridges with closure equivalents; the WASM codec and wire converters are untouched.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root=new URL('../',import.meta.url),lock=JSON.parse(readFileSync(new URL('../../docs/parity/dependency-lock.json',root),'utf8'));
const asset=lock.assets.find(a=>a.id==='basis-universal');
for(const name of ['basis_transcoder.js','basis_transcoder.wasm']) {
  const bytes=readFileSync(new URL('assets/basis/'+name,root));
  if(createHash('sha256').update(bytes).digest('hex')!==asset.build.artifacts.find(a=>a.name===name).sha256)throw Error('Basis upstream artifact digest mismatch: '+name);
}
let source=readFileSync(new URL('assets/basis/basis_transcoder.js',root),'utf8');
for(const [startMarker,endMarker,template] of [
  ['function createJsInvoker(', 'function craftInvokerFunction(', 'basis-csp-invoker.js.txt'],
  ['var __emval_create_invoker=', 'var __emval_get_property=', 'basis-csp-emval.js.txt'],
]) {
  const start=source.indexOf(startMarker),end=source.indexOf(endMarker,start);
  if(start<0||end<0||source.indexOf(startMarker,start+1)>=0)throw Error('Pinned Basis glue boundary changed');
  source=source.slice(0,start)+readFileSync(new URL(template,import.meta.url),'utf8').replace(/\r\n?/g,'\n')+source.slice(end);
}
if(/\bnew\s+Function\s*\(|\beval\s*\(/.test(source))throw Error('Basis CSP glue still generates JavaScript dynamically');
const bytes=Buffer.from(source),digest=createHash('sha256').update(bytes).digest('hex');
const recorded=asset.build.artifacts.find(a=>a.name==='basis_transcoder.csp.js');
if(!process.argv.includes('--update-lock')&&recorded?.sha256!==digest)throw Error('Basis CSP adapter differs from W00 lock; review and update the adapter digest');
const output=new URL('assets/basis/basis_transcoder.csp.js',root);
if(!existsSync(output)||!readFileSync(output).equals(bytes))writeFileSync(output,bytes);
if(process.argv.includes('--update-lock')) {
  const entry={name:'basis_transcoder.csp.js',sha256:digest};
  if(recorded)Object.assign(recorded,entry);else asset.build.artifacts.push(entry);
  asset.build.flags=[...new Set([...asset.build.flags,'csp-static-closure-adapter'])];
  asset.consumerTokens=[...new Set([...asset.consumerTokens,'basis_transcoder.csp.js'])];
  const path=new URL('../../docs/parity/dependency-lock.json',root);
  writeFileSync(path,JSON.stringify(lock,null,2)+'\n');
}
