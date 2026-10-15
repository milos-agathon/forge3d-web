import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=new URL('../',import.meta.url);
const lock=JSON.parse(readFileSync(new URL('../../docs/parity/dependency-lock.json',root),'utf8'));
const definitions=[
  ['tiff','geotiff','W08',['geotiff']],['laz','laz-perf','W16',['laz-perf']],
  ['ktx2','ktx2-basis','W04',['ktx-parse','basis-universal']],['hdr','radiance-rgbe','W04/W15',[]],
  ['exr','exr-wasm','W06',['exr']],['glb','gltf2','W15',[]],['glyph-pbf','mapbox-glyph-pbf','W13/W19',[]],
];
// A conservative package implementation identity covers transitive and dynamic
// imports, WASM bindings, worker entry points, shaders, helpers and build locks.
// Unrelated implementation changes may invalidate caches; omitted helpers cannot.
const inputs=[];
function collect(directory){
  for(const entry of readdirSync(new URL(directory+'/',root),{withFileTypes:true})){
    const path=directory+'/'+entry.name;
    if(entry.isDirectory())collect(path);
    else if(entry.isFile()&&/\.(ts|mjs|rs|wgsl|glsl|json|toml|txt)(\.(tmpl|template))?$/.test(path)&&path!=='src-ts/codec-catalog.ts')inputs.push(path);
  }
}
for(const path of ['src-ts','src','../forge3d-core/src'])collect(path);
for(const path of ['scripts/generate-codec-catalog.mjs','scripts/prepare-dist.mjs','scripts/embed-proj-worker.mjs','scripts/prepare-basis-csp.mjs','scripts/basis-csp-invoker.js.txt','scripts/basis-csp-emval.js.txt','package.json','package-lock.json','Cargo.toml','build.rs','../forge3d-core/Cargo.toml','../forge3d-core/build.rs','../../Cargo.toml','../../Cargo.lock','../../rust-toolchain.toml'])if(existsSync(new URL(path,root)))inputs.push(path);
const implementation=createHash('sha256');
for(const path of inputs.sort())implementation.update(path+'\0'+readFileSync(new URL(path,root),'utf8').replace(/\r\n?/g,'\n')+'\0');
const implementationId=implementation.digest('hex');
const codecs=definitions.map(([format,id,owner,ids])=>{
  const dependencies=ids.map(id=>{
    const asset=lock.assets.find(a=>a.id===id);
    if(!asset||!asset.consumingTasks.includes('W22'))throw Error(`Missing W22 lock: ${id}`);
    return {id,version:asset.version,sha256:asset.source.sha256};
  });
  const hash=createHash('sha256').update(implementationId).update(JSON.stringify(dependencies));
  for(const id of ids)hash.update(JSON.stringify(lock.assets.find(a=>a.id===id).build.artifacts));
  return {id,format,owner,revision:hash.digest('hex'),dependencies};
});
const output='// Generated from complete runtime source/build inputs and W00 codec pins.\n'+
  "import type { CodecDescriptor } from './codec-types.js';\n"+
  `export const CODEC_CATALOG: readonly CodecDescriptor[] = ${JSON.stringify(codecs,null,2)};\n`+
  `export const DENOISER_REVISION = '${implementationId}';\n`;
const target=new URL('src-ts/codec-catalog.ts',root);
if(process.argv.includes('--check')){
  if(readFileSync(target,'utf8')!==output)throw Error('Codec catalog is stale; run npm run generate:codecs');
}else writeFileSync(fileURLToPath(target),output);
