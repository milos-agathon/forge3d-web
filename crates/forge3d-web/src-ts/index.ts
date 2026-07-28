import { registerRuntimeInternals } from "./runtime-internals.js";

export type Forge3DErrorCode =
  | "WEBGPU_UNAVAILABLE"
  | "WEBGPU_ADAPTER_UNAVAILABLE"
  | "INSECURE_CONTEXT"
  | "WASM_LOAD_FAILED"
  | "DEVICE_REQUEST_FAILED"
  | "DEVICE_LOST"
  | "SURFACE_CREATE_FAILED"
  | "SURFACE_LOST"
  | "SURFACE_OUTDATED"
  | "OUT_OF_MEMORY"
  | "UNSUPPORTED_FEATURE"
  | "INVALID_INPUT"
  | "IO_ERROR"
  | "REQUEST_CANCELLED"
  | "SHADER_COMPILATION_FAILED"
  | "INTERNAL_ERROR"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "RUNTIME_DISPOSED";

export interface Forge3DRuntimeOptions {
  powerPreference?: "none" | "low-power" | "high-performance";
  wasmUrl?: string | URL;
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  clearColor?: [number, number, number, number];
  alphaMode?: "opaque" | "premultiplied";
  colorSpace?: "srgb";
  diagnostics?: boolean;
}

type WasmRuntimeOptions = Omit<Forge3DRuntimeOptions, "wasmUrl">;

export interface Forge3DRuntimeCapabilities {
  deviceState: "ready" | "lost" | "disposed";
  maxTextureDimension2D: number;
  maxBufferSize: number;
  surfaceFormat: string;
}

export type ViewerStatus =
  | "initializing"
  | "ready"
  | "recovering"
  | "failed"
  | "disposed";

export type ViewerResourcePreset = "desktop" | "mobile";

export interface OrbitView {
  target: [number, number, number];
  distance: number;
  yawDegrees: number;
  pitchDegrees: number;
  fovYDegrees: number;
  near: number;
  far: number;
}

export interface OrbitControlsOptions {
  enabled?: boolean;
  keyboard?: boolean;
  orbitSpeed?: number;
  panSpeed?: number;
  zoomSpeed?: number;
  minDistance?: number;
  maxDistance?: number;
  minPitchDegrees?: number;
  maxPitchDegrees?: number;
}

export interface ViewerResizeOptions {
  maxDevicePixelRatio?: number;
}

export interface ViewerRecoveryOptions {
  deviceLoss?: "none" | "once";
}

export interface ViewerResourceBudget {
  maxTerrainSamples: number;
  maxSourceBytes: number;
  maxCanvasPixels: number;
  maxScreenshotPixels: number;
}

export interface ViewerResourceOptions {
  preset?: ViewerResourcePreset;
  budget?: Partial<ViewerResourceBudget>;
}

export interface ViewerCapabilities extends Forge3DRuntimeCapabilities {
  secureContext: true;
  webgpuAvailable: true;
}

export interface ViewerDiagnostics {
  generation: number;
  renderRequests: number;
  submittedFrames: number;
  skippedFrames: number;
  activePointers: number;
  ownedListeners: number;
  activeObservers: number;
  activeRuntimes: number;
  pendingAnimationFrame: boolean;
  recoveryAttempts: number;
  screenshotInFlight: boolean;
  effectiveResourceBudget: ViewerResourceBudget;
  effectiveMaxDevicePixelRatio: number;
}

export interface ViewerStatusChange {
  previous: ViewerStatus;
  current: ViewerStatus;
}

export interface Forge3DViewerOptions {
  runtime?: Forge3DRuntimeOptions;
  initialView?: OrbitView;
  controls?: false | OrbitControlsOptions;
  resize?: false | ViewerResizeOptions;
  recovery?: ViewerRecoveryOptions;
  resources?: ViewerResourceOptions;
  onStatusChange?: (change: ViewerStatusChange) => void;
  onError?: (error: Forge3DError) => void;
}

export interface TerrainHeightmapInput {
  width: number;
  height: number;
  heights: Float32Array;
  colorRamp?: TerrainColorRampInput;
}

export interface TerrainColorRampInput {
  stops: TerrainColorStopInput[];
}

export interface TerrainColorStopInput {
  position: number;
  color: [number, number, number];
}

export interface TerrainSourceProgress {
  loaded: number;
  total?: number;
  done: boolean;
}

export type TerrainByteSource = string | URL | File | Blob | ArrayBuffer;

export interface TerrainHeightmapSourceInput {
  width: number;
  height: number;
  source: TerrainByteSource;
  byteOffset?: number;
  byteLength?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TerrainSourceProgress) => void;
}

export interface CameraInput {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fovYDegrees: number;
  near: number;
  far: number;
}

export interface ResizeInput {
  width: number;
  height: number;
  devicePixelRatio: number;
}

interface WasmRuntime {
  readonly disposed: boolean;
  readonly width: number;
  readonly height: number;
  readonly diagnosticsEnabled: boolean;
  clearColor(): number[];
  getCapabilities(): Forge3DRuntimeCapabilities;
  setDeviceLostCallback?(
    callback: ((error: unknown) => void) | undefined,
  ): void;
  simulateDeviceLossForTesting?(): void;
  setTerrain(terrain: TerrainHeightmapInput): void;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  setCamera(camera: CameraInput): void;
  resize(size: ResizeInput): void;
  render(): boolean;
  screenshot(): Promise<Blob>;
  dispose(): void;
}

interface WasmRuntimeConstructor {
  create(canvas: HTMLCanvasElement, options: unknown): Promise<WasmRuntime>;
}

interface WasmBridge {
  Forge3DRuntime: WasmRuntimeConstructor;
  loadTerrainHeightmapSource(
    terrain: TerrainHeightmapSourceInput,
    maxTextureDimension2D: number,
    maxBufferSize: number,
  ): Promise<TerrainHeightmapInput>;
  default?: (options?: { module_or_path: unknown }) => Promise<unknown>;
}

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

export class Forge3DError extends Error {
  readonly code: Forge3DErrorCode;
  readonly details?: unknown;

  constructor(code: Forge3DErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "Forge3DError";
    this.code = code;
    this.details = details;
  }

  static from(value: unknown): Forge3DError {
    if (value instanceof Forge3DError) {
      return value;
    }

    if (isErrorLike(value)) {
      return new Forge3DError(
        normalizeErrorCode(value.code),
        value.message,
        value.details,
      );
    }

    return new Forge3DError(
      "INTERNAL_ERROR",
      value instanceof Error ? value.message : String(value),
    );
  }
}

export class Forge3DRuntime {
  readonly #inner: WasmRuntime;
  readonly #loadTerrainHeightmapSource: WasmBridge["loadTerrainHeightmapSource"];
  readonly #diagnosticsEnabled: boolean;
  readonly #clearColor: [number, number, number, number];
  #lastCapabilities: Forge3DRuntimeCapabilities;
  #deviceLostHandler: ((error: unknown) => void) | undefined;
  #width: number;
  #height: number;
  #disposeRequested = false;
  #nativeDisposed = false;
  #screenshotPromise: Promise<Blob> | undefined;
  #pendingMutations: Array<() => void> = [];

  private constructor(
    inner: WasmRuntime,
    loadTerrainHeightmapSource: WasmBridge["loadTerrainHeightmapSource"],
  ) {
    this.#inner = inner;
    this.#loadTerrainHeightmapSource = loadTerrainHeightmapSource;
    this.#deviceLostHandler = undefined;
    this.#width = inner.width;
    this.#height = inner.height;
    this.#diagnosticsEnabled = inner.diagnosticsEnabled;
    const clearColor = inner.clearColor();
    this.#clearColor = [
      clearColor[0] ?? 0,
      clearColor[1] ?? 0,
      clearColor[2] ?? 0,
      clearColor[3] ?? 1,
    ];
    this.#lastCapabilities = normalizeCapabilities(inner.getCapabilities());
    this.#inner.setDeviceLostCallback?.((error) => {
      const normalized = Forge3DError.from(error);
      this.#lastCapabilities = {
        ...this.#lastCapabilities,
        deviceState: "lost",
      };
      this.#deviceLostHandler?.(
        normalized.code === "DEVICE_LOST"
          ? normalized
          : new Forge3DError("DEVICE_LOST", normalized.message, normalized.details),
      );
    });
    registerRuntimeInternals(this, {
      setDeviceLostHandler: (handler) => {
        this.#deviceLostHandler = handler;
      },
      simulateDeviceLossForTests: () => {
        this.#assertNotDisposed();
        if (
          !this.#diagnosticsEnabled ||
          this.#inner.simulateDeviceLossForTesting === undefined
        ) {
          throw new Forge3DError(
            "UNSUPPORTED_FEATURE",
            "Device-loss simulation requires diagnostics: true",
          );
        }
        try {
          this.#inner.simulateDeviceLossForTesting();
        } catch (error) {
          throw Forge3DError.from(error);
        }
      },
    });
  }

  static async create(
    canvas: HTMLCanvasElement,
    options: Forge3DRuntimeOptions = {},
  ): Promise<Forge3DRuntime> {
    if (globalThis.isSecureContext === false) {
      throw new Forge3DError(
        "INSECURE_CONTEXT",
        "WebGPU requires a secure context",
      );
    }

    try {
      const bridge = await loadWasmBridge(options.wasmUrl);
      const runtime = await bridge.Forge3DRuntime.create(
        canvas,
        normalizeRuntimeOptions(options),
      );
      return new Forge3DRuntime(
        runtime,
        bridge.loadTerrainHeightmapSource,
      );
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  get disposed(): boolean {
    return this.#disposeRequested;
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  get diagnosticsEnabled(): boolean {
    return this.#diagnosticsEnabled;
  }

  clearColor(): [number, number, number, number] {
    return [...this.#clearColor];
  }

  getCapabilities(): Forge3DRuntimeCapabilities {
    if (!this.disposed && this.#screenshotPromise === undefined) {
      this.#lastCapabilities = normalizeCapabilities(
        this.#inner.getCapabilities(),
      );
    }
    return {
      ...this.#lastCapabilities,
      deviceState: this.disposed
        ? "disposed"
        : this.#lastCapabilities.deviceState,
    };
  }

  render(): boolean {
    this.#assertNotDisposed();
    if (this.#screenshotPromise !== undefined) {
      return false;
    }
    try {
      return (
        this.#inner.render as unknown as () => boolean
      )();
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  async screenshot(): Promise<Blob> {
    this.#assertNotDisposed();
    if (this.#screenshotPromise !== undefined) {
      return this.#screenshotPromise;
    }
    const native = this.#inner.screenshot();
    const result = native.then(
      (blob) => {
        this.#assertNotDisposed();
        return blob;
      },
      (error: unknown) => {
        this.#assertNotDisposed();
        throw Forge3DError.from(error);
      },
    );
    this.#screenshotPromise = result;
    void result.then(
      () => this.#completeScreenshotSafely(result),
      () => this.#completeScreenshotSafely(result),
    );
    return result;
  }

  setTerrain(terrain: TerrainHeightmapInput): void {
    this.#assertNotDisposed();
    const normalized = normalizeTerrainHeightmapInput(terrain);
    this.#runOrQueue(() => this.#inner.setTerrain(normalized));
  }

  async setTerrainFromSource(
    terrain: TerrainHeightmapSourceInput,
  ): Promise<void> {
    try {
      const decoded = await this.#loadTerrainHeightmapSource(
        normalizeTerrainHeightmapSourceInput(terrain),
        this.#lastCapabilities.maxTextureDimension2D,
        this.#lastCapabilities.maxBufferSize,
      );
      if (this.disposed) {
        throw new Forge3DError(
          "RUNTIME_DISPOSED",
          "Runtime was disposed during terrain source loading",
        );
      }
      if (this.#screenshotPromise !== undefined) {
        await this.#screenshotPromise.catch(() => undefined);
        this.#assertNotDisposed();
      }
      this.#inner.setTerrain(decoded);
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  setCamera(camera: CameraInput): void {
    this.#assertNotDisposed();
    const normalized = normalizeCameraInput(camera);
    this.#runOrQueue(() => this.#inner.setCamera(normalized));
  }

  resize(size: ResizeInput): void {
    this.#assertNotDisposed();
    const normalized = normalizeResizeInput(size);
    this.#runOrQueue(() => {
      this.#inner.resize(normalized);
      this.#width = Math.round(normalized.width * normalized.devicePixelRatio);
      this.#height = Math.round(normalized.height * normalized.devicePixelRatio);
    });
  }

  dispose(): void {
    if (this.#disposeRequested) {
      return;
    }
    this.#disposeRequested = true;
    this.#deviceLostHandler = undefined;
    this.#pendingMutations = [];
    if (this.#screenshotPromise !== undefined) {
      this.#lastCapabilities = {
        ...this.#lastCapabilities,
        deviceState: "disposed",
      };
      return;
    }
    this.#finalizeDispose();
  }

  #assertNotDisposed(): void {
    if (this.#disposeRequested) {
      throw new Forge3DError("RUNTIME_DISPOSED", "Runtime is disposed");
    }
  }

  #runOrQueue(operation: () => void): void {
    if (this.#screenshotPromise !== undefined) {
      this.#pendingMutations.push(operation);
      return;
    }
    try {
      operation();
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  #completeScreenshot(promise: Promise<Blob>): void {
    if (this.#screenshotPromise !== promise) {
      return;
    }
    this.#screenshotPromise = undefined;
    if (this.#disposeRequested) {
      this.#finalizeDispose();
      return;
    }
    const mutations = this.#pendingMutations.splice(0);
    for (const mutation of mutations) {
      try {
        mutation();
      } catch (error) {
        const normalized = Forge3DError.from(error);
        if (normalized.code === "DEVICE_LOST") {
          this.#deviceLostHandler?.(normalized);
        } else {
          reportUnhandledRuntimeError(normalized);
        }
      }
    }
  }

  #completeScreenshotSafely(promise: Promise<Blob>): void {
    try {
      this.#completeScreenshot(promise);
    } catch (error) {
      reportUnhandledRuntimeError(Forge3DError.from(error));
    }
  }

  #finalizeDispose(): void {
    if (this.#nativeDisposed) {
      return;
    }
    this.#nativeDisposed = true;
    this.#inner.setDeviceLostCallback?.(undefined);
    this.#inner.dispose();
    this.#lastCapabilities = {
      ...this.#lastCapabilities,
      deviceState: "disposed",
    };
  }
}

function reportUnhandledRuntimeError(error: Forge3DError): void {
  const reportError = (
    globalThis as typeof globalThis & {
      reportError?: (value: unknown) => void;
    }
  ).reportError;
  if (typeof reportError === "function") {
    queueMicrotask(() => reportError(error));
    return;
  }
  console.error(error);
}

function loadWasmBridge(wasmUrl?: string | URL): Promise<WasmBridge> {
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

function normalizeRuntimeOptions(
  options: Forge3DRuntimeOptions,
): WasmRuntimeOptions {
  const { wasmUrl: _wasmUrl, ...runtimeOptions } = options;
  return runtimeOptions;
}

function normalizeTerrainHeightmapInput(
  terrain: TerrainHeightmapInput,
): TerrainHeightmapInput {
  const normalized: TerrainHeightmapInput = {
    width: terrain.width,
    height: terrain.height,
    heights: terrain.heights,
  };
  if (terrain.colorRamp !== undefined) {
    const stops = terrain.colorRamp.stops;
    if (
      !Array.isArray(stops) ||
      stops.length < 2 ||
      stops.length > 8
    ) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "colorRamp.stops must contain between 2 and 8 stops",
      );
    }
    normalized.colorRamp = {
      stops: stops.map((stop) => ({
        position: stop.position,
        color: [stop.color[0], stop.color[1], stop.color[2]],
      })),
    };
  }
  return normalized;
}

function normalizeTerrainHeightmapSourceInput(
  terrain: TerrainHeightmapSourceInput,
): TerrainHeightmapSourceInput {
  const normalized: TerrainHeightmapSourceInput = {
    width: terrain.width,
    height: terrain.height,
    source: terrain.source,
  };
  if (terrain.byteOffset !== undefined) {
    normalized.byteOffset = terrain.byteOffset;
  }
  if (terrain.byteLength !== undefined) {
    normalized.byteLength = terrain.byteLength;
  }
  if (terrain.signal !== undefined) {
    normalized.signal = terrain.signal;
  }
  if (terrain.onProgress !== undefined) {
    normalized.onProgress = terrain.onProgress;
  }
  return normalized;
}

function normalizeCameraInput(camera: CameraInput): CameraInput {
  return {
    position: [camera.position[0], camera.position[1], camera.position[2]],
    target: [camera.target[0], camera.target[1], camera.target[2]],
    up: [camera.up[0], camera.up[1], camera.up[2]],
    fovYDegrees: camera.fovYDegrees,
    near: camera.near,
    far: camera.far,
  };
}

function normalizeResizeInput(size: ResizeInput): ResizeInput {
  return {
    width: size.width,
    height: size.height,
    devicePixelRatio: size.devicePixelRatio,
  };
}

function normalizeCapabilities(
  capabilities: Forge3DRuntimeCapabilities,
): Forge3DRuntimeCapabilities {
  return {
    deviceState: capabilities.deviceState,
    maxTextureDimension2D: capabilities.maxTextureDimension2D,
    maxBufferSize: capabilities.maxBufferSize,
    surfaceFormat: capabilities.surfaceFormat,
  };
}

function isErrorLike(value: unknown): value is {
  code?: unknown;
  message: string;
  details?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function normalizeErrorCode(code: unknown): Forge3DErrorCode {
  const fallback = "INTERNAL_ERROR";
  if (typeof code !== "string") {
    return fallback;
  }
  return ERROR_CODES.has(code as Forge3DErrorCode)
    ? (code as Forge3DErrorCode)
    : fallback;
}

const ERROR_CODES = new Set<Forge3DErrorCode>([
  "WEBGPU_UNAVAILABLE",
  "WEBGPU_ADAPTER_UNAVAILABLE",
  "INSECURE_CONTEXT",
  "WASM_LOAD_FAILED",
  "DEVICE_REQUEST_FAILED",
  "DEVICE_LOST",
  "SURFACE_CREATE_FAILED",
  "SURFACE_LOST",
  "SURFACE_OUTDATED",
  "OUT_OF_MEMORY",
  "UNSUPPORTED_FEATURE",
  "INVALID_INPUT",
  "IO_ERROR",
  "REQUEST_CANCELLED",
  "SHADER_COMPILATION_FAILED",
  "INTERNAL_ERROR",
  "RESOURCE_LIMIT_EXCEEDED",
  "RUNTIME_DISPOSED",
]);

export { Forge3DViewer } from "./viewer.js";
