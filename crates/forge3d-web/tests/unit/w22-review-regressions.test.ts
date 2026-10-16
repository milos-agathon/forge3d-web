import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodecRegistry, HdrFrame, AovFrame } from '../../src-ts/index.js';
import type { PersistentByteStore } from '../../src-ts/byte-cache.js';

afterEach(() => vi.unstubAllGlobals());
const hdr = () => new Uint8Array([...new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),128,64,32,129]);
class Store implements PersistentByteStore {
  entries = new Map<string, Uint8Array>();
  async get(k: string) { return this.entries.get(k); }
  async put(k: string, v: Uint8Array) { this.entries.set(k, v.slice()); }
  async delete(k: string) { this.entries.delete(k); }
  async clear() { this.entries.clear(); }
}
describe('W22 architecture review regressions', () => {
  it('M1 rejects the real HDR resolution after a decoy header line before allocation', async () => {
    const registry = new CodecRegistry({maxDecodedBytes:1024});
    const bytes = new TextEncoder().encode('#?RADIANCE\n-Y 1 +X 1\nFORMAT=32-bit_rle_rgbe\n\n-Y 32 +X 32\n');
    const original = Float32Array;
    const allocations: number[] = [];
    vi.stubGlobal('Float32Array', new Proxy(original, { construct(target,args) { if(typeof args[0]==='number')allocations.push(args[0]);return Reflect.construct(target,args); } }));
    try {
      await expect(registry.decode('hdr',bytes)).rejects.toMatchObject({code:'RESOURCE_LIMIT_EXCEEDED',details:{reason:'decoded-byte-limit'}});
      expect(allocations).toEqual([]);
    } finally { await registry.dispose(); }
  });
  it('L6 reports the exact KTX2 WASM capability failure', async () => {
    vi.stubGlobal('WebAssembly',undefined);
    const registry=new CodecRegistry();
    try { expect(registry.select('ktx2')).toEqual({status:'unavailable',format:'ktx2',code:'UNSUPPORTED_FEATURE',reason:'webassembly-unavailable'}); }
    finally { await registry.dispose(); }
  });
  it('L4 removes a corrupt persistent artifact when replay rejects it',async()=>{
    const store=new Store(),first=new CodecRegistry({store});
    const result=await first.decode('hdr',hdr());await first.dispose();
    store.entries.get(result.cacheKey)![store.entries.get(result.cacheKey)!.length-1]^=1;
    const next=new CodecRegistry({store});
    try { await expect(next.replay(result.cacheKey)).rejects.toMatchObject({details:{reason:'cache-corrupt'}});expect(store.entries.has(result.cacheKey)).toBe(false); }
    finally { await next.dispose(); }
  });
  it('L1 forwards the signal and settles cancelled denoise before submitted work completes',async()=>{
    const registry=new CodecRegistry({maxConcurrent:1}),abort=new AbortController();
    const frame=new HdrFrame(1,1,new Float32Array([1,1,1,1]));
    const guides=new AovFrame({width:1,height:1,near:0.1,far:10,albedo:new Float32Array([1,1,1]),normal:new Float32Array([0,1,0])});
    let resolve!: (f:HdrFrame)=>void, entered!:()=>void, passedSignal:AbortSignal|undefined;
    const started=new Promise<void>(r=>{entered=r;});
    const gpu=new Promise<HdrFrame>(r=>{resolve=r;});
    const target={denoiseHdrFrame(_frame:HdrFrame,_aov?:AovFrame,_settings?:unknown,options?:{signal?:AbortSignal}){passedSignal=options?.signal;entered();return gpu;}};
    let outcome='pending';
    const job=registry.denoise(target,frame,guides,{signal:abort.signal}).then(()=>{outcome='resolved';},e=>{outcome=e.code;});
    await started;abort.abort();await new Promise(r=>setTimeout(r,0));
    try { expect(passedSignal?.aborted).toBe(true);expect(outcome).toBe('REQUEST_CANCELLED');expect(registry.stats()).toMatchObject({activeOperations:1,workingBytes:68});await expect(registry.denoise(target,frame,guides)).rejects.toMatchObject({details:{reason:'codec-backpressure'}}); }
    finally { resolve(frame);await job;await registry.dispose(); }
  });
});
