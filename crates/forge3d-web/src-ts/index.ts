import { registerRuntimeInternals } from "./runtime-internals.js";
import {
  normalizeMemoryReport,
  normalizeRenderStats,
} from "./native-reports.js";

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
  quality?: RenderQuality;
  memoryBudgetBytes?: number;
  overflowPolicy?: MemoryOverflowPolicy;
  timestampMode?: TimestampMode;
}

type WasmRuntimeOptions = Omit<Forge3DRuntimeOptions, "wasmUrl">;

export interface Forge3DRuntimeCapabilities {
  deviceState: "ready" | "lost" | "disposed";
  maxTextureDimension2D: number;
  maxBufferSize: number;
  surfaceFormat: string;
  adapterInfo?: AdapterInfo;
  isFallbackAdapter?: boolean;
  features?: string[];
  limits?: Record<string, number>;
  surfaceFormats?: string[];
  preferredCanvasFormat?: string;
  timestampQuery?: boolean;
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
  /** Number of requestAnimationFrame handles currently owned by this viewer. */
  ownedAnimationFrameCount: number;
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

export type RenderQuality = "ultra" | "high" | "medium" | "low";

export type MemoryOverflowPolicy = "reject" | "downscale";

export type TimestampMode = "auto" | "disabled";

export type RendererPresetName =
  | "studio-pbr"
  | "outdoor-sun"
  | "toon-viz"
  | "rainier-showcase"
  | "rainier-relief";

export interface LightSlotConfig {
  type: string;
  intensity: number;
  color: [number, number, number];
  direction?: [number, number, number];
  position?: [number, number, number];
}

export interface MaterialSlotConfig {
  id: string;
  model: string;
  parameters: Record<string, number | boolean | string>;
}

export interface RendererConfigData {
  quality: RenderQuality;
  memoryBudgetBytes: number;
  overflowPolicy: MemoryOverflowPolicy;
  timestampMode: TimestampMode;
  sampleCount: 1 | 4;
  lighting: { exposure: number; lights: LightSlotConfig[] };
  materials: Record<string, MaterialSlotConfig>;
  shading: {
    brdf: string;
    roughness: number;
    metallic: number;
    normalMaps: boolean;
  };
  shadows: {
    enabled: boolean;
    technique: string;
    mapSize: number;
    cascades: number;
  };
  gi: { modes: string[]; ambientOcclusionStrength: number };
  atmosphere: { enabled: boolean; sky: string; hdrUrl?: string };
  brdfOverride?: string;
}

export interface RendererConfigInput {
  quality?: RenderQuality;
  memoryBudgetBytes?: number;
  overflowPolicy?: MemoryOverflowPolicy;
  timestampMode?: TimestampMode;
  sampleCount?: 1 | 4;
  lighting?: Partial<RendererConfigData["lighting"]>;
  materials?: Record<string, MaterialSlotConfig>;
  shading?: Partial<RendererConfigData["shading"]>;
  shadows?: Partial<RendererConfigData["shadows"]>;
  gi?: Partial<RendererConfigData["gi"]>;
  atmosphere?: Partial<RendererConfigData["atmosphere"]>;
  brdfOverride?: string | null;
}

export type RendererConfigSource =
  | import("./renderer-config.js").RendererConfig
  | RendererConfigInput
  | RendererPresetName;

export type SceneNodeId = number;

export type SceneNodeKind =
  | "group"
  | "terrain"
  | "ground-plane"
  | "text-mesh"
  | "overlay"
  | "custom";

export interface SceneTransform {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface SceneNodeBase {
  name: string;
  transform?: Partial<SceneTransform>;
  visible?: boolean;
  materialSlot?: string;
}

export interface GroupNodeInput extends SceneNodeBase {
  kind: "group";
}

export interface TerrainNodeInput extends SceneNodeBase {
  kind: "terrain";
  terrain: TerrainHeightmapInput;
}

export interface GroundPlaneNodeInput extends SceneNodeBase {
  kind: "ground-plane";
  size: [number, number];
  color: [number, number, number, number];
  height?: number;
}

export interface TextMeshNodeInput extends SceneNodeBase {
  kind: "text-mesh";
  text: string;
  size: number;
  color: [number, number, number, number];
}

export interface OverlayNodeInput extends SceneNodeBase {
  kind: "overlay";
  bounds: [number, number, number, number];
  color: [number, number, number, number];
  zIndex?: number;
}

export interface CustomNodeInput extends SceneNodeBase {
  kind: "custom";
  layerType: string;
  payload?: unknown;
}

export type SceneNodeInput =
  | GroupNodeInput
  | TerrainNodeInput
  | GroundPlaneNodeInput
  | TextMeshNodeInput
  | OverlayNodeInput
  | CustomNodeInput;

export interface SceneNodeSnapshot {
  id: SceneNodeId;
  parent: SceneNodeId | null;
  children: SceneNodeId[];
  node: SceneNodeInput;
  transform: SceneTransform;
  visible: boolean;
}

export type ScenePassKind = "render" | "compute" | "copy";

export interface ScenePassInput {
  name: string;
  kind: ScenePassKind;
  reads?: string[];
  writes?: string[];
  dependsOn?: string[];
}

export interface SceneRenderBarrier {
  resource: string;
  beforePass: string;
  from: "read" | "write";
  to: "read" | "write";
}

export interface SceneRenderPlan {
  passes: string[];
  barriers: SceneRenderBarrier[];
  resourceLifetimes: Record<string, [number, number]>;
}

export interface SceneSnapshot {
  revision: number;
  nodes: SceneNodeSnapshot[];
  passes: ScenePassInput[];
}

export type MemoryCategory =
  | "buffers"
  | "textures"
  | "staging"
  | "readback"
  | "tile-cache"
  | "render-bundles"
  | "other";

export interface QualityDowngrade {
  requested: RenderQuality;
  effective: RenderQuality;
  requestedBytes: number;
  admittedBytes: number;
}

export interface MemoryReport {
  currentBytes: number;
  peakBytes: number;
  budgetBytes: number;
  utilization: number;
  allocationCount: number;
  categories: Record<MemoryCategory, number>;
  effectiveQuality: RenderQuality;
  downgrades: QualityDowngrade[];
}

export type SessionStatus =
  | "initializing"
  | "ready"
  | "recovering"
  | "failed"
  | "disposed";

export interface Forge3DSessionOptions {
  runtime?: Forge3DRuntimeOptions;
  renderer?: RendererConfigSource;
  recovery?: { deviceLoss?: "none" | "once" };
}

export interface AdapterInfo {
  name: string;
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  backend: string;
  deviceType: string;
}

export interface Forge3DSessionCapabilities extends Forge3DRuntimeCapabilities {
  adapterInfo: AdapterInfo;
  isFallbackAdapter: boolean;
  features: string[];
  limits: Record<string, number>;
  surfaceFormats: string[];
  preferredCanvasFormat: string;
  timestampQuery: boolean;
  timingMode: "gpu-timestamp" | "cpu";
  effectiveQuality: RenderQuality;
  offscreenCanvas: boolean;
  workers: boolean;
  sharedArrayBuffer: boolean;
  fileSystemAccess: boolean;
  opfs: boolean;
}

export interface PassRenderStats {
  name: string;
  milliseconds: number;
  timing: "gpu-timestamp" | "cpu";
}

export interface RenderStats {
  frameIndex: number;
  frameTimeMs: number;
  drawCalls: number;
  triangles: number;
  passes: PassRenderStats[];
}

export type Forge3DTypedArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

export type Forge3DDType =
  | "u8"
  | "u16"
  | "u32"
  | "i8"
  | "i16"
  | "i32"
  | "f32"
  | "f64";

export interface TypedArrayShape {
  dtype: Forge3DDType;
  shape: readonly number[];
}

export interface TransferableTypedArray<T extends Forge3DTypedArray> {
  value: T;
  transfer: [ArrayBuffer];
}

export type BrowserByteSource =
  | string
  | URL
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | Response;

export interface ByteReadProgress {
  loaded: number;
  total?: number;
  done: boolean;
}

export interface ByteReadOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  onProgress?: (progress: ByteReadProgress) => void;
}

export type BrowserByteSink =
  | { kind: "blob"; type?: string }
  | { kind: "stream"; stream: WritableStream<Uint8Array> }
  | {
      kind: "file-system";
      handle?: FileSystemFileHandle;
      suggestedName?: string;
      type?: string;
    }
  | { kind: "opfs"; path: string; type?: string }
  | { kind: "download"; filename: string; type?: string };

export interface ByteWriteResult {
  bytesWritten: number;
  blob?: Blob;
  handle?: FileSystemFileHandle;
}

export interface Forge3DMessageCallOptions {
  signal?: AbortSignal;
  transfer?: Transferable[];
}

export interface Forge3DMessageContext {
  signal: AbortSignal;
  requestId: number;
}

export type Forge3DMessageHandler = (
  payload: unknown,
  context: Forge3DMessageContext,
) => unknown | Promise<unknown>;

export type Forge3DMessageHandlers = Record<string, Forge3DMessageHandler>;

export type WorkerExecutionMode =
  | "shared-array-buffer"
  | "transferable"
  | "main-thread";

export interface Forge3DWorkerPoolOptions {
  size?: number;
  maxQueued?: number;
  preferSharedArrayBuffer?: boolean;
  workerFactory?: (index: number) => MessagePort;
  mainThreadHandler: Forge3DMessageHandler;
}

export interface WorkerPoolDiagnostics {
  mode: WorkerExecutionMode;
  size: number;
  active: number;
  queued: number;
  disposed: boolean;
}

export interface Forge3DWorkerRendererOptions {
  worker: Worker;
  session?: Forge3DSessionOptions;
  controls?: false | OrbitControlsOptions;
  resize?: false | ViewerResizeOptions;
  ariaLabel?: string;
}

export interface WorkerRendererDiagnostics {
  ownedListeners: number;
  activePointers: number;
  activeObservers: number;
  disposed: boolean;
  stateHash: string;
}

export type OffscreenOutput =
  | { kind: "blob"; value: Blob }
  | { kind: "image-bitmap"; value: ImageBitmap }
  | { kind: "rgba8"; value: Uint8Array; width: number; height: number }
  | { kind: "stream"; value: ReadableStream<Uint8Array> };

export interface Forge3DOffscreenRendererOptions extends Forge3DSessionOptions {
  width: number;
  height: number;
}

export interface Forge3DNotebookAdapter {
  readonly canvas: HTMLCanvasElement;
  readonly session: Promise<import("./session.js").Forge3DSession>;
  display(scene: import("./scene.js").Forge3DScene): Promise<void>;
  capture(): Promise<Blob>;
  dispose(): void;
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
  registerDeviceLostCallback?(
    callback: (error: unknown) => void,
  ): () => void;
  simulateDeviceLossForTesting?(): void;
  setTerrain(terrain: TerrainHeightmapInput): void;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  setScene?(scene: SceneSnapshot): void;
  setCamera(camera: CameraInput): void;
  resize(size: ResizeInput): void;
  render(): boolean;
  screenshot(): Promise<Blob>;
  readRgba?(): Promise<Uint8Array>;
  getMemoryReport?(): MemoryReport;
  getRenderStats?(): RenderStats;
  dispose(): void;
}

interface WasmRuntimeConstructor {
  create(canvas: HTMLCanvasElement, options: unknown): Promise<WasmRuntime>;
  createOffscreen?(
    canvas: OffscreenCanvas,
    options: unknown,
  ): Promise<WasmRuntime>;
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
  #pendingDeviceLoss: Forge3DError | undefined;
  #detachDeviceLostRegistration: (() => void) | undefined;
  #width: number;
  #height: number;
  #disposeRequested = false;
  #nativeDisposed = false;
  #screenshotPromise: Promise<Blob> | undefined;
  #readbackPromise: Promise<Uint8Array> | undefined;
  #pendingMutations: Array<() => void> = [];

  private constructor(
    inner: WasmRuntime,
    loadTerrainHeightmapSource: WasmBridge["loadTerrainHeightmapSource"],
  ) {
    this.#inner = inner;
    this.#loadTerrainHeightmapSource = loadTerrainHeightmapSource;
    this.#deviceLostHandler = undefined;
    this.#pendingDeviceLoss = undefined;
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
    const nativeDeviceLostCallback = (error: unknown) => {
      const normalized = Forge3DError.from(error);
      this.#lastCapabilities = {
        ...this.#lastCapabilities,
        deviceState: "lost",
      };
      const deviceLoss = normalized.code === "DEVICE_LOST"
        ? normalized
        : new Forge3DError("DEVICE_LOST", normalized.message, normalized.details);
      if (this.#deviceLostHandler !== undefined) {
        this.#deviceLostHandler(deviceLoss);
      } else if (!this.#disposeRequested && this.#pendingDeviceLoss === undefined) {
        this.#pendingDeviceLoss = deviceLoss;
      }
    };
    this.#detachDeviceLostRegistration =
      this.#inner.registerDeviceLostCallback?.(nativeDeviceLostCallback);
    if (this.#detachDeviceLostRegistration === undefined) {
      this.#inner.setDeviceLostCallback?.(nativeDeviceLostCallback);
      this.#detachDeviceLostRegistration = () => {
        this.#inner.setDeviceLostCallback?.(undefined);
      };
    }
    registerRuntimeInternals(this, {
      setDeviceLostHandler: (handler) => {
        if (this.#disposeRequested) {
          this.#deviceLostHandler = undefined;
          this.#pendingDeviceLoss = undefined;
          return;
        }
        this.#deviceLostHandler = handler;
        if (handler !== undefined && this.#pendingDeviceLoss !== undefined) {
          const pending = this.#pendingDeviceLoss;
          this.#pendingDeviceLoss = undefined;
          handler(pending);
        }
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
    canvas: HTMLCanvasElement | OffscreenCanvas,
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
      const normalized = normalizeRuntimeOptions(options);
      const offscreen =
        typeof OffscreenCanvas !== "undefined" &&
        canvas instanceof OffscreenCanvas;
      let runtime: WasmRuntime;
      if (offscreen) {
        if (bridge.Forge3DRuntime.createOffscreen === undefined) {
          throw new Forge3DError(
            "UNSUPPORTED_FEATURE",
            "The Forge3D WASM bridge does not support OffscreenCanvas",
          );
        }
        runtime = await bridge.Forge3DRuntime.createOffscreen(
          canvas,
          normalized,
        );
      } else {
        runtime = await bridge.Forge3DRuntime.create(
          canvas as HTMLCanvasElement,
          normalized,
        );
      }
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
    if (!this.disposed && !this.#captureInFlight()) {
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
    if (this.#captureInFlight()) {
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
    if (this.#readbackPromise !== undefined) {
      await this.#readbackPromise.catch(() => undefined);
      this.#assertNotDisposed();
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
      () => this.#completeCaptureSafely(result),
      () => this.#completeCaptureSafely(result),
    );
    return result;
  }

  async readRgba(): Promise<Uint8Array> {
    this.#assertNotDisposed();
    const readRgba = this.#inner.readRgba;
    if (readRgba === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support readback",
      );
    }
    if (this.#readbackPromise !== undefined) {
      return this.#readbackPromise;
    }
    if (this.#screenshotPromise !== undefined) {
      await this.#screenshotPromise.catch(() => undefined);
      this.#assertNotDisposed();
    }
    const native = readRgba.call(this.#inner);
    const result = native.then(
      (bytes) => {
        this.#assertNotDisposed();
        return new Uint8Array(bytes);
      },
      (error: unknown) => {
        this.#assertNotDisposed();
        throw Forge3DError.from(error);
      },
    );
    this.#readbackPromise = result;
    void result.then(
      () => this.#completeCaptureSafely(result),
      () => this.#completeCaptureSafely(result),
    );
    return result;
  }

  setScene(scene: SceneSnapshot): void {
    this.#assertNotDisposed();
    if (this.#inner.setScene === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support scenes",
      );
    }
    this.#runOrQueue(() => this.#inner.setScene?.(scene));
  }

  getRenderStats(): RenderStats {
    const getRenderStats = this.#inner.getRenderStats;
    if (getRenderStats === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not report render stats",
      );
    }
    let stats: RenderStats | undefined;
    try {
      stats = normalizeRenderStats(getRenderStats.call(this.#inner));
    } catch (error) {
      throw Forge3DError.from(error);
    }
    if (stats === undefined) {
      throw new Forge3DError(
        "INTERNAL_ERROR",
        "Native render stats were malformed",
      );
    }
    return stats;
  }

  getMemoryReport(): MemoryReport {
    const getMemoryReport = this.#inner.getMemoryReport;
    if (getMemoryReport === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not report memory usage",
      );
    }
    let report: MemoryReport | undefined;
    try {
      report = normalizeMemoryReport(getMemoryReport.call(this.#inner));
    } catch (error) {
      throw Forge3DError.from(error);
    }
    if (report === undefined) {
      throw new Forge3DError(
        "INTERNAL_ERROR",
        "Native memory report was malformed",
      );
    }
    return report;
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
    this.#pendingDeviceLoss = undefined;
    this.#detachDeviceLostRegistration?.();
    this.#detachDeviceLostRegistration = undefined;
    this.#pendingMutations = [];
    if (this.#captureInFlight()) {
      this.#lastCapabilities = {
        ...this.#lastCapabilities,
        deviceState: "disposed",
      };
      return;
    }
    this.#finalizeDispose();
  }

  #captureInFlight(): boolean {
    return (
      this.#screenshotPromise !== undefined ||
      this.#readbackPromise !== undefined
    );
  }

  #assertNotDisposed(): void {
    if (this.#disposeRequested) {
      throw new Forge3DError("RUNTIME_DISPOSED", "Runtime is disposed");
    }
  }

  #runOrQueue(operation: () => void): void {
    if (this.#captureInFlight()) {
      this.#pendingMutations.push(operation);
      return;
    }
    try {
      operation();
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  #completeCapture(promise: Promise<unknown>): void {
    if (this.#screenshotPromise === promise) {
      this.#screenshotPromise = undefined;
    } else if (this.#readbackPromise === promise) {
      this.#readbackPromise = undefined;
    } else {
      return;
    }
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

  #completeCaptureSafely(promise: Promise<unknown>): void {
    try {
      this.#completeCapture(promise);
    } catch (error) {
      reportUnhandledRuntimeError(Forge3DError.from(error));
    }
  }

  #finalizeDispose(): void {
    if (this.#nativeDisposed) {
      return;
    }
    this.#nativeDisposed = true;
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
  const normalized: Forge3DRuntimeCapabilities = {
    deviceState: capabilities.deviceState,
    maxTextureDimension2D: capabilities.maxTextureDimension2D,
    maxBufferSize: capabilities.maxBufferSize,
    surfaceFormat: capabilities.surfaceFormat,
  };
  if (capabilities.adapterInfo !== undefined) {
    normalized.adapterInfo = { ...capabilities.adapterInfo };
  }
  if (capabilities.isFallbackAdapter !== undefined) {
    normalized.isFallbackAdapter = capabilities.isFallbackAdapter === true;
  }
  if (capabilities.features !== undefined) {
    normalized.features = [...new Set(capabilities.features)].sort();
  }
  if (capabilities.limits !== undefined) {
    normalized.limits = { ...capabilities.limits };
  }
  if (capabilities.surfaceFormats !== undefined) {
    normalized.surfaceFormats = [
      ...new Set(capabilities.surfaceFormats),
    ].sort();
  }
  if (capabilities.preferredCanvasFormat !== undefined) {
    normalized.preferredCanvasFormat = capabilities.preferredCanvasFormat;
  }
  if (capabilities.timestampQuery !== undefined) {
    normalized.timestampQuery = capabilities.timestampQuery === true;
  }
  return normalized;
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
export {
  getRendererPreset,
  RendererConfig,
  rendererPresetNames,
} from "./renderer-config.js";
export { Forge3DScene } from "./scene.js";
export { Forge3DSession } from "./session.js";
export { BorrowedWasmView } from "./ownership.js";
export { readByteSource, writeByteSink } from "./browser-io.js";
export {
  Forge3DMessageClient,
  Forge3DWebSocketAdapter,
  serveForge3DMessagePort,
} from "./message-protocol.js";
export { Forge3DWorkerPool, selectWorkerExecutionMode } from "./browser-resources.js";
export { Forge3DWorkerRenderer, installForge3DWorkerHost } from "./worker-renderer.js";
export { Forge3DOffscreenRenderer } from "./offscreen-renderer.js";
export {
  createNotebookAdapter,
  defineForge3DElement,
} from "./display-adapters.js";
