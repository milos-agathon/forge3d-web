export type RuntimeDeviceLostHandler = (error: unknown) => void;
import type { Forge3DRuntime, Forge3DRuntimeOptions } from './index.js';
import type { MapNativeContext } from './map-render-context.js';
type RuntimeFactory = (canvas: HTMLCanvasElement | OffscreenCanvas, options: Forge3DRuntimeOptions) => Promise<Forge3DRuntime>;
let mapRuntimeFactory: RuntimeFactory | undefined;
export function registerMapRuntimeFactory(factory: RuntimeFactory): void { mapRuntimeFactory = factory; }
/** Keep MapScene's bootstrap private, with the original path for older facades. */
export function createMapRuntime(canvas: HTMLCanvasElement | OffscreenCanvas, options: Forge3DRuntimeOptions, fallback: RuntimeFactory): Promise<Forge3DRuntime> {
  return (mapRuntimeFactory ?? fallback)(canvas, options);
}

interface RuntimeInternalAccess {
  createMapContext?(): MapNativeContext | undefined;
  configureMap?(setup: () => void): Promise<void>;
  readMapFrame?(): Promise<MapFrameReadback | undefined>;
  setDeviceLostHandler(handler: RuntimeDeviceLostHandler | undefined): void;
  simulateDeviceLossForTests(): void;
}

const runtimeInternals = new WeakMap<object, RuntimeInternalAccess>();
export function getMapRuntimeContext(runtime: object): MapNativeContext | undefined { return runtimeInternals.get(runtime)?.createMapContext?.(); }
export async function configureMapRuntime(runtime: object, setup: () => void): Promise<void> {
  const configure = runtimeInternals.get(runtime)?.configureMap;
  if (configure) await configure(setup); else setup();
}

export interface MapFrameReadback { rgba: Uint8Array; coverage: Uint8Array }

/** Optional private bridge; older bridges and test runtimes keep the capture path. */
export async function tryReadMapFrame(runtime: object): Promise<MapFrameReadback | undefined> {
  return runtimeInternals.get(runtime)?.readMapFrame?.();
}

export function registerRuntimeInternals(
  runtime: object,
  access: RuntimeInternalAccess,
): void {
  runtimeInternals.set(runtime, access);
}

export function setRuntimeDeviceLostHandler(
  runtime: object,
  handler: RuntimeDeviceLostHandler | undefined,
): void {
  requiredRuntimeInternals(runtime).setDeviceLostHandler(handler);
}

export function simulateRuntimeDeviceLossForTests(runtime: object): void {
  requiredRuntimeInternals(runtime).simulateDeviceLossForTests();
}

export { loadOfflineWasm, loadProbeWorkerWasmAssets } from './wasm-realm.js';
export type { OfflineWasmExports } from './wasm-realm.js';

function requiredRuntimeInternals(runtime: object): RuntimeInternalAccess {
  const access = runtimeInternals.get(runtime);
  if (access === undefined) {
    throw new Error("Forge3D runtime internals are unavailable");
  }
  return access;
}

// Reuse topology compiled for scene budget admission in that same scene snapshot.
// Weak keys keep the private packet out of public snapshots and worker payloads.
const sceneVectorPackets = new WeakMap<object, { revision:number; packet:import("./vector-geometry.js").VectorPacket }>();
export function registerSceneVectorPacket(source:object, revision:number, packet:import("./vector-geometry.js").VectorPacket):void {sceneVectorPackets.set(source,{revision,packet});}
export function getSceneVectorPacket(source:object, revision:number):import("./vector-geometry.js").VectorPacket|undefined {const entry=sceneVectorPackets.get(source);return entry?.revision===revision?entry.packet:undefined;}
