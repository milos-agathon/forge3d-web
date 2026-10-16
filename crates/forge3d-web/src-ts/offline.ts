import { Forge3DError } from "./index.js";
import type {
  AovName,
  CameraInput,
  CaptureOptions,
  CaptureResult,
  DenoiseGuides,
  DenoiseMethod,
  DenoiseSettingsInput,
  HdrDenoiseInput,
  ImageCompareOptions,
  ImageComparison,
  OfflineAccumulationOptions,
  OfflineBatchResult,
  OfflineMetrics,
  OfflineQualitySettingsInput,
  OfflineRenderMetadata,
  OfflineRenderOptions,
  OfflineResolveOptions,
  OfflineResult,
  TonemapOperatorName,
} from "./index.js";
import { AovFrame, Frame, HdrFrame } from "./frames.js";
import { loadOfflineWasm } from "./runtime-internals.js";

/** Native `_CONVERGENCE_TREND_WINDOW`. */
const CONVERGENCE_TREND_WINDOW = 3;
const AOV_NAMES: readonly AovName[] = ["albedo", "normal", "depth", "id", "motion"];
/** Native `AovSettings` defaults: albedo, normal and depth. */
export const DEFAULT_AOVS: readonly AovName[] = ["albedo", "normal", "depth"];
const TONEMAP_OPERATORS: readonly TonemapOperatorName[] = [
  "display",
  "reinhard",
  "reinhard-extended",
  "aces",
  "uncharted2",
  "exposure",
  "filmic-terrain",
];
/** Native fallback warning when OIDN is requested but unavailable. */
export const OIDN_FALLBACK_WARNING =
  "oidn package not installed; falling back to atrous denoiser";

function invalid(message: string, details?: unknown): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message, details);
}

function finiteNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${name} must be a finite number`);
  }
  return value;
}

function integer(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalid(`${name} must be an integer`);
  }
  return value;
}

function bool(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw invalid(`${name} must be a boolean`);
  }
  return value;
}

/** Offline accumulation and adaptive sampling policy (native TV12). */
export class OfflineQualitySettings {
  readonly enabled: boolean;
  readonly adaptive: boolean;
  readonly targetVariance: number;
  readonly maxSamples: number;
  readonly minSamples: number;
  readonly batchSize: number;
  readonly tileSize: number;
  readonly convergenceRatio: number;

  constructor(input: OfflineQualitySettingsInput = {}) {
    this.enabled = bool("enabled", input.enabled ?? false);
    this.adaptive = bool("adaptive", input.adaptive ?? false);
    this.targetVariance = finiteNumber("targetVariance", input.targetVariance ?? 0.001);
    this.maxSamples = integer("maxSamples", input.maxSamples ?? 64);
    this.minSamples = integer("minSamples", input.minSamples ?? 4);
    this.batchSize = integer("batchSize", input.batchSize ?? 4);
    this.tileSize = integer("tileSize", input.tileSize ?? 16);
    this.convergenceRatio = finiteNumber("convergenceRatio", input.convergenceRatio ?? 0.95);
    if (this.targetVariance < 0) throw invalid("targetVariance must be >= 0");
    if (this.maxSamples < 1) throw invalid("maxSamples must be >= 1");
    if (this.minSamples < 1) throw invalid("minSamples must be >= 1");
    if (this.minSamples > this.maxSamples) throw invalid("minSamples must be <= maxSamples");
    if (this.batchSize < 1) throw invalid("batchSize must be >= 1");
    if (this.tileSize < 1) throw invalid("tileSize must be >= 1");
    if (this.convergenceRatio < 0 || this.convergenceRatio > 1) {
      throw invalid("convergenceRatio must be in [0, 1]");
    }
    Object.freeze(this);
  }

  static from(input: OfflineQualitySettings | OfflineQualitySettingsInput | undefined): OfflineQualitySettings {
    return input instanceof OfflineQualitySettings ? input : new OfflineQualitySettings(input ?? {});
  }

  toJSON(): Required<OfflineQualitySettingsInput> {
    return {
      enabled: this.enabled,
      adaptive: this.adaptive,
      targetVariance: this.targetVariance,
      maxSamples: this.maxSamples,
      minSamples: this.minSamples,
      batchSize: this.batchSize,
      tileSize: this.tileSize,
      convergenceRatio: this.convergenceRatio,
    };
  }
}

/** A-trous denoise configuration (native M5 `DenoiseSettings`). */
export class DenoiseSettings {
  readonly enabled: boolean;
  readonly method: DenoiseMethod;
  readonly iterations: number;
  readonly sigmaColor: number;
  readonly sigmaAlbedo: number;
  readonly sigmaNormal: number;
  readonly sigmaDepth: number;
  readonly edgeStopping: number;
  readonly guides: Readonly<Required<DenoiseGuides>>;

  constructor(input: DenoiseSettingsInput = {}) {
    this.enabled = bool("enabled", input.enabled ?? false);
    const method = input.method ?? "atrous";
    if (method !== "atrous" && method !== "oidn" && method !== "none") {
      throw invalid("method must be one of ('atrous', 'oidn', 'none')");
    }
    this.method = method;
    this.iterations = integer("iterations", input.iterations ?? 3);
    this.sigmaColor = finiteNumber("sigmaColor", input.sigmaColor ?? 0.1);
    this.sigmaAlbedo = finiteNumber("sigmaAlbedo", input.sigmaAlbedo ?? 0.2);
    this.sigmaNormal = finiteNumber("sigmaNormal", input.sigmaNormal ?? 0.1);
    this.sigmaDepth = finiteNumber("sigmaDepth", input.sigmaDepth ?? 0.1);
    this.edgeStopping = finiteNumber("edgeStopping", input.edgeStopping ?? 1);
    if (this.iterations < 1) throw invalid("iterations must be >= 1");
    if (this.iterations > 10) throw invalid("iterations must be <= 10 (quality/performance limit)");
    for (const [name, value] of [
      ["sigmaColor", this.sigmaColor],
      ["sigmaAlbedo", this.sigmaAlbedo],
      ["sigmaNormal", this.sigmaNormal],
      ["sigmaDepth", this.sigmaDepth],
      ["edgeStopping", this.edgeStopping],
    ] as const) {
      if (value < 0) throw invalid(`${name} must be >= 0`);
    }
    this.guides = Object.freeze({
      albedo: bool("guides.albedo", input.guides?.albedo ?? true),
      normal: bool("guides.normal", input.guides?.normal ?? true),
      depth: bool("guides.depth", input.guides?.depth ?? false),
    });
    Object.freeze(this);
  }

  static from(input: DenoiseSettings | DenoiseSettingsInput | null | undefined): DenoiseSettings {
    if (input instanceof DenoiseSettings) return input;
    return new DenoiseSettings(input ?? {});
  }

  /** Whether a denoise pass runs (`enabled` and a method other than `none`). */
  get active(): boolean {
    return this.enabled && this.method !== "none";
  }

  toNative(): Record<string, unknown> {
    return {
      iterations: this.iterations,
      sigmaColor: this.sigmaColor,
      sigmaAlbedo: this.sigmaAlbedo,
      sigmaNormal: this.sigmaNormal,
      sigmaDepth: this.sigmaDepth,
      edgeStopping: this.edgeStopping,
      guides: { ...this.guides },
    };
  }

  toJSON(): Required<Omit<DenoiseSettingsInput, "guides">> & { guides: Required<DenoiseGuides> } {
    return {
      enabled: this.enabled,
      method: this.method,
      iterations: this.iterations,
      sigmaColor: this.sigmaColor,
      sigmaAlbedo: this.sigmaAlbedo,
      sigmaNormal: this.sigmaNormal,
      sigmaDepth: this.sigmaDepth,
      edgeStopping: this.edgeStopping,
      guides: { ...this.guides },
    };
  }
}

/** Progress of `renderOffline` (native `OfflineProgress`). */
export class OfflineProgress {
  readonly samplesSoFar: number;
  readonly maxSamples: number;
  readonly meanDelta: number;
  readonly p95Delta: number;
  readonly convergedRatio: number;
  readonly elapsedMs: number;

  constructor(
    samplesSoFar: number,
    maxSamples: number,
    meanDelta: number,
    p95Delta: number,
    convergedRatio: number,
    elapsedMs: number,
  ) {
    this.samplesSoFar = samplesSoFar;
    this.maxSamples = maxSamples;
    this.meanDelta = meanDelta;
    this.p95Delta = p95Delta;
    this.convergedRatio = convergedRatio;
    this.elapsedMs = elapsedMs;
    Object.freeze(this);
  }
}

/** Native `_has_upward_convergence_trend`. */
export function hasUpwardConvergenceTrend(history: readonly OfflineMetrics[]): boolean {
  if (history.length < CONVERGENCE_TREND_WINDOW) {
    return false;
  }
  const ratios = history.slice(-CONVERGENCE_TREND_WINDOW).map((entry) => entry.convergedTileRatio);
  let rising = 0;
  for (let i = 1; i < ratios.length; i += 1) {
    rising += (ratios[i] ?? 0) - (ratios[i - 1] ?? 0);
  }
  return (ratios.at(-1) ?? 0) >= (ratios[0] ?? 0) - 1e-3 && rising >= -1e-3;
}

export function normalizeAovSelection(
  aovs: OfflineAccumulationOptions["aovs"],
  fallback: readonly AovName[] = DEFAULT_AOVS,
): Record<AovName, boolean> {
  const list = aovs === undefined ? fallback : aovs === "all" ? AOV_NAMES : aovs;
  if (!Array.isArray(list)) {
    throw invalid("aovs must be an array of AOV names or 'all'");
  }
  const selection: Record<AovName, boolean> = {
    albedo: false,
    normal: false,
    depth: false,
    id: false,
    motion: false,
  };
  for (const name of list as readonly AovName[]) {
    if (!AOV_NAMES.includes(name)) {
      throw invalid(`unknown AOV '${String(name)}'; expected ${AOV_NAMES.join(", ")}`);
    }
    selection[name] = true;
  }
  return selection;
}

export function nativeBeginOptions(options: OfflineAccumulationOptions): Record<string, unknown> {
  const samples = integer("samples", options.samples ?? 1);
  if (samples < 1 || samples > 4096) {
    throw invalid("samples must be in [1, 4096]");
  }
  if (options.seed !== undefined && options.seed !== null) {
    if (!Number.isSafeInteger(options.seed) || options.seed < 0) {
      throw invalid("seed must be a non-negative safe integer");
    }
  }
  const native: Record<string, unknown> = {
    samples,
    seed: options.seed ?? null,
    aovs: normalizeAovSelection(options.aovs),
  };
  if (options.previousCamera !== undefined) {
    native.previousCamera = options.previousCamera as CameraInput;
  }
  return native;
}

export function nativeResolveOptions(options: OfflineResolveOptions): Record<string, unknown> {
  const tonemap = options.tonemap ?? {};
  const operator = tonemap.operator ?? "display";
  if (!TONEMAP_OPERATORS.includes(operator)) {
    throw invalid(`unknown tonemap operator '${String(operator)}'`);
  }
  const whitePoint = finiteNumber("tonemap.whitePoint", tonemap.whitePoint ?? 4);
  if (whitePoint <= 0) throw invalid("tonemap.whitePoint must be > 0");
  const denoise = options.denoise === undefined || options.denoise === null
    ? undefined
    : DenoiseSettings.from(options.denoise);
  return {
    tonemap: { operator, whitePoint },
    denoise: denoise !== undefined && denoise.active ? denoise.toNative() : null,
  };
}

interface NativeResolveResult {
  width: number;
  height: number;
  totalSamples: number;
  near: number;
  far: number;
  color: Float32Array;
  rgba8: Uint8Array;
  tonemapOperator: TonemapOperatorName;
  denoised: boolean;
  denoiseGuides: string[];
  albedo?: Float32Array;
  normal?: Float32Array;
  depth?: Float32Array;
  id?: Uint32Array;
  motion?: Float32Array;
}

/** Converts a native resolve payload into typed frames. */
export function captureResultFromNative(raw: unknown): CaptureResult & {
  totalSamples: number;
  denoised: boolean;
  denoiseGuides: string[];
  tonemapOperator: TonemapOperatorName;
} {
  const value = raw as NativeResolveResult;
  if (value === null || typeof value !== "object" || !(value.color instanceof Float32Array)) {
    throw new Forge3DError("INTERNAL_ERROR", "Native offline resolve returned a malformed payload");
  }
  const aovFrame = new AovFrame({
    width: value.width,
    height: value.height,
    near: value.near,
    far: value.far,
    ...(value.albedo === undefined ? {} : { albedo: value.albedo }),
    ...(value.normal === undefined ? {} : { normal: value.normal }),
    ...(value.depth === undefined ? {} : { depth: value.depth }),
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.motion === undefined ? {} : { motion: value.motion }),
  });
  return {
    frame: new Frame(value.width, value.height, value.rgba8),
    hdrFrame: new HdrFrame(value.width, value.height, value.color),
    aovFrame,
    totalSamples: value.totalSamples,
    denoised: value.denoised,
    denoiseGuides: [...value.denoiseGuides],
    tonemapOperator: value.tonemapOperator,
  };
}

/** Surface both `Forge3DRuntime` and `Forge3DSession` implement. */
export interface OfflineRenderTarget {
  beginOfflineAccumulation(options?: OfflineAccumulationOptions): void;
  accumulateBatch(sampleCount: number): Promise<OfflineBatchResult>;
  readAccumulationMetrics(targetVariance: number, tileSize?: number): Promise<OfflineMetrics>;
  resolveOfflineHdr(options?: OfflineResolveOptions): Promise<CaptureResult>;
  endOfflineAccumulation(): boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Forge3DError("REQUEST_CANCELLED", "Offline render was cancelled", signal.reason);
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Offline accumulation with adaptive convergence and AOV-guided denoise
 * (native `forge3d.offline.render_offline`). `settings.enabled` must be true.
 */
export async function renderOffline(
  target: OfflineRenderTarget,
  options: OfflineRenderOptions = {},
): Promise<OfflineResult> {
  const settings = OfflineQualitySettings.from(options.settings);
  if (!settings.enabled) {
    throw invalid("renderOffline requires OfflineQualitySettings({ enabled: true })");
  }
  const denoise = DenoiseSettings.from(options.denoise ?? undefined);
  const aaSamples = integer("samples", options.samples ?? 1);
  if (aaSamples < 1) throw invalid("samples must be >= 1");
  const targetSamples = Math.max(settings.adaptive ? settings.maxSamples : aaSamples, 1);
  if (targetSamples > 4096) throw invalid("target samples must be <= 4096");
  throwIfAborted(options.signal);

  const warnings: string[] = [];
  let denoiserUsed: OfflineRenderMetadata["denoiserUsed"] = "none";
  if (denoise.active) {
    if (denoise.method === "oidn") {
      warnings.push(OIDN_FALLBACK_WARNING);
    }
    denoiserUsed = "atrous";
  }
  const aovs = normalizeAovSelection(options.aovs);
  if (denoise.active) {
    // Native denoising always has albedo/normal AOVs available.
    if (denoise.guides.albedo) aovs.albedo = true;
    if (denoise.guides.normal) aovs.normal = true;
    if (denoise.guides.depth) aovs.depth = true;
  }
  const selected = (Object.keys(aovs) as AovName[]).filter((name) => aovs[name]);
  const begin: OfflineAccumulationOptions = {
    samples: targetSamples,
    seed: options.seed ?? null,
    aovs: selected,
    ...(options.previousCamera === undefined ? {} : { previousCamera: options.previousCamera }),
  };
  target.beginOfflineAccumulation(begin);

  let rendered = 0;
  let metrics: OfflineMetrics | undefined;
  const history: OfflineMetrics[] = [];
  const started = nowMs();
  try {
    while (rendered < targetSamples) {
      throwIfAborted(options.signal);
      const batch = Math.min(settings.batchSize, targetSamples - rendered);
      const result = await target.accumulateBatch(batch);
      rendered = result.totalSamples;
      const needMetrics =
        options.onProgress !== undefined || (settings.adaptive && rendered >= settings.minSamples);
      if (needMetrics) {
        metrics = await target.readAccumulationMetrics(settings.targetVariance, settings.tileSize);
        history.push(metrics);
      }
      if (options.onProgress !== undefined && metrics !== undefined) {
        options.onProgress(
          new OfflineProgress(
            rendered,
            targetSamples,
            metrics.meanDelta,
            metrics.p95Delta,
            metrics.convergedTileRatio,
            nowMs() - started,
          ),
        );
      }
      if (
        settings.adaptive &&
        rendered >= settings.minSamples &&
        metrics !== undefined &&
        hasUpwardConvergenceTrend(history) &&
        (metrics.convergedTileRatio >= settings.convergenceRatio ||
          metrics.p95Delta < settings.targetVariance)
      ) {
        break;
      }
    }
    throwIfAborted(options.signal);
    const resolved = await target.resolveOfflineHdr({
      ...(options.tonemap === undefined ? {} : { tonemap: options.tonemap }),
      denoise: denoise.active ? denoise : null,
    });
    const requested = normalizeAovSelection(options.aovs);
    const aovFrame = trimAovFrame(resolved.aovFrame, requested);
    const metadata: OfflineRenderMetadata = {
      samplesUsed: rendered,
      denoiserUsed,
      denoiserRequested: denoise.enabled ? denoise.method : "none",
      denoiseGuides: denoiserUsed === "none" ? [] : guidesOf(resolved),
      finalP95Delta: metrics === undefined ? null : metrics.p95Delta,
      convergedRatio: metrics === undefined ? null : metrics.convergedTileRatio,
      targetSamples,
      adaptive: settings.adaptive,
      tonemapOperator: options.tonemap?.operator ?? "display",
      elapsedMs: nowMs() - started,
      warnings,
    };
    return {
      frame: resolved.frame,
      hdrFrame: resolved.hdrFrame,
      aovFrame,
      metadata,
    };
  } finally {
    target.endOfflineAccumulation();
  }
}

function guidesOf(result: CaptureResult): string[] {
  const guides = (result as { denoiseGuides?: string[] }).denoiseGuides;
  return Array.isArray(guides) ? [...guides] : [];
}

/** Drops AOV channels that were only captured as denoise guides. */
function trimAovFrame(frame: AovFrame, requested: Record<AovName, boolean>): AovFrame {
  const keep = (name: AovName) => requested[name] && frame.channels().includes(name);
  return new AovFrame({
    width: frame.width,
    height: frame.height,
    near: frame.near,
    far: frame.far,
    ...(keep("albedo") ? { albedo: frame.albedo() } : {}),
    ...(keep("normal") ? { normal: frame.normal() } : {}),
    ...(keep("depth") ? { depth: frame.depth() } : {}),
    ...(keep("id") ? { id: frame.id() } : {}),
    ...(keep("motion") ? { motion: frame.motion() } : {}),
  });
}

/** One-sample capture: begin, accumulate, resolve and end. */
export async function captureOnce(
  target: OfflineRenderTarget,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const samples = integer("samples", options.samples ?? 1);
  target.beginOfflineAccumulation({
    ...options,
    aovs: options.aovs ?? DEFAULT_AOVS,
    samples,
  });
  try {
    let rendered = 0;
    while (rendered < samples) {
      throwIfAborted(options.signal);
      rendered = (await target.accumulateBatch(Math.min(256, samples - rendered))).totalSamples;
    }
    return await target.resolveOfflineHdr({
      ...(options.tonemap === undefined ? {} : { tonemap: options.tonemap }),
      ...(options.denoise === undefined ? {} : { denoise: options.denoise }),
    });
  } finally {
    target.endOfflineAccumulation();
  }
}

/** CPU/WASM A-trous reference (native `forge3d.denoise.atrous_denoise`). */
export async function atrousDenoise(input: HdrDenoiseInput): Promise<Float32Array> {
  const wasm = await loadOfflineWasm();
  try {
    return wasm.atrousDenoise(input);
  } catch (error) {
    throw Forge3DError.from(error);
  }
}

/** MSE, PSNR (native `_psnr`), Gaussian SSIM and max absolute error. */
export async function compareImages(
  a: Float32Array,
  b: Float32Array,
  options: ImageCompareOptions,
): Promise<ImageComparison> {
  const wasm = await loadOfflineWasm();
  try {
    return wasm.compareImages(a, b, options) as ImageComparison;
  } catch (error) {
    throw Forge3DError.from(error);
  }
}
