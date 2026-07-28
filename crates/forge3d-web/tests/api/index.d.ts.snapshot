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
}

/** Observable low-level WebGPU runtime limits and device state. */
export interface Forge3DRuntimeCapabilities {
  deviceState: "ready" | "lost" | "disposed";
  maxTextureDimension2D: number;
  maxBufferSize: number;
  surfaceFormat: string;
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

/**
 * Stable browser WebGPU runtime facade.
 *
 * Create instances with Forge3DRuntime.create(canvas, options), then release
 * browser GPU resources with dispose(). After dispose(), mutating/rendering
 * methods reject or throw Forge3DError with code RUNTIME_DISPOSED.
 */
export declare class Forge3DRuntime {
  static create(
    canvas: HTMLCanvasElement,
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
  setTerrain(terrain: TerrainHeightmapInput): void;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  setCamera(camera: CameraInput): void;
  resize(size: ResizeInput): void;
  render(): void;
  screenshot(): Promise<Blob>;
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
