import { Forge3DError } from './runtime-failure.js';
import type { Forge3DRuntime, Forge3DRuntimeOptions } from './index.js';
import { getMapRuntimeContext } from './runtime-internals.js';

type Factory = (canvas: HTMLCanvasElement | OffscreenCanvas, options: Forge3DRuntimeOptions) => Promise<Forge3DRuntime>;
export interface MapNativeContext { create: Factory; dispose(): void }
/** Opaque ownership token, valid only inside MapScene.withRenderContext. */
export interface MapSceneRenderContext { readonly kind: 'forge3d.map-render-context' }
interface Scope { closed: boolean; pending: Map<string, Promise<MapNativeContext | undefined>>; contexts: MapNativeContext[]; tail: Promise<void> }
const scopes = new WeakMap<MapSceneRenderContext, Scope>();

export async function withMapRenderContext<T>(work: (context: MapSceneRenderContext) => Promise<T>): Promise<T> {
  const token: MapSceneRenderContext = Object.freeze({ kind: 'forge3d.map-render-context' });
  const scope: Scope = { closed: false, pending: new Map(), contexts: [], tail: Promise.resolve() }; scopes.set(token, scope);
  try { return await work(token); }
  finally {
    scope.closed = true;
    await scope.tail;
    // Release even when the caller rejects while the first device is opening.
    await Promise.allSettled(scope.pending.values());
    for (const context of scope.contexts) context.dispose();
  }
}

/** WebGPU validation scopes are a device stack. Serialize complete frames on
 * a shared device so independent calls cannot consume each other's errors. */
export function scheduleMapFrame<T>(token: MapSceneRenderContext, render: () => Promise<T>): Promise<T> {
  const scope = scopes.get(token);
  if (!scope || scope.closed) return Promise.reject(new Forge3DError('INVALID_INPUT', 'Map render context is closed or invalid'));
  const pending = scope.tail.then(() => {
    if (scope.closed) throw new Forge3DError('INVALID_INPUT', 'Map render context is closed');
    return render();
  });
  scope.tail = pending.then(() => {}, () => {});
  return pending;
}

export async function createScopedMapRuntime(token: MapSceneRenderContext, canvas: HTMLCanvasElement | OffscreenCanvas, options: Forge3DRuntimeOptions, fallback: Factory): Promise<Forge3DRuntime> {
  const scope = scopes.get(token);
  if (!scope || scope.closed) throw new Forge3DError('INVALID_INPUT', 'Map render context is closed or invalid');
  // Different bridge/device feature requests must never borrow an existing
  // context. Frame size, quality and memory budgets remain per native owner.
  const key = JSON.stringify([String(options.wasmUrl ?? ''), options.powerPreference ?? 'high-performance', options.timestampMode ?? 'auto']);
  const pending = scope.pending.get(key);
  if (pending) {
    const context = await pending;
    if (scope.closed) throw new Forge3DError('INVALID_INPUT', 'Map render context is closed');
    const runtime = await (context ? context.create(canvas, options) : fallback(canvas, options));
    if (scope.closed) { runtime.dispose(); throw new Forge3DError('INVALID_INPUT', 'Map render context is closed'); }
    return runtime;
  }
  let resolve!: (context: MapNativeContext | undefined) => void, reject!: (error: unknown) => void;
  const opening = new Promise<MapNativeContext | undefined>((yes, no) => { resolve = yes; reject = no; });
  scope.pending.set(key, opening);
  // The creation error is also returned by this call; avoid an unhandled
  // rejection if no second renderer has awaited the device yet.
  void opening.catch(() => {});
  let runtime: Forge3DRuntime | undefined;
  try {
    runtime = await fallback(canvas, options);
    const context = getMapRuntimeContext(runtime);
    if (context) scope.contexts.push(context);
    resolve(context);
    if (scope.closed) throw new Forge3DError('INVALID_INPUT', 'Map render context is closed');
    return runtime;
  } catch (error) { runtime?.dispose(); reject(error); throw error; }
}
