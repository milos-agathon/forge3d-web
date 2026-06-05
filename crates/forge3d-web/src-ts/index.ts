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
}

interface WasmRuntime {
  readonly disposed: boolean;
  readonly width: number;
  readonly height: number;
  readonly diagnosticsEnabled: boolean;
  clearColor(): number[];
  setTerrain(terrain: TerrainHeightmapInput): void;
  render(): void;
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
        value.details
      );
    }

    return new Forge3DError(
      "WEBGPU_UNAVAILABLE",
      value instanceof Error ? value.message : String(value)
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
    options: Forge3DRuntimeOptions = {}
  ): Promise<Forge3DRuntime> {
    const bridge = await loadWasmBridge();
    try {
      const runtime = await bridge.Forge3DRuntime.create(
        canvas,
        normalizeRuntimeOptions(options)
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

  setTerrain(terrain: TerrainHeightmapInput): void {
    try {
      this.#inner.setTerrain(normalizeTerrainHeightmapInput(terrain));
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
  options: Forge3DRuntimeOptions
): Forge3DRuntimeOptions {
  return { ...options };
}

function normalizeTerrainHeightmapInput(
  terrain: TerrainHeightmapInput
): TerrainHeightmapInput {
  return {
    width: terrain.width,
    height: terrain.height,
    heights: terrain.heights
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
  "RUNTIME_DISPOSED"
]);
