import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CodecRegistry, Ktx2Loader } from '../../src-ts/index.js';
import { CodecPersistentCache } from '../../src-ts/codec-persistent-cache.js';
import { codecDigest, packCodecArtifact } from '../../src-ts/codec-cache.js';

const hdr=(n=128)=>new Uint8Array([...new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),n,64,32,129]);
class Store {
  entries=new Map<string,Uint8Array>();peak=0;fail=false;
  async get(key:string){return this.entries.get(key);}
  async put(key:string,value:Uint8Array){if(this.fail)throw new DOMException('quota exhausted','QuotaExceededError');this.entries.set(key,value.slice());this.peak=Math.max(this.peak,[...this.entries.values()].reduce((n,b)=>n+b.length,0));}
  async delete(key:string){this.entries.delete(key);}
  async clear(){this.entries.clear();}
}
afterEach(()=>vi.unstubAllGlobals());
describe('W22 bounded cache and allocation admission',()=>{
  it('bounds persistent artifacts and index at peak across registry instances',async()=>{
    const store=new Store(),budget=1300;
    let oldest='';
    for(let i=0;i<12;i++){
      const r=new CodecRegistry({store,persistentCacheBytes:budget,maxInputBytes:1024,maxDecodedBytes:1024});
      try{const result=await r.decode('hdr',hdr(100+i));if(!i)oldest=result.cacheKey;expect(r.stats().persistentBytes).toBeLessThanOrEqual(budget);}finally{await r.dispose();}
    }
    expect(store.peak).toBeLessThanOrEqual(budget);expect(store.entries.has(oldest)).toBe(false);
    expect(store.entries.size).toBeGreaterThan(1);
  });
  it('rolls back a new artifact if quota fails while committing the index',async()=>{
    const store=new Store(),put=store.put.bind(store);store.put=async(key,value)=>{if(key.endsWith('/index'))throw new DOMException('index quota','QuotaExceededError');await put(key,value);};
    for(let i=0;i<3;i++){
      const r=new CodecRegistry({store});
      try{await expect(r.decode('hdr',hdr(120+i))).rejects.toMatchObject({code:'IO_ERROR',details:{reason:'cache-store-failed'}});expect(store.entries.size).toBe(0);expect(r.stats().workingBytes).toBe(0);}finally{await r.dispose();}
    }
  });
  it('decodes band zero of a real multi-band strip TIFF and replays metadata',async()=>{
    const {writeArrayBuffer,fromArrayBuffer}=await import('geotiff');
    const input=writeArrayBuffer(new Uint8Array([1,91,191,2,92,192,3,93,193,4,94,194,5,95,195,6,96,196]),{width:3,height:2,BitsPerSample:[8,8,8],SamplesPerPixel:[3],GDAL_NODATA:'255\0'});
    const tiff=await fromArrayBuffer(input),image=await tiff.getImage();
    expect(image.isTiled).toBe(false);expect(image.getSamplesPerPixel()).toBe(3);
    const r=new CodecRegistry();
    try{const a=await r.decode('tiff',input),b=await r.replay(a.cacheKey,{format:'tiff'});expect([...a.value.data]).toEqual([1,2,3,4,5,6]);expect(a.value).toMatchObject({width:3,height:2,crs:'EPSG:4326',nodata:255});expect(b.value).toEqual(a.value);}finally{await r.dispose();await tiff.close();}
  });
  it('reads multiple RGB strips including a partial final strip',async()=>{
    const bytes=new Uint8Array(readFileSync(new URL('../fixtures/w22/multiband-strips.tif',import.meta.url)));
    const r=new CodecRegistry();
    try{const result=await r.decode('tiff',bytes);expect([...result.value.data]).toEqual([1,2,3,4,5,6,7,8,9]);expect(result.value).toMatchObject({width:3,height:3,crs:'EPSG:4326',nodata:255});}finally{await r.dispose();}
  });
  it('preserves valid artifacts rejected by local capability or allocation policy',async()=>{
    const store=new Store(),first=new CodecRegistry({store}),result=await first.decode('hdr',hdr());await first.dispose();
    for(const options of [{disabled:['hdr'] as const},{maxDecodedBytes:8},{maxInputBytes:1}]){
      const r=new CodecRegistry({store,...options});
      try{await expect(r.replay(result.cacheKey)).rejects.toBeDefined();expect(store.entries.has(result.cacheKey)).toBe(true);}finally{await r.dispose();}
    }
    const last=new CodecRegistry({store});try{expect((await last.replay(result.cacheKey,{format:'hdr'})).value.data[0]).toBe(1);}finally{await last.dispose();}
  });
  it('serializes concurrent owners of the same store and preserves both entries',async()=>{
    const store=new Store(),a=new CodecPersistentCache(store,4096),b=new CodecPersistentCache(store,4096);
    const keys=['a','b'].map(c=>'forge3d-codec-v1/'+c.repeat(64));
    await Promise.all([a.put(keys[0]!,hdr()),b.put(keys[1]!,hdr(130))]);
    expect(await a.get(keys[0]!)).toEqual(hdr());expect(await b.get(keys[1]!)).toEqual(hdr(130));expect(b.stats().entries).toBe(2);
  });
  it('evicts an implementation-stale artifact and reports the exact reason',async()=>{
    const store=new Store(),r=new CodecRegistry({store});const selected=r.select('hdr');if(selected.status!=='selected')throw Error('hdr');
    const artifact=packCodecArtifact({...selected.codec,revision:'old'}, {}, hdr()),key='forge3d-codec-v1/'+await codecDigest(artifact);
    await new CodecPersistentCache(store,4096).put(key,artifact);
    try{await expect(r.replay(key)).rejects.toMatchObject({code:'UNSUPPORTED_FEATURE',details:{reason:'cache-incompatible'}});expect(store.entries.has(key)).toBe(false);}finally{await r.dispose();}
  });
  it('types quota failure, admits transient copies before IO, and releases failed work',async()=>{
    const store=new Store();store.fail=true;const r=new CodecRegistry({store});
    try{await expect(r.decode('hdr',hdr())).rejects.toMatchObject({code:'IO_ERROR',details:{reason:'cache-store-failed'}});expect(r.stats()).toMatchObject({workingBytes:0,activeOperations:0,cacheBytes:0});}finally{await r.dispose();}
    const small=new CodecRegistry({maxWorkingBytes:100,maxDecodedBytes:16});let reads=0;
    try{await expect(small.decode('hdr','https://unused.invalid/input',{onProgress:()=>{reads++;}})).rejects.toMatchObject({code:'RESOURCE_LIMIT_EXCEEDED',details:{reason:'working-byte-limit'}});expect(reads).toBe(0);expect(small.stats().workingBytes).toBe(0);}finally{await small.dispose();}
  });
});

describe('W04 real Basis loader regressions',()=>{
  const options={semantic:'base-color' as const,capabilities:{bc:false,etc2:false,astc:false}};
  const fixture=()=>new Uint8Array(readFileSync(new URL('../fixtures/w22/kodim23.ktx2',import.meta.url)));
  it('initializes the pinned real module and accepts its integer success flags',async()=>{
    const dir=new URL('../../assets/basis/',import.meta.url);
    const factory=vm.runInNewContext(readFileSync(new URL('basis_transcoder.csp.js',dir),'utf8')+';BASIS;',
      {require:createRequire(import.meta.url),process,console,__dirname:fileURLToPath(dir)},{codeGeneration:{strings:false,wasm:true}});
    let initialized=0,started:number|undefined;
    vi.stubGlobal('importScripts',()=>{});
    vi.stubGlobal('BASIS',async()=>{
      const module=await factory({wasmBinary:readFileSync(new URL('basis_transcoder.wasm',dir))});
      const init=module.initializeBasis;module.initializeBasis=()=>{initialized++;return init();};
      const Original=module.KTX2File;
      module.KTX2File=function(data:Uint8Array){const f=new Original(data),start=f.startTranscoding.bind(f);f.startTranscoding=()=>{started=start();return started;};return f;};
      return module;
    });
    const decoded=await new Ktx2Loader({basisJsUrl:'w04-real-integer.js'}).load(fixture(),options);
    const expected=JSON.parse(readFileSync(new URL('../fixtures/w22/manifest.json',import.meta.url),'utf8')).fixtures.find((f:any)=>f.file==='kodim23.ktx2');
    expect(initialized).toBe(1);expect(started).toBe(1);
    expect(createHash('sha256').update(decoded.levels[0]!.data).digest('hex')).toBe(expected.expected.rgbaSha256);
  });
  it('types a custom module without initializeBasis',async()=>{
    vi.stubGlobal('importScripts',()=>{});vi.stubGlobal('BASIS',async()=>({}));
    await expect(new Ktx2Loader({basisJsUrl:'w04-no-initializer.js'}).load(fixture(),options)).rejects.toMatchObject({code:'UNSUPPORTED_FEATURE',details:{reason:'basis-initializer-unavailable'}});
  });
});
