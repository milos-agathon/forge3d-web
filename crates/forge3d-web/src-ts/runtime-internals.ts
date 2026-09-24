export type RuntimeDeviceLostHandler = (error: unknown) => void;

interface RuntimeInternalAccess {
  setDeviceLostHandler(handler: RuntimeDeviceLostHandler | undefined): void;
  simulateDeviceLossForTests(): void;
}

const runtimeInternals = new WeakMap<object, RuntimeInternalAccess>();

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

function requiredRuntimeInternals(runtime: object): RuntimeInternalAccess {
  const access = runtimeInternals.get(runtime);
  if (access === undefined) {
    throw new Error("Forge3D runtime internals are unavailable");
  }
  return access;
}
