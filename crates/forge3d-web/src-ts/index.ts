import {
  registerOfflineWasmLoader,
  registerRuntimeInternals,
  type OfflineWasmExports,
} from "./runtime-internals.js";
import {
  captureOnce,
  captureResultFromNative,
  DenoiseSettings,
  nativeBeginOptions,
  nativeResolveOptions,
  renderOffline as renderOfflineTarget,
} from "./offline.js";
import { HdrFrame, type AovFrame } from "./frames.js";
import {
  normalizeMemoryReport,
  normalizeRenderStats,
} from "./native-reports.js";
import { getTerrainColormap, TerrainDataset } from "./terrain-dataset.js";
import { normalizeTerrainMaterial } from "./terrain-material.js";
import type { TextureSet } from "./textures.js";
import { cloneCameraInput } from "./camera.js";

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
  /** Initial camera mode for viewer controls (default `"orbit"`). */
  mode?: CameraControllerMode;
  /** Fly (FPS) movement and look settings. */
  fly?: FlyControlsOptions;
  /** Keyboard bindings by `KeyboardEvent.code`. */
  bindings?: CameraKeyBindings;
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
  /** Initial fly view; defaults to the eye and direction of `initialView`. */
  initialFlyView?: FlyView;
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
  colormap?: TerrainColormapInput;
  spacing?: [number, number];
  exaggeration?: number;
  domain?: [number, number];
  nodata?: number;
  crs?: string;
  heightAo?: HeightAoOptions;
  sunVisibility?: SunVisibilityOptions;
  debugView?: TerrainDebugView;
  renderMode?: TerrainRenderMode;
  /** Terrain PBR/POM material; omitted keeps the unmaterialed terrain. */
  material?: TerrainMaterialInput;
}

export interface TerrainColorRampInput {
  stops: TerrainColorStopInput[];
}

export interface TerrainColorStopInput {
  position: number;
  color: [number, number, number];
}

export type TerrainColormapName =
  | "viridis"
  | "magma"
  | "terrain"
  | "grayscale";

export type TerrainColormapInput = TerrainColormapName | TerrainColorRampInput;

export type TerrainDebugView = "none" | "height-ao" | "sun-visibility";

export type TerrainRenderMode = "perspective" | "screen";

export type TerrainAlbedoMode = "material" | "colormap" | "mix";
export type TerrainPomMode = "occlusion" | "relief" | "parallax";
export type TerrainHeightCurveMode = "linear" | "pow" | "smoothstep" | "lut";
export type TerrainSamplingFilter = "linear" | "nearest";
export type TerrainSamplingAddress = "repeat" | "clamp-to-edge" | "mirror-repeat";
export type TerrainSpecularAaQuality = "off" | "native" | "medium" | "high";
export type TerrainMaterialDebugView =
  | "none"
  | "material-albedo"
  | "triplanar-weights"
  | "triplanar-checker"
  | "pom-offset"
  | "specular-aa-variance"
  | "roughness"
  | "layer-weights"
  | "subsurface";

/** Decoded RGBA8 image (albedo is sRGB-encoded, normal maps are linear). */
export interface TerrainMaterialImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decoded single-channel coverage mask in terrain UV space. */
export interface TerrainMaterialMask {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface TerrainMaterialLayerInput {
  baseColor?: [number, number, number];
  roughness?: number;
  metallic?: number;
  texture?: TerrainMaterialImage | null;
}

export interface TerrainTriplanarInput {
  scale?: number;
  blendSharpness?: number;
  normalStrength?: number;
}

export interface TerrainPomInput {
  enabled?: boolean;
  mode?: TerrainPomMode;
  scale?: number;
  minSteps?: number;
  maxSteps?: number;
  refineSteps?: number;
  shadow?: boolean;
  occlusion?: boolean;
}

export interface TerrainLodInput {
  level?: number;
  bias?: number;
  lod0Bias?: number;
}

export interface TerrainSamplingInput {
  magFilter?: TerrainSamplingFilter;
  minFilter?: TerrainSamplingFilter;
  mipFilter?: TerrainSamplingFilter;
  anisotropy?: number;
  addressU?: TerrainSamplingAddress;
  addressV?: TerrainSamplingAddress;
  addressW?: TerrainSamplingAddress;
}

export interface TerrainClampInput {
  /** Defaults to the terrain height domain. */
  heightRange?: [number, number] | null;
  slopeRange?: [number, number];
  ambientRange?: [number, number];
  shadowRange?: [number, number];
  occlusionRange?: [number, number];
}

export interface TerrainHeightCurveInput {
  mode?: TerrainHeightCurveMode;
  strength?: number;
  power?: number;
  /** 256 values in [0, 1]; required when `mode` is `"lut"`. */
  lut?: Float32Array | number[] | null;
}

export interface TerrainSnowLayerInput {
  enabled?: boolean;
  altitudeMin?: number;
  altitudeBlend?: number;
  slopeMax?: number;
  slopeBlend?: number;
  aspectInfluence?: number;
  color?: [number, number, number];
  roughness?: number;
  subsurfaceStrength?: number;
  subsurfaceTint?: [number, number, number];
  mask?: TerrainMaterialMask | null;
}

export interface TerrainRockLayerInput {
  enabled?: boolean;
  slopeMin?: number;
  slopeBlend?: number;
  color?: [number, number, number];
  roughness?: number;
  subsurfaceStrength?: number;
  subsurfaceTint?: [number, number, number];
  mask?: TerrainMaterialMask | null;
}

export interface TerrainWetnessLayerInput {
  enabled?: boolean;
  strength?: number;
  slopeInfluence?: number;
  subsurfaceStrength?: number;
  subsurfaceTint?: [number, number, number];
  mask?: TerrainMaterialMask | null;
}

export interface TerrainMaterialNoiseInput {
  macroScale?: number;
  detailScale?: number;
  octaves?: number;
  snowMacroAmplitude?: number;
  snowDetailAmplitude?: number;
  rockMacroAmplitude?: number;
  rockDetailAmplitude?: number;
  wetnessMacroAmplitude?: number;
  wetnessDetailAmplitude?: number;
}

export interface TerrainMaterialLayersInput {
  snow?: TerrainSnowLayerInput;
  rock?: TerrainRockLayerInput;
  wetness?: TerrainWetnessLayerInput;
  variation?: TerrainMaterialNoiseInput;
}

export interface TerrainDetailInput {
  enabled?: boolean;
  scale?: number;
  normalStrength?: number;
  albedoNoise?: number;
  fadeStart?: number;
  fadeEnd?: number;
  sigmaPx?: number;
  /** Blend strength of `normalMap` (0 disables it). */
  strength?: number;
  normalMap?: TerrainMaterialImage | null;
}

export interface TerrainSpecularAaInput {
  quality?: TerrainSpecularAaQuality;
  sigmaScale?: number;
}

/**
 * Terrain PBR/POM material (native `TerrainRenderParams` material fields).
 * Every field is optional; omitted fields take the native defaults, and the
 * all-default material reproduces the unmaterialed terrain image.
 */
export interface TerrainMaterialInput {
  albedoMode?: TerrainAlbedoMode;
  colormapStrength?: number;
  gamma?: number;
  colormapSrgb?: boolean;
  outputSrgbEotf?: boolean;
  lambertContrast?: number;
  roughnessMultiplier?: number;
  hueVariation?: number;
  /** 1-4 layers; defaults to the native rock/grass/dirt/snow set. */
  materialSet?: TerrainMaterialLayerInput[];
  triplanar?: TerrainTriplanarInput;
  pom?: TerrainPomInput;
  lod?: TerrainLodInput;
  sampling?: TerrainSamplingInput;
  clamp?: TerrainClampInput;
  heightCurve?: TerrainHeightCurveInput;
  layers?: TerrainMaterialLayersInput;
  detail?: TerrainDetailInput;
  specularAa?: TerrainSpecularAaInput;
  debugView?: TerrainMaterialDebugView;
}

export interface TerrainMaterialLayerSnapshot {
  baseColor: [number, number, number];
  roughness: number;
  metallic: number;
  texture: TerrainMaterialImage | null;
}

/** Fully resolved, validated terrain material. */
export interface TerrainMaterialSnapshot {
  albedoMode: TerrainAlbedoMode;
  colormapStrength: number;
  gamma: number;
  colormapSrgb: boolean;
  outputSrgbEotf: boolean;
  lambertContrast: number;
  roughnessMultiplier: number;
  hueVariation: number;
  materialSet: TerrainMaterialLayerSnapshot[];
  triplanar: Required<TerrainTriplanarInput>;
  pom: Required<TerrainPomInput>;
  lod: Required<TerrainLodInput>;
  sampling: Required<TerrainSamplingInput>;
  clamp: {
    heightRange: [number, number] | null;
    slopeRange: [number, number];
    ambientRange: [number, number];
    shadowRange: [number, number];
    occlusionRange: [number, number];
  };
  heightCurve: {
    mode: TerrainHeightCurveMode;
    strength: number;
    power: number;
    lut: Float32Array | null;
  };
  layers: {
    snow: Required<Omit<TerrainSnowLayerInput, "mask">> & {
      mask: TerrainMaterialMask | null;
    };
    rock: Required<Omit<TerrainRockLayerInput, "mask">> & {
      mask: TerrainMaterialMask | null;
    };
    wetness: Required<Omit<TerrainWetnessLayerInput, "mask">> & {
      mask: TerrainMaterialMask | null;
    };
    variation: Required<TerrainMaterialNoiseInput>;
  };
  detail: Required<Omit<TerrainDetailInput, "normalMap">> & {
    normalMap: TerrainMaterialImage | null;
  };
  specularAa: Required<TerrainSpecularAaInput>;
  debugView: TerrainMaterialDebugView;
}

export type TerrainMaterialDiagnosticCode =
  | "terrain-material-texture-invalid"
  | "terrain-material-texture-resampled"
  | "terrain-material-texture-downscaled"
  | "terrain-material-texture-missing"
  | "terrain-material-detail-normal-invalid"
  | "terrain-material-detail-normal-missing"
  | "terrain-material-mask-invalid"
  | "terrain-material-aux-downscaled"
  | "terrain-material-pom-mode-approximated";

export interface TerrainMaterialDiagnostic {
  code: TerrainMaterialDiagnosticCode;
  message: string;
  layer?: number;
}

/** What the runtime actually bound for the committed terrain material. */
export interface TerrainMaterialReport {
  enabled: boolean;
  layerCount: number;
  texturedLayers: boolean[];
  textureWidth: number;
  textureHeight: number;
  mipLevels: number;
  maskChannels: ("snow" | "rock" | "wetness")[];
  detailNormalMap: boolean;
  gpuBytes: number;
  diagnostics: TerrainMaterialDiagnostic[];
}

export interface TerrainStatistics {
  min: number;
  max: number;
  mean: number;
  std: number;
  median: number;
  p01: number;
  p99: number;
  count: number;
  nodataCount: number;
}

export interface HeightAoOptions {
  enabled?: boolean;
  resolutionScale?: number;
  directions?: number;
  steps?: number;
  maxDistance?: number;
  strength?: number;
}

export interface SunVisibilityOptions {
  enabled?: boolean;
  mode?: "hard" | "soft";
  resolutionScale?: number;
  samples?: number;
  steps?: number;
  maxDistance?: number;
  softness?: number;
  bias?: number;
  direction?: [number, number, number];
}

export interface TerrainDatasetInput {
  width: number;
  height: number;
  heights: Float32Array;
  spacing?: [number, number];
  exaggeration?: number;
  domain?: [number, number];
  nodata?: number;
  crs?: string;
  transform?: [number, number, number, number, number, number];
  bounds?: [number, number, number, number];
  colormap?: TerrainColormapInput;
  renderMode?: TerrainRenderMode;
}

export interface TerrainDatasetSourceInput
  extends Omit<TerrainDatasetInput, "heights"> {
  source: TerrainByteSource;
  signal?: AbortSignal;
  onProgress?: (progress: TerrainSourceProgress) => void;
  maxBytes?: number;
}

export interface TerrainDatasetLoadOptions {
  workerPool?: import("./browser-resources.js").Forge3DWorkerPool;
}

export interface TerrainNormalizationOptions {
  domain?: [number, number];
  targetDomain?: [number, number];
  clip?: boolean;
}

export interface TerrainSlopeAspectResult {
  width: number;
  height: number;
  slopeRadians: Float32Array;
  aspectRadians: Float32Array;
}

export interface TerrainContourPolyline {
  level: number;
  points: Float32Array;
}

export interface TerrainContourResult {
  polylines: TerrainContourPolyline[];
  polylineCount: number;
  totalPoints: number;
}

export interface TerrainQueryResult {
  elevation: number;
  slopeRadians: number;
  aspectRadians: number;
  worldPosition: [number, number, number];
  normal: [number, number, number];
  gridPosition: [number, number];
}

export interface TerrainScalarField {
  kind: "height-ao" | "sun-visibility";
  width: number;
  height: number;
  values: Float32Array;
}

export type TerrainComputeRequest =
  | { kind: "slope-aspect" }
  | { kind: "height-ao"; options?: HeightAoOptions }
  | { kind: "sun-visibility"; options?: SunVisibilityOptions };

export type TerrainComputeResult =
  | TerrainSlopeAspectResult
  | TerrainScalarField;

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
  colorRamp?: TerrainColorRampInput;
  colormap?: TerrainColormapInput;
  spacing?: [number, number];
  exaggeration?: number;
  domain?: [number, number];
  nodata?: number;
  crs?: string;
  heightAo?: HeightAoOptions;
  sunVisibility?: SunVisibilityOptions;
  debugView?: TerrainDebugView;
  renderMode?: TerrainRenderMode;
  /** Terrain PBR/POM material; omitted keeps the unmaterialed terrain. */
  material?: TerrainMaterialInput;
}

export interface CameraInput {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fovYDegrees: number;
  near: number;
  far: number;
  /** Projection model; defaults to `"perspective"`. */
  projection?: CameraProjectionKind;
  /** Vertical world extent of an orthographic camera (required for it). */
  orthographicHeight?: number;
}

export type Vec3 = [number, number, number];
export type CameraProjectionKind = "perspective" | "orthographic";
export type ClipSpace = "wgpu" | "gl";

export interface CameraOptions {
  position: Vec3;
  target: Vec3;
  up?: Vec3;
  fovYDegrees?: number;
  near?: number;
  far?: number;
  projection?: CameraProjectionKind;
  orthographicHeight?: number;
}

export interface CameraJSON extends CameraOptions {
  kind: "forge3d.camera";
  version: 1;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ScreenPoint {
  /** Pixels from the left edge. */
  x: number;
  /** Pixels from the top edge. */
  y: number;
  /** WebGPU NDC depth: 0 at the near plane, 1 at the far plane. */
  depth: number;
}

export interface ScreenRay {
  origin: Vec3;
  direction: Vec3;
}

export interface CameraDofParamsInput {
  aperture: number;
  focusDistance: number;
  focalLength: number;
  autoFocus?: boolean;
  autoFocusSpeed?: number;
}

export interface CameraDofParams {
  aperture: number;
  focusDistance: number;
  focalLength: number;
  autoFocus: boolean;
  autoFocusSpeed: number;
}

export interface DepthOfFieldRange {
  near: number;
  far: number;
}

export interface PathTracingCameraInput {
  origin: Vec3;
  lookAt: Vec3;
  up: Vec3;
  fovY: number;
  aspect: number;
  exposure: number;
}

export type PathTracingCamera = PathTracingCameraInput;

export interface CameraKeyframeInput {
  time: number;
  phiDeg: number;
  thetaDeg: number;
  radius: number;
  fovDeg: number;
  target?: Vec3 | null;
}

export interface CameraKeyframeJSON {
  time: number;
  phiDeg: number;
  thetaDeg: number;
  radius: number;
  fovDeg: number;
  target: Vec3 | null;
}

export interface CameraState {
  phiDeg: number;
  thetaDeg: number;
  radius: number;
  fovDeg: number;
  target: Vec3 | null;
}

export interface CameraAnimationSample {
  frame: number;
  time: number;
  state: CameraState;
}

export interface CameraAnimationJSON {
  kind: "forge3d.camera-animation";
  version: 1;
  keyframes: CameraKeyframeJSON[];
}

export interface CameraStateCameraOptions {
  fallbackTarget?: Vec3;
  up?: Vec3;
  near?: number;
  far?: number;
  projection?: CameraProjectionKind;
  orthographicHeight?: number;
}

export interface RenderConfigOptions {
  outputDir?: string;
  fps?: number;
  width?: number;
  height?: number;
  filenamePrefix?: string;
  frameDigits?: number;
}

/** W06 capture AOVs (native `AovSettings` plus ID and motion). */
export type AovName = "albedo" | "normal" | "depth" | "id" | "motion";

/** Native offline tonemap operators plus the realtime `display` encode. */
export type TonemapOperatorName =
  | "display"
  | "reinhard"
  | "reinhard-extended"
  | "aces"
  | "uncharted2"
  | "exposure"
  | "filmic-terrain";

export interface TonemapOptions {
  operator?: TonemapOperatorName;
  whitePoint?: number;
}

export interface HdrTonemapOptions extends TonemapOptions {
  /** Per-pixel display encode for `display`: 0 linear, 1 sRGB, 2 screen filmic. */
  displayEncode?: Uint8Array;
}

export type DenoiseMethod = "atrous" | "oidn" | "none";

export interface DenoiseGuides {
  albedo?: boolean;
  normal?: boolean;
  depth?: boolean;
}

export interface DenoiseSettingsInput {
  enabled?: boolean;
  method?: DenoiseMethod;
  iterations?: number;
  sigmaColor?: number;
  sigmaAlbedo?: number;
  sigmaNormal?: number;
  sigmaDepth?: number;
  edgeStopping?: number;
  guides?: DenoiseGuides;
}

export interface OfflineQualitySettingsInput {
  enabled?: boolean;
  adaptive?: boolean;
  targetVariance?: number;
  maxSamples?: number;
  minSamples?: number;
  batchSize?: number;
  tileSize?: number;
  convergenceRatio?: number;
}

export interface OfflineAccumulationOptions {
  /** Jitter sequence length (native `jitter_sequence_samples`). */
  samples?: number;
  seed?: number | null;
  aovs?: readonly AovName[] | "all";
  /** Camera of the previous frame for motion vectors (default: current). */
  previousCamera?: CameraInput;
}

export interface OfflineBatchResult {
  totalSamples: number;
  batchTimeMs: number;
}

export interface OfflineMetrics {
  totalSamples: number;
  meanDelta: number;
  p95Delta: number;
  maxTileDelta: number;
  convergedTileRatio: number;
}

export interface OfflineResolveOptions {
  tonemap?: TonemapOptions;
  denoise?: DenoiseSettingsInput | import("./offline.js").DenoiseSettings | null;
}

export interface CaptureOptions extends OfflineAccumulationOptions, OfflineResolveOptions {
  signal?: AbortSignal;
}

export interface CaptureResult {
  frame: import("./frames.js").Frame;
  hdrFrame: import("./frames.js").HdrFrame;
  aovFrame: import("./frames.js").AovFrame;
}

export interface OfflineRenderOptions {
  settings?: import("./offline.js").OfflineQualitySettings | OfflineQualitySettingsInput;
  /** Target samples when not adaptive (native `aa_samples`). */
  samples?: number;
  seed?: number | null;
  aovs?: readonly AovName[] | "all";
  denoise?: import("./offline.js").DenoiseSettings | DenoiseSettingsInput | null;
  tonemap?: TonemapOptions;
  previousCamera?: CameraInput;
  onProgress?: (progress: import("./offline.js").OfflineProgress) => void;
  signal?: AbortSignal;
}

export interface OfflineRenderMetadata {
  samplesUsed: number;
  denoiserUsed: "none" | "atrous";
  denoiserRequested: DenoiseMethod;
  denoiseGuides: string[];
  finalP95Delta: number | null;
  convergedRatio: number | null;
  targetSamples: number;
  adaptive: boolean;
  tonemapOperator: TonemapOperatorName;
  elapsedMs: number;
  warnings: string[];
}

export interface OfflineResult extends CaptureResult {
  metadata: OfflineRenderMetadata;
}

export type ExrCompression = "none" | "rle" | "zip" | "zips" | "piz";

export interface ExrChannelInput {
  name: string;
  data: Float32Array | Uint32Array;
  quantizeLinearly?: boolean;
}

export interface ExrChannel {
  name: string;
  type: "f32" | "u32" | "f16";
  data: Float32Array | Uint32Array;
}

export interface ExrImage {
  width: number;
  height: number;
  channels: ExrChannel[];
  metadata: Record<string, string>;
  software: string | null;
  compression: string;
}

export interface ExrWriteOptions {
  prefix?: string;
  compression?: ExrCompression;
  metadata?: Readonly<Record<string, string>>;
}

export interface ExrReadOptions {
  maxDimension?: number;
  maxPixels?: number;
}

export interface PngEncodeOptions {
  compression?: "deflate" | "none";
}

export interface HdrDenoiseInput extends DenoiseSettingsInput {
  width: number;
  height: number;
  color: Float32Array;
  albedo?: Float32Array;
  normal?: Float32Array;
  depth?: Float32Array;
}

export interface ImageCompareOptions {
  width: number;
  height: number;
  /** Interleaved lanes per pixel in both images. */
  channels: number;
  /** Leading lanes that enter the metrics (default: all). */
  compareChannels?: number;
  /** SSIM dynamic range (default 1). */
  dataRange?: number;
}

export interface ImageComparison {
  mse: number;
  psnr: number;
  ssim: number;
  maxAbs: number;
}

export interface RenderedFrame {
  index: number;
  time: number;
  timestampUs: number;
  durationUs: number;
  camera?: CameraInput;
  frame: import("./frames.js").Frame;
  hdrFrame?: import("./frames.js").HdrFrame;
  aovFrame?: import("./frames.js").AovFrame;
}

export type FrameSequenceMode = "capture" | "display" | "offline";

export interface FrameSequenceOptions {
  animation?: import("./camera-animation.js").CameraAnimation;
  cameraAt?: (time: number, index: number) => CameraInput;
  cameraOptions?: CameraStateCameraOptions;
  frameCount?: number;
  fps?: number;
  config?: import("./camera-animation.js").RenderConfig;
  startFrame?: number;
  endFrame?: number;
  mode?: FrameSequenceMode;
  capture?: CaptureOptions;
  offline?: Omit<OfflineRenderOptions, "onProgress" | "previousCamera" | "signal">;
  onProgress?: (progress: import("./camera-animation.js").RenderProgress) => void;
  signal?: AbortSignal;
}

export type FrameSinkFormat = "png" | "exr";

export interface FrameSink {
  write(frame: RenderedFrame, name?: string): Promise<string>;
  close?(): void | Promise<void>;
  abort?(reason: unknown): void | Promise<void>;
}

export interface FrameWriteSummary {
  frames: number;
  names: string[];
  timestampsUs: number[];
}

export type VideoCodecName = "avc" | "hevc" | "vp9" | "av1" | "vp8";
export type VideoContainer = "mp4" | "webm";

export interface VideoCodecProbeOptions {
  width: number;
  height: number;
  fps: number;
  container?: VideoContainer;
  codec?: VideoCodecName | readonly VideoCodecName[];
  bitrate?: number;
}

export interface VideoCodecSupport {
  codec: VideoCodecName;
  codecString: string;
  container: VideoContainer;
  supported: boolean;
  reason?: "webcodecs-unavailable" | "unsupported-config";
}

export interface VideoCodecUnavailableDetails {
  kind: "video-codec-unavailable";
  container: VideoContainer;
  requested: VideoCodecName[];
  probes: VideoCodecSupport[];
  webCodecs: boolean;
}

export interface VideoEncodeOptions {
  fps: number;
  container?: VideoContainer;
  codec?: VideoCodecName | readonly VideoCodecName[];
  bitrate?: number;
  keyFrameInterval?: number;
  creationTime?: Date | number;
  signal?: AbortSignal;
  onProgress?: (framesEncoded: number) => void;
}

export interface EncodedVideoChunkInput {
  data: Uint8Array;
  type: "key" | "delta";
  timestampUs: number;
  durationUs: number;
}

export interface MuxVideoOptions {
  codec: VideoCodecName;
  codecString?: string;
  container?: VideoContainer;
  width: number;
  height: number;
  fps: number;
  decoderConfig?: VideoDecoderConfig;
  creationTime?: Date | number;
}

export interface EncodedVideoResult {
  blob: Blob;
  mimeType: string;
  container: VideoContainer;
  codec: VideoCodecName;
  codecString: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  timestampsUs: number[];
  durationUs: number;
  keyFrames: number;
}

export interface FlyView {
  position: Vec3;
  yawDegrees: number;
  pitchDegrees: number;
  fovYDegrees: number;
  near: number;
  far: number;
}

export interface FlyControlsOptions {
  /** World units per second at unit input (native default 5). */
  moveSpeed?: number;
  /** Movement multiplier while a boost key is held (native default 2). */
  boostMultiplier?: number;
  /** Look sensitivity in degrees per CSS pixel. */
  lookSpeed?: number;
  minPitchDegrees?: number;
  maxPitchDegrees?: number;
}

export interface FlyInputState {
  forward?: boolean;
  backward?: boolean;
  left?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
  boost?: boolean;
}

export type CameraControllerMode = "orbit" | "fly";

export type CameraKeyAction =
  | "forward"
  | "backward"
  | "left"
  | "right"
  | "up"
  | "down"
  | "boost"
  | "toggleMode"
  | "reset";

/** `KeyboardEvent.code` values per action. */
export type CameraKeyBindings = Partial<Record<CameraKeyAction, readonly string[]>>;

export interface CameraControllerOptions {
  mode?: CameraControllerMode;
  orbit?: OrbitView;
  orbitOptions?: OrbitControlsOptions;
  fly?: FlyView;
  flyOptions?: FlyControlsOptions;
  bindings?: CameraKeyBindings;
}

export interface CameraControllerState {
  mode: CameraControllerMode;
  orbit: OrbitView;
  fly: FlyView;
}

export type CameraInputEvent =
  | { type: "orbit"; deltaYawDegrees: number; deltaPitchDegrees: number }
  | { type: "pan"; deltaX: number; deltaY: number; viewportHeight: number }
  | { type: "zoom"; delta: number }
  | { type: "look"; deltaYawDegrees: number; deltaPitchDegrees: number }
  | { type: "move"; forward: number; right: number; up: number }
  | { type: "key"; code: string; pressed: boolean }
  | { type: "tick"; deltaSeconds: number }
  | { type: "mode"; mode: CameraControllerMode }
  | { type: "reset" }
  | { type: "releaseKeys" };

export interface TerrainRigSourceInput {
  heights: Float32Array | readonly number[];
  width: number;
  height: number;
  zScale?: number;
  terrainWidth?: number;
}

export interface TerrainClearanceOptions {
  minimumHeight?: number;
  maxRefinePasses?: number;
}

export interface TerrainRigBakeOptions {
  samplesPerSecond?: number;
}

export interface TerrainOrbitRigOptions {
  targetXZ: [number, number];
  duration: number;
  radius: number;
  phiStartDeg: number;
  phiEndDeg: number;
  thetaStartDeg?: number;
  thetaEndDeg?: number;
  radiusEnd?: number;
  fovStartDeg?: number;
  fovEndDeg?: number;
  targetHeightOffset?: number;
  clearance?: TerrainClearanceOptions;
}

export interface TerrainRailRigOptions {
  pathXZ: [number, number][];
  duration: number;
  cameraHeightOffset: number;
  lookAheadDistance: number;
  lateralOffset?: number;
  targetHeightOffset?: number;
  fovDeg?: number;
  clearance?: TerrainClearanceOptions;
}

export interface TerrainTargetFollowRigOptions {
  targetPathXZ: [number, number][];
  duration: number;
  radius: number;
  thetaDeg?: number;
  headingOffsetDeg?: number;
  targetHeightOffset?: number;
  fovDeg?: number;
  clearance?: TerrainClearanceOptions;
}

export type TerrainRigJSON =
  | { kind: "orbit"; version: 1; options: TerrainOrbitRigOptions }
  | { kind: "rail"; version: 1; options: TerrainRailRigOptions }
  | { kind: "follow"; version: 1; options: TerrainTargetFollowRigOptions };

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

export type LightId = number;
export type LightType = "directional" | "point" | "spot" | "rect";
export type SoftLightFalloff =
  | "inverse-square"
  | "linear"
  | "quadratic"
  | "cubic"
  | "exponential";
export type AreaLightApproximation = "ltc" | "sampled";
export type AreaLightSampleCount = 1 | 4 | 8 | 16;

export interface LightBaseInput {
  color: [number, number, number];
  intensity: number;
  enabled?: boolean;
  castsShadow?: boolean;
}
export interface DirectionalLightInput extends LightBaseInput {
  type: "directional";
  direction: [number, number, number];
}
export interface PointLightInput extends LightBaseInput {
  type: "point";
  position: [number, number, number];
  range: number;
  innerRadius?: number;
  edgeSoftness?: number;
  falloff?: SoftLightFalloff;
  falloffExponent?: number;
}
export interface SpotLightInput extends LightBaseInput {
  type: "spot";
  position: [number, number, number];
  direction: [number, number, number];
  range: number;
  innerConeDegrees: number;
  outerConeDegrees: number;
  innerRadius?: number;
  edgeSoftness?: number;
  falloff?: SoftLightFalloff;
  falloffExponent?: number;
}
export interface RectAreaLightInput extends LightBaseInput {
  type: "rect";
  position: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  width: number;
  height: number;
  range: number;
  edgeSoftness?: number;
  twoSided?: boolean;
}
export type LightInput =
  | DirectionalLightInput
  | PointLightInput
  | SpotLightInput
  | RectAreaLightInput;
export type LightSnapshot = LightInput & {
  id: LightId;
  enabled: boolean;
  castsShadow: boolean;
};
export type LightBounds =
  | { kind: "unbounded" }
  | { kind: "sphere"; center: [number, number, number]; radius: number };
export interface AreaLightApproximationConfig {
  mode: AreaLightApproximation;
  sampleCount: AreaLightSampleCount;
  lutSize: 64;
}
export interface LightingSnapshot {
  revision: number;
  maxLights: number;
  exposure: number;
  debugBounds: boolean;
  areaLights: AreaLightApproximationConfig;
  lights: LightSnapshot[];
}
export type LightPresetName =
  | "spotlight"
  | "area-light"
  | "ambient-light"
  | "candle"
  | "street-lamp";

export type LightSlotConfig = LightInput;

export type MaterialParameterValue =
  | number
  | boolean
  | string
  | [number, number, number, number];

export interface MaterialSlotConfig {
  id: string;
  model: string;
  parameters: Record<string, MaterialParameterValue>;
}

export type BrdfModel =
  | "lambert"
  | "phong"
  | "blinn-phong"
  | "oren-nayar"
  | "cooktorrance-ggx"
  | "cooktorrance-beckmann"
  | "disney-principled"
  | "ashikhmin-shirley"
  | "ward"
  | "toon"
  | "minnaert"
  | "subsurface"
  | "hair";
export type BrdfImplementation = "exact" | "alias" | "approximation";
export interface BrdfRoute {
  requested: string;
  model: BrdfModel;
  effectiveModel: BrdfModel;
  implementation: BrdfImplementation;
  diagnostic?: string;
}
export type TextureSemantic =
  | "base-color"
  | "normal"
  | "metallic-roughness"
  | "occlusion"
  | "emissive";
export type TextureColorSpace = "srgb" | "linear";
export type TextureFormat =
  | "rgba8unorm"
  | "rgba8unorm-srgb"
  | "bc1-rgba-unorm"
  | "bc1-rgba-unorm-srgb"
  | "bc3-rgba-unorm"
  | "bc3-rgba-unorm-srgb"
  | "bc7-rgba-unorm"
  | "bc7-rgba-unorm-srgb"
  | "etc2-rgba8unorm"
  | "etc2-rgba8unorm-srgb"
  | "astc-4x4-unorm"
  | "astc-4x4-unorm-srgb";
export type TextureWrapMode = "repeat" | "clamp-to-edge" | "mirror-repeat";
export type TextureFilter = "nearest" | "linear";
export type TextureEffectiveQuality =
  | "native"
  | "transcoded"
  | "rgba8-fallback";
export interface TextureSamplerConfig {
  wrapU?: TextureWrapMode;
  wrapV?: TextureWrapMode;
  magFilter?: TextureFilter;
  minFilter?: TextureFilter;
  mipmapFilter?: TextureFilter;
  maxAnisotropy?: 1 | 2 | 4 | 8 | 16;
}
export interface TextureLevelInput {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface TextureImageInput {
  width: number;
  height: number;
  format: TextureFormat;
  colorSpace: TextureColorSpace;
  data: Uint8Array;
  mipmaps?: TextureLevelInput[];
  generateMipmaps?: boolean;
  sourceFormat?: "raw" | "ktx2" | "basis";
  effectiveQuality?: TextureEffectiveQuality;
}
export interface TextureLevelSnapshot {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface TextureImageSnapshot {
  width: number;
  height: number;
  format: TextureFormat;
  colorSpace: TextureColorSpace;
  levels: TextureLevelSnapshot[];
  compressed: boolean;
  sourceFormat: "raw" | "ktx2" | "basis";
  effectiveQuality: TextureEffectiveQuality;
}
export interface TextureSetInput {
  baseColor?: TextureImageInput | TextureImageSnapshot;
  normal?: TextureImageInput | TextureImageSnapshot;
  metallicRoughness?: TextureImageInput | TextureImageSnapshot;
  occlusion?: TextureImageInput | TextureImageSnapshot;
  emissive?: TextureImageInput | TextureImageSnapshot;
  sampler?: TextureSamplerConfig;
}
export interface TextureSetSnapshot {
  baseColor?: TextureImageSnapshot;
  normal?: TextureImageSnapshot;
  metallicRoughness?: TextureImageSnapshot;
  occlusion?: TextureImageSnapshot;
  emissive?: TextureImageSnapshot;
  sampler: Required<TextureSamplerConfig>;
}
export interface TextureFormatCapabilities {
  bc: boolean;
  etc2: boolean;
  astc: boolean;
}
export interface Ktx2LoadOptions {
  semantic: TextureSemantic;
  capabilities: TextureFormatCapabilities;
  signal?: AbortSignal;
  maxBytes?: number;
}
export interface Ktx2TranscodeReport {
  sourceFormat: string;
  requestedFormat: string;
  effectiveFormat: TextureFormat | "unsupported";
  effectiveQuality: TextureEffectiveQuality | "unsupported";
  reason: string;
}
export interface BasisTranscoderAdapter {
  transcode(
    data: Uint8Array,
    target: TextureFormat,
    colorSpace: TextureColorSpace,
    signal?: AbortSignal,
  ): Promise<TextureImageSnapshot>;
}
export interface Ktx2LoaderOptions {
  basisTranscoder?: BasisTranscoderAdapter;
  basisJsUrl?: string | URL;
  basisWasmUrl?: string | URL;
}
export interface MeshTbnInput {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
}
export interface MeshTbnResult {
  tangents: Float32Array;
}
export interface GltfMaterialChannels {
  occlusion: Uint8Array;
  roughness: Uint8Array;
  metallic: Uint8Array;
}
export interface MaterialInput {
  id: string;
  brdf?: string;
  baseColor?: [number, number, number, number];
  metallic?: number;
  roughness?: number;
  sheen?: number;
  clearcoat?: number;
  subsurface?: number;
  anisotropy?: number;
  textures?: TextureSet | TextureSetInput;
}
export interface MaterialSnapshot {
  id: string;
  brdf: BrdfModel;
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  sheen: number;
  clearcoat: number;
  subsurface: number;
  anisotropy: number;
  route: BrdfRoute;
  textures: TextureSetSnapshot;
}
export interface MaterialSlotSnapshot {
  slot: string;
  index: number;
  material: MaterialSnapshot;
}
export interface MaterialCollectionSnapshot {
  revision: number;
  maxMaterials: number;
  materials: MaterialSlotSnapshot[];
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

export type ShadowFilter = "hard" | "pcf" | "pcss" | "vsm" | "evsm" | "msm";
export type ShadowTechnique = "none" | ShadowFilter;
export type ShadowDebugView = "none" | "cascades" | "shadow-factor";
export interface ShadowConfigInput {
  enabled?: boolean;
  filter?: string;
  mapSize?: number;
  depthBias?: number;
  normalBias?: number;
  slopeBias?: number;
  softness?: number;
  pcssBlockerRadius?: number;
  pcssFilterRadius?: number;
  lightSize?: number;
  momentBias?: number;
  lightBleedReduction?: number;
  evsmPositiveExponent?: number;
  evsmNegativeExponent?: number;
  peterPanningOffset?: number;
}
export interface ShadowConfigSnapshot {
  enabled: boolean;
  filter: ShadowFilter;
  mapSize: number;
  depthBias: number;
  normalBias: number;
  slopeBias: number;
  softness: number;
  pcssBlockerRadius: number;
  pcssFilterRadius: number;
  lightSize: number;
  momentBias: number;
  lightBleedReduction: number;
  evsmPositiveExponent: number;
  evsmNegativeExponent: number;
  peterPanningOffset: number;
}
export interface CascadedShadowConfigInput {
  enabled?: boolean;
  cascadeCount?: 2 | 3 | 4;
  maxDistance?: number;
  splitLambda?: number;
  blendRange?: number;
  stabilize?: boolean;
  debugView?: ShadowDebugView;
}
export interface CascadedShadowConfigSnapshot {
  enabled: boolean;
  cascadeCount: 2 | 3 | 4;
  maxDistance: number;
  splitLambda: number;
  blendRange: number;
  stabilize: boolean;
  debugView: ShadowDebugView;
}
export interface ShadowReport {
  requestedFilter: ShadowFilter;
  effectiveFilter: ShadowFilter;
  requestedMapSize: number;
  effectiveMapSize: number;
  csmEnabled: boolean;
  cascadeCount: number;
  momentFormat: "none" | "rgba32float";
  casterLightId: number | null;
  reason: string;
}
export interface ShadowSnapshot {
  config: ShadowConfigSnapshot;
  csm: CascadedShadowConfigSnapshot;
  report: ShadowReport;
}
export interface ShadowCascadeInfo {
  near: number;
  far: number;
  texelSize: number;
}

export interface SceneSnapshot {
  revision: number;
  nodes: SceneNodeSnapshot[];
  passes: ScenePassInput[];
  lighting: LightingSnapshot;
  materials: MaterialCollectionSnapshot;
  ibl: IblSnapshot | null;
  shadows: ShadowSnapshot;
}

export type IblQuality = "low" | "medium" | "high" | "ultra";
export type IblCacheBackend = "auto" | "cache-storage" | "opfs" | "none";
export interface RgbeImage {
  width: number;
  height: number;
  data: Float32Array;
}
/**
 * Specular prefilter schedule. `per-mip` (default) filters every mip at its
 * own roughness. `native` reproduces a native renderer bug for oracle
 * comparisons: every prefilter pass reads the last mip's parameters, so each
 * mip only receives a small corner of the roughest lobe and the rest is zero.
 */
export type IblPrefilterMode = "native" | "per-mip";
export interface IblOptions {
  quality?: IblQuality;
  intensity?: number;
  rotationDegrees?: number;
  prefilter?: IblPrefilterMode;
}
export interface IblSourceSnapshot {
  width: number;
  height: number;
  data: Float32Array;
  sourceHash: string;
}
export interface IblPrecomputedSnapshot {
  format: "rgba16float";
  irradianceSize: number;
  specularSize: number;
  specularMipCount: number;
  brdfLutSize: number;
  irradiance: Uint8Array;
  specular: Uint8Array;
  brdfLut: Uint8Array;
}
export interface IblReport {
  requestedQuality: IblQuality;
  effectiveQuality: IblQuality;
  cacheBackend: IblCacheBackend;
  cacheHit: boolean;
  effectiveMode: "disabled" | "runtime-precompute" | "prepared-upload";
  brdfApproximation: "split-sum-ggx";
  reason: string;
}
export interface IblSnapshot {
  source: IblSourceSnapshot;
  intensity: number;
  rotationDegrees: number;
  requestedQuality: IblQuality;
  effectiveQuality: IblQuality;
  /** Defaults to `per-mip` when absent. */
  prefilter?: IblPrefilterMode;
  prepared?: IblPrecomputedSnapshot;
  report: IblReport;
}
export interface IblCacheOptions {
  backend?: IblCacheBackend;
  namespace?: string;
}
export interface IblPrecomputeTarget {
  precomputeIbl(input: IblSnapshot): Promise<IblSnapshot>;
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
  setLighting?(lighting: LightingSnapshot): void;
  setMaterials?(materials: MaterialCollectionSnapshot): void;
  setIbl?(ibl: IblSnapshot | null): void;
  precomputeIbl?(input: IblSnapshot): Promise<IblSnapshot>;
  setShadows?(shadows: ShadowSnapshot): void;
  getShadowReport?(): ShadowReport;
  getTerrainMaterialReport?(): TerrainMaterialReport;
  setCamera(camera: CameraInput): void;
  resize(size: ResizeInput): void;
  render(): boolean;
  screenshot(): Promise<Blob>;
  readRgba?(): Promise<Uint8Array>;
  readTerrainHeights?(): Promise<Float32Array>;
  computeTerrainAnalysis?(
    terrain: TerrainHeightmapInput,
    request: TerrainComputeRequest,
  ): Promise<TerrainComputeResult>;
  readTerrainAnalysis?(
    kind: "height-ao" | "sun-visibility",
  ): Promise<TerrainScalarField>;
  getMemoryReport?(): MemoryReport;
  getRenderStats?(): RenderStats;
  beginOffline?(options: unknown): void;
  accumulateBatch?(sampleCount: number): Promise<OfflineBatchResult>;
  readAccumulationMetrics?(targetVariance: number, tileSize: number): Promise<OfflineMetrics>;
  resolveOffline?(options: unknown): Promise<unknown>;
  endOffline?(): boolean;
  readonly offlineActive?: boolean;
  denoiseHdr?(input: unknown): Promise<Float32Array>;
  dispose(): void;
}

interface WasmRuntimeConstructor {
  create(canvas: HTMLCanvasElement, options: unknown): Promise<WasmRuntime>;
  createOffscreen?(
    canvas: OffscreenCanvas,
    options: unknown,
  ): Promise<WasmRuntime>;
}

interface WasmBridge extends Partial<OfflineWasmExports> {
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
  #readbackPromise: Promise<unknown> | undefined;
  #pendingMutations: Array<() => void> = [];
  #offlineActive = false;
  #deviceLossError: Forge3DError | undefined;

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
      this.#deviceLossError = deviceLoss;
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
    if (this.#captureInFlight() || this.#offlineActive) {
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
    this.#assertNoOffline();
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
    this.#assertNoOffline();
    const readRgba = this.#inner.readRgba;
    if (readRgba === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support readback",
      );
    }
    if (this.#readbackPromise !== undefined) {
      return this.#readbackPromise as Promise<Uint8Array>;
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

  setLighting(lighting: LightingSnapshot): void {
    this.#assertNotDisposed();
    if (this.#inner.setLighting === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support lighting",
      );
    }
    this.#runOrQueue(() => this.#inner.setLighting?.(lighting));
  }

  setMaterials(materials: MaterialCollectionSnapshot): void {
    this.#assertNotDisposed();
    if (this.#inner.setMaterials === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support materials",
      );
    }
    this.#runOrQueue(() => this.#inner.setMaterials?.(materials));
  }

  setIbl(ibl: IblSnapshot | null): void {
    this.#assertNotDisposed();
    if (this.#inner.setIbl === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support IBL",
      );
    }
    this.#runOrQueue(() => this.#inner.setIbl?.(ibl));
  }

  async precomputeIbl(input: IblSnapshot): Promise<IblSnapshot> {
    this.#assertNotDisposed();
    if (this.#inner.precomputeIbl === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support IBL precomputation",
      );
    }
    const precompute = this.#inner.precomputeIbl;
    return this.#exclusiveReadback(() => precompute.call(this.#inner, input));
  }

  setShadows(shadows: ShadowSnapshot): void {
    this.#assertNotDisposed();
    if (this.#inner.setShadows === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support shadows",
      );
    }
    this.#runOrQueue(() => this.#inner.setShadows?.(shadows));
  }

  getShadowReport(): ShadowReport {
    this.#assertNotDisposed();
    if (this.#inner.getShadowReport === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not report shadow state",
      );
    }
    return this.#inner.getShadowReport.call(this.#inner);
  }

  /** What the runtime bound for the committed terrain material. */
  getTerrainMaterialReport(): TerrainMaterialReport {
    this.#assertNotDisposed();
    if (this.#inner.getTerrainMaterialReport === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not report terrain material state",
      );
    }
    return this.#inner.getTerrainMaterialReport.call(this.#inner);
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
      // The material never passes through the byte-source decoder; it is
      // reattached to the decoded heightmap.
      const { material, ...source } =
        normalizeTerrainHeightmapSourceInput(terrain);
      const decoded = await this.#loadTerrainHeightmapSource(
        source,
        this.#lastCapabilities.maxTextureDimension2D,
        this.#lastCapabilities.maxBufferSize,
      );
      if (material !== undefined) {
        decoded.material = material;
      }
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

  async readTerrainHeights(): Promise<Float32Array> {
    this.#assertNotDisposed();
    const readTerrainHeights = this.#inner.readTerrainHeights;
    if (readTerrainHeights === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support terrain height readback",
      );
    }
    const values = await this.#exclusiveReadback(() =>
      readTerrainHeights.call(this.#inner),
    );
    return new Float32Array(values);
  }

  async computeTerrainAnalysis(
    terrain: TerrainDataset | TerrainHeightmapInput,
    request: TerrainComputeRequest,
  ): Promise<TerrainComputeResult> {
    this.#assertNotDisposed();
    const computeTerrainAnalysis = this.#inner.computeTerrainAnalysis;
    if (computeTerrainAnalysis === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support terrain analysis",
      );
    }
    const normalized =
      terrain instanceof TerrainDataset
        ? terrain.toTerrainInput()
        : normalizeTerrainHeightmapInput(terrain);
    return this.#exclusiveReadback(() =>
      computeTerrainAnalysis.call(this.#inner, normalized, request),
    );
  }

  async readTerrainAnalysis(
    kind: "height-ao" | "sun-visibility",
  ): Promise<TerrainScalarField> {
    this.#assertNotDisposed();
    const readTerrainAnalysis = this.#inner.readTerrainAnalysis;
    if (readTerrainAnalysis === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support terrain analysis readback",
      );
    }
    return this.#exclusiveReadback(() =>
      readTerrainAnalysis.call(this.#inner, kind),
    );
  }

  /** Whether an offline accumulation session is open. */
  get offlineActive(): boolean {
    return this.#offlineActive;
  }

  /**
   * Opens an offline accumulation session for the committed scene and
   * camera (native `begin_offline_accumulation`). Display frames are skipped
   * and scene/camera mutations queue until `endOfflineAccumulation`.
   */
  beginOfflineAccumulation(options: OfflineAccumulationOptions = {}): void {
    this.#assertNotDisposed();
    const begin = this.#inner.beginOffline;
    if (begin === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support offline capture",
      );
    }
    if (this.#offlineActive) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "An offline accumulation session is already active.",
      );
    }
    if (this.#captureInFlight()) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "Cannot begin offline accumulation while a readback is in flight",
      );
    }
    const native = nativeBeginOptions({
      ...options,
      ...(options.previousCamera === undefined
        ? {}
        : { previousCamera: normalizeCameraInput(options.previousCamera) }),
    });
    try {
      begin.call(this.#inner, native);
    } catch (error) {
      throw Forge3DError.from(error);
    }
    this.#offlineActive = true;
  }

  async accumulateBatch(sampleCount: number): Promise<OfflineBatchResult> {
    const accumulate = this.#requireOffline(this.#inner.accumulateBatch);
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 256) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "sampleCount must be an integer in [1, 256]",
      );
    }
    return this.#offlineReadback(() => accumulate.call(this.#inner, sampleCount));
  }

  async readAccumulationMetrics(
    targetVariance: number,
    tileSize = 16,
  ): Promise<OfflineMetrics> {
    const read = this.#requireOffline(this.#inner.readAccumulationMetrics);
    if (!Number.isFinite(targetVariance)) {
      throw new Forge3DError("INVALID_INPUT", "targetVariance must be finite");
    }
    if (!Number.isSafeInteger(tileSize) || tileSize < 1) {
      throw new Forge3DError("INVALID_INPUT", "tileSize must be >= 1");
    }
    return this.#offlineReadback(() =>
      read.call(this.#inner, targetVariance, tileSize),
    );
  }

  /** Resolves the accumulation to HDR, AOVs and a tonemapped frame. */
  async resolveOfflineHdr(
    options: OfflineResolveOptions = {},
  ): Promise<CaptureResult> {
    const resolve = this.#requireOffline(this.#inner.resolveOffline);
    const native = nativeResolveOptions(options);
    const raw = await this.#offlineReadback(() =>
      resolve.call(this.#inner, native),
    );
    return captureResultFromNative(raw);
  }

  /** Ends the session; returns whether one was open. Idempotent. */
  endOfflineAccumulation(): boolean {
    const wasActive = this.#offlineActive;
    this.#offlineActive = false;
    if (!this.#nativeDisposed) {
      try {
        this.#inner.endOffline?.call(this.#inner);
      } catch (error) {
        reportUnhandledRuntimeError(Forge3DError.from(error));
      }
    }
    if (wasActive && !this.#captureInFlight() && !this.#disposeRequested) {
      this.#flushPendingMutations();
    }
    return wasActive;
  }

  /** One-sample (or `samples`) HDR/AOV capture of the committed scene. */
  capture(options: CaptureOptions = {}): Promise<CaptureResult> {
    return captureOnce(this, options);
  }

  /** Native `render_offline` on this runtime. */
  renderOffline(options: OfflineRenderOptions = {}): Promise<OfflineResult> {
    return renderOfflineTarget(this, options);
  }

  /** WebGPU A-trous denoise of an HDR frame guided by its AOVs. */
  async denoiseHdrFrame(
    frame: HdrFrame,
    aov?: AovFrame,
    settings: DenoiseSettingsInput = {},
  ): Promise<HdrFrame> {
    this.#assertNotDisposed();
    const denoise = this.#inner.denoiseHdr;
    if (denoise === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support GPU denoising",
      );
    }
    if (!(frame instanceof HdrFrame)) {
      throw new Forge3DError("INVALID_INPUT", "frame must be an HdrFrame");
    }
    if (aov !== undefined && (aov.width !== frame.width || aov.height !== frame.height)) {
      throw new Forge3DError("INVALID_INPUT", "AOV frame size must match the HDR frame");
    }
    const resolved = DenoiseSettings.from({ ...settings, enabled: true });
    const input: Record<string, unknown> = {
      width: frame.width,
      height: frame.height,
      color: frame.data,
      ...resolved.toNative(),
    };
    if (aov?.hasAlbedo === true && resolved.guides.albedo) input.albedo = aov.albedo();
    if (aov?.hasNormal === true && resolved.guides.normal) input.normal = aov.normal();
    if (aov?.hasDepth === true && resolved.guides.depth) input.depth = aov.depth();
    const data = await this.#offlineReadback(() => denoise.call(this.#inner, input));
    return new HdrFrame(frame.width, frame.height, new Float32Array(data));
  }

  /** Readback that reports a device loss as DEVICE_LOST, not disposal. */
  #offlineReadback<T>(operation: () => Promise<T>): Promise<T> {
    return this.#exclusiveReadback(operation).catch((error: unknown) => {
      throw this.#deviceLossError ?? Forge3DError.from(error);
    });
  }

  #requireOffline<T>(method: T | undefined): T {
    this.#assertNotDisposed();
    if (method === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support offline capture",
      );
    }
    if (!this.#offlineActive) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "No offline accumulation session is active",
      );
    }
    return method;
  }

  #assertNoOffline(): void {
    if (this.#offlineActive) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "An offline accumulation session is active; end it before reading the display frame",
      );
    }
  }

  async #exclusiveReadback<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#readbackPromise !== undefined) {
      await this.#readbackPromise.catch(() => undefined);
      this.#assertNotDisposed();
    }
    if (this.#screenshotPromise !== undefined) {
      await this.#screenshotPromise.catch(() => undefined);
      this.#assertNotDisposed();
    }
    const result = operation().then(
      (value) => {
        this.#assertNotDisposed();
        return value;
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
    if (this.#captureInFlight() || this.#offlineActive) {
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
    if (!this.#offlineActive) {
      this.#flushPendingMutations();
    }
  }

  #flushPendingMutations(): void {
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

function normalizeTerrainColorRamp(
  terrain: TerrainHeightmapInput | TerrainHeightmapSourceInput,
): TerrainColorRampInput | undefined {
  if (terrain.colormap !== undefined && terrain.colorRamp !== undefined) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "terrain colormap and colorRamp cannot both be provided",
    );
  }
  const ramp =
    terrain.colorRamp ??
    (terrain.colormap === undefined
      ? undefined
      : typeof terrain.colormap === "string"
        ? getTerrainColormap(terrain.colormap)
        : terrain.colormap);
  if (ramp === undefined) {
    return undefined;
  }
  const stops = ramp.stops;
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 8) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "colorRamp.stops must contain between 2 and 8 stops",
    );
  }
  return {
    stops: stops.map((stop) => ({
      position: stop.position,
      color: [stop.color[0], stop.color[1], stop.color[2]],
    })),
  };
}

interface TerrainMetadataTarget {
  spacing?: [number, number];
  exaggeration?: number;
  domain?: [number, number];
  nodata?: number;
  crs?: string;
  heightAo?: HeightAoOptions;
  sunVisibility?: SunVisibilityOptions;
  debugView?: TerrainDebugView;
  renderMode?: TerrainRenderMode;
  /** Terrain PBR/POM material; omitted keeps the unmaterialed terrain. */
  material?: TerrainMaterialInput;
}

function copyTerrainMetadata(
  source: TerrainHeightmapInput | TerrainHeightmapSourceInput,
  target: TerrainMetadataTarget,
): void {
  if (source.spacing !== undefined) {
    target.spacing = [source.spacing[0], source.spacing[1]];
  }
  if (source.exaggeration !== undefined) {
    target.exaggeration = source.exaggeration;
  }
  if (source.domain !== undefined) {
    target.domain = [source.domain[0], source.domain[1]];
  }
  if (source.nodata !== undefined) {
    target.nodata = source.nodata;
  }
  if (source.crs !== undefined) {
    target.crs = source.crs;
  }
  if (source.heightAo !== undefined) {
    target.heightAo = { ...source.heightAo };
  }
  if (source.sunVisibility !== undefined) {
    const direction = source.sunVisibility.direction;
    target.sunVisibility =
      direction === undefined
        ? { ...source.sunVisibility }
        : {
            ...source.sunVisibility,
            direction: [direction[0], direction[1], direction[2]],
          };
  }
  if (source.debugView !== undefined) {
    target.debugView = source.debugView;
  }
  if (source.renderMode !== undefined) {
    if (source.renderMode !== "perspective" && source.renderMode !== "screen") {
      throw new Forge3DError(
        "INVALID_INPUT",
        "terrain renderMode must be 'perspective' or 'screen'",
      );
    }
    target.renderMode = source.renderMode;
  }
  if (source.material !== undefined) {
    target.material = normalizeTerrainMaterial(source.material);
  }
}

function normalizeTerrainHeightmapInput(
  terrain: TerrainHeightmapInput,
): TerrainHeightmapInput {
  const normalized: TerrainHeightmapInput = {
    width: terrain.width,
    height: terrain.height,
    heights: terrain.heights,
  };
  const colorRamp = normalizeTerrainColorRamp(terrain);
  if (colorRamp !== undefined) {
    normalized.colorRamp = colorRamp;
  }
  copyTerrainMetadata(terrain, normalized);
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
  const colorRamp = normalizeTerrainColorRamp(terrain);
  if (colorRamp !== undefined) {
    normalized.colorRamp = colorRamp;
  }
  copyTerrainMetadata(terrain, normalized);
  return normalized;
}

function normalizeCameraInput(camera: CameraInput): CameraInput {
  return cloneCameraInput(camera);
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
export {
  getLightPreset,
  LightCollection,
  lightPresetNames,
} from "./lighting.js";
export { MaterialCollection, resolveBrdfModel } from "./materials.js";
export {
  getTerrainMaterialDefaults,
  normalizeTerrainMaterial,
} from "./terrain-material.js";
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
export {
  TerrainDataset,
  createTerrainDatasetWorkerHandler,
  getTerrainColormap,
  getTerrainColormapLut,
} from "./terrain-dataset.js";
export {
  TextureSet,
  generateMeshTangents,
  extractGltfMaterialChannels,
  Ktx2Loader,
} from "./textures.js";
export { decodeRgbe, IblCache, ImageBasedLighting } from "./ibl.js";
export { CascadedShadowConfig, ShadowConfig } from "./shadows.js";
export {
  apertureToFStop,
  Camera,
  cameraDofParams,
  circleOfConfusion,
  composeTrs,
  depthOfFieldRange,
  fStopToAperture,
  hyperfocalDistance,
  invertMatrix,
  lookAt,
  lookAtTransform,
  makeCamera,
  mat4FromRows,
  mat4ToRows,
  multiplyMatrices,
  normalMatrix,
  orthographic,
  perspective,
  rotateX,
  rotateY,
  rotateZ,
  scale,
  scaleUniform,
  screenRay,
  screenToWorld,
  translate,
  viewProjection,
  worldToScreen,
} from "./camera.js";
export {
  CameraAnimation,
  CameraKeyframe,
  cameraStateEye,
  cameraStateToInput,
  cubicHermite,
  RenderConfig,
  RenderProgress,
} from "./camera-animation.js";
export {
  CameraController,
  cameraDirection,
  DEFAULT_CAMERA_KEY_BINDINGS,
  FlyController,
  replayCameraInput,
  yawPitchFromDirection,
} from "./camera-controllers.js";
export { OrbitController } from "./orbit-controller.js";
export {
  TERRAIN_CLEARANCE_TOLERANCE,
  TerrainClearance,
  TerrainOrbitRig,
  TerrainRailRig,
  TerrainRigSource,
  TerrainTargetFollowRig,
  terrainRigFromJSON,
  viewerOrbitRadius,
} from "./camera-rigs.js";
export { Forge3DWorkerRenderer, installForge3DWorkerHost } from "./worker-renderer.js";
export { Forge3DOffscreenRenderer } from "./offscreen-renderer.js";
export {
  createNotebookAdapter,
  defineForge3DElement,
} from "./display-adapters.js";
export {
  AOV_ID_BACKGROUND,
  AOV_ID_SCENE_NODE_BASE,
  AOV_ID_TERRAIN,
  AovFrame,
  aovObjectId,
  encodePng,
  EXR_MIME_TYPE,
  Frame,
  HdrFrame,
  readExr,
  writeExr,
} from "./frames.js";
export {
  atrousDenoise,
  compareImages,
  DenoiseSettings,
  hasUpwardConvergenceTrend,
  OfflineProgress,
  OfflineQualitySettings,
  renderOffline,
} from "./offline.js";
export {
  createDownloadFrameSink,
  createFrameStream,
  createMemoryFrameSink,
  createOpfsFrameSink,
  dumpFrameSequence,
  FrameDumper,
  frameTimestampUs,
  renderFrames,
  writeFrames,
} from "./frame-stream.js";
export { encodeVideo, muxEncodedVideo, probeVideoCodecs } from "./video.js";

registerOfflineWasmLoader(async () => {
  const record = getWasmBridgeCoordinator().record;
  const bridge = await (record !== undefined ? record.promise : loadWasmBridge());
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
});
