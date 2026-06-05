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

export declare class Forge3DError extends Error {
  readonly code: Forge3DErrorCode;
  readonly details?: unknown;
  constructor(code: Forge3DErrorCode, message: string, details?: unknown);
  static from(value: unknown): Forge3DError;
}

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

export declare class Forge3DRuntime {
  static create(
    canvas: HTMLCanvasElement,
    options?: Forge3DRuntimeOptions
  ): Promise<Forge3DRuntime>;
  readonly disposed: boolean;
  readonly width: number;
  readonly height: number;
  readonly diagnosticsEnabled: boolean;
  clearColor(): [number, number, number, number];
  setTerrain(terrain: TerrainHeightmapInput): void;
  setCamera(camera: CameraInput): void;
  resize(size: ResizeInput): void;
  render(): void;
  screenshot(): Promise<Blob>;
  dispose(): void;
}
