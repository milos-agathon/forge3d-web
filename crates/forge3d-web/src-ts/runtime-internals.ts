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

/** Stateless WASM exports used by the W06 frame/offline helpers. */
export interface OfflineWasmExports {
  buildTraceBvh(input:unknown,leafSize:number,budget:number):unknown;
  evaluateTraceSdf(input:unknown,points:Float32Array):{distances:Float32Array;materials:Uint32Array};
  bakeTerrainProbe?(input: unknown): { coefficients: number[]; reflectionMips: number[][] };
  bakeTerrainProbeGrids?(input: unknown): { coefficients: number[]; reflectionMips: number[][] };
  exrChannelNames(prefix: string, channelCount: number): string[];
  encodeExr(input: unknown): Uint8Array;
  decodeExr(bytes: Uint8Array, maxDimension: number, maxPixels: number): unknown;
  tonemapHdr(input: unknown): Uint8Array;
  atrousDenoise(input: unknown): Float32Array;
  compareImages(a: Float32Array, b: Float32Array, options: unknown): unknown;
}

let offlineWasmLoader: (() => Promise<OfflineWasmExports>) | undefined;

/** Registered once by the facade so helpers reuse the realm's WASM bridge. */
export function registerOfflineWasmLoader(loader: () => Promise<OfflineWasmExports>): void {
  offlineWasmLoader = loader;
}

export function loadOfflineWasm(): Promise<OfflineWasmExports> {
  if (offlineWasmLoader === undefined) {
    return Promise.reject(new Error("Forge3D WASM loader is not registered"));
  }
  return offlineWasmLoader();
}

interface WasmCoordinatorRecord {
  selectedUrl: string;
}

/**
 * Resolves the exact realm-selected WASM URL for the probe worker. Loading the
 * offline bridge first preserves the facade's one-WASM-URL-per-realm contract,
 * including an already selected custom `wasmUrl`.
 */
export async function loadProbeWorkerWasmAssets(): Promise<{
  wasmModuleUrl: string;
  wasmUrl: string;
}> {
  await loadOfflineWasm();
  const key = Symbol.for("@forge3d/web.wasm-bridge-coordinator");
  const coordinator = (globalThis as Record<PropertyKey, unknown>)[key] as
    | { record?: WasmCoordinatorRecord }
    | undefined;
  const selectedUrl = coordinator?.record?.selectedUrl;
  if (typeof selectedUrl !== "string") {
    throw new Error("Forge3D WASM coordinator did not select a worker URL");
  }
  const sourceModule = new URL(import.meta.url).pathname.includes("/src-ts/");
  return {
    wasmModuleUrl: new URL(
      sourceModule ? "../pkg/forge3d_web.js" : "./forge3d_web.js",
      import.meta.url,
    ).href,
    wasmUrl: selectedUrl,
  };
}

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
