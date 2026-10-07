import type { VectorLayers } from "./vector-layers.js";
import type { VectorSnapshot, VectorReport, VectorPickMap, VectorPickRegion, VectorProjectionReport } from "./vector-types.js";
export { VectorLayers, VectorLayer } from "./vector-layers.js";
export { VectorPicker, pickVectorTerrain } from "./vector-picking.js";
export type { VectorPickTarget } from "./vector-picking.js";
export type * from "./vector-types.js";
import type { PostFxChain } from "./postfx.js";
import type { PostFxInput, PostFxChainInput, PostFxSnapshot, PostFxReport, PostFxFrame } from "./postfx-types.js";
export { PostFxChain, normalizePostFx, createIdentityColorLut } from "./postfx.js";
export type * from "./postfx-types.js";
import type { TerrainScatterBatch, ScatterBatchInput, ScatterBatchSnapshot, ScatterFrameStats, ScatterMemoryReport } from "./terrain-scatter.js";
import type { TerrainLightingProbes, TerrainProbeSnapshot, TerrainProbeMemoryReport } from "./terrain-probes.js";
export { TerrainScatterBatch, ScatterWindSettings, TerrainScatterSource, makeScatterTransform, seededScatterTransforms, gridScatterTransforms, bilinearScatterSample, simplifyScatterMesh, autoScatterLodLevels, scatterMeshBounds, scatterTransformBounds } from "./terrain-scatter.js";
export type * from "./scatter-types.js";
export { TerrainLightingProbes, getTerrainProbeMaterialDefaults } from "./terrain-probes.js";
export type { TerrainProbeGrid, TerrainProbeBakeOptions, TerrainProbeSnapshot, TerrainProbeMemoryReport, ProbeReflectionMaterial, ProbeReflectionLighting } from "./terrain-probes.js";
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
  /** W08 (E0): negotiated per-stage limits the W08 features were checked against. */
  maxSampledTexturesPerShaderStage?: number;
  maxStorageBuffersPerShaderStage?: number;
  /** W08 (E0): clipmap geometry supported at the negotiated limits. */
  terrainClipmap?: boolean;
  /** W08 (E0): streamed heightfield supported at the negotiated limits. */
  terrainStreaming?: boolean;
  /** W08 (E0): overlay stack supported at the negotiated limits. */
  terrainOverlays?: boolean;
  /** W08 (E0): virtual texturing supported at the negotiated limits. */
  terrainVirtualTexture?: boolean;
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
  /** Initial viewer camera mode (default `"orbit"`). */
  mode?: CameraControllerMode;
  /** Fly (FPS) movement and look settings. */
  fly?: FlyControlsOptions;
  /** Keyboard bindings by `KeyboardEvent.code` (toggle defaults to `KeyV`). */
  bindings?: CameraKeyBindings;
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
  /** Initial fly view; defaults to the eye and direction of `initialView`. */
  initialFlyView?: FlyView;
  controls?: false | OrbitControlsOptions;
  resize?: false | ViewerResizeOptions;
  recovery?: ViewerRecoveryOptions;
  resources?: ViewerResourceOptions;
  onStatusChange?: (change: ViewerStatusChange) => void;
  onError?: (error: Forge3DError) => void;
}

/** Float32 heightmap input for the terrain renderer. */
export interface TerrainHeightmapInput {
  width: number;
  height: number;
  /** Must contain exactly width * height values; NaN marks nodata cells. */
  heights: Float32Array;
  /** Optional terrain color ramp used by the WebGPU surface shader. */
  colorRamp?: TerrainColorRampInput;
  /** Named colormap or custom ramp; cannot be combined with colorRamp. */
  colormap?: TerrainColormapInput;
  /** Physical sample spacing in world units. */
  spacing?: [number, number];
  /** Vertical exaggeration applied to (height - domainMin). */
  exaggeration?: number;
  /** Height domain used for normalized rendering. */
  domain?: [number, number];
  /** Optional numeric nodata marker; NaN always marks nodata cells. */
  nodata?: number;
  /** Optional CRS identifier retained as metadata. */
  crs?: string;
  transform?: [number, number, number, number, number, number];
  /** Optional GPU ambient-occlusion settings. */
  heightAo?: HeightAoOptions;
  /** Optional GPU sun-visibility settings. */
  sunVisibility?: SunVisibilityOptions;
  /** Optional grayscale debug view selection. */
  debugView?: TerrainDebugView;
  renderMode?: TerrainRenderMode;
  /** Terrain PBR/POM material; omitted keeps the unmaterialed terrain. */
  material?: TerrainMaterialInput;
  /** W08: geometry mode — clipmap ring geometry or the default dense grid. */
  geometry?: TerrainGeometryInput;
  /** W08: world XZ bounds override `[minX, minZ, maxX, maxZ]`. */
  bounds?: [number, number, number, number];
  /** W08: streamed heightfield pyramid; implies clipmap geometry. */
  streaming?: TerrainStreamingInput;
  /** W08 (E5): composited overlay layers over the terrain albedo. */
  overlays?: TerrainOverlaysInput;
}

/** W08 (E5): `terrain.overlays` — composited image layers over the
 * terrain albedo, applied in linear space before lighting. */
export interface TerrainOverlaysInput {
  enabled?: boolean;
  globalOpacity?: number;
  resolutionScale?: number;
  layers?: TerrainOverlayLayerInput[];
}

/** One W08 overlay layer; `extent` (uv) and `crs`/`crsBounds` are mutually
 * exclusive placements. */
export interface TerrainOverlayLayerInput {
  name?: string;
  image: TerrainMaterialImage;
  /** `[u0, v0, u1, v1]` uv extent placement. */
  extent?: [number, number, number, number];
  /** Layer CRS id (e.g. `"EPSG:4326"`); requires `crsBounds`. */
  crs?: string;
  /** `[minx, miny, maxx, maxy]` bounds in `crs` units. */
  crsBounds?: [number, number, number, number];
  opacity?: number;
  blendMode?: "normal" | "multiply" | "overlay";
  visible?: boolean;
  zOrder?: number;
}

/** W08 (E5) `getTerrainOverlayReport` shape — `enabled:false` zeros when
 * the committed terrain has no visible overlay plan. */
export interface TerrainOverlayReport {
  enabled: boolean;
  layerCount: number;
  width: number;
  height: number;
  requestedWidth: number;
  requestedHeight: number;
  downscaled: boolean;
  gpuBytes: number;
  globalOpacity: number;
  layers: { name: string; blendMode: string; zOrder: number }[];
}

export type TerrainVtFamily = "albedo" | "normal" | "mask";

/** One `material.virtualTexture.layers[i]` entry (W08/E6); only `albedo`
 * is paged by the runtime, other families fail commit validation. */
export interface TerrainVtLayerInput {
  family?: TerrainVtFamily;
  virtualSizePx?: [number, number];
  tileSize?: number;
  tileBorder?: number;
  fallback?: [number, number, number, number];
}

/** W08 (E6): `material.virtualTexture` — paged albedo texturing for the
 * terrain material path. */
export interface TerrainVirtualTextureInput {
  enabled?: boolean;
  atlasSize?: number;
  residencyBudgetMb?: number;
  maxMipLevels?: number;
  useFeedback?: boolean;
  layers?: TerrainVtLayerInput[];
}

/** One registered VT source image (W08/E6): full-resolution RGBA8 pixels
 * for one `(materialIndex, family)` virtual texture; the runtime pages
 * from it. */
export interface MaterialVtSourceImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** W08 (E6) `getMaterialVtStats` shape — camelCase core `VtStats`. */
export interface TerrainMaterialVtStats {
  enabled: boolean;
  residentPages: number;
  totalPages: number;
  cacheBudgetPages: number;
  cacheBudgetMb: number;
  cacheHits: number;
  cacheMisses: number;
  missRate: number;
  tilesStreamed: number;
  evictions: number;
  avgUploadMs: number;
  lastUploadMs: number;
  residentMegabytes: number;
  sourceCount: number;
  feedbackRequests: number;
}

/** W08 (E6) `validateTerrainVtSupport` report. */
export interface TerrainVtSupportReport {
  status: string;
  diagnostics: {
    code: string;
    severity: string;
    message: string;
    remediation: string;
    supportLevel: string;
    layerId: string;
    objectId: string;
    details: Record<string, string>;
  }[];
  layerSummaries: {
    layerId: string;
    layerType: string;
    supportLevel: string;
    diagnosticCodes: string[];
    enabled: boolean;
    families: string[];
    nativeSupportedFamily: string;
  }[];
  supportedFeatures: Record<string, string>;
  unsupportedFeatures: Record<string, string>;
}

/** W08 clipmap ring options (A1 defaults apply to absent fields). */
export interface TerrainClipmapInput {
  ringCount?: number;
  ringResolution?: number;
  centerResolution?: number;
  skirtDepth?: number;
  morphRange?: number;
  baseCellSize?: [number, number];
}

export type TerrainGeometryMode = "grid" | "clipmap";

/** W08 terrain geometry selection; `streaming` implies `clipmap`. */
export interface TerrainGeometryInput {
  mode?: TerrainGeometryMode;
  clipmap?: TerrainClipmapInput;
}

export type TerrainCoalescePolicy = "prefer-coarse" | "prefer-fine";

/** W08 streamed heightfield options; `heights` then holds the coarsest level. */
export interface TerrainStreamingInput {
  /** Virtual heightfield width in samples. */
  width?: number;
  /** Virtual heightfield height in samples. */
  height?: number;
  tileSize?: number;
  maxResidentBytes?: number;
  lodBias?: number;
  prefetchMarginTiles?: number;
  maxInFlight?: number;
  coalescePolicy?: TerrainCoalescePolicy;
}

/** W08 (E7) `getTerrainGeometryReport` shape; ring fields are clipmap-only. */
export interface TerrainGeometryReport {
  mode: TerrainGeometryMode;
  renderMode: TerrainRenderMode;
  ringCount?: number;
  ringResolution?: number;
  centerResolution?: number;
  skirtDepth?: number;
  morphRange?: number;
  baseCellSize?: [number, number];
  vertexCount: number;
  indexCount: number;
  triangleCount: number;
  triangleBudget: number;
  fullResolutionTriangles: number;
  triangleReductionPercent: number;
  centers?: [number, number][];
  shadowCasterResolution: [number, number];
}

/** One planned height-tile request from `planHeightTiles`. */
export interface HeightTileRequest {
  lod: number;
  x: number;
  y: number;
  priority: number;
  prefetch: boolean;
}

export interface HeightTileId {
  lod: number;
  x: number;
  y: number;
}

/** `planHeightTiles` result — new requests plus cancelled in-flight tiles. */
export interface HeightTilePlan {
  requests: HeightTileRequest[];
  cancelled: HeightTileId[];
}

/** `completeHeightTile` result — `evicted` is the LRU casualty, if any. */
export interface HeightTileCompletion {
  accepted: boolean;
  evicted: HeightTileId | null;
}

/** W08 (E3) `getHeightStreamingStats` shape. */
export interface HeightStreamingStats {
  enabled: boolean;
  center: [number, number];
  lodCount: number;
  tileSize: number;
  residentTiles: number;
  residentFineTiles: number;
  residentHeightBytes: number;
  maxResidentBytes: number;
  coarsePrefilled: boolean;
  tilesRequested: number;
  tilesUploaded: number;
  pending: number;
  cancelled: number;
  droppedByPolicy: number;
  backpressure: number;
  deduplicated: number;
  failed: number;
  evictions: number;
  plannedTiles: number;
  plannedResident: number;
  converged: boolean;
  lodSelection: {
    visibleTiles: number;
    totalTriangles: number;
    frame: number;
  };
}

/** One tile in the latest GPU LOD selection. */
export interface LodSelectionTile {
  tileId: number;
  lod: number;
  x: number;
  y: number;
  distance: number;
  selectedLod: number;
}

/** W08 (E4) `getLodSelection` shape — `null` before the first readback. */
export interface LodSelectionReport {
  frame: number;
  visibleCount: number;
  totalTriangles: number;
  tiles: LodSelectionTile[];
}

/** W08 (A4/E7) `generateClipmapMesh` result — `positions` are xz pairs. */
export interface ClipmapMeshResult {
  positions: Float32Array;
  uvs: Float32Array;
  morphData: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  triangleCount: number;
  ringsCount: number;
  triangleReductionPercent: number;
}

/** `selectLodTilesReference` input tile; `tileId` or `(lod, x, y)`. */
export interface LodReferenceTile {
  tileId?: number;
  lod?: number;
  x?: number;
  y?: number;
  boundsMin: [number, number];
  boundsMax: [number, number];
  heightMin?: number;
  heightMax?: number;
}

/** `selectLodTilesReference` input — CPU mirror of the GPU LOD pass. */
export interface LodSelectReferenceInput {
  /** Column-major 4x4 view-projection matrix (16 floats). */
  viewProj: number[];
  cameraPos: [number, number, number];
  viewportHeight: number;
  /** Vertical field of view in radians. */
  fovY: number;
  maxLod: number;
  pixelErrorBudget?: number;
  tiles: LodReferenceTile[];
}

/** `selectLodTilesReference` result — every input tile sorted by
 * `(distance, tileId)`. */
export interface LodSelectReferenceResult {
  tiles: (LodSelectionTile & { visible: boolean })[];
  visibleCount: number;
  totalTriangles: number;
}

export interface TerrainColorRampInput {
  /** Ordered color stops. Positions and RGB channels are normalized to 0..1. */
  stops: TerrainColorStopInput[];
}

export interface TerrainColorStopInput {
  position: number;
  color: [number, number, number];
}

/** Named colormaps provided by the terrain facade. */
export type TerrainColormapName =
  | "viridis"
  | "magma"
  | "terrain"
  | "grayscale";

/** Colormap selector accepted by terrain inputs and LUT generation. */
export type TerrainColormapInput = TerrainColormapName | TerrainColorRampInput;

/** Grayscale debug views for terrain analysis output. */
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
  /** Native terrain water coverage/shore-distance mask. */
  waterMask?: TerrainMaterialMask | null;
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
  /** W08 (E6): paged virtual texturing for the material albedo. */
  virtualTexture?: TerrainVirtualTextureInput | null;
}

export interface TerrainMaterialLayerSnapshot {
  baseColor: [number, number, number];
  roughness: number;
  metallic: number;
  texture: TerrainMaterialImage | null;
}

/** Fully resolved, validated terrain material. */
export interface TerrainMaterialSnapshot {
  waterMask: TerrainMaterialMask | null;
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
  /** W08 (E6): paged virtual texturing; `null` disables it. */
  virtualTexture: TerrainVirtualTextureInput | null;
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
  maskChannels: ("snow" | "rock" | "wetness" | "water")[];
  detailNormalMap: boolean;
  gpuBytes: number;
  diagnostics: TerrainMaterialDiagnostic[];
}

/** Population statistics over valid (non-nodata) height samples. */
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

/** Heightfield ambient-occlusion options shared by CPU and GPU analysis. */
export interface HeightAoOptions {
  enabled?: boolean;
  resolutionScale?: number;
  directions?: number;
  steps?: number;
  maxDistance?: number;
  strength?: number;
}

/** Sun-visibility options shared by CPU and GPU analysis. */
export interface SunVisibilityOptions {
  enabled?: boolean;
  mode?: "hard" | "soft";
  resolutionScale?: number;
  samples?: number;
  steps?: number;
  maxDistance?: number;
  softness?: number;
  bias?: number;
  /** Direction pointing toward the sun; normalized by the implementation. */
  direction?: [number, number, number];
}

/** Typed-array input accepted by TerrainDataset.fromArray. */
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
  /** Terrain PBR/POM material; omitted keeps the unmaterialed terrain. */
  material?: TerrainMaterialInput;
}

/** Byte-source input accepted by TerrainDataset.fromSource. */
export interface TerrainDatasetSourceInput
  extends Omit<TerrainDatasetInput, "heights"> {
  source: TerrainByteSource;
  signal?: AbortSignal;
  onProgress?: (progress: TerrainSourceProgress) => void;
  maxBytes?: number;
}

export interface TerrainDatasetLoadOptions {
  workerPool?: Forge3DWorkerPool;
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
  /** Flat x/z point pairs in centered physical coordinates. */
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

/** CPU terrain dataset with metadata, statistics, and analysis helpers. */
export declare class TerrainDataset {
  static fromArray(input: TerrainDatasetInput): TerrainDataset;
  static fromSource(
    input: TerrainDatasetSourceInput,
    options?: TerrainDatasetLoadOptions,
  ): Promise<TerrainDataset>;
  readonly width: number;
  readonly height: number;
  readonly heights: Float32Array;
  readonly spacing: [number, number];
  readonly exaggeration: number;
  readonly domain: [number, number];
  readonly nodata?: number;
  readonly crs?: string;
  readonly transform?: [number, number, number, number, number, number];
  readonly bounds?: [number, number, number, number];
  readonly colormap: TerrainColormapInput;
  readonly statistics: TerrainStatistics;
  validMask(): Uint8Array;
  normalize(options?: TerrainNormalizationOptions): TerrainDataset;
  fillNodata(method?: "nearest" | "mean"): TerrainDataset;
  toTerrainInput(): TerrainHeightmapInput;
  slopeAspect(): TerrainSlopeAspectResult;
  contours(levels: readonly number[]): TerrainContourResult;
  query(x: number, z: number): TerrainQueryResult | undefined;
  heightAo(options?: HeightAoOptions): TerrainScalarField;
  sunVisibility(options?: SunVisibilityOptions): TerrainScalarField;
  estimatedCpuBytes(): number;
}

export declare function createTerrainDatasetWorkerHandler(): Forge3DMessageHandler;
export declare function normalizeTerrainMaterial(
  input?: TerrainMaterialInput,
): TerrainMaterialSnapshot;
export declare function getTerrainMaterialDefaults(): TerrainMaterialSnapshot;
export declare function getTerrainColormap(
  name: TerrainColormapName,
): TerrainColorRampInput;
export declare function getTerrainColormapLut(
  input: TerrainColormapInput,
  size?: number,
): Uint8Array;

/**
 * W08 (A4/E7): generate the crack-free clipmap ring mesh for `config` at
 * `center` — `{positions (xz pairs), uvs, morphData, indices, ...}`.
 */
export declare function generateClipmapMesh(
  config: TerrainClipmapInput,
  center: [number, number],
  terrainExtent: number,
): Promise<ClipmapMeshResult>;

/**
 * W08 (A4/E7): triangle-count reduction percent of a clipmap mesh versus
 * the full-resolution grid covering the same extent.
 */
export declare function calculateTriangleReduction(
  full: number,
  clipmap: number,
): Promise<number>;

/**
 * W08 (E4/E7): CPU reference LOD selection — the expected result of the
 * GPU `clipmap_lod_select` pass for the same tiles and camera.
 */
export declare function selectLodTilesReference(
  input: LodSelectReferenceInput,
): Promise<LodSelectReferenceResult>;

/**
 * W08 (E6): evaluate `material.virtualTexture` settings against the
 * supported feature table — the same report a failed terrain commit
 * attaches to `details`.
 */
export declare function validateTerrainVtSupport(
  settings: TerrainVirtualTextureInput,
): Promise<TerrainVtSupportReport>;

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
  /** Optional terrain color ramp used by the WebGPU surface shader. */
  colorRamp?: TerrainColorRampInput;
  /** Named colormap or custom ramp; cannot be combined with colorRamp. */
  colormap?: TerrainColormapInput;
  spacing?: [number, number];
  exaggeration?: number;
  domain?: [number, number];
  nodata?: number;
  crs?: string;
  transform?: [number, number, number, number, number, number];
  heightAo?: HeightAoOptions;
  sunVisibility?: SunVisibilityOptions;
  debugView?: TerrainDebugView;
  renderMode?: TerrainRenderMode;
  /** Terrain PBR/POM material; omitted keeps the unmaterialed terrain. */
  material?: TerrainMaterialInput;
  /** W08: geometry mode — clipmap ring geometry or the default dense grid. */
  geometry?: TerrainGeometryInput;
  /** W08: world XZ bounds override `[minX, minZ, maxX, maxZ]`. */
  bounds?: [number, number, number, number];
  /** W08: streamed heightfield pyramid; implies clipmap geometry. */
  streaming?: TerrainStreamingInput;
  /** W08 (E5): composited overlay layers over the terrain albedo. */
  overlays?: TerrainOverlaysInput;
}

/** Camera parameters used to build the terrain view-projection matrix. */
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

/** Three-component vector. */
export type Vec3 = [number, number, number];

/** Camera projection model. */
export type CameraProjectionKind = "perspective" | "orthographic";

/** Clip-space depth convention: WebGPU `0..1` or OpenGL `-1..1`. */
export type ClipSpace = "wgpu" | "gl";

/** Options for the typed `Camera`; omitted fields use documented defaults. */
export interface CameraOptions {
  position: Vec3;
  target: Vec3;
  /** Defaults to +Y. */
  up?: Vec3;
  /** Defaults to 45 degrees. */
  fovYDegrees?: number;
  /** Defaults to 0.1. */
  near?: number;
  /** Defaults to 1000. */
  far?: number;
  projection?: CameraProjectionKind;
  /** Vertical world extent; required for orthographic cameras. */
  orthographicHeight?: number;
}

/** Versioned camera serialization. */
export interface CameraJSON extends CameraOptions {
  kind: "forge3d.camera";
  version: 1;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/** Projected point: pixels from the top-left corner plus WebGPU NDC depth. */
export interface ScreenPoint {
  x: number;
  y: number;
  /** 0 at the near plane, 1 at the far plane. */
  depth: number;
}

/** World-space picking ray with a unit direction. */
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
  /** `Infinity` beyond the hyperfocal distance. */
  far: number;
}

/** Path-tracing camera descriptor (native `make_camera`). */
export interface PathTracingCameraInput {
  origin: Vec3;
  lookAt: Vec3;
  up: Vec3;
  fovY: number;
  aspect: number;
  exposure: number;
}

export type PathTracingCamera = PathTracingCameraInput;

/**
 * Typed, immutable camera with perspective or orthographic projection,
 * matrices (column-major `Float32Array(16)`) and world/screen conversion.
 */
export declare class Camera {
  constructor(options: CameraOptions);
  static fromInput(input: CameraInput): Camera;
  static fromJSON(json: CameraJSON): Camera;
  readonly position: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  readonly fovYDegrees: number;
  readonly near: number;
  readonly far: number;
  readonly projection: CameraProjectionKind;
  readonly orthographicHeight: number | undefined;
  readonly forward: Vec3;
  with(changes: Partial<CameraOptions>): Camera;
  viewMatrix(): Float32Array;
  projectionMatrix(aspect: number, clipSpace?: ClipSpace): Float32Array;
  viewProjectionMatrix(aspect: number, clipSpace?: ClipSpace): Float32Array;
  worldToScreen(point: Readonly<Vec3>, viewport: ViewportSize): ScreenPoint | undefined;
  screenToWorld(x: number, y: number, depth: number, viewport: ViewportSize): Vec3;
  screenRay(x: number, y: number, viewport: ViewportSize): ScreenRay;
  toInput(): CameraInput;
  toJSON(): CameraJSON;
}

export declare function lookAt(eye: Readonly<Vec3>, target: Readonly<Vec3>, up: Readonly<Vec3>): Float32Array;
export declare function perspective(
  fovYDegrees: number,
  aspect: number,
  near: number,
  far: number,
  clipSpace?: ClipSpace,
): Float32Array;
export declare function orthographic(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
  clipSpace?: ClipSpace,
): Float32Array;
export declare function viewProjection(
  eye: Readonly<Vec3>,
  target: Readonly<Vec3>,
  up: Readonly<Vec3>,
  fovYDegrees: number,
  aspect: number,
  near: number,
  far: number,
  clipSpace?: ClipSpace,
): Float32Array;
export declare function translate(tx: number, ty: number, tz: number): Float32Array;
export declare function rotateX(degrees: number): Float32Array;
export declare function rotateY(degrees: number): Float32Array;
export declare function rotateZ(degrees: number): Float32Array;
export declare function scale(sx: number, sy: number, sz: number): Float32Array;
export declare function scaleUniform(s: number): Float32Array;
/** `T * R * S`; Euler rotation applied X, then Y, then Z. */
export declare function composeTrs(
  translation: Readonly<Vec3>,
  rotationDegrees: Readonly<Vec3>,
  scale: Readonly<Vec3>,
): Float32Array;
export declare function lookAtTransform(
  position: Readonly<Vec3>,
  target: Readonly<Vec3>,
  up: Readonly<Vec3>,
): Float32Array;
export declare function multiplyMatrices(left: ArrayLike<number>, right: ArrayLike<number>): Float32Array;
export declare function invertMatrix(matrix: ArrayLike<number>): Float32Array;
export declare function normalMatrix(modelMatrix: ArrayLike<number>): Float32Array;
/** Column-major matrix to native row-major rows. */
export declare function mat4ToRows(matrix: ArrayLike<number>): number[][];
/** Native row-major rows to a column-major matrix. */
export declare function mat4FromRows(rows: readonly (readonly number[])[]): Float32Array;
export declare function worldToScreen(
  viewProjection: ArrayLike<number>,
  point: Readonly<Vec3>,
  viewport: ViewportSize,
): ScreenPoint | undefined;
export declare function screenToWorld(
  inverseViewProjection: ArrayLike<number>,
  x: number,
  y: number,
  depth: number,
  viewport: ViewportSize,
): Vec3;
export declare function screenRay(
  inverseViewProjection: ArrayLike<number>,
  x: number,
  y: number,
  viewport: ViewportSize,
): ScreenRay;
export declare function fStopToAperture(fStop: number): number;
export declare function apertureToFStop(aperture: number): number;
export declare function hyperfocalDistance(
  focalLength: number,
  fStop: number,
  circleOfConfusion?: number,
): number;
export declare function depthOfFieldRange(
  focalLength: number,
  fStop: number,
  focusDistance: number,
  circleOfConfusion?: number,
): DepthOfFieldRange;
export declare function circleOfConfusion(
  depth: number,
  focalLength: number,
  aperture: number,
  focusDistance: number,
  sensorSize?: number,
): number;
export declare function cameraDofParams(input: CameraDofParamsInput): CameraDofParams;
export declare function makeCamera(input: PathTracingCameraInput): PathTracingCamera;

/** Keyframe input: azimuth `phi`, polar angle `theta` from +Y, radius, FOV. */
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

/** Interpolated camera animation state. */
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
  /** Target used when a state has none. */
  fallbackTarget?: Vec3;
  up?: Vec3;
  near?: number;
  far?: number;
  projection?: CameraProjectionKind;
  orthographicHeight?: number;
}

/** Immutable keyframe; values are stored in f32 like the native animation. */
export declare class CameraKeyframe {
  constructor(input: CameraKeyframeInput);
  static from(input: CameraKeyframeInput | CameraKeyframe): CameraKeyframe;
  readonly time: number;
  readonly phiDeg: number;
  readonly thetaDeg: number;
  readonly radius: number;
  readonly fovDeg: number;
  readonly target: Readonly<Vec3> | null;
  toJSON(): CameraKeyframeJSON;
}

/** Target-aware keyframe animation with Catmull-Rom interpolation. */
export declare class CameraAnimation {
  constructor(keyframes?: Iterable<CameraKeyframeInput | CameraKeyframe>);
  static fromJSON(json: CameraAnimationJSON): CameraAnimation;
  readonly keyframeCount: number;
  /** Time of the last keyframe in seconds. */
  readonly duration: number;
  addKeyframe(keyframe: CameraKeyframeInput | CameraKeyframe): void;
  getKeyframes(): CameraKeyframe[];
  replaceKeyframes(keyframes: Iterable<CameraKeyframeInput | CameraKeyframe>): void;
  clearKeyframes(): void;
  /** Inclusive frame count `ceil(duration * fps) + 1`, or 0. */
  getFrameCount(fps: number): number;
  frameTimes(fps: number): number[];
  sample(fps: number): CameraAnimationSample[];
  evaluate(time: number): CameraState | undefined;
  cameraAt(time: number, options?: CameraStateCameraOptions): CameraInput | undefined;
  toJSON(): CameraAnimationJSON;
}

export declare function cubicHermite(p0: number, p1: number, p2: number, p3: number, t: number): number;
export declare function cameraStateEye(state: CameraState, fallbackTarget?: Readonly<Vec3>): Vec3;
export declare function cameraStateToInput(state: CameraState, options?: CameraStateCameraOptions): CameraInput;

export interface RenderConfigOptions {
  outputDir?: string;
  fps?: number;
  width?: number;
  height?: number;
  filenamePrefix?: string;
  frameDigits?: number;
}

/** Offline frame-sequence naming (native `RenderConfig`). */
export declare class RenderConfig {
  constructor(options?: RenderConfigOptions);
  readonly outputDir: string;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly filenamePrefix: string;
  readonly frameDigits: number;
  frameFileName(frame: number): string;
  framePath(frame: number): string;
  /** Creates the nested output directory below a File System Access/OPFS root. */
  ensureOutputDir(root: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle>;
}

export declare class RenderProgress {
  constructor(frame: number, totalFrames: number, time: number, outputPath: string);
  readonly frame: number;
  readonly totalFrames: number;
  readonly time: number;
  readonly outputPath: string;
  readonly percent: number;
}

/** First-person fly camera state (degrees). */
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
  /** Movement multiplier while boost is held (native default 2). */
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

/** Serializable controller input used for deterministic replay. */
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

export declare const DEFAULT_CAMERA_KEY_BINDINGS: Readonly<Required<CameraKeyBindings>>;

/** Browser-independent Y-up orbit camera math. */
export declare class OrbitController {
  constructor(initialView?: OrbitView, options?: OrbitControlsOptions);
  getView(): OrbitView;
  getCamera(): CameraInput;
  setView(view: OrbitView): boolean;
  orbitBy(deltaYawDegrees: number, deltaPitchDegrees: number): boolean;
  panBy(deltaXCssPixels: number, deltaYCssPixels: number, viewportHeightCssPixels: number): boolean;
  zoomBy(delta: number): boolean;
  reset(): boolean;
}

/** First-person fly (FPS) camera with native movement semantics. */
export declare class FlyController {
  constructor(initialView?: FlyView, options?: FlyControlsOptions);
  static viewFromCamera(camera: CameraInput): FlyView;
  readonly moveSpeed: number;
  readonly lookSpeed: number;
  readonly boostMultiplier: number;
  readonly forward: Vec3;
  readonly right: Vec3;
  getView(): FlyView;
  setView(view: FlyView): boolean;
  getCamera(): CameraInput;
  lookBy(deltaYawDegrees: number, deltaPitchDegrees: number): boolean;
  moveBy(forward: number, right: number, up: number): boolean;
  update(deltaSeconds: number, input: FlyInputState): boolean;
  zoomBy(deltaFovDegrees: number): boolean;
  reset(): boolean;
}

/** Orbit + fly controller with mode switching, bindings and replay. */
export declare class CameraController {
  constructor(options?: CameraControllerOptions, orbit?: OrbitController);
  readonly orbit: OrbitController;
  readonly fly: FlyController;
  readonly bindings: Readonly<Required<CameraKeyBindings>>;
  readonly mode: CameraControllerMode;
  readonly flyInput: FlyInputState;
  readonly moving: boolean;
  readonly recording: boolean;
  getCamera(): CameraInput;
  getState(): CameraControllerState;
  setState(state: CameraControllerState): boolean;
  setMode(mode: CameraControllerMode): boolean;
  toggleMode(): CameraControllerMode;
  setCamera(camera: CameraInput): boolean;
  startRecording(): void;
  stopRecording(): CameraInputEvent[];
  apply(event: CameraInputEvent): boolean;
  replay(events: readonly CameraInputEvent[]): boolean;
  resetAll(): boolean;
}

export declare function cameraDirection(yawDegrees: number, pitchDegrees: number): Vec3;
export declare function yawPitchFromDirection(vector: Readonly<Vec3>): [number, number];
export declare function replayCameraInput(
  options: CameraControllerOptions,
  events: readonly CameraInputEvent[],
): CameraInput;

/** Heightfield for terrain rigs (native `TerrainScatterSource` contract). */
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
  /** Initial keyframe rate (default 60). */
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

/** Clearance tolerance used by rig verification (world units). */
export declare const TERRAIN_CLEARANCE_TOLERANCE: number;

export declare class TerrainRigSource {
  constructor(input: TerrainRigSourceInput);
  static fromDataset(
    dataset: TerrainDataset,
    options?: { zScale?: number; terrainWidth?: number },
  ): TerrainRigSource;
  readonly width: number;
  readonly height: number;
  readonly terrainWidth: number;
  readonly zScale: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  contractToPixel(x: number, z: number): [number, number];
  sampleScaledHeight(row: number, col: number): number;
  heightAt(x: number, z: number): number;
  toWorld(point: Readonly<Vec3>): Vec3;
  /**
   * Contract-space pose at `time`; with `minimumHeight` the eye is lifted to
   * terrain + minimum so playback never violates clearance.
   */
  eyeAt(
    animation: CameraAnimation,
    time: number,
    options?: { minimumHeight?: number },
  ): { eye: Vec3; target: Vec3; fovDeg: number } | undefined;
  /** Renderer-space camera at `time` (`eyeAt` mapped through `toWorld`). */
  cameraAt(
    animation: CameraAnimation,
    time: number,
    options?: Omit<CameraStateCameraOptions, "fallbackTarget"> & { minimumHeight?: number },
  ): CameraInput | undefined;
}

export declare class TerrainClearance {
  constructor(options?: TerrainClearanceOptions);
  readonly minimumHeight: number;
  readonly maxRefinePasses: number;
  toJSON(): Required<TerrainClearanceOptions>;
}

export declare class TerrainOrbitRig {
  /** Clearance-clamped renderer camera for a bake of this rig. */
  cameraAt(
    source: TerrainRigSource,
    animation: CameraAnimation,
    time: number,
    options?: Omit<CameraStateCameraOptions, "fallbackTarget">,
  ): CameraInput | undefined;
  constructor(options: TerrainOrbitRigOptions);
  readonly kind: "orbit";
  readonly targetXZ: Readonly<[number, number]>;
  readonly duration: number;
  readonly radius: number;
  readonly phiStartDeg: number;
  readonly phiEndDeg: number;
  readonly thetaStartDeg: number;
  readonly thetaEndDeg: number | undefined;
  readonly radiusEnd: number | undefined;
  readonly fovStartDeg: number;
  readonly fovEndDeg: number | undefined;
  readonly targetHeightOffset: number;
  readonly clearance: TerrainClearance;
  bake(source: TerrainRigSource, options?: TerrainRigBakeOptions): CameraAnimation;
  toJSON(): TerrainRigJSON;
}

export declare class TerrainRailRig {
  /** Clearance-clamped renderer camera for a bake of this rig. */
  cameraAt(
    source: TerrainRigSource,
    animation: CameraAnimation,
    time: number,
    options?: Omit<CameraStateCameraOptions, "fallbackTarget">,
  ): CameraInput | undefined;
  constructor(options: TerrainRailRigOptions);
  readonly kind: "rail";
  readonly pathXZ: readonly Readonly<[number, number]>[];
  readonly duration: number;
  readonly cameraHeightOffset: number;
  readonly lookAheadDistance: number;
  readonly lateralOffset: number;
  readonly targetHeightOffset: number;
  readonly fovDeg: number;
  readonly clearance: TerrainClearance;
  bake(source: TerrainRigSource, options?: TerrainRigBakeOptions): CameraAnimation;
  toJSON(): TerrainRigJSON;
}

export declare class TerrainTargetFollowRig {
  /** Clearance-clamped renderer camera for a bake of this rig. */
  cameraAt(
    source: TerrainRigSource,
    animation: CameraAnimation,
    time: number,
    options?: Omit<CameraStateCameraOptions, "fallbackTarget">,
  ): CameraInput | undefined;
  constructor(options: TerrainTargetFollowRigOptions);
  readonly kind: "follow";
  readonly targetPathXZ: readonly Readonly<[number, number]>[];
  readonly duration: number;
  readonly radius: number;
  readonly thetaDeg: number;
  readonly headingOffsetDeg: number;
  readonly targetHeightOffset: number;
  readonly fovDeg: number;
  readonly clearance: TerrainClearance;
  bake(source: TerrainRigSource, options?: TerrainRigBakeOptions): CameraAnimation;
  toJSON(): TerrainRigJSON;
}

export type TerrainRig = TerrainOrbitRig | TerrainRailRig | TerrainTargetFollowRig;

export declare function terrainRigFromJSON(json: TerrainRigJSON): TerrainRig;
export declare function viewerOrbitRadius(
  sourceOrWidth: TerrainRigSource | number,
  options?: { scale?: number; minimum?: number },
): number;

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
  vertices?: Float32Array;
  kind: "text-mesh";
  text: string;
  size: number;
  color: [number, number, number, number];
}

export interface OverlayNodeInput extends SceneNodeBase {
  vertices?: Float32Array;
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
  vectors?:VectorSnapshot|null;
  postFx?:PostFxSnapshot|null;
  /** Authoring lights retained while the environment synchronizes the sun. */
  environmentLighting?: LightingSnapshot;
  environment?:EnvironmentSnapshot|null;
  scatter?: ScatterBatchSnapshot[];
  probes?: TerrainProbeSnapshot | null;
  timeSeconds?: number;
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
/**
 * Specular prefilter schedule. `per-mip` (default) filters every mip at its
 * own roughness. `native` reproduces a native renderer bug for oracle
 * comparisons: every prefilter pass reads the last mip's parameters, so each
 * mip only receives a small corner of the roughest lobe and the rest is zero.
 */
export type IblPrefilterMode = "native" | "per-mip";
export interface RgbeImage {
  width: number;
  height: number;
  data: Float32Array;
}
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

export declare class LightCollection {
  constructor(maxLights?: number);
  static defaults(maxLights?: number): LightCollection;
  static from(snapshot: LightingSnapshot): LightCollection;
  readonly size: number;
  readonly maxLights: number;
  readonly revision: number;
  add(light: LightInput): LightId;
  update(id: LightId, light: LightInput): void;
  remove(id: LightId): boolean;
  clear(): void;
  get(id: LightId): LightSnapshot | undefined;
  values(): LightSnapshot[];
  setExposure(exposure: number): void;
  setDebugBounds(enabled: boolean): void;
  setAreaLightApproximation(config: Partial<AreaLightApproximationConfig>): void;
  effectiveRange(id: LightId): number;
  affectsPoint(id: LightId, point: [number, number, number]): boolean;
  bounds(id: LightId): LightBounds;
  snapshot(): LightingSnapshot;
  copy(): LightCollection;
  estimatedGpuBytes(): number;
}

export declare function lightPresetNames(): readonly LightPresetName[];
export declare function getLightPreset(name: LightPresetName): LightInput;

export declare function resolveBrdfModel(requested: string): BrdfRoute;

export declare class MaterialCollection {
  constructor(maxMaterials?: number);
  static from(snapshot: MaterialCollectionSnapshot): MaterialCollection;
  readonly size: number;
  readonly maxMaterials: number;
  readonly revision: number;
  set(slot: string, material: MaterialInput): void;
  remove(slot: string): boolean;
  clear(): void;
  get(slot: string): MaterialSnapshot | undefined;
  values(): MaterialSlotSnapshot[];
  route(slot: string): BrdfRoute;
  snapshot(): MaterialCollectionSnapshot;
  copy(): MaterialCollection;
  estimatedGpuBytes(): number;
}

export declare class TextureSet {
  constructor(input?: TextureSetInput);
  static from(snapshot: TextureSetSnapshot): TextureSet;
  get(semantic: TextureSemantic): TextureImageSnapshot | undefined;
  snapshot(): TextureSetSnapshot;
  copy(): TextureSet;
  estimatedGpuBytes(): number;
}

export declare function generateMeshTangents(input: MeshTbnInput): MeshTbnResult;
export declare function extractGltfMaterialChannels(
  data: Uint8Array,
  width: number,
  height: number,
): GltfMaterialChannels;

export declare class Ktx2Loader {
  constructor(options?: Ktx2LoaderOptions);
  getLastReport(): Ktx2TranscodeReport | undefined;
  load(
    source: BrowserByteSource,
    options: Ktx2LoadOptions,
  ): Promise<TextureImageSnapshot>;
}

export declare function decodeRgbe(data: Uint8Array): RgbeImage;

export declare class IblCache {
  constructor(options?: IblCacheOptions);
  readonly backend: IblCacheBackend;
  get(key: string): Promise<IblPrecomputedSnapshot | undefined>;
  put(key: string, value: IblPrecomputedSnapshot): Promise<void>;
}

export declare class ImageBasedLighting {
  private constructor();
  static fromRGBE(
    source: BrowserByteSource,
    options?: IblOptions & ByteReadOptions,
  ): Promise<ImageBasedLighting>;
  static fromLinear(
    image: RgbeImage,
    options?: IblOptions,
  ): Promise<ImageBasedLighting>;
  readonly prepared: boolean;
  readonly report: IblReport;
  readonly prefilter: IblPrefilterMode;
  cacheKey(): Promise<string>;
  prepare(
    target: IblPrecomputeTarget,
    cache?: IblCache,
  ): Promise<ImageBasedLighting>;
  snapshot(): IblSnapshot;
  copy(): ImageBasedLighting;
  estimatedGpuBytes(): number;
}

/** Shadow filter configuration; "csm" is rejected (use CascadedShadowConfig). */
export declare class ShadowConfig {
  constructor(input?: ShadowConfigInput);
  static from(snapshot: ShadowConfigSnapshot): ShadowConfig;
  snapshot(): ShadowConfigSnapshot;
  copy(): ShadowConfig;
  requiresMoments(): boolean;
  peterPanningSafe(): boolean;
  estimatedGpuBytes(cascadeCount?: number): number;
}

/** Cascaded shadow map pipeline, configured separately from the filter. */
export declare class CascadedShadowConfig {
  constructor(input?: CascadedShadowConfigInput);
  static from(snapshot: CascadedShadowConfigSnapshot): CascadedShadowConfig;
  snapshot(): CascadedShadowConfigSnapshot;
  copy(): CascadedShadowConfig;
  calculateSplits(near: number, far: number): number[];
  stabilizeBounds(
    min: [number, number, number],
    max: [number, number, number],
    mapSize: number,
  ): {
    min: [number, number, number];
    max: [number, number, number];
    texelSize: number;
  };
}

export declare class Forge3DScene {
  setVectorLayers(input:VectorLayers|VectorSnapshot|null):void;
  getVectorLayers():VectorSnapshot|null;

  setScatterBatches(batches: readonly (TerrainScatterBatch | ScatterBatchInput | ScatterBatchSnapshot)[]): void;
  setLightingProbes(probes: TerrainLightingProbes | TerrainProbeSnapshot | null): void;
  setTimeSeconds(seconds: number): void;
  setPostFx(input:PostFxChain|PostFxChainInput|PostFxSnapshot|readonly PostFxInput[]|null):void;
  getPostFx():PostFxSnapshot|null;
  setEnvironment(input:Forge3DEnvironment|EnvironmentInput|EnvironmentSnapshot|null):void;
  getEnvironment():EnvironmentSnapshot|null;
  getScatterBatches(): ScatterBatchSnapshot[];
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
  addLight(light: LightInput): LightId;
  updateLight(id: LightId, light: LightInput): void;
  removeLight(id: LightId): boolean;
  clearLights(): void;
  getLight(id: LightId): LightSnapshot | undefined;
  getLights(): LightSnapshot[];
  getLightBounds(id: LightId): LightBounds;
  lightAffectsPoint(id: LightId, point: [number, number, number]): boolean;
  setLightingExposure(exposure: number): void;
  setLightDebugBounds(enabled: boolean): void;
  setAreaLightApproximation(config: Partial<AreaLightApproximationConfig>): void;
  setMaterial(slot: string, material: MaterialInput): void;
  removeMaterial(slot: string): boolean;
  clearMaterials(): void;
  getMaterial(slot: string): MaterialSnapshot | undefined;
  getMaterials(): MaterialSlotSnapshot[];
  getMaterialRoute(slot: string): BrdfRoute;
  setImageBasedLighting(ibl: ImageBasedLighting | undefined): void;
  getImageBasedLighting(): ImageBasedLighting | undefined;
  setShadows(
    config: ShadowConfig | ShadowConfigInput,
    csm?: CascadedShadowConfig | CascadedShadowConfigInput,
  ): void;
  getShadows(): { config: ShadowConfig; csm: CascadedShadowConfig };
  getShadowReport(): ShadowReport;
  getShadowCascadeInfo(cameraNear: number, cameraFar: number): ShadowCascadeInfo[];
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
  getVectorReport():VectorReport;
  readVectorPickMap():Promise<VectorPickMap>;
  readVectorPickMap(region:VectorPickRegion):Promise<VectorPickMap>;

  setTimeSeconds(seconds: number): void;
  setPostFx(input:PostFxChain|PostFxChainInput|PostFxSnapshot|readonly PostFxInput[]|null):void;
  getPostFxReport():PostFxReport;
  resetPostFxHistory():void;
  readPostFxIntermediate(name:string):Promise<PostFxFrame>;
  setEnvironment(input:Forge3DEnvironment|EnvironmentInput|EnvironmentSnapshot|null):void;
  getEnvironmentMemoryReport():EnvironmentMemoryReport;
  getScatterStats(): ScatterFrameStats;
  getScatterMemoryReport(): ScatterMemoryReport;
  getProbeMemoryReport(): TerrainProbeMemoryReport;

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
  precomputeIbl(input: IblSnapshot): Promise<IblSnapshot>;
  getShadowReport(): ShadowReport;
  /** What the runtime bound for the committed terrain material. */
  getTerrainMaterialReport(): TerrainMaterialReport;
  /** W08 (E7): committed terrain geometry — grid counts or clipmap budget. */
  getTerrainGeometryReport(): TerrainGeometryReport;
  /** W08 (E5): committed overlay plan — sizes, layer order, GPU bytes. */
  getTerrainOverlayReport(): TerrainOverlayReport;
  /** W08 (E3): plan streamed height-tile requests for the current layout. */
  planHeightTiles(maxRequests: number): HeightTilePlan;
  /** W08 (E3): deliver fetched tile heights for a pending request. */
  completeHeightTile(
    lod: number,
    x: number,
    y: number,
    heights: Float32Array,
  ): HeightTileCompletion;
  /** W08 (E3): release an in-flight tile request, counted failed. */
  failHeightTile(lod: number, x: number, y: number): void;
  /** W08 (E3): streamed-heightfield residency/queue statistics. */
  getHeightStreamingStats(): HeightStreamingStats;
  /** W08 (E4): latest GPU LOD selection; `null` before the first readback. */
  getLodSelection(): LodSelectionReport | null;
  /** W08 (E6): register a VT source image; retained across recovery. */
  registerMaterialVtSource(
    materialIndex: number,
    family: string,
    image: MaterialVtSourceImage,
    fallback?: [number, number, number, number],
  ): void;
  /** W08 (E6): drop every registered VT source image. */
  clearMaterialVtSources(): void;
  /** W08 (E6): VT residency/feedback statistics; zeros when VT is off. */
  getMaterialVtStats(): TerrainMaterialVtStats;
  setScene(scene: Forge3DScene): void;
  getScene(): Forge3DScene | undefined;
  render(): boolean;
  setCamera(camera: CameraInput): void;
  /** Last committed camera (replayed after device loss), if any. */
  getCamera(): CameraInput | undefined;
  readRgba(): Promise<Uint8Array>;
  resize(size: ResizeInput): void;
  screenshot(): Promise<Blob>;
  /** Drawing-buffer size of the live runtime (0 before initialization). */
  readonly width: number;
  readonly height: number;
  /** Commits pending scene edits, then opens an offline accumulation session. */
  beginOfflineAccumulation(options?: OfflineAccumulationOptions): void;
  accumulateBatch(sampleCount: number): Promise<OfflineBatchResult>;
  readAccumulationMetrics(targetVariance: number, tileSize?: number): Promise<OfflineMetrics>;
  resolveOfflineHdr(options?: OfflineResolveOptions): Promise<CaptureResult>;
  /** Ends the live runtime's offline session; never throws. */
  endOfflineAccumulation(): boolean;
  capture(options?: CaptureOptions): Promise<CaptureResult>;
  renderOffline(options?: OfflineRenderOptions): Promise<OfflineResult>;
  denoiseHdrFrame(frame: HdrFrame, aov?: AovFrame, settings?: DenoiseSettingsInput): Promise<HdrFrame>;
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
  setVectorLayers(input:VectorLayers|VectorSnapshot|null,terrain?:TerrainHeightmapInput|TerrainDataset):void|Promise<void>;
  getVectorReport():VectorReport;
  readVectorProjection():Promise<VectorProjectionReport>;
  readVectorPickMap():Promise<VectorPickMap>;
  readVectorPickMap(region:VectorPickRegion):Promise<VectorPickMap>;

  setTimeSeconds(seconds: number): void;
  setPostFx(input:PostFxChain|PostFxChainInput|PostFxSnapshot|readonly PostFxInput[]|null):void;
  getPostFxReport():PostFxReport;
  resetPostFxHistory():void;
  readPostFxIntermediate(name:string):Promise<PostFxFrame>;
  setEnvironment(input:Forge3DEnvironment|EnvironmentInput|EnvironmentSnapshot|null):void;
  getEnvironmentMemoryReport():EnvironmentMemoryReport;
  getScatterStats(): ScatterFrameStats;
  getScatterMemoryReport(): ScatterMemoryReport;
  getProbeMemoryReport(): TerrainProbeMemoryReport;
  setScatterBatches(batches: readonly (TerrainScatterBatch | ScatterBatchInput | ScatterBatchSnapshot)[]): void;
  setLightingProbes(probes: TerrainLightingProbes | TerrainProbeSnapshot | null): void;

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
  setTerrain(terrain: TerrainHeightmapInput|TerrainDataset): void;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  setScene(scene: SceneSnapshot): void;
  setLighting(lighting: LightingSnapshot): void;
  setMaterials(materials: MaterialCollectionSnapshot): void;
  setIbl(ibl: IblSnapshot | null): void;
  precomputeIbl(input: IblSnapshot): Promise<IblSnapshot>;
  setShadows(shadows: ShadowSnapshot): void;
  getShadowReport(): ShadowReport;
  /** What the runtime bound for the committed terrain material. */
  getTerrainMaterialReport(): TerrainMaterialReport;
  /** W08 (E7): committed terrain geometry — grid counts or clipmap budget. */
  getTerrainGeometryReport(): TerrainGeometryReport;
  /** W08 (E3): plan streamed height-tile requests for the current layout. */
  planHeightTiles(maxRequests: number): HeightTilePlan;
  /** W08 (E3): deliver fetched tile heights for a pending request. */
  completeHeightTile(
    lod: number,
    x: number,
    y: number,
    heights: Float32Array,
  ): HeightTileCompletion;
  /** W08 (E3): release an in-flight tile request, counted failed. */
  failHeightTile(lod: number, x: number, y: number): void;
  /** W08 (E3): streamed-heightfield residency/queue statistics. */
  getHeightStreamingStats(): HeightStreamingStats;
  /** W08 (E4): latest GPU LOD selection; `null` before the first readback. */
  getLodSelection(): LodSelectionReport | null;
  /** W08 (E5): committed overlay plan — sizes, layer order, GPU bytes. */
  getTerrainOverlayReport(): TerrainOverlayReport;
  /** W08 (E6): register an albedo source image for material
   * `materialIndex`. Sources persist across terrain re-commits until
   * cleared or the runtime is disposed. */
  registerMaterialVtSource(
    materialIndex: number,
    family: TerrainVtFamily,
    image: MaterialVtSourceImage,
    fallback?: [number, number, number, number],
  ): void;
  /** W08 (E6): drop every registered VT source image. */
  clearMaterialVtSources(): void;
  /** W08 (E6): VT residency/feedback statistics; zeros when VT is off. */
  getMaterialVtStats(): TerrainMaterialVtStats;
  setCamera(camera: CameraInput): void;
  resize(size: ResizeInput): void;
  render(): boolean;
  screenshot(): Promise<Blob>;
  readRgba(): Promise<Uint8Array>;
  readTerrainHeights(): Promise<Float32Array>;
  computeTerrainAnalysis(
    terrain: TerrainDataset | TerrainHeightmapInput,
    request: TerrainComputeRequest,
  ): Promise<TerrainComputeResult>;
  readTerrainAnalysis(
    kind: "height-ao" | "sun-visibility",
  ): Promise<TerrainScalarField>;
  /** Whether an offline accumulation session is open. */
  readonly offlineActive: boolean;
  /**
   * Opens an offline accumulation session for the committed scene and camera
   * (native `begin_offline_accumulation`). While open, render() returns false,
   * screenshot()/readRgba() reject, and scene/camera mutations queue until
   * endOfflineAccumulation().
   */
  beginOfflineAccumulation(options?: OfflineAccumulationOptions): void;
  accumulateBatch(sampleCount: number): Promise<OfflineBatchResult>;
  readAccumulationMetrics(targetVariance: number, tileSize?: number): Promise<OfflineMetrics>;
  /** Resolves HDR color, AOVs and a tonemapped frame (optionally denoised). */
  resolveOfflineHdr(options?: OfflineResolveOptions): Promise<CaptureResult>;
  /** Ends the session; returns whether one was open. Idempotent. */
  endOfflineAccumulation(): boolean;
  /** HDR/AOV capture of the committed scene (one sample by default). */
  capture(options?: CaptureOptions): Promise<CaptureResult>;
  /** Native `render_offline` on this runtime. */
  renderOffline(options?: OfflineRenderOptions): Promise<OfflineResult>;
  /** WebGPU A-trous denoise guided by the frame's AOVs. */
  denoiseHdrFrame(frame: HdrFrame, aov?: AovFrame, settings?: DenoiseSettingsInput): Promise<HdrFrame>;
  dispose(): void;
}

/**
 * High-level, invalidation-driven interactive terrain viewer.
 *
 * The viewer owns controls, resize observation, scheduling, and one optional
 * device-loss recovery. dispose() synchronously releases all owned resources.
 */
export declare class Forge3DViewer {
  setLabels(layer: import("./labels.js").LabelLayer | null, options?: Omit<import("./labels.js").LabelRenderOptions,"viewport"|"camera">): void;
  getLabelReport(): import("./labels.js").LabelPlacementReport | undefined;
  setVectorLayers(input:VectorLayers|VectorSnapshot|null,terrain?:TerrainHeightmapInput):void|Promise<void>;
  getVectorReport():VectorReport;
  readVectorPickMap():Promise<VectorPickMap>;
  readVectorPickMap(region:VectorPickRegion):Promise<VectorPickMap>;

  setTimeSeconds(seconds: number): void;
  setPostFx(input:PostFxChain|PostFxChainInput|PostFxSnapshot|readonly PostFxInput[]|null):void;
  getPostFxReport():PostFxReport;
  resetPostFxHistory():void;
  readPostFxIntermediate(name:string):Promise<PostFxFrame>;
  setEnvironment(input:Forge3DEnvironment|EnvironmentInput|EnvironmentSnapshot|null):void;
  getEnvironmentMemoryReport():EnvironmentMemoryReport;
  getScatterStats(): ScatterFrameStats;
  getScatterMemoryReport(): ScatterMemoryReport;
  getProbeMemoryReport(): TerrainProbeMemoryReport;
  setScatterBatches(batches: readonly (TerrainScatterBatch | ScatterBatchInput | ScatterBatchSnapshot)[]): void;
  setLightingProbes(probes: TerrainLightingProbes | TerrainProbeSnapshot | null): void;

  static create(
    canvas: HTMLCanvasElement,
    options?: Forge3DViewerOptions,
  ): Promise<Forge3DViewer>;
  readonly disposed: boolean;
  readonly status: ViewerStatus;
  getView(): OrbitView;
  /** Active controller mode. */
  getCameraMode(): CameraControllerMode;
  /** Switches orbit/fly control keeping the eye and view direction. */
  setCameraMode(mode: CameraControllerMode): void;
  getFlyView(): FlyView;
  setFlyView(view: FlyView): void;
  /** Camera currently rendered (active controller plus projection). */
  getCamera(): CameraInput;
  /** Points both controllers at a Y-up camera and adopts its projection. */
  setCamera(camera: CameraInput): void;
  startCameraRecording(): void;
  stopCameraRecording(): CameraInputEvent[];
  replayCameraInput(events: readonly CameraInputEvent[]): void;
  getCapabilities(): ViewerCapabilities;
  getDiagnostics(): ViewerDiagnostics;
  setTerrain(terrain: TerrainHeightmapInput): void;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  /** W08 (E7): committed terrain geometry — grid counts or clipmap budget. */
  getTerrainGeometryReport(): TerrainGeometryReport;
  /** W08 (E5): committed overlay plan — sizes, layer order, GPU bytes. */
  getTerrainOverlayReport(): TerrainOverlayReport;
  /** W08 (E3): plan streamed height-tile requests for the current layout. */
  planHeightTiles(maxRequests: number): HeightTilePlan;
  /** W08 (E3): deliver fetched tile heights for a pending request. */
  completeHeightTile(
    lod: number,
    x: number,
    y: number,
    heights: Float32Array,
  ): HeightTileCompletion;
  /** W08 (E3): release an in-flight tile request, counted failed. */
  failHeightTile(lod: number, x: number, y: number): void;
  /** W08 (E3): streamed-heightfield residency/queue statistics. */
  getHeightStreamingStats(): HeightStreamingStats;
  /** W08 (E4): latest GPU LOD selection; `null` before the first readback. */
  getLodSelection(): LodSelectionReport | null;
  /** W08 (E6): register a VT source image; retained across recovery. */
  registerMaterialVtSource(
    materialIndex: number,
    family: string,
    image: MaterialVtSourceImage,
    fallback?: [number, number, number, number],
  ): void;
  /** W08 (E6): drop every registered VT source image. */
  clearMaterialVtSources(): void;
  /** W08 (E6): VT residency/feedback statistics; zeros when VT is off. */
  getMaterialVtStats(): TerrainMaterialVtStats;
  /** Registers a listener invoked once per successful device-loss
   * recovery, after the terrain/VT replay. Returns an unsubscribe. */
  addRecoveryListener(listener: () => void): () => void;
  /** Registers a listener invoked each submitted frame; returning
   * `true` keeps the render loop alive (`TerrainStreamer.autoUpdate`). */
  addFrameListener(
    listener: (timestamp: number) => boolean | void,
  ): () => void;
  /** Schedules a render on the viewer's scheduler. */
  requestRender(): void;
  setView(view: OrbitView): void;
  /** Resets the active controller (orbit or fly) to its initial view. */
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
  getVectorReport():Promise<VectorReport>;
  readVectorPickMap():Promise<VectorPickMap>;
  readVectorPickMap(region:VectorPickRegion):Promise<VectorPickMap>;

  static create(
    canvas: HTMLCanvasElement,
    options: Forge3DWorkerRendererOptions,
  ): Promise<Forge3DWorkerRenderer>;
  readonly disposed: boolean;
  setScene(scene: Forge3DScene): Promise<void>;
  setCamera(camera: CameraInput): Promise<void>;
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
  getVectorReport(): VectorReport;
  readVectorPickMap(): Promise<VectorPickMap>;
  readVectorPickMap(region:VectorPickRegion):Promise<VectorPickMap>;
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

/* W06: readback, AOV/HDR/EXR, offline quality, frame sequences and video. */

/** Capture AOVs (native `AovSettings` plus ID and motion). */
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
  /** Luminance edge-stopping strength; 0 reproduces the native NumPy weights. */
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
  denoise?: DenoiseSettingsInput | DenoiseSettings | null;
}

export interface CaptureOptions extends OfflineAccumulationOptions, OfflineResolveOptions {
  signal?: AbortSignal;
}

export interface CaptureResult {
  frame: Frame;
  hdrFrame: HdrFrame;
  aovFrame: AovFrame;
}

export interface OfflineRenderOptions {
  settings?: OfflineQualitySettings | OfflineQualitySettingsInput;
  /** Target samples when not adaptive (native `aa_samples`). */
  samples?: number;
  seed?: number | null;
  aovs?: readonly AovName[] | "all";
  denoise?: DenoiseSettings | DenoiseSettingsInput | null;
  tonemap?: TonemapOptions;
  previousCamera?: CameraInput;
  onProgress?: (progress: OfflineProgress) => void;
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

export interface AovFrameInit {
  width: number;
  height: number;
  near: number;
  far: number;
  albedo?: Float32Array;
  normal?: Float32Array;
  depth?: Float32Array;
  id?: Uint32Array;
  motion?: Float32Array;
}

export declare const EXR_MIME_TYPE: "image/x-exr";
export declare const AOV_ID_BACKGROUND: 0;
export declare const AOV_ID_TERRAIN: 1;
/** Reserved object ID for all vector fragments; full feature IDs use the pick map. */
export declare const AOV_ID_VECTOR: 4294967279;
export declare const AOV_ID_SCENE_NODE_BASE: 2;
/** AOV object ID of a scene node (`node.id + 2`). */
export declare function aovObjectId(nodeId: number): number;

/** Tight RGBA8 frame, rows top to bottom (native `Frame`). */
export declare class Frame {
  constructor(width: number, height: number, data: Uint8Array);
  readonly width: number;
  readonly height: number;
  readonly format: "rgba8unorm";
  readonly data: Uint8Array;
  size(): [number, number];
  toRgba8(): Uint8Array;
  pixel(x: number, y: number): [number, number, number, number];
  /** Deterministic PNG (native `save_png_deterministic`). */
  toPng(options?: PngEncodeOptions): Promise<Blob>;
}

/** Linear float RGBA frame (native `HdrFrame`). */
export declare class HdrFrame {
  constructor(width: number, height: number, data: Float32Array);
  readonly width: number;
  readonly height: number;
  readonly size: [number, number];
  readonly data: Float32Array;
  toFloat32(): Float32Array;
  pixel(x: number, y: number): [number, number, number, number];
  tonemap(options?: HdrTonemapOptions): Promise<Frame>;
  toExr(options?: ExrWriteOptions): Promise<Blob>;
  static fromExr(
    source: Blob | ArrayBuffer | Uint8Array,
    options?: ExrReadOptions & { prefix?: string },
  ): Promise<HdrFrame>;
}

/** Arbitrary output variables (native `AovFrame`). */
export declare class AovFrame {
  constructor(init: AovFrameInit);
  readonly width: number;
  readonly height: number;
  readonly near: number;
  readonly far: number;
  readonly hasAlbedo: boolean;
  readonly hasNormal: boolean;
  readonly hasDepth: boolean;
  readonly hasId: boolean;
  readonly hasMotion: boolean;
  size(): [number, number];
  channels(): AovName[];
  albedo(): Float32Array;
  normal(): Float32Array;
  /** Linear view depth normalized to [0, 1] by the camera clip planes. */
  depth(): Float32Array;
  /** View-space depth `near + depth * (far - near)`. */
  linearDepth(): Float32Array;
  id(): Uint32Array;
  /** Pixel motion `current - previous` (+x right, +y down). */
  motion(): Float32Array;
  toPngs(baseName?: string, options?: PngEncodeOptions): Promise<Record<string, Blob>>;
  toExr(beauty?: HdrFrame | Frame, options?: ExrWriteOptions): Promise<Blob>;
}

export declare function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
  options?: PngEncodeOptions,
): Promise<Blob>;
export declare function writeExr(image: {
  width: number;
  height: number;
  channels: readonly ExrChannelInput[];
  metadata?: Readonly<Record<string, string>>;
  compression?: ExrCompression;
}): Promise<Blob>;
export declare function readExr(
  source: Blob | ArrayBuffer | Uint8Array,
  options?: ExrReadOptions,
): Promise<ExrImage>;

/** Offline accumulation and adaptive sampling policy (native TV12). */
export declare class OfflineQualitySettings {
  constructor(input?: OfflineQualitySettingsInput);
  static from(input: OfflineQualitySettings | OfflineQualitySettingsInput | undefined): OfflineQualitySettings;
  readonly enabled: boolean;
  readonly adaptive: boolean;
  readonly targetVariance: number;
  readonly maxSamples: number;
  readonly minSamples: number;
  readonly batchSize: number;
  readonly tileSize: number;
  readonly convergenceRatio: number;
  toJSON(): Required<OfflineQualitySettingsInput>;
}

/** A-trous denoise configuration (native M5 `DenoiseSettings`). */
export declare class DenoiseSettings {
  constructor(input?: DenoiseSettingsInput);
  static from(input: DenoiseSettings | DenoiseSettingsInput | null | undefined): DenoiseSettings;
  readonly enabled: boolean;
  readonly method: DenoiseMethod;
  readonly iterations: number;
  readonly sigmaColor: number;
  readonly sigmaAlbedo: number;
  readonly sigmaNormal: number;
  readonly sigmaDepth: number;
  readonly edgeStopping: number;
  readonly guides: Readonly<Required<DenoiseGuides>>;
  readonly active: boolean;
  toNative(): Record<string, unknown>;
  toJSON(): Required<Omit<DenoiseSettingsInput, "guides">> & { guides: Required<DenoiseGuides> };
}

/** Progress of renderOffline (native `OfflineProgress`). */
export declare class OfflineProgress {
  constructor(
    samplesSoFar: number,
    maxSamples: number,
    meanDelta: number,
    p95Delta: number,
    convergedRatio: number,
    elapsedMs: number,
  );
  readonly samplesSoFar: number;
  readonly maxSamples: number;
  readonly meanDelta: number;
  readonly p95Delta: number;
  readonly convergedRatio: number;
  readonly elapsedMs: number;
}

/** Surface implemented by Forge3DRuntime and Forge3DSession. */
export interface OfflineRenderTarget {
  beginOfflineAccumulation(options?: OfflineAccumulationOptions): void;
  accumulateBatch(sampleCount: number): Promise<OfflineBatchResult>;
  readAccumulationMetrics(targetVariance: number, tileSize?: number): Promise<OfflineMetrics>;
  resolveOfflineHdr(options?: OfflineResolveOptions): Promise<CaptureResult>;
  endOfflineAccumulation(): boolean;
}

/** Native `forge3d.offline.render_offline`; settings.enabled must be true. */
export declare function renderOffline(
  target: OfflineRenderTarget,
  options?: OfflineRenderOptions,
): Promise<OfflineResult>;
/** Native `_has_upward_convergence_trend`. */
export declare function hasUpwardConvergenceTrend(history: readonly OfflineMetrics[]): boolean;
/** CPU/WASM A-trous reference (native `atrous_denoise`). */
export declare function atrousDenoise(input: HdrDenoiseInput): Promise<Float32Array>;
/** MSE, PSNR, Gaussian SSIM and max absolute error between two images. */
export declare function compareImages(
  a: Float32Array,
  b: Float32Array,
  options: ImageCompareOptions,
): Promise<ImageComparison>;

export interface RenderedFrame {
  index: number;
  time: number;
  timestampUs: number;
  durationUs: number;
  camera?: CameraInput;
  frame: Frame;
  hdrFrame?: HdrFrame;
  aovFrame?: AovFrame;
}

export type FrameSequenceMode = "capture" | "display" | "offline";

export interface FrameSequenceOptions {
  animation?: CameraAnimation;
  cameraAt?: (time: number, index: number) => CameraInput;
  cameraOptions?: CameraStateCameraOptions;
  frameCount?: number;
  fps?: number;
  config?: RenderConfig;
  startFrame?: number;
  endFrame?: number;
  mode?: FrameSequenceMode;
  capture?: CaptureOptions;
  offline?: Omit<OfflineRenderOptions, "onProgress" | "previousCamera" | "signal">;
  onProgress?: (progress: RenderProgress) => void;
  signal?: AbortSignal;
}

/** Render surface renderFrames drives (Forge3DRuntime or Forge3DSession). */
export interface FrameRenderTarget {
  readonly width: number;
  readonly height: number;
  setCamera(camera: CameraInput): void;
  render(): boolean;
  readRgba(): Promise<Uint8Array>;
  capture(options?: CaptureOptions): Promise<CaptureResult>;
  renderOffline(options?: OfflineRenderOptions): Promise<OfflineResult>;
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

/** Exact microsecond timestamp `round(index * 1e6 / fps)`. */
export declare function frameTimestampUs(index: number, fps: number): number;
export declare function renderFrames(
  target: FrameRenderTarget,
  options: FrameSequenceOptions,
): AsyncGenerator<RenderedFrame, void, undefined>;
export declare function createFrameStream(
  target: FrameRenderTarget,
  options: FrameSequenceOptions,
): ReadableStream<RenderedFrame>;
export declare function writeFrames(
  frames: AsyncIterable<RenderedFrame> | Iterable<RenderedFrame>,
  sink: FrameSink,
  options?: { signal?: AbortSignal },
): Promise<FrameWriteSummary>;
export declare function createMemoryFrameSink(options?: {
  config?: RenderConfig;
  format?: FrameSinkFormat;
  png?: PngEncodeOptions;
}): FrameSink & { readonly files: Map<string, Blob> };
export declare function createOpfsFrameSink(options?: {
  root?: FileSystemDirectoryHandle;
  config?: RenderConfig;
  format?: FrameSinkFormat;
  png?: PngEncodeOptions;
}): Promise<FrameSink & { readonly directory: FileSystemDirectoryHandle }>;
export declare function createDownloadFrameSink(options?: {
  config?: RenderConfig;
  format?: FrameSinkFormat;
  png?: PngEncodeOptions;
  download?: (blob: Blob, name: string) => void | Promise<void>;
}): FrameSink;

/** Native `FrameDumper`: auto-numbered frame capture into a sink. */
export declare class FrameDumper {
  constructor(sink: FrameSink, options?: { prefix?: string; frameDigits?: number });
  readonly prefix: string;
  startRecording(): void;
  captureFrame(frame: Frame | RenderedFrame): Promise<string>;
  stopRecording(): Promise<number>;
  getFrameCount(): number;
  isRecording(): boolean;
}

/** Native `dump_frame_sequence`. */
export declare function dumpFrameSequence(
  frames: Iterable<Frame> | AsyncIterable<Frame>,
  sink: FrameSink,
  options?: { prefix?: string; frameDigits?: number },
): Promise<number>;

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

/** `Forge3DError.details` of UNSUPPORTED_FEATURE when no codec can encode. */
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

export declare function probeVideoCodecs(options: VideoCodecProbeOptions): Promise<VideoCodecSupport[]>;
/** WebCodecs encode plus deterministic MP4/WebM muxing (mediabunny 1.58.0). */
export declare function encodeVideo(
  frames: Iterable<Frame | RenderedFrame> | AsyncIterable<Frame | RenderedFrame>,
  options: VideoEncodeOptions,
): Promise<EncodedVideoResult>;
export declare function muxEncodedVideo(
  chunks: readonly EncodedVideoChunkInput[],
  options: MuxVideoOptions,
): Promise<Blob>;

// ---------------------------------------------------------------------------
// W08 (F1-F5): terrain streaming — range scheduling, byte caches, COG IO,
// height-tile streaming, overlay / virtual-texture helpers.
// ---------------------------------------------------------------------------

/** W08 (F5): overlay blend mode values accepted by `blendMode`. */
export type OverlayBlendMode = "normal" | "multiply" | "overlay";

/** W08 (F2): `MemoryByteCache` statistics. */
export interface MemoryByteCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  bytes: number;
  budgetBytes: number;
  entries: number;
}

/** W08 (F2): persistent adapter statistics. `entries`/`bytes` count
 * writes performed by this adapter instance. */
export interface PersistentByteCacheStats {
  hits: number;
  misses: number;
  checksumFailures: number;
  entries: number;
  bytes: number;
}

/** W08 (F2): digest-verified persistent byte cache (OPFS / IndexedDB /
 * CacheStorage). Cache keys embed the source validator so stale bytes
 * never hit. */
export interface PersistentByteCache {
  readonly kind: string;
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  stats(): PersistentByteCacheStats;
}

/** Minimal in-memory byte-cache contract accepted by `RangeScheduler`. */
export interface MemoryByteCacheLike {
  get(key: string): Uint8Array | undefined;
  put(key: string, bytes: Uint8Array): void;
  /** Used to drop entries keyed by a validator the server rejected. */
  delete?(key: string): unknown;
  stats?(): MemoryByteCacheStats;
}

/** Minimal key/value storage a persistent adapter writes framed
 * entries to (digest framing lives in `DigestCheckedByteCache`). */
export interface PersistentByteStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** W08 (F2): in-memory LRU byte cache with a byte budget. */
export declare class MemoryByteCache implements MemoryByteCacheLike {
  constructor(budgetBytes: number);
  readonly budgetBytes: number;
  get(key: string): Uint8Array | undefined;
  peek(key: string): Uint8Array | undefined;
  put(key: string, bytes: Uint8Array): void;
  delete(key: string): boolean;
  clear(): void;
  stats(): MemoryByteCacheStats;
}

/** W08 (F2): digest-framed `PersistentByteCache` over an injectable
 * `PersistentByteStore`; checksum failures delete the entry. */
export declare class DigestCheckedByteCache implements PersistentByteCache {
  readonly kind: string;
  constructor(kind: string, store: PersistentByteStore);
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  stats(): PersistentByteCacheStats;
}

/** W08 (F2): OPFS-backed `PersistentByteStore` factory. */
export declare function opfsByteStore(namespace: string): PersistentByteStore;
/** W08 (F2): IndexedDB-backed `PersistentByteStore` factory. */
export declare function indexedDbByteStore(namespace: string): PersistentByteStore;
/** W08 (F2): CacheStorage-backed `PersistentByteStore` factory. */
export declare function cacheStorageByteStore(namespace: string): PersistentByteStore;

export interface PersistentByteCacheAdapterOptions {
  /** Namespace used by the real backend (directory, DB, cache name). */
  name?: string;
  /** Injectable store; when omitted the real browser backend is used. */
  store?: PersistentByteStore;
}

export declare class OpfsByteCache extends DigestCheckedByteCache {
  constructor(options: PersistentByteCacheAdapterOptions);
}

export declare class IndexedDbByteCache extends DigestCheckedByteCache {
  constructor(options: PersistentByteCacheAdapterOptions);
}

export declare class CacheStorageByteCache extends DigestCheckedByteCache {
  constructor(options: PersistentByteCacheAdapterOptions);
}

export type PersistentByteCacheKind = "opfs" | "indexeddb" | "cache-storage";

export interface CreatePersistentByteCacheOptions {
  name: string;
  prefer?: readonly PersistentByteCacheKind[];
  /** Injectable stores per adapter kind (tests / custom backends). */
  stores?: Partial<Record<PersistentByteCacheKind, PersistentByteStore>>;
}

/** W08 (F2): pick the first available persistent backend in `prefer`
 * order (default `["opfs", "indexeddb", "cache-storage"]`); returns
 * `null` when no backend exists in the environment. */
export declare function createPersistentByteCache(
  options: CreatePersistentByteCacheOptions,
): Promise<PersistentByteCache | null>;

/** W08 (F1): `RangeScheduler.stats()` shape. */
export interface RangeSchedulerStats {
  requested: number;
  deduplicated: number;
  coalesced: number;
  httpRequests: number;
  bytesRequested: number;
  bytesTransferred: number;
  memoryHits: number;
  persistentHits: number;
  misses: number;
  cancelled: number;
  failed: number;
  inFlight: number;
  peakInFlight: number;
  queued: number;
  offlineServed: number;
}

export type RangeFetchLike = (
  input: string,
  init: {
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface RangeSchedulerOptions {
  fetch?: RangeFetchLike;
  maxConcurrent?: number;
  coalesceGapBytes?: number;
  maxCoalescedBytes?: number;
  memoryCache?: MemoryByteCacheLike;
  persistentCache?: PersistentByteCache;
}

/** W08 (F1): HTTP range request scheduler — dedupe, coalescing,
 * priority queue, bounded concurrency, per-subscriber cancellation,
 * memory â†’ persistent â†’ network lookup. Requires servers to honor
 * `Range` (HTTP 206); a 200 to a range request fails fast. */
export declare class RangeScheduler {
  constructor(options?: RangeSchedulerOptions);
  request(
    source: string | URL | Blob,
    offset: number,
    length: number,
    options?: { priority?: number; signal?: AbortSignal },
  ): Promise<Uint8Array>;
  stats(): RangeSchedulerStats;
  fileSize(source: string | URL | Blob): number | undefined;
  dispose(): void;
}

/** W08 (F3): `CogDataset.ifdInfo(level)` shape. */
export interface IfdInfo {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tilesAcross: number;
  tilesDown: number;
  bitsPerSample: number;
  compression: number;
  tileCount: number;
}

/** W08 (F3): `CogDataset.stats()` — decoded-tile cache stats plus the
 * range scheduler and persistent-cache stats. */
export interface CogStats {
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
  memoryUsedBytes: number;
  memoryBudgetBytes: number;
  hitRatePercent: number;
  range: RangeSchedulerStats;
  persistent: PersistentByteCacheStats | null;
}

/** W08 (F3): `CogDataset.open` options. */
export interface CogDatasetOptions {
  cacheSizeMb?: number;
  scheduler?: RangeScheduler;
  persistentCache?: PersistentByteCache;
  workerPool?: Forge3DWorkerPool;
  signal?: AbortSignal;
}

/** W08 (F3): range-scheduled COG reader (geotiff 3.0.5, vendored).
 * Header/IFD/tile bytes all flow through the `RangeScheduler`;
 * decoded tiles live in a byte-budgeted LRU. */
export declare class CogDataset {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly overviewCount: number;
  readonly bounds: [number, number, number, number];
  readonly geoTransform:
    | [number, number, number, number, number, number]
    | undefined;
  readonly crs: string | null;
  readonly nodata: number | null;
  readonly bitsPerSample: number;
  readonly sampleFormat: number;
  readonly samplesPerPixel: number;
  readonly compression: number;
  static open(
    source: string | URL | Blob,
    options?: CogDatasetOptions,
  ): Promise<CogDataset>;
  ifdInfo(level: number): IfdInfo;
  selectOverview(lod: number): number;
  selectOverviewForResolution(unitsPerPixel: number): number;
  readTile(
    x: number,
    y: number,
    lod?: number,
    options?: { signal?: AbortSignal; priority?: number },
  ): Promise<Float32Array>;
  readTileRgba(
    x: number,
    y: number,
    lod?: number,
    options?: { signal?: AbortSignal; priority?: number },
  ): Promise<Uint8ClampedArray>;
  readOverviewRgba(
    level: number,
    options?: { signal?: AbortSignal; priority?: number },
  ): Promise<Uint8ClampedArray>;
  stats(): CogStats;
  dispose(): void;
}

/** W08 (F3): worker decode handler for `"cog-decode"` pool jobs. */
export declare function createCogWorkerHandler(): Forge3DMessageHandler;

/** W08 (F4): a heightfield pyramid tile source for `TerrainStreamer`.
 * `readTile(lod, x, y)` returns the pyramid tile rect clipped at the
 * edge (B2) as `tileHeight * tileWidth` float32 heights. */
export interface HeightTileSource {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  /** Source nodata; `TerrainStreamer` commits it as `terrain.nodata`
   * when `options.terrain.nodata` is unset. */
  readonly nodata?: number | null;
  readTile(
    lod: number,
    x: number,
    y: number,
    options?: { signal?: AbortSignal; priority?: number },
  ): Promise<Float32Array>;
}

/** W08 (F4): `TerrainStreamer.create` options. */
export interface TerrainStreamerOptions {
  terrain?: Partial<TerrainHeightmapInput>;
  clipmap?: TerrainClipmapInput;
  maxResidentBytes?: number;
  maxInFlight?: number;
  maxUploadsPerFrame?: number;
  coalescePolicy?: TerrainCoalescePolicy;
  prefetchMarginTiles?: number;
  lodBias?: number;
  autoUpdate?: boolean;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
}

/** W08 (F4): `TerrainStreamer.stats()` = runtime stats + source stats. */
export interface TerrainStreamerStats {
  runtime: HeightStreamingStats;
  uploadedTiles: number;
  pendingFetches: number;
  queuedFetches: number;
  converged: boolean;
}

/** W08 (F4): dense-array `HeightTileSource` (point subsample). */
export declare class ArrayHeightSource implements HeightTileSource {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  constructor(
    heights: ArrayLike<number>,
    width: number,
    height: number,
    tileSize?: number,
  );
  readTile(
    lod: number,
    x: number,
    y: number,
    options?: { signal?: AbortSignal; priority?: number },
  ): Promise<Float32Array>;
}

/** W08 (F4): `sample(lod, x, y)` `HeightTileSource`. */
export declare class FunctionHeightSource implements HeightTileSource {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  constructor(options: {
    width: number;
    height: number;
    tileSize?: number;
    sample: (lod: number, x: number, y: number) => number;
  });
  readTile(
    lod: number,
    x: number,
    y: number,
    options?: { signal?: AbortSignal; priority?: number },
  ): Promise<Float32Array>;
}

/** W08 (F4): `CogDataset`-backed `HeightTileSource` (IFD l = lod l
 * when dims match; coarser missing levels point-subsample the coarsest
 * IFD). */
export declare class CogHeightSource implements HeightTileSource {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly cog: CogDataset;
  readonly nodata: number | null;
  constructor(cog: CogDataset);
  readTile(
    lod: number,
    x: number,
    y: number,
    options?: { signal?: AbortSignal; priority?: number },
  ): Promise<Float32Array>;
}

/** W08 (F4): pyramid lod count — smallest n whose coarsest level fits
 * one tile. */
export declare function heightPyramidLodCount(
  width: number,
  height: number,
  tileSize: number,
): number;

/** W08 (F4): streams a `HeightTileSource` through the wasm height
 * streaming contract; viewer-bound streamers re-upload resident tiles
 * from cache after device-loss recovery without network refetch. */
export declare class TerrainStreamer {
  readonly source: HeightTileSource;
  readonly terrain: TerrainHeightmapInput;
  static create(
    target: Forge3DRuntime | Forge3DViewer,
    source: HeightTileSource,
    options?: TerrainStreamerOptions,
  ): Promise<TerrainStreamer>;
  update(): Promise<void>;
  readonly converged: boolean;
  whenConverged(options?: {
    signal?: AbortSignal;
    timeoutFrames?: number;
  }): Promise<void>;
  stats(): TerrainStreamerStats;
  dispose(): void;
}

/** W08 (F5): normalized overlay settings (native `OverlaySettings`
 * resolution). `enabled` defaults true when the block is present. */
export interface NormalizedTerrainOverlays {
  enabled: boolean;
  globalOpacity: number;
  resolutionScale: number;
  layers: NormalizedTerrainOverlayLayer[];
}

/** W08 (F5): normalized overlay layer; exactly one placement. */
export interface NormalizedTerrainOverlayLayer {
  name: string;
  image: TerrainMaterialImage;
  extent?: [number, number, number, number];
  crs?: string;
  crsBounds?: [number, number, number, number];
  opacity: number;
  blendMode: OverlayBlendMode;
  visible: boolean;
  zOrder: number;
}

/** W08 (F5): `TerrainVtLayerInput` under the native naming. */
export type TerrainVtLayerFamilyInput = TerrainVtLayerInput;

/** W08 (F5): normalized VT layer family (native `VTLayerFamily`). */
export interface NormalizedTerrainVtLayerFamily {
  family: TerrainVtFamily;
  virtualSizePx: [number, number];
  tileSize: number;
  tileBorder: number;
  fallback: [number, number, number, number];
}

/** W08 (F5): normalized VT settings (native `TerrainVTSettings`). */
export interface NormalizedTerrainVirtualTexture {
  enabled: boolean;
  atlasSize: number;
  residencyBudgetMb: number;
  maxMipLevels: number;
  useFeedback: boolean;
  layers: NormalizedTerrainVtLayerFamily[];
}

/** W08 (F5): native `OverlaySettings::default()` (disabled). */
export declare function getTerrainOverlayDefaults(): NormalizedTerrainOverlays;

/** W08 (F5): normalize + validate `terrain.overlays` exactly as the
 * commit path does. */
export declare function normalizeTerrainOverlays(
  input: TerrainOverlaysInput,
): NormalizedTerrainOverlays;

/** W08 (F5): native `is_effectively_visible` predicate. */
export declare function isTerrainOverlayLayerVisible(
  layer: NormalizedTerrainOverlayLayer,
): boolean;

/** W08 (F5): effectively-visible layers sorted by `zOrder`, stable by
 * input order. */
export declare function terrainOverlayVisibleLayers(
  settings: NormalizedTerrainOverlays,
): NormalizedTerrainOverlayLayer[];

/** W08 (F5): decode a browser image source or `{width, height, data}`
 * object into straight RGBA8. */
export declare function decodeOverlayImage(
  input:
    | TerrainMaterialImage
    | { width: number; height: number; data: Uint8ClampedArray | Uint8Array }
    | { width: number; height: number; rgba: Uint8ClampedArray | Uint8Array }
    | Blob
    | ImageData
    | CanvasImageSource,
): Promise<TerrainMaterialImage>;

/** W08 (F5): normalize + validate `material.virtualTexture` exactly as
 * the commit path does; `undefined` â†’ the disabled core default. */
export declare function normalizeTerrainVirtualTexture(
  input?: TerrainVirtualTextureInput,
): NormalizedTerrainVirtualTexture;

export type EnvironmentDebug = "none" | "transmittance" | "clouds" | "water-mask" | "foam" | "reflection";
export interface SunPosition { azimuth: number; elevation: number; direction: [number,number,number]; daytime: boolean }
export interface SunInput { latitude: number; longitude: number; utc: string; color?: [number,number,number]; intensity?: number; timeScale?: number }
export interface SkyInput { model?: "preetham"|"hosek-wilkie"; turbidity?: number; groundAlbedo?: number; sunSize?: number; sunIntensity?: number; aerialPerspective?: boolean; aerialDensity?: number; exposure?: number }
export interface FogInput { mode?:"uniform"|"height"|"exponential"; scattering?:number; absorption?:number; density?: number; height?: number; falloff?: number; color?: [number,number,number]; anisotropy?: number; godRays?: boolean; shaftIntensity?: number; shaftSamples?: number; useShadows?: boolean }
export interface CloudsInput {
  /** Native clip-space quad, or depth-clipped world-space clouds. */
  renderPath?: "native" | "world"; color?:[number,number,number]; scatterStrength?:number; mode?: "billboard"|"volumetric"|"hybrid"; preset?: "static"|"gentle"|"moderate"|"stormy"; density?: number; coverage?: number; scale?: number; height?: number; thickness?: number; wind?: [number,number]; animationSpeed?: number; seed?: number; shadowStrength?: number; absorption?: number; anisotropy?: number; ambient?: number; fadeDistance?: number }
export interface DensityVolumeInput { bounds: [number,number,number,number,number,number]; density?: number; color?: [number,number,number]; anisotropy?: number; dimensions?: [number,number,number]; data?: Float32Array|number[] }
export interface WaterLayerInput { bounds: [number,number,number,number]; height?: number; mode?: "disabled"|"transparent"|"reflective"|"animated"; fresnelPower?: number; hueShift?: number; tintColor?: [number,number,number]; tintStrength?: number; rippleScale?: number; rippleSpeed?: number; refractionStrength?: number; shoreAttenuationWidth?: number; waveDistortionStrength?: number; shallowColor?: [number,number,number]; deepColor?: [number,number,number]; depthScale?: number; alpha?: number; waveAmplitude?: number; waveFrequency?: number; waveSpeed?: number; flow?: [number,number]; roughness?: number; reflection?: "sky"|"screen"|"planar"; reflectionStrength?: number; foamWidth?: number; foamIntensity?: number; maskDimensions?: [number,number]; mask?: Float32Array|number[] }
export interface SunClock {latitude:number;longitude:number;unixSeconds:number;timeScale:number}
export interface EnvironmentInput { sunClock?:SunClock|null; sun?: SunInput; sunDirection?: [number,number,number]; sunColor?: [number,number,number]; sunIntensity?: number; sky?: SkyInput|null; fog?: FogInput|null; clouds?: CloudsInput|null; volumes?: DensityVolumeInput[]; water?: WaterLayerInput[]; quality?: "low"|"medium"|"high"|"ultra"; resolutionScale?: 0.5|1; steps?: number; temporalWeight?: number; volumetricMode?: "raymarch"|"froxel"; maxDistance?: number; debug?: EnvironmentDebug }
export interface EnvironmentSnapshot { sunClock:SunClock|null; sky: Required<SkyInput>|null; fog: Required<FogInput>|null; clouds: Required<Omit<CloudsInput,"preset">>|null; volumes: (Required<Omit<DensityVolumeInput,"data">>&{data:number[]})[]; water: (Required<Omit<WaterLayerInput,"mask">>&{mask:number[]})[]; sunDirection: [number,number,number]; sunColor: [number,number,number]; sunIntensity: number; resolutionScale: 0.5|1; steps: number; temporalWeight: number; volumetricMode: "raymarch"|"froxel"; maxDistance: number; debug: EnvironmentDebug }
export interface EnvironmentMemoryReport { gpuBytes: number; width: number; height: number; effectWidth: number; effectHeight: number; resolutionScale: number; steps: number; volumeCount: number; waterCount: number; historyValid: boolean }
export declare function sunPosition(latitude:number,longitude:number,utc:string):SunPosition;
export declare function environmentMemoryReport(snapshot:EnvironmentSnapshot,width:number,height:number):EnvironmentMemoryReport;
export declare class Forge3DEnvironment {
  constructor(input?:EnvironmentInput);
  snapshot(timeSeconds?:number):EnvironmentSnapshot;
  copy():Forge3DEnvironment;
  memoryReport(width:number,height:number):EnvironmentMemoryReport;
}

export interface DensityVolumePresetInput {
  preset: "valley_fog" | "plume" | "localized_haze";
  bounds: DensityVolumeInput["bounds"];
  dimensions?: [number, number, number];
  densityScale?: number;
  edgeSoftness?: number;
  noiseStrength?: number;
  floorOffset?: number;
  ceiling?: number;
  plumeSpread?: number;
  wind?: [number, number, number];
  seed?: number;
  color?: [number, number, number];
  anisotropy?: number;
  terrain?: {
    heights: Float32Array;
    width: number;
    height: number;
    bounds: [number, number, number, number];
    domainMin?: number;
    exaggeration?: number;
  };
}
export interface DensityVolumeGenerationOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}
export declare function generateDensityVolume(input: DensityVolumePresetInput, options?: DensityVolumeGenerationOptions): Promise<DensityVolumeInput>;

/** Water layer i writes AOV_ID_WATER_BASE + i. */
export declare const AOV_ID_WATER_BASE = 4294967280;

export { FontAtlas, FontFallbackRange, TypographySettings } from './typography.js';
export type { FontSource, FontAtlasOptions } from './typography.js';
export { LabelLayer, LabelManager, LabelStyle, LabelFlags } from './labels.js';
export type { LabelRenderOptions, LabelPlacementReport } from './labels.js';
export { LabelPlan, KeepoutRegion, PriorityClass, LABEL_REJECTION_REASONS } from './label-plan.js';
export type * from './label-types.js';

export { LabelCollisionIndex, declutterLabels } from './label-declutter.js';
export type { LabelDeclutterCandidate, LabelDeclutterConfig, LabelDeclutterResult } from './label-declutter.js';

export {LabelFeatureSource} from './label-features.js';
export type {LabelFeature,LabelFeatureOptions} from './label-features.js';

export { CrsTransformer, crsToEpsg, crsFromRasterMetadata, crsFromGeoJson, projAvailable } from './crs.js';
export type * from './crs-types.js';
export { DatasetRegistry, DATASET_BASE_URL, decodeDatasetNpy } from './datasets.js';
export type * from './dataset-types.js';
export { reprojectVectorLayer, reprojectLabelFeatures } from './crs-layers.js';
export type { GeospatialVectorLayerInput, CrsLayerTarget } from './crs-layers.js';
export { cloneMesh, meshBounds, meshBytes, recomputeMeshNormals, attachMeshTangents, transferMesh, mergeMeshes, MeshLayer, MESH_IDENTITY, MAX_MESH_BYTES } from './mesh.js';
export type { MeshBuffers, MeshInput, MeshBounds } from './mesh.js';
export { generatePrimitive, extrudePolygon, generateRibbon, generateTube, generateThickPolyline } from './geometry.js';
export type { PrimitiveKind, PrimitiveOptions, ExtrudeOptions, RibbonOptions, TubeOptions, JoinStyle } from './geometry.js';
export { validateMesh, weldMesh, transformMesh, centerMesh, scaleMesh, flipMeshAxis, swapMeshAxes, subdivideMesh, subdivideMeshAdaptive, displaceHeightmap, displaceProcedural, simplifyMesh, generateMeshLods, planarMeshUv, sphericalMeshUv } from './mesh-processing.js';
export type { MeshValidationIssue, MeshValidationReport, WeldOptions, SubdivisionOptions, AdaptiveSubdivisionOptions, HeightmapDisplacement } from './mesh-processing.js';
export { parseObj, parseMtl, encodeObj, encodeMtl } from './mesh-obj.js';
export type { ObjImport, ObjMaterial } from './mesh-obj.js';
export { parseStl, encodeStl } from './mesh-stl.js';
export { loadGltf, decodeGltf, encodeGlb } from './mesh-gltf.js';
export type { GltfLoadOptions, GltfAsset, GltfPrimitive } from './mesh-gltf.js';
export { MeshIo, loadObj, loadMesh, exportMesh, exportMeshToSink } from './mesh-io.js';
export type { MeshFormat, MeshLoadOptions, MeshExportOptions, MeshIoOptions } from './mesh-io.js';
export { loadHdr, exportHdr, loadImage, exportImage } from './image-io.js';
export type { RasterImage } from './image-io.js';
export { BuildingLayer, loadBuildings, parseGeoJsonBuildings, parseCityJsonBuildings, meshFromMultiPolygonZ, loadBuildingTilesMetadata } from './buildings.js';
export type { BuildingInput, BuildingRecord, BuildingLayerOptions, BuildingLoadOptions } from './buildings.js';
export { buildingMaterialFromName, buildingMaterialFromTags, roofMaterialFromTags, parseBuildingColor, inferRoofType } from './building-materials.js';
export type { BuildingMaterial, RoofType } from './building-materials.js';
export { diagnoseBuildingTextures } from './building-diagnostics.js';
export type { BuildingTextureRequest, BuildingDiagnostic, BuildingTextureReport } from './building-diagnostics.js';
export { createMeshWorkerHandler } from './mesh-worker.js';
export type { MeshWorkerRequest } from './mesh-worker.js';

import { CrsTransformer } from "./crs.js";
