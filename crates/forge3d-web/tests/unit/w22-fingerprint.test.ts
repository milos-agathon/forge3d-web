import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot=fileURLToPath(new URL('../../',import.meta.url));
let temporary='',packageCopy='',baseline:any[]=[];
let copyTasks: Promise<void>[]=[];
function generate() {
  const run=spawnSync(process.execPath,[join(packageCopy,'scripts/generate-codec-catalog.mjs')],{cwd:packageCopy,encoding:'utf8'});
  if(run.status!==0)throw Error(run.stdout+run.stderr);
  const text=readFileSync(join(packageCopy,'src-ts/codec-catalog.ts'),'utf8');
  return JSON.parse(/CODEC_CATALOG[^=]*= ([\s\S]*?);\nexport const DENOISER_REVISION/.exec(text)![1]!);
}
beforeAll(async()=>{
  temporary=mkdtempSync(join(tmpdir(),'w22-fingerprint-'));
  packageCopy=join(temporary,'crates/forge3d-web');mkdirSync(packageCopy,{recursive:true});
  const copies: Promise<void>[]=copyTasks=[];
  // Preserve every source/build input, but overlap independent filesystem IO
  // instead of serially blocking the worker while the full suite transforms.
  for(const path of ['src-ts','src','scripts','package.json','package-lock.json','Cargo.toml','build.rs'])if(existsSync(join(packageRoot,path)))copies.push(cp(join(packageRoot,path),join(packageCopy,path),{recursive:true}));
  const repo=resolve(packageRoot,'../..');
  for(const path of ['crates/forge3d-core/src','crates/forge3d-core/Cargo.toml','Cargo.toml','Cargo.lock','rust-toolchain.toml','docs/parity/dependency-lock.json']){
    if(!existsSync(join(repo,path)))continue;
    mkdirSync(resolve(temporary,path,'..'),{recursive:true});copies.push(cp(join(repo,path),join(temporary,path),{recursive:true}));
  }
  await Promise.all(copies);
  baseline=generate();
},60_000);
afterAll(async()=>{
  // Finish outstanding IO before removing the isolated tree on a setup error.
  await Promise.allSettled(copyTasks);
  const resolved=resolve(temporary),parent=realpathSync(tmpdir());
  if(temporary&&resolved.startsWith(parent+sep)&&resolved.split(sep).at(-1)!.startsWith('w22-fingerprint-'))rmSync(resolved,{recursive:true,force:true});
});
describe('M2 persistent replay implementation identity',()=>{
  it.each([
    ['laz','src-ts/pointcloud-las.ts'],['laz','src-ts/laz-worker.ts'],['laz','src-ts/laz-admission.ts'],
    ['exr','src-ts/frames.ts'],['exr','src/offline_api.rs'],['glb','src-ts/mesh.ts'],
    ['tiff','src-ts/range-scheduler.ts'],['tiff','src-ts/byte-cache.ts'],
  ])('invalidates %s when its delegated implementation %s changes',(format,path)=>{
    const target=join(packageCopy,path),original=readFileSync(target);
    let changed:any[];
    try{appendFileSync(target,'\n// W22 mutation negative control\n');changed=generate();}finally{writeFileSync(target,original);}
    expect(changed!.find(c=>c.format===format).revision).not.toBe(baseline.find(c=>c.format===format).revision);
  });
});
