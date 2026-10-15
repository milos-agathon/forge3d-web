import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CodecRegistry, HdrFrame, AovFrame } from '../../src-ts/index.js';
import { CODEC_CATALOG } from '../../src-ts/codec-catalog.js';
import { CODEC_CACHE_PREFIX, codecDigest } from '../../src-ts/codec-cache.js';
import type { PersistentByteStore } from '../../src-ts/byte-cache.js';

const hdr = () => {
  const header = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n');
  const bytes = new Uint8Array(header.length + 8);
  bytes.set(header); bytes.set([128,64,32,129,32,64,128,129], header.length); return bytes;
};
class Store implements PersistentByteStore {
  entries = new Map<string, Uint8Array>();
  async get(key: string) { return this.entries.get(key); }
  async put(key: string, bytes: Uint8Array) { this.entries.set(key, bytes); }
  async delete(key: string) { this.entries.delete(key); }
  async clear() { this.entries.clear(); }
}
describe('W22 integrated E05 registry', () => {
  it('pins every delegated dependency and hashes implementation revisions', () => {
    const lock = JSON.parse(readFileSync(new URL('../../../../docs/parity/dependency-lock.json', import.meta.url), 'utf8'));
    expect(new Set(CODEC_CATALOG.map(c => c.format)).size).toBe(7);
    for (const codec of CODEC_CATALOG) {
      expect(codec.revision).toMatch(/^[a-f0-9]{64}$/);
      for (const dep of codec.dependencies) {
        const pinned = lock.assets.find((a: any) => a.id === dep.id);
        expect(dep).toEqual({ id: pinned.id, version: pinned.version, sha256: pinned.source.sha256 });
        expect(pinned.consumingTasks).toContain('W22');
      }
    }
  });
  it('selects once, reports exact unavailable contracts and isolates mutable reports', async () => {
    const registry = new CodecRegistry({ disabled: ['tiff'] });
    expect(registry.select('unknown')).toEqual({ status: 'unavailable', format: 'unknown', code: 'UNSUPPORTED_FEATURE', reason: 'codec-not-registered' });
    expect(registry.select('tiff')).toMatchObject({ status: 'unavailable', reason: 'codec-disabled' });
    expect(registry.select('laz')).toMatchObject({ status: 'unavailable', reason: 'worker-hard-stop-unavailable' });
    await expect(registry.decode('tiff', hdr())).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE', details: { reason: 'codec-disabled' } });
    const selected = registry.select('hdr');
    if (selected.status === 'selected') selected.codec.revision = 'changed';
    expect(registry.select('hdr')).toMatchObject({ codec: { revision: CODEC_CATALOG.find(c => c.format === 'hdr')!.revision } });
    await registry.dispose();
  });
  it('decodes HDR values and replays byte-exact from a new registry with no source access', async () => {
    const store = new Store(), registry = new CodecRegistry({ store });
    const a = await registry.decode('hdr', hdr());
    expect([...a.value.data]).toEqual([1,0.5,0.25,1,0.25,0.5,1,1]);
    expect(a.codec.owner).toBe('W04/W15');
    const key = (await registry.decode('hdr', new Blob([hdr()]))).cacheKey;
    expect(key).toBe(a.cacheKey);
    a.value.data.fill(0);
    await registry.dispose();
    expect(registry.stats()).toMatchObject({ disposed: true, activeOperations: 0, cacheBytes: 0, cacheEntries: 0 });
    expect(store.entries.size).toBe(1);
    const fresh = new CodecRegistry({ store });
    const replay = await fresh.replay(key, {format:'hdr'});
    expect([...replay.value.data]).toEqual([1,0.5,0.25,1,0.25,0.5,1,1]);
    expect(store.entries.get(key)!.slice(-hdr().length)).toEqual(hdr());
    await fresh.dispose();
  });
  it('rejects corrupt, incompatible, absent and invalid cache entries with exact reasons', async () => {
    const store = new Store(), original = new CodecRegistry({ store });
    const result = await original.decode('hdr', hdr()); await original.dispose();
    const valid = store.entries.get(result.cacheKey)!.slice();
    store.entries.get(result.cacheKey)![valid.length - 1] ^= 1;
    const fresh = new CodecRegistry({ store });
    await expect(fresh.replay(result.cacheKey)).rejects.toMatchObject({ code: 'IO_ERROR', details: { reason: 'cache-corrupt' } });
    await expect(fresh.replay('bad')).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'invalid-cache-key' } });
    await expect(fresh.replay(CODEC_CACHE_PREFIX + '0'.repeat(64))).rejects.toMatchObject({ code: 'IO_ERROR', details: { reason: 'cache-miss' } });
    const text = new TextDecoder().decode(valid), revision = CODEC_CATALOG.find(c => c.format === 'hdr')!.revision;
    const stale = new TextEncoder().encode(text.replace(revision, '0'.repeat(64)));
    const key = CODEC_CACHE_PREFIX + await codecDigest(stale); store.entries.set(key, stale);
    await expect(fresh.replay(key)).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE', details: { reason: 'cache-incompatible' } });
    await fresh.dispose();
  });
  it('delegates TIFF predictor/deflate and self-contained GLB conformance', async () => {
    const registry = new CodecRegistry();
    const tiff = new Uint8Array(readFileSync(new URL('../golden/w08/predictor-deflate-u16.tif', import.meta.url)));
    const raster = await registry.decode('tiff', tiff);
    expect(raster.value.width * raster.value.height).toBe(raster.value.data.length);
    expect(new Set(raster.value.data).size).toBeGreaterThan(10);
    const glb = new Uint8Array(readFileSync(new URL('../fixtures/w15/triangle.glb', import.meta.url)));
    const mesh = await registry.decode('glb', glb);
    expect(mesh.value.primitives).toHaveLength(1);
    expect(mesh.value.primitives[0]!.mesh.positions.length).toBe(9);
    expect((await registry.replay(mesh.cacheKey, {format:'glb'})).value.primitives[0]!.mesh.positions).toEqual(mesh.value.primitives[0]!.mesh.positions);
    await registry.dispose();
  });
  it.each(['tiff','ktx2','hdr','exr','glb','glyph-pbf'] as const)('types corrupt %s inputs and does not cache failures', async format => {
    const registry = new CodecRegistry();
    await expect(registry.decode(format, new Uint8Array([1,2,3]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(registry.stats().cacheEntries).toBe(0);
    await registry.dispose();
  });
  it('enforces encoded/decoded limits before HDR allocation, parameters and LRU retention', async () => {
    const registry = new CodecRegistry({ maxInputBytes: 1024, maxDecodedBytes: 16, cacheBytes: 1 });
    await expect(registry.decode('hdr', hdr())).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    await expect(registry.decode('hdr', new Uint8Array(1025))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    await expect(registry.decode('hdr', hdr(), { parameters: { overview: 1 } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await registry.dispose();
    const small = new CodecRegistry({ cacheBytes: 1 });
    await small.decode('hdr', hdr()); expect(small.stats().cacheBytes).toBe(0); await small.dispose();
    for (const value of [0,-1,NaN,Infinity,1.2]) expect(() => new CodecRegistry({ maxConcurrent: value })).toThrow();
  });
  it('keys output parameters canonically and checks replay result types', async () => {
    const registry = new CodecRegistry();
    const bytes = new Uint8Array(readFileSync(new URL('../fixtures/w22/rgba.ktx2', import.meta.url)));
    const a = await registry.decode('ktx2',bytes,{parameters:{semantic:'base-color',capabilities:{bc:false,etc2:false,astc:false}}});
    const b = await registry.decode('ktx2',bytes,{parameters:{capabilities:{astc:false,bc:false,etc2:false},semantic:'base-color'}});
    const c = await registry.decode('ktx2',bytes,{parameters:{semantic:'normal'}});
    expect(a.cacheKey).toBe(b.cacheKey); expect(c.cacheKey).not.toBe(a.cacheKey);
    await expect(registry.replay(a.cacheKey,{format:'hdr'})).rejects.toMatchObject({code:'INVALID_INPUT',details:{reason:'cache-format-mismatch'}});
    await registry.dispose();
  });
  it('preflights EXR channel memory before loading WASM', async () => {
    const registry=new CodecRegistry({maxDecodedBytes:8});
    const bytes=new Uint8Array(readFileSync(new URL('../fixtures/w22/linear.exr',import.meta.url)));
    await expect(registry.decode('exr',bytes)).rejects.toMatchObject({code:'RESOURCE_LIMIT_EXCEEDED'});
    await registry.dispose();
  });
  it('types store failures without retaining cache entries or active jobs', async () => {
    const store=new Store();store.put=async()=>{throw Error('quota exceeded');};
    const registry=new CodecRegistry({store});
    await expect(registry.decode('hdr',hdr())).rejects.toMatchObject({code:'IO_ERROR',details:{reason:'cache-store-failed'}});
    expect(registry.stats()).toMatchObject({cacheEntries:0,activeOperations:0});
    await registry.dispose();
  });
  it('aborts streams, applies backpressure, drains disposal and rejects use after disposal', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(hdr().subarray(0,8)); }, cancel() { cancelled = true; } });
    const registry = new CodecRegistry({ maxConcurrent: 1 });
    const job = registry.decode('hdr', source);
    const failure = job.catch(e => e.code);
    await expect(registry.decode('hdr', hdr())).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED', details: { reason: 'codec-backpressure' } });
    await new Promise(r => setTimeout(r, 5));
    await registry.dispose();
    expect(await failure).toBe('RUNTIME_DISPOSED'); expect(cancelled).toBe(true);
    expect(registry.stats().activeOperations).toBe(0);
    expect(registry.dispose()).toBe(registry.dispose());
    await expect(registry.decode('hdr', hdr())).rejects.toMatchObject({ code: 'RUNTIME_DISPOSED' });
    expect(() => registry.select('hdr')).toThrow();
    const fresh = new CodecRegistry(), abort = new AbortController(); abort.abort();
    await expect(fresh.decode('hdr', hdr(), { signal: abort.signal })).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    await fresh.dispose();
  });
  it('requires actual AOV guides and exposes OIDN as the WebGPU equivalent', async () => {
    const registry = new CodecRegistry();
    expect(registry.denoiserCapability()).toEqual({ status: 'unavailable', code: 'UNSUPPORTED_FEATURE', reason: 'denoiser-target-required' });
    const target = { denoiseHdrFrame: async (f: HdrFrame) => f };
    expect(registry.denoiserCapability(target, 'oidn')).toMatchObject({ status: 'selected', id: 'webgpu-atrous', equivalent: true, requested: 'oidn', owner: 'W06' });
    const frame = new HdrFrame(1,1,new Float32Array([1,1,1,1]));
    await expect(registry.denoise(target, frame, new AovFrame({ width:1,height:1,near:0.1,far:100 }))).rejects.toMatchObject({ code:'INVALID_INPUT', details:{ reason:'missing-denoise-guide' } });
    await registry.dispose();
  });
});
