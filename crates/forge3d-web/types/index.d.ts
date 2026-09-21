/**
 * Stable Forge3D browser error codes. Unknown generated or platform errors are
 * normalized before they cross the public TypeScript facade.
 */
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

/** Error thrown by the stable browser facade. */
export declare class Forge3DError extends Error {
  readonly code: Forge3DErrorCode;
  readonly details?: unknown;
  constructor(code: Forge3DErrorCode, message: string, details?: unknown);
  static from(value: unknown): Forge3DError;
}

/** Options used during async WebGPU runtime creation. */
export interface Forge3DRuntimeOptions {
  /** Browser WebGPU adapter preference. */
  powerPreference?: "none" | "low-power" | "high-performance";
  /** Optional facade-owned wasm-bindgen asset URL. */
  wasmUrl?: string | URL;
  /** Canvas backing width in CSS pixels before applying devicePixelRatio. */
  width?: number;
  /** Canvas backing height in CSS pixels before applying devicePixelRatio. */
  height?: number;
  /** Explicit device pixel ratio multiplier. */
  devicePixelRatio?: number;
  /** RGBA clear color with channels in the 0..1 range. */
  clearColor?: [number, number, number, number];
  alphaMode?: "opaque" | "premultiplied";
  colorSpace?: "srgb";
  /** Enables runtime diagnostics exposed through diagnosticsEnabled. */
  diagnostics?: boolean;
  quality?: RenderQuality;
  memoryBudgetBytes?: number;
  overflowPolicy?: MemoryOverflowPolicy;
  timestampMode?: TimestampMode;
}

/** Observable low-level WebGPU runtime limits and device state. */
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

/** High-level interactive viewer lifecycle state. */
export type ViewerStatus =
  | "initializing"
  | "ready"
  | "recovering"
  | "failed"
  | "disposed";

/** Viewer resource-policy preset. */
export type ViewerResourcePreset = "desktop" | "mobile";

/** Y-up orbit camera state. */
export interface OrbitView {
  target: [number, number, number];
  distance: number;
  yawDegrees: number;
  pitchDegrees: number;
  fovYDegrees: number;
  near: number;
  far: number;
}

/** Optional orbit, pan, zoom, and keyboard control settings. */
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

/** Automatic resize policy. */
export interface ViewerResizeOptions {
  maxDevicePixelRatio?: number;
}

/** Unexpected device-loss recovery policy. */
export interface ViewerRecoveryOptions {
  deviceLoss?: "none" | "once";
}

/** Effective high-level viewer allocation ceilings. */
export interface ViewerResourceBudget {
  maxTerrainSamples: number;
  maxSourceBytes: number;
  maxCanvasPixels: number;
  maxScreenshotPixels: number;
}

/** Viewer resource preset and optional validated budget overrides. */
export interface ViewerResourceOptions {
  preset?: ViewerResourcePreset;
  budget?: Partial<ViewerResourceBudget>;
}

/** Viewer capabilities after secure WebGPU initialization succeeds. */
export interface ViewerCapabilities extends Forge3DRuntimeCapabilities {
  secureContext: true;
  webgpuAvailable: true;
}

/** Owned-resource and render-scheduler diagnostics. */
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

/** A single actual viewer lifecycle transition. */
export interface ViewerStatusChange {
  previous: ViewerStatus;
  current: ViewerStatus;
}

/** Options used during async interactive viewer creation. */
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

/** Float32 heightmap input for the MVP terrain renderer. */
export interface TerrainHeightmapInput {
  width: number;
  height: number;
  /** Must contain exactly width * height finite float values. */
  heights: Float32Array;
  /** Optional terrain color ramp used by the WebGPU surface shader. */
  colorRamp?: TerrainColorRampInput;
}

export interface TerrainColorRampInput {
  /** Ordered color stops. Positions and RGB channels are normalized to 0..1. */
  stops: TerrainColorStopInput[];
}

export interface TerrainColorStopInput {
  position: number;
  color: [number, number, number];
}

/** Progress event for browser terrain byte-source reads. */
export interface TerrainSourceProgress {
  /** Bytes loaded by the current source read. */
  loaded: number;
  /** Total bytes when known from Blob size, ArrayBuffer length, or HTTP headers. */
  total?: number;
  /** True when the source has been fully read. */
  done: boolean;
}

/** Browser byte sources accepted by async terrain loading. */
export type TerrainByteSource = string | URL | File | Blob | ArrayBuffer;

/** Async browser byte-source input for little-endian f32 terrain heightmaps. */
export interface TerrainHeightmapSourceInput {
  width: number;
  height: number;
  /** URL, File, Blob, or ArrayBuffer containing little-endian f32 height values. */
  source: TerrainByteSource;
  /** Optional byte offset into Blob or ArrayBuffer sources, or Range start for URLs. */
  byteOffset?: number;
  /** Optional byte length for Blob or ArrayBuffer sources, or Range length for URLs. */
  byteLength?: number;
  /** AbortSignal mapped to REQUEST_CANCELLED when triggered. */
  signal?: AbortSignal;
  /** Completion/progress callback. URL and Blob reads currently report completion. */
  onProgress?: (progress: TerrainSourceProgress) => void;
}

/** Camera parameters used to build the terrain view-projection matrix. */
export interface CameraInput {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fovYDegrees: number;
  near: number;
  far: number;
}

/** Explicit DPR-aware resize input. */
export interface ResizeInput {
  /** New CSS pixel width before applying devicePixelRatio. */
  width: number;
  /** New CSS pixel height before applying devicePixelRatio. */
  height: number;
  /** New backing-store multiplier. */
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
  | RendererConfig
  | RendererConfigInput
  | RendererPresetName;

export declare class RendererConfig {
  constructor(input?: RendererConfigInput);
  static from(source?: RendererConfigSource): RendererConfig;
  static preset(name: RendererPresetName): RendererConfig;
  validate(): this;
  copy(overrides?: RendererConfigInput): RendererConfig;
  toJSON(): RendererConfigData;
}

export declare function rendererPresetNames(): readonly RendererPresetName[];

export declare function getRendererPreset(
  name: RendererPresetName,
): RendererConfig;

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

export declare class Forge3DScene {
  static create(): Forge3DScene;
  readonly disposed: boolean;
  readonly revision: number;
  addNode(node: SceneNodeInput, parent?: SceneNodeId): SceneNodeId;
  addTerrain(
    terrain: TerrainHeightmapInput,
    options?: Omit<TerrainNodeInput, "kind" | "terrain">,
  ): SceneNodeId;
  addGroundPlane(input: Omit<GroundPlaneNodeInput, "kind">): SceneNodeId;
  addTextMesh(input: Omit<TextMeshNodeInput, "kind">): SceneNodeId;
  addOverlay(input: Omit<OverlayNodeInput, "kind">): SceneNodeId;
  setParent(child: SceneNodeId, parent?: SceneNodeId): void;
  setTransform(id: SceneNodeId, transform: Partial<SceneTransform>): void;
  setVisible(id: SceneNodeId, visible: boolean): void;
  removeNode(id: SceneNodeId): SceneNodeId[];
  getNode(id: SceneNodeId): SceneNodeSnapshot | undefined;
  getNodes(): SceneNodeSnapshot[];
  addPass(pass: ScenePassInput): void;
  removePass(name: string): boolean;
  getRenderPlan(): SceneRenderPlan;
  snapshot(): SceneSnapshot;
  copy(): Forge3DScene;
  estimatedGpuBytes(): number;
  dispose(): void;
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

export interface Forge3DSessionCapabilities
  extends Forge3DRuntimeCapabilities {
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

export declare class Forge3DSession {
  static create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options?: Forge3DSessionOptions,
  ): Promise<Forge3DSession>;
  readonly status: SessionStatus;
  readonly disposed: boolean;
  getConfig(): RendererConfig;
  getCapabilities(): Forge3DSessionCapabilities;
  getRenderStats(): RenderStats;
  getMemoryReport(): MemoryReport;
  setScene(scene: Forge3DScene): void;
  getScene(): Forge3DScene | undefined;
  render(): boolean;
  setCamera(camera: CameraInput): void;
  readRgba(): Promise<Uint8Array>;
  resize(size: ResizeInput): void;
  screenshot(): Promise<Blob>;
  whenReady(): Promise<void>;
  dispose(): void;
}

/**
 * Stable browser WebGPU runtime facade.
 *
 * Create instances with Forge3DRuntime.create(canvas, options), then release
 * browser GPU resources with dispose(). After dispose(), mutating/rendering
 * methods reject or throw Forge3DError with code RUNTIME_DISPOSED.
 */
export declare class Forge3DRuntime {
  static create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options?: Forge3DRuntimeOptions,
  ): Promise<Forge3DRuntime>;
  /** True after dispose() has been called. */
  readonly disposed: boolean;
  /** Current canvas backing width in physical pixels. */
  readonly width: number;
  /** Current canvas backing height in physical pixels. */
  readonly height: number;
  /** Whether diagnostics were enabled at creation time. */
  readonly diagnosticsEnabled: boolean;
  clearColor(): [number, number, number, number];
  getCapabilities(): Forge3DRuntimeCapabilities;
  getRenderStats(): RenderStats;
  getMemoryReport(): MemoryReport;
  setTerrain(terrain: TerrainHeightmapInput): void;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  setScene(scene: SceneSnapshot): void;
  setCamera(camera: CameraInput): void;
  resize(size: ResizeInput): void;
  render(): boolean;
  screenshot(): Promise<Blob>;
  readRgba(): Promise<Uint8Array>;
  dispose(): void;
}

/**
 * High-level, invalidation-driven interactive terrain viewer.
 *
 * The viewer owns controls, resize observation, scheduling, and one optional
 * device-loss recovery. dispose() synchronously releases all owned resources.
 */
export declare class Forge3DViewer {
  static create(
    canvas: HTMLCanvasElement,
    options?: Forge3DViewerOptions,
  ): Promise<Forge3DViewer>;
  readonly disposed: boolean;
  readonly status: ViewerStatus;
  getView(): OrbitView;
  getCapabilities(): ViewerCapabilities;
  getDiagnostics(): ViewerDiagnostics;
  setTerrain(terrain: TerrainHeightmapInput): void;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  setView(view: OrbitView): void;
  resetView(): void;
  resize(size: ResizeInput): void;
  render(): void;
  screenshot(): Promise<Blob>;
  dispose(): void;
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

export declare class BorrowedWasmView<T extends Forge3DTypedArray> {
  constructor(resolve: () => T, descriptor: TypedArrayShape);
  readonly disposed: boolean;
  readonly generation: number;
  readonly descriptor: TypedArrayShape;
  view(): T;
  copy(): T;
  transfer(): TransferableTypedArray<T>;
  dispose(): void;
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

export declare function readByteSource(
  source: BrowserByteSource,
  options?: ByteReadOptions,
): Promise<Uint8Array>;

export declare function writeByteSink(
  bytes: BufferSource,
  sink: BrowserByteSink,
): Promise<ByteWriteResult>;

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

export declare class Forge3DMessageClient {
  constructor(port: MessagePort);
  readonly disposed: boolean;
  call<T = unknown>(
    method: string,
    payload?: unknown,
    options?: Forge3DMessageCallOptions,
  ): Promise<T>;
  dispose(): void;
}

export declare function serveForge3DMessagePort(
  port: MessagePort,
  handlers: Forge3DMessageHandlers,
): () => void;

export declare class Forge3DWebSocketAdapter {
  constructor(socket: WebSocket);
  readonly port: MessagePort;
  dispose(): void;
}

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

export declare class Forge3DWorkerPool {
  constructor(options: Forge3DWorkerPoolOptions);
  run<T = unknown>(
    payload: unknown,
    options?: Forge3DMessageCallOptions,
  ): Promise<T>;
  getDiagnostics(): WorkerPoolDiagnostics;
  dispose(): void;
}

export declare function selectWorkerExecutionMode(input?: {
  workerAvailable?: boolean;
  crossOriginIsolated?: boolean;
  sharedArrayBufferAvailable?: boolean;
  preferSharedArrayBuffer?: boolean;
}): WorkerExecutionMode;

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

export declare class Forge3DWorkerRenderer {
  static create(
    canvas: HTMLCanvasElement,
    options: Forge3DWorkerRendererOptions,
  ): Promise<Forge3DWorkerRenderer>;
  readonly disposed: boolean;
  setScene(scene: Forge3DScene): Promise<void>;
  render(): Promise<boolean>;
  resize(size: ResizeInput): Promise<void>;
  screenshot(): Promise<Blob>;
  readRgba(): Promise<Uint8Array>;
  getDiagnostics(): WorkerRendererDiagnostics;
  dispose(): void;
}

export declare function installForge3DWorkerHost(scope?: Worker): () => void;

export type OffscreenOutput =
  | { kind: "blob"; value: Blob }
  | { kind: "image-bitmap"; value: ImageBitmap }
  | { kind: "rgba8"; value: Uint8Array; width: number; height: number }
  | { kind: "stream"; value: ReadableStream<Uint8Array> };

export interface Forge3DOffscreenRendererOptions
  extends Forge3DSessionOptions {
  width: number;
  height: number;
}

export declare class Forge3DOffscreenRenderer {
  static create(
    options: Forge3DOffscreenRendererOptions,
  ): Promise<Forge3DOffscreenRenderer>;
  readonly disposed: boolean;
  setScene(scene: Forge3DScene): void;
  render(): boolean;
  capture(kind: OffscreenOutput["kind"]): Promise<OffscreenOutput>;
  write(sink: BrowserByteSink): Promise<ByteWriteResult>;
  dispose(): void;
}

export interface Forge3DNotebookAdapter {
  readonly canvas: HTMLCanvasElement;
  readonly session: Promise<Forge3DSession>;
  display(scene: Forge3DScene): Promise<void>;
  capture(): Promise<Blob>;
  dispose(): void;
}

export declare function defineForge3DElement(
  tagName?: string,
): CustomElementConstructor;

export declare function createNotebookAdapter(
  container: HTMLElement,
  options?: Forge3DSessionOptions,
): Forge3DNotebookAdapter;
