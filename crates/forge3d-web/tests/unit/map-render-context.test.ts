import { describe, it, expect } from 'vitest';
import { withMapRenderContext, createScopedMapRuntime, scheduleMapFrame, type MapSceneRenderContext } from '../../src-ts/map-render-context.js';
import { registerRuntimeInternals } from '../../src-ts/runtime-internals.js';
import type { Forge3DRuntime, Forge3DRuntimeOptions } from '../../src-ts/index.js';

function latch() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(native = true) {
  const counters = { devices: 0, contextsClosed: 0, owners: 0, ownersDisposed: 0 };
  function owner(): Forge3DRuntime {
    counters.owners++;
    let disposed = false;
    const runtime = { dispose() { if (!disposed) { disposed = true; counters.ownersDisposed++; } } } as Forge3DRuntime;
    registerRuntimeInternals(runtime, { setDeviceLostHandler() {}, simulateDeviceLossForTests() {},
      ...(native ? { createMapContext: () => ({ create: async () => owner(), dispose() { counters.contextsClosed++; } }) } : {}) });
    return runtime;
  }
  const create = async () => { counters.devices++; return owner(); };
  const canvas = {} as OffscreenCanvas;
  const draw = (context: MapSceneRenderContext, options: Forge3DRuntimeOptions = {}) => scheduleMapFrame(context, async () => {
    const runtime = await createScopedMapRuntime(context, canvas, options, create);
    try { return runtime; } finally { runtime.dispose(); }
  });
  return { counters, create, owner, canvas, draw };
}

describe('explicit map render device ownership', () => {
  it('creates lazily, shares only within a scope, and disposes every frame owner', async () => {
    const f = fixture();
    await withMapRenderContext(async () => {});
    expect(f.counters.devices).toBe(0);
    await withMapRenderContext(async context => { await f.draw(context); await f.draw(context); await f.draw(context); expect(f.counters.contextsClosed).toBe(0); });
    expect(f.counters).toEqual({ devices: 1, contextsClosed: 1, owners: 3, ownersDisposed: 3 });
    await withMapRenderContext(async context => { await f.draw(context); });
    expect(f.counters).toEqual({ devices: 2, contextsClosed: 2, owners: 4, ownersDisposed: 4 });
  });

  it('serializes shared-device error scopes and continues after a rejected frame', async () => {
    const gate = latch(), started = latch(), events: string[] = [];
    await withMapRenderContext(async context => {
      const first = scheduleMapFrame(context, async () => { events.push('first'); started.resolve(); await gate.promise; throw Error('first shader'); });
      const second = scheduleMapFrame(context, async () => { events.push('second'); return 23; });
      const rejected = expect(first).rejects.toThrow('first shader');
      await started.promise; await Promise.resolve(); expect(events).toEqual(['first']);
      gate.resolve(); await rejected; expect(await second).toBe(23);
    });
    expect(events).toEqual(['first', 'second']);
  });

  it('separates bridge, power and timestamp feature requests', async () => {
    const f = fixture();
    await withMapRenderContext(async context => {
      await f.draw(context); await f.draw(context, { width: 128, height: 96, memoryBudgetBytes: 8000000 });
      await f.draw(context, { powerPreference: 'low-power' });
      await f.draw(context, { wasmUrl: '/another.wasm' });
      await f.draw(context, { timestampMode: 'disabled' });
    });
    expect(f.counters).toEqual({ devices: 4, contextsClosed: 4, owners: 5, ownersDisposed: 5 });
  });

  it('keeps older bridges functional with independent real owners', async () => {
    const f = fixture(false);
    await withMapRenderContext(async context => { await f.draw(context); await f.draw(context); });
    expect(f.counters).toEqual({ devices: 2, contextsClosed: 0, owners: 2, ownersDisposed: 2 });
  });

  it('waits for in-flight creation and releases it before propagating a scope failure', async () => {
    const f = fixture(), gate = latch(), started = latch();
    let settled = false, pending!: Promise<unknown>;
    const work = withMapRenderContext(async context => {
      pending = scheduleMapFrame(context, async () => createScopedMapRuntime(context, f.canvas, {}, async () => { started.resolve(); await gate.promise; return f.create(); }));
      void pending.catch(() => {}); await started.promise; throw Error('scope failed');
    }).finally(() => { settled = true; });
    const rejected = expect(work).rejects.toThrow('scope failed');
    await started.promise; await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
    gate.resolve(); await rejected; await expect(pending).rejects.toThrow('closed');
    expect(f.counters).toEqual({ devices: 1, contextsClosed: 1, owners: 1, ownersDisposed: 1 });
  });

  it('rejects closed and forged tokens before requesting another device', async () => {
    const f = fixture(); let closed!: MapSceneRenderContext;
    await withMapRenderContext(async context => { closed = context; await f.draw(context); });
    await expect(f.draw(closed)).rejects.toThrow('closed or invalid');
    await expect(f.draw({ kind: 'forge3d.map-render-context' })).rejects.toThrow('closed or invalid');
    expect(f.counters.devices).toBe(1);
  });
});
