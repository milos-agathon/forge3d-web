import { describe, expect, it, vi } from 'vitest';
import { CodecRegistry } from '../../src-ts/index.js';
const hdr = () => new Uint8Array([...new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),128,64,32,129]);

describe('owned codec operation failures at the registry interface', () => {
  it.each(['selection', 'admission', 'read', 'decode', 'storage', 'replay'] as const)('releases all ownership after %s failure and admits subsequent work', async stage => {
    const store = { get: vi.fn(async () => undefined), put: vi.fn(async () => {}), delete: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    const registry = new CodecRegistry({ store, maxConcurrent: 1, maxInputBytes: 1024, maxDecodedBytes: 1024, maxWorkingBytes: 22000 });
    if(stage === 'storage') store.put.mockRejectedValueOnce(new Error('store failed'));
    const failing = stage === 'selection' ? registry.decode('not-a-codec' as 'hdr', hdr())
      : stage === 'admission' ? registry.decode('hdr', new Uint8Array(2048))
      : stage === 'read' ? registry.decode('hdr', new ReadableStream({ start(c) { c.error(new Error('read failed')); } }))
      : stage === 'decode' ? registry.decode('hdr', new Uint8Array([1,2,3]))
      : stage === 'replay' ? registry.replay('forge3d-codec-v1/'+'a'.repeat(64))
      : registry.decode('hdr', hdr());
    await expect(failing).rejects.toBeDefined();
    expect(registry.stats()).toMatchObject({ activeOperations: 0, workingBytes: 0 });
    await expect(registry.decode('hdr', hdr())).resolves.toHaveProperty('cacheKey');
    await registry.dispose();
  });
  it('removes abort listeners on success, rejection and cancellation after drain', async () => {
    for(const mode of ['success','failure','cancel']) {
      const controller = new AbortController();
      const add=vi.spyOn(controller.signal,'addEventListener'),remove=vi.spyOn(controller.signal,'removeEventListener');
      const registry=new CodecRegistry();
      const job=registry.decode('hdr',mode==='failure'?new Uint8Array():hdr(),{signal:controller.signal});
      if(mode==='cancel')controller.abort();
      await job.catch(()=>{});await registry.dispose();
      const listeners=add.mock.calls.filter(c=>c[0]==='abort');
      for(const call of listeners)expect(remove.mock.calls.some(c=>c[0]==='abort'&&c[1]===call[1])).toBe(true);
      expect(registry.stats()).toMatchObject({activeOperations:0,workingBytes:0});
    }
  });
});
