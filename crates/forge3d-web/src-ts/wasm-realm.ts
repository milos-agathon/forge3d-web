import { Forge3DError } from './runtime-failure.js';
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

interface WasmBridge extends Partial<OfflineWasmExports> { default?: (options?: {module_or_path:unknown})=>Promise<unknown>; }
interface WasmBridgeCoordinatorRecord {
  selectedUrl: string;
  promise: Promise<WasmBridge>;
  state: "pending" | "ready";
}

interface WasmBridgeCoordinator {
  schemaVersion: 1;
  record?: WasmBridgeCoordinatorRecord;
}

const WASM_COORDINATOR_KEY = Symbol.for(
  "@forge3d/web.wasm-bridge-coordinator",
);

export function loadWasmBridge(wasmUrl?: string | URL): Promise<WasmBridge> {
  let selectedUrl: string;
  try {
    const canonicalUrl = new URL(
      wasmUrl ?? "./forge3d_web_bg.wasm",
      import.meta.url,
    );
    canonicalUrl.hash = "";
    selectedUrl = canonicalUrl.href;
  } catch (error) {
    return Promise.reject(
      new Forge3DError("INVALID_INPUT", "wasmUrl must be a valid URL", error),
    );
  }

  let coordinator: WasmBridgeCoordinator;
  try {
    coordinator = getWasmBridgeCoordinator();
  } catch (error) {
    return Promise.reject(Forge3DError.from(error));
  }
  const existing = coordinator.record;
  if (existing !== undefined) {
    if (existing.selectedUrl !== selectedUrl) {
      return Promise.reject(
        new Forge3DError(
          "INVALID_INPUT",
          `This Window realm already selected a different Forge3D WASM URL`,
          { requestedUrl: selectedUrl, selectedUrl: existing.selectedUrl },
        ),
      );
    }
    return existing.promise;
  }

  let resolveBridge!: (bridge: WasmBridge) => void;
  let rejectBridge!: (reason: unknown) => void;
  const promise = new Promise<WasmBridge>((resolve, reject) => {
    resolveBridge = resolve;
    rejectBridge = reject;
  });
  const record: WasmBridgeCoordinatorRecord = {
    selectedUrl,
    promise,
    state: "pending",
  };
  coordinator.record = record;

  void importWasmBridge(selectedUrl).then(
    (bridge) => {
      if (coordinator.record?.promise === promise) {
        coordinator.record.state = "ready";
      }
      resolveBridge(bridge);
    },
    (error) => {
      if (coordinator.record?.promise === promise) {
        delete coordinator.record;
      }
      rejectBridge(
        error instanceof Forge3DError
          ? error
          : new Forge3DError(
              "WASM_LOAD_FAILED",
              "Failed to load the Forge3D WASM bridge",
              error,
            ),
      );
    },
  );
  return promise;
}

function getWasmBridgeCoordinator(): WasmBridgeCoordinator {
  const realm = globalThis as typeof globalThis & {
    [WASM_COORDINATOR_KEY]?: unknown;
  };
  if (Object.prototype.hasOwnProperty.call(realm, WASM_COORDINATOR_KEY)) {
    const value = realm[WASM_COORDINATOR_KEY];
    if (!isWasmBridgeCoordinator(value)) {
      throw new Forge3DError(
        "INTERNAL_ERROR",
        "The Forge3D WASM coordinator has an incompatible schema",
      );
    }
    return value;
  }

  const coordinator: WasmBridgeCoordinator = { schemaVersion: 1 };
  Object.defineProperty(realm, WASM_COORDINATOR_KEY, {
    value: coordinator,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return coordinator;
}

function isWasmBridgeCoordinator(value: unknown): value is WasmBridgeCoordinator {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return false;
  }
  const record = (value as { record?: unknown }).record;
  return (
    record === undefined ||
    (typeof record === "object" &&
      record !== null &&
      typeof (record as { selectedUrl?: unknown }).selectedUrl === "string" &&
      (record as { promise?: unknown }).promise instanceof Promise &&
      ((record as { state?: unknown }).state === "pending" ||
        (record as { state?: unknown }).state === "ready"))
  );
}

async function importWasmBridge(selectedUrl: string): Promise<WasmBridge> {
  const modulePath = "../pkg/forge3d_web.js";
  try {
    const [module, response] = await Promise.all([
      import(/* @vite-ignore */ modulePath),
      fetchValidatedWasm(selectedUrl),
    ]);
    const bridge = module as WasmBridge;
    await bridge.default?.({ module_or_path: response });
    return bridge;
  } catch (error) {
    throw error instanceof Forge3DError
      ? error
      : new Forge3DError(
          "WASM_LOAD_FAILED",
          `Failed to initialize Forge3D WASM from ${selectedUrl}`,
          error,
        );
  }
}

async function fetchValidatedWasm(selectedUrl: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(selectedUrl);
  } catch (error) {
    throw new Forge3DError(
      "WASM_LOAD_FAILED",
      `Failed to fetch Forge3D WASM from ${selectedUrl}`,
      error,
    );
  }
  if (!response.ok) {
    throw new Forge3DError(
      "WASM_LOAD_FAILED",
      `Forge3D WASM request failed with HTTP ${response.status}`,
      { status: response.status, url: selectedUrl },
    );
  }
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/wasm") {
    throw new Forge3DError(
      "WASM_LOAD_FAILED",
      "Forge3D WASM must be served as application/wasm",
      { mediaType: mediaType ?? null, url: selectedUrl },
    );
  }
  return response;
}

export function selectedWasmBridge():Promise<WasmBridge> {
  return getWasmBridgeCoordinator().record?.promise ?? loadWasmBridge();
}
export async function loadOfflineWasm():Promise<OfflineWasmExports> {
  const bridge = await selectedWasmBridge();
  if (
    bridge.encodeExr === undefined ||
    bridge.decodeExr === undefined ||
    bridge.exrChannelNames === undefined ||
    bridge.tonemapHdr === undefined ||
    bridge.atrousDenoise === undefined ||
    bridge.compareImages === undefined
  ) {
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "The Forge3D WASM bridge does not export the W06 frame helpers",
    );
  }
  return bridge as unknown as OfflineWasmExports;
}
export async function loadProbeWorkerWasmAssets(): Promise<{
  wasmModuleUrl: string;
  wasmUrl: string;
}> {
  await loadOfflineWasm();
  const selectedUrl = getWasmBridgeCoordinator().record?.selectedUrl;
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
