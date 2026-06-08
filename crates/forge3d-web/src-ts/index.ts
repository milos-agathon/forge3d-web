export type Forge3DErrorCode =
  | "WEBGPU_UNAVAILABLE"
  | "WEBGPU_ADAPTER_UNAVAILABLE"
  | "DEVICE_REQUEST_FAILED"
  | "SURFACE_CREATE_FAILED"
  | "SURFACE_LOST"
  | "SURFACE_OUTDATED"
  | "OUT_OF_MEMORY"
  | "UNSUPPORTED_FEATURE"
  | "INVALID_INPUT"
  | "IO_ERROR"
  | "REQUEST_CANCELLED"
  | "SHADER_COMPILATION_FAILED"
  | "RUNTIME_DISPOSED";

export interface Forge3DRuntimeOptions {
  powerPreference?: "low-power" | "high-performance";
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  clearColor?: [number, number, number, number];
  alphaMode?: "opaque" | "premultiplied";
  colorSpace?: "srgb";
  diagnostics?: boolean;
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
  setTerrain(terrain: TerrainHeightmapInput): void;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  setCamera(camera: CameraInput): void;
  resize(size: ResizeInput): void;
  render(): void;
  screenshot(): Promise<Blob>;
  dispose(): void;
}

interface WasmRuntimeConstructor {
  create(canvas: HTMLCanvasElement, options: unknown): Promise<WasmRuntime>;
}

interface WasmBridge {
  Forge3DRuntime: WasmRuntimeConstructor;
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
}

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
      "WEBGPU_UNAVAILABLE",
      value instanceof Error ? value.message : String(value),
    );
  }
}

export class Forge3DRuntime {
  readonly #inner: WasmRuntime;

  private constructor(inner: WasmRuntime) {
    this.#inner = inner;
  }

  static async create(
    canvas: HTMLCanvasElement,
    options: Forge3DRuntimeOptions = {},
  ): Promise<Forge3DRuntime> {
    const bridge = await loadWasmBridge();
    try {
      const runtime = await bridge.Forge3DRuntime.create(
        canvas,
        normalizeRuntimeOptions(options),
      );
      return new Forge3DRuntime(runtime);
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  get disposed(): boolean {
    return this.#inner.disposed;
  }

  get width(): number {
    return this.#inner.width;
  }

  get height(): number {
    return this.#inner.height;
  }

  get diagnosticsEnabled(): boolean {
    return this.#inner.diagnosticsEnabled;
  }

  clearColor(): [number, number, number, number] {
    const color = this.#inner.clearColor();
    return [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, color[3] ?? 1];
  }

  render(): void {
    try {
      this.#inner.render();
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  async screenshot(): Promise<Blob> {
    try {
      return await this.#inner.screenshot();
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  setTerrain(terrain: TerrainHeightmapInput): void {
    try {
      this.#inner.setTerrain(normalizeTerrainHeightmapInput(terrain));
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  async setTerrainFromSource(
    terrain: TerrainHeightmapSourceInput,
  ): Promise<void> {
    try {
      await this.#inner.setTerrainFromSource(
        normalizeTerrainHeightmapSourceInput(terrain),
      );
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  setCamera(camera: CameraInput): void {
    try {
      this.#inner.setCamera(normalizeCameraInput(camera));
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  resize(size: ResizeInput): void {
    try {
      this.#inner.resize(normalizeResizeInput(size));
    } catch (error) {
      throw Forge3DError.from(error);
    }
  }

  dispose(): void {
    this.#inner.dispose();
  }
}

let bridgePromise: Promise<WasmBridge> | undefined;

async function loadWasmBridge(): Promise<WasmBridge> {
  bridgePromise ??= importWasmBridge();
  return bridgePromise;
}

async function importWasmBridge(): Promise<WasmBridge> {
  const modulePath = "../pkg/forge3d_web.js";
  const module = await import(/* @vite-ignore */ modulePath);
  const bridge = module as WasmBridge;
  await bridge.default?.();
  return bridge;
}

function normalizeRuntimeOptions(
  options: Forge3DRuntimeOptions,
): Forge3DRuntimeOptions {
  return { ...options };
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
    normalized.colorRamp = {
      stops: terrain.colorRamp.stops.map((stop) => ({
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
  const fallback = "WEBGPU_UNAVAILABLE";
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
  "DEVICE_REQUEST_FAILED",
  "SURFACE_CREATE_FAILED",
  "SURFACE_LOST",
  "SURFACE_OUTDATED",
  "OUT_OF_MEMORY",
  "UNSUPPORTED_FEATURE",
  "INVALID_INPUT",
  "IO_ERROR",
  "REQUEST_CANCELLED",
  "SHADER_COMPILATION_FAILED",
  "RUNTIME_DISPOSED",
]);
