import { Forge3DError } from "./index.js";
import type {
  Forge3DMessageContext,
  Forge3DMessageHandler,
  HeightAoOptions,
  SunVisibilityOptions,
  TerrainColormapInput,
  TerrainColormapName,
  TerrainColorRampInput,
  TerrainContourPolyline,
  TerrainContourResult,
  TerrainDatasetInput,
  TerrainDatasetLoadOptions,
  TerrainDatasetSourceInput,
  TerrainHeightmapInput,
  TerrainNormalizationOptions,
  TerrainQueryResult,
  TerrainByteSource,
  TerrainScalarField,
  TerrainSlopeAspectResult,
  TerrainSourceProgress,
  TerrainStatistics,
} from "./index.js";
import type { Forge3DWorkerPool } from "./browser-resources.js";

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

interface NormalizedDatasetFields {
  width: number;
  height: number;
  heights: Float32Array;
  spacing: [number, number];
  exaggeration: number;
  domain: [number, number];
  nodata: number | undefined;
  crs: string | undefined;
  transform: [number, number, number, number, number, number] | undefined;
  bounds: [number, number, number, number] | undefined;
  colormap: TerrainColormapInput;
  statistics: TerrainStatistics;
}

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}

function isValidSample(value: number, nodata: number | undefined): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  if (nodata !== undefined && !Number.isNaN(nodata) && value === nodata) {
    return false;
  }
  return true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Forge3DError("REQUEST_CANCELLED", "Read was cancelled");
  }
}

function mapIoError(error: unknown): Forge3DError {
  if (error instanceof Forge3DError) {
    return error;
  }
  const name =
    typeof error === "object" && error !== null
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError") {
    return new Forge3DError("REQUEST_CANCELLED", message, error);
  }
  return new Forge3DError("IO_ERROR", message, error);
}

function sourceProgress(
  loaded: number,
  total: number | undefined,
  done: boolean,
): TerrainSourceProgress {
  return total === undefined ? { loaded, done } : { loaded, total, done };
}

interface TerrainSourceReadContext {
  expectedBytes: number;
  maxBytes: number | undefined;
  signal: AbortSignal | undefined;
  onProgress: ((progress: TerrainSourceProgress) => void) | undefined;
}

async function readTerrainSourceBuffer(
  source: TerrainByteSource,
  context: TerrainSourceReadContext,
): Promise<ArrayBuffer> {
  const { expectedBytes, signal, onProgress } = context;
  if (
    context.maxBytes !== undefined &&
    (!Number.isSafeInteger(context.maxBytes) || context.maxBytes <= 0)
  ) {
    throw invalid("maxBytes must be a positive safe integer");
  }
  const effectiveMax = Math.min(
    context.maxBytes ?? expectedBytes,
    expectedBytes,
  );
  const checkActual = (buffer: ArrayBuffer, total: number): ArrayBuffer => {
    throwIfAborted(signal);
    if (buffer.byteLength > effectiveMax) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        `terrain source payload exceeds the ${effectiveMax} byte limit`,
      );
    }
    if (buffer.byteLength !== expectedBytes) {
      throw new Forge3DError(
        "IO_ERROR",
        `terrain source payload contains ${buffer.byteLength} bytes; expected ${expectedBytes}`,
      );
    }
    onProgress?.(sourceProgress(expectedBytes, total, true));
    return buffer;
  };
  throwIfAborted(signal);

  if (source instanceof ArrayBuffer) {
    const total = source.byteLength;
    onProgress?.(sourceProgress(0, total, false));
    if (total > effectiveMax) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        `terrain source payload exceeds the ${effectiveMax} byte limit`,
      );
    }
    return checkActual(source.slice(0), total);
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    const total = source.size;
    onProgress?.(sourceProgress(0, total, false));
    if (total > effectiveMax) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        `terrain source payload exceeds the ${effectiveMax} byte limit`,
      );
    }
    let buffer: ArrayBuffer;
    try {
      buffer = await source.arrayBuffer();
    } catch (error) {
      throw mapIoError(error);
    }
    return checkActual(buffer, total);
  }
  if (typeof source === "string" || source instanceof URL) {
    let response: Response;
    try {
      response = await fetch(typeof source === "string" ? source : source.href, {
        credentials: "same-origin",
        signal: signal ?? null,
      });
    } catch (error) {
      throw mapIoError(error);
    }
    if (!response.ok) {
      throw new Forge3DError(
        "IO_ERROR",
        `HTTP request failed with status ${response.status}`,
        { status: response.status, url: String(source) },
      );
    }
    const header = response.headers.get("content-length");
    const declared =
      header === null ? undefined : Number(header);
    const total =
      declared !== undefined && Number.isSafeInteger(declared) && declared >= 0
        ? declared
        : undefined;
    onProgress?.(sourceProgress(0, total, false));
    if (total !== undefined && total > effectiveMax) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        `terrain source payload exceeds the ${effectiveMax} byte limit`,
      );
    }
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      throw mapIoError(error);
    }
    return checkActual(buffer, total ?? buffer.byteLength);
  }
  throw invalid("unsupported terrain byte source");
}

function validateRamp(ramp: unknown): TerrainColorRampInput {
  if (typeof ramp !== "object" || ramp === null) {
    throw invalid("colormap must be a named colormap or a color ramp object");
  }
  const stops = (ramp as TerrainColorRampInput).stops;
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 8) {
    throw invalid("colorRamp.stops must contain between 2 and 8 stops");
  }
  let previous = -Infinity;
  const normalizedStops = stops.map((stop, index) => {
    if (typeof stop !== "object" || stop === null) {
      throw invalid(`colorRamp.stops[${index}] must be an object`);
    }
    const position = stop.position;
    const color = stop.color;
    if (
      typeof position !== "number" ||
      !Number.isFinite(position) ||
      position < 0 ||
      position > 1
    ) {
      throw invalid(
        `colorRamp.stops[${index}].position must be finite and in [0, 1]`,
      );
    }
    if (position < previous) {
      throw invalid("colorRamp.stops positions must be ordered");
    }
    previous = position;
    if (!Array.isArray(color) || color.length !== 3) {
      throw invalid(`colorRamp.stops[${index}].color must have 3 channels`);
    }
    const channels: [number, number, number] = [color[0], color[1], color[2]];
    for (let channel = 0; channel < 3; channel += 1) {
      const value = channels[channel]!;
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw invalid(
          `colorRamp.stops[${index}].color[${channel}] must be finite and in [0, 1]`,
        );
      }
    }
    return { position, color: channels };
  });
  return { stops: normalizedStops };
}

function hex(color: number): [number, number, number] {
  return [
    ((color >> 16) & 0xff) / 255,
    ((color >> 8) & 0xff) / 255,
    (color & 0xff) / 255,
  ];
}

function namedRamp(colors: number[]): TerrainColorRampInput {
  const count = colors.length;
  return {
    stops: colors.map((color, index) => ({
      position: index / (count - 1),
      color: hex(color),
    })),
  };
}

const NAMED_COLORMAPS: Record<TerrainColormapName, TerrainColorRampInput> = {
  viridis: namedRamp([
    0x440154, 0x46327e, 0x365c8d, 0x277f8e, 0x1fa187, 0x4ac16d, 0xa0da39,
    0xfde725,
  ]),
  magma: namedRamp([
    0x000004, 0x1c1044, 0x4f127b, 0x812581, 0xb5367a, 0xe55063, 0xfb8761,
    0xfcfdbf,
  ]),
  terrain: {
    stops: [
      { position: 0.0, color: hex(0xc7d0b1) },
      { position: 0.1667, color: hex(0xd3e2c1) },
      { position: 0.3333, color: hex(0xf7f4c9) },
      { position: 0.5, color: hex(0xfce8ab) },
      { position: 0.6667, color: hex(0xe3b770) },
      { position: 0.8333, color: hex(0xb98935) },
      { position: 1.0, color: hex(0x745e37) },
    ],
  },
  grayscale: {
    stops: [
      { position: 0, color: [0, 0, 0] },
      { position: 1, color: [1, 1, 1] },
    ],
  },
};

export function getTerrainColormap(
  name: TerrainColormapName,
): TerrainColorRampInput {
  const ramp = NAMED_COLORMAPS[name];
  if (ramp === undefined) {
    throw invalid(`unknown terrain colormap ${String(name)}`);
  }
  return {
    stops: ramp.stops.map((stop) => ({
      position: stop.position,
      color: [...stop.color] as [number, number, number],
    })),
  };
}

export function getTerrainColormapLut(
  input: TerrainColormapInput,
  size = 256,
): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 2) {
    throw invalid("colormap LUT size must be an integer of at least 2");
  }
  const ramp =
    typeof input === "string" ? getTerrainColormap(input) : validateRamp(input);
  const stops = ramp.stops;
  const lut = new Uint8Array(size * 4);
  for (let index = 0; index < size; index += 1) {
    const t = index / (size - 1);
    let lower = stops[0]!;
    let upper = stops[stops.length - 1]!;
    for (const stop of stops) {
      if (stop.position <= t) {
        lower = stop;
      }
      if (stop.position >= t) {
        upper = stop;
        break;
      }
    }
    const span = upper.position - lower.position;
    const local = span > 0 ? (t - lower.position) / span : 0;
    const offset = index * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const lo = lower.color[channel]!;
      const hi = upper.color[channel]!;
      const value = lo + (hi - lo) * local;
      lut[offset + channel] = Math.round(Math.min(Math.max(value, 0), 1) * 255);
    }
    lut[offset + 3] = 255;
  }
  return lut;
}

function resolveColormap(input: TerrainColormapInput): TerrainColorRampInput {
  return typeof input === "string" ? getTerrainColormap(input) : input;
}

function finiteTuple<const N extends number>(
  value: readonly number[] | undefined,
  name: string,
  length: N,
): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    throw invalid(`${name} must contain ${length} finite numbers`);
  }
  return [...value];
}

function floatOrderKey(bits: number): number {
  return (bits & 0x80000000) !== 0 ? (~bits >>> 0) : ((bits ^ 0x80000000) >>> 0);
}

function bitsFromFloatOrderKey(key: number): number {
  return (key & 0x80000000) !== 0 ? ((key ^ 0x80000000) >>> 0) : (~key >>> 0);
}

function computeStatistics(
  heights: Float32Array,
  nodata: number | undefined,
  signal?: AbortSignal,
): { statistics: TerrainStatistics; validCount: number } {
  const sampleCount = heights.length;
  const bits = new Uint32Array(
    heights.buffer,
    heights.byteOffset,
    heights.length,
  );
  const scratchBits = new Uint32Array(1);
  const scratchFloats = new Float32Array(scratchBits.buffer);
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let mean = 0;
  let m2 = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    if ((index & 4095) === 0 && signal?.aborted) {
      throw new Forge3DError("REQUEST_CANCELLED", "Work was cancelled");
    }
    const value = heights[index]!;
    if (value === Infinity || value === -Infinity) {
      throw invalid("terrain heights must not contain Infinity");
    }
    if (!isValidSample(value, nodata)) {
      continue;
    }
    count += 1;
    min = Math.min(min, value);
    max = Math.max(max, value);
    const delta = value - mean;
    mean += delta / count;
    m2 += delta * (value - mean);
  }
  if (count === 0) {
    throw invalid("terrain heights must contain at least one valid sample");
  }
  const countLe = (key: number): number => {
    let total = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      if ((index & 4095) === 0 && signal?.aborted) {
        throw new Forge3DError("REQUEST_CANCELLED", "Work was cancelled");
      }
      if (
        isValidSample(heights[index]!, nodata) &&
        floatOrderKey(bits[index]!) <= key
      ) {
        total += 1;
      }
    }
    return total;
  };
  const rankValues = new Map<number, number>();
  const valueAtRank = (rank: number): number => {
    const cached = rankValues.get(rank);
    if (cached !== undefined) {
      return cached;
    }
    let lo = 0;
    let hi = 0xffffffff;
    while (lo < hi) {
      const mid = lo + ((hi - lo) >>> 1);
      if (countLe(mid) > rank) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    scratchBits[0] = bitsFromFloatOrderKey(lo);
    const value = scratchFloats[0]!;
    rankValues.set(rank, value);
    return value;
  };
  const quantile = (q: number): number => {
    const position = (count - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;
    return (
      valueAtRank(lower) + (valueAtRank(upper) - valueAtRank(lower)) * fraction
    );
  };
  return {
    statistics: {
      min,
      max,
      mean,
      std: Math.sqrt(Math.max(m2 / count, 0)),
      median: quantile(0.5),
      p01: quantile(0.01),
      p99: quantile(0.99),
      count,
      nodataCount: sampleCount - count,
    },
    validCount: count,
  };
}

function validateDatasetFields(
  input: {
    width: number;
    height: number;
    heights: Float32Array;
    spacing?: [number, number] | undefined;
    exaggeration?: number | undefined;
    domain?: [number, number] | undefined;
    nodata?: number | undefined;
    crs?: string | undefined;
    transform?: [number, number, number, number, number, number] | undefined;
    bounds?: [number, number, number, number] | undefined;
    colormap?: TerrainColormapInput | undefined;
  },
  signal?: AbortSignal,
): NormalizedDatasetFields {
  if (typeof input !== "object" || input === null) {
    throw invalid("terrain dataset input must be an object");
  }
  const { width, height, heights } = input;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw invalid("terrain width and height must be positive integers");
  }
  if (!(heights instanceof Float32Array)) {
    throw invalid("terrain heights must be a Float32Array");
  }
  if (heights.length !== width * height) {
    throw invalid(
      `terrain heights length ${heights.length} does not match width * height (${width * height})`,
    );
  }

  let spacing: [number, number] = [1, 1];
  if (input.spacing !== undefined) {
    const value = finiteTuple(input.spacing, "terrain spacing", 2)!;
    if (value[0]! <= 0 || value[1]! <= 0) {
      throw invalid("terrain spacing must be greater than zero");
    }
    spacing = [value[0]!, value[1]!];
  }

  let exaggeration = 1;
  if (input.exaggeration !== undefined) {
    if (
      typeof input.exaggeration !== "number" ||
      !Number.isFinite(input.exaggeration) ||
      input.exaggeration <= 0
    ) {
      throw invalid("terrain exaggeration must be finite and greater than zero");
    }
    exaggeration = input.exaggeration;
  }

  if (input.crs !== undefined) {
    if (typeof input.crs !== "string" || input.crs.length === 0) {
      throw invalid("terrain crs must be a non-empty string");
    }
  }

  let nodata: number | undefined;
  if (input.nodata !== undefined) {
    if (typeof input.nodata !== "number") {
      throw invalid("terrain nodata must be a number");
    }
    if (input.nodata === Infinity || input.nodata === -Infinity) {
      throw invalid("terrain nodata must not be infinite");
    }
    nodata = input.nodata;
  }

  const { statistics } = computeStatistics(heights, nodata, signal);

  let domain: [number, number];
  if (input.domain !== undefined) {
    const value = finiteTuple(input.domain, "terrain domain", 2)!;
    if (value[0]! > value[1]!) {
      throw invalid("terrain domain must be ordered");
    }
    domain = [value[0]!, value[1]!];
  } else {
    domain = [statistics.min, statistics.max];
  }
  if (domain[0] === domain[1]) {
    domain = [domain[0] - 0.5, domain[1] + 0.5];
  }

  const transform = finiteTuple(input.transform, "terrain transform", 6) as
    | [number, number, number, number, number, number]
    | undefined;
  const bounds = finiteTuple(input.bounds, "terrain bounds", 4) as
    | [number, number, number, number]
    | undefined;
  if (bounds !== undefined && (bounds[0] > bounds[2] || bounds[1] > bounds[3])) {
    throw invalid("terrain bounds must be ordered");
  }

  let colormap: TerrainColormapInput = "terrain";
  if (input.colormap !== undefined) {
    if (typeof input.colormap === "string") {
      getTerrainColormap(input.colormap as TerrainColormapName);
      colormap = input.colormap as TerrainColormapName;
    } else {
      colormap = validateRamp(input.colormap);
    }
  }

  return {
    width,
    height,
    heights,
    spacing,
    exaggeration,
    domain,
    nodata,
    crs: input.crs,
    transform,
    bounds,
    colormap,
    statistics,
  };
}

interface AnalysisOptions {
  enabled: boolean;
  resolutionScale: number;
  steps: number;
  maxDistance: number;
}

function validateResolutionScale(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const scale = value ?? fallback;
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 1) {
    throw invalid(`${name} resolutionScale must be between 0.1 and 1`);
  }
  return scale;
}

function normalizeAoOptions(
  options: HeightAoOptions | undefined,
): HeightfieldAoSettings {
  const defaults = {
    enabled: false,
    resolutionScale: 0.5,
    directions: 6,
    steps: 16,
    maxDistance: 200,
    strength: 1,
  };
  const merged = {
    enabled: options?.enabled ?? defaults.enabled,
    resolutionScale: validateResolutionScale(
      options?.resolutionScale,
      defaults.resolutionScale,
      "heightAo",
    ),
    directions: options?.directions ?? defaults.directions,
    steps: options?.steps ?? defaults.steps,
    maxDistance: options?.maxDistance ?? defaults.maxDistance,
    strength: options?.strength ?? defaults.strength,
  };
  if (
    !Number.isSafeInteger(merged.directions) ||
    merged.directions < 1 ||
    merged.directions > 16
  ) {
    throw invalid("heightAo directions must be between 1 and 16");
  }
  if (
    !Number.isSafeInteger(merged.steps) ||
    merged.steps < 1 ||
    merged.steps > 64
  ) {
    throw invalid("heightAo steps must be between 1 and 64");
  }
  if (!Number.isFinite(merged.maxDistance) || merged.maxDistance <= 0) {
    throw invalid("heightAo maxDistance must be a finite value greater than zero");
  }
  if (
    !Number.isFinite(merged.strength) ||
    merged.strength < 0 ||
    merged.strength > 2
  ) {
    throw invalid("heightAo strength must be between 0 and 2");
  }
  return merged;
}

interface HeightfieldAoSettings extends AnalysisOptions {
  directions: number;
  strength: number;
}

interface SunVisibilitySettings extends AnalysisOptions {
  mode: "hard" | "soft";
  samples: number;
  softness: number;
  bias: number;
  direction: [number, number, number];
}

function normalizeSunOptions(
  options: SunVisibilityOptions | undefined,
): SunVisibilitySettings {
  const mode = options?.mode ?? "hard";
  if (mode !== "hard" && mode !== "soft") {
    throw invalid("sunVisibility mode must be 'hard' or 'soft'");
  }
  const settings: SunVisibilitySettings = {
    enabled: options?.enabled ?? false,
    mode,
    resolutionScale: validateResolutionScale(
      options?.resolutionScale,
      0.5,
      "sunVisibility",
    ),
    samples: options?.samples ?? 4,
    steps: options?.steps ?? 24,
    maxDistance: options?.maxDistance ?? 400,
    softness: options?.softness ?? 1,
    bias: options?.bias ?? 0.01,
    direction: [0.3, 0.7, 0.2],
  };
  if (options?.direction !== undefined) {
    const direction = finiteTuple(options.direction, "sunVisibility.direction", 3)!;
    settings.direction = [direction[0]!, direction[1]!, direction[2]!];
  }
  const length = Math.hypot(
    settings.direction[0],
    settings.direction[1],
    settings.direction[2],
  );
  if (!Number.isFinite(length) || length <= 0) {
    throw invalid("sunVisibility direction must be a finite non-zero vector");
  }
  settings.direction = [
    settings.direction[0] / length,
    settings.direction[1] / length,
    settings.direction[2] / length,
  ];
  if (
    !Number.isSafeInteger(settings.samples) ||
    settings.samples < 1 ||
    settings.samples > 16
  ) {
    throw invalid("sunVisibility samples must be between 1 and 16");
  }
  if (!Number.isFinite(settings.softness) || settings.softness < 0) {
    throw invalid(
      "sunVisibility softness must be a finite non-negative value",
    );
  }
  if (
    !Number.isSafeInteger(settings.steps) ||
    settings.steps < 1 ||
    settings.steps > 64
  ) {
    throw invalid("sunVisibility steps must be between 1 and 64");
  }
  if (!Number.isFinite(settings.maxDistance) || settings.maxDistance <= 0) {
    throw invalid(
      "sunVisibility maxDistance must be a finite value greater than zero",
    );
  }
  if (!Number.isFinite(settings.bias) || settings.bias < 0) {
    throw invalid("sunVisibility bias must be a finite non-negative value");
  }
  if (mode === "hard") {
    settings.samples = 1;
    settings.softness = 0;
  }
  return settings;
}

function downslopeAspect(dzdx: number, dzdz: number): number {
  if (dzdx === 0 && dzdz === 0) {
    return 0;
  }
  const angle = Math.atan2(-dzdx, -dzdz);
  return angle < 0 ? angle + TWO_PI : angle;
}

function outputDimensions(
  width: number,
  height: number,
  scale: number,
): [number, number] {
  return [
    Math.max(Math.round(width * scale), 1),
    Math.max(Math.round(height * scale), 1),
  ];
}

export class TerrainDataset {
  static fromArray(input: TerrainDatasetInput): TerrainDataset {
    return new TerrainDataset(validateDatasetFields(input));
  }

  static async fromSource(
    input: TerrainDatasetSourceInput,
    options: TerrainDatasetLoadOptions = {},
  ): Promise<TerrainDataset> {
    if (typeof input !== "object" || input === null) {
      throw invalid("terrain dataset source input must be an object");
    }
    const width = input.width;
    const height = input.height;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1
    ) {
      throw invalid("terrain width and height must be positive integers");
    }
    const expectedBytes = width * height * 4;
    if (!Number.isSafeInteger(expectedBytes)) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "terrain source payload size overflowed",
      );
    }
    const buffer = await readTerrainSourceBuffer(input.source, {
      expectedBytes,
      maxBytes: input.maxBytes,
      signal: input.signal,
      onProgress: input.onProgress,
    });
    const metadata = {
      width,
      height,
      spacing: input.spacing,
      exaggeration: input.exaggeration,
      domain: input.domain,
      nodata: input.nodata,
      crs: input.crs,
      transform: input.transform,
      bounds: input.bounds,
      colormap: input.colormap,
    };
    if (options.workerPool !== undefined) {
      const heights = await (options.workerPool as Forge3DWorkerPool).run<
        Float32Array
      >(
        { ...metadata, buffer },
        {
          transfer: [buffer],
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
      );
      return new TerrainDataset(
        validateDatasetFields({ ...metadata, heights }, input.signal),
      );
    }
    const heights = new Float32Array(buffer, 0, width * height);
    return new TerrainDataset(
      validateDatasetFields({ ...metadata, heights }, input.signal),
    );
  }

  readonly width: number;
  readonly height: number;
  readonly heights: Float32Array;
  readonly spacing: [number, number];
  readonly exaggeration: number;
  readonly domain: [number, number];
  readonly nodata: number | undefined;
  readonly crs: string | undefined;
  readonly transform:
    | [number, number, number, number, number, number]
    | undefined;
  readonly bounds: [number, number, number, number] | undefined;
  readonly colormap: TerrainColormapInput;
  readonly statistics: TerrainStatistics;

  #mask?: Uint8Array;

  private constructor(fields: NormalizedDatasetFields) {
    this.width = fields.width;
    this.height = fields.height;
    this.heights = fields.heights;
    this.spacing = fields.spacing;
    this.exaggeration = fields.exaggeration;
    this.domain = fields.domain;
    this.nodata = fields.nodata;
    this.crs = fields.crs;
    this.transform = fields.transform;
    this.bounds = fields.bounds;
    this.colormap = fields.colormap;
    this.statistics = fields.statistics;
  }

  validMask(): Uint8Array {
    if (this.#mask === undefined) {
      const mask = new Uint8Array(this.heights.length);
      for (let index = 0; index < this.heights.length; index += 1) {
        mask[index] = isValidSample(this.heights[index]!, this.nodata) ? 1 : 0;
      }
      this.#mask = mask;
    }
    return this.#mask;
  }

  normalize(options: TerrainNormalizationOptions = {}): TerrainDataset {
    let domain = this.domain;
    if (options.domain !== undefined) {
      const value = finiteTuple(options.domain, "terrain domain", 2)!;
      if (value[0]! > value[1]!) {
        throw invalid("terrain domain must be ordered");
      }
      domain = [value[0]!, value[1]!];
    }
    if (domain[0] === domain[1]) {
      domain = [domain[0] - 0.5, domain[1] + 0.5];
    }
    let target: [number, number] = [0, 1];
    if (options.targetDomain !== undefined) {
      const value = finiteTuple(options.targetDomain, "terrain targetDomain", 2)!;
      if (value[0]! > value[1]!) {
        throw invalid("terrain targetDomain must be ordered");
      }
      target = [value[0]!, value[1]!];
    }
    if (target[0] === target[1]) {
      target = [target[0] - 0.5, target[1] + 0.5];
    }
    const clip = options.clip ?? false;
    const span = domain[1] - domain[0];
    const targetSpan = target[1] - target[0];
    const heights = new Float32Array(this.heights.length);
    for (let index = 0; index < this.heights.length; index += 1) {
      const value = this.heights[index]!;
      if (!isValidSample(value, this.nodata)) {
        heights[index] = value;
        continue;
      }
      let t = (value - domain[0]) / span;
      if (clip) {
        t = Math.min(Math.max(t, 0), 1);
      }
      heights[index] = Math.fround(target[0] + t * targetSpan);
    }
    return new TerrainDataset(
      validateDatasetFields({
        width: this.width,
        height: this.height,
        heights,
        spacing: this.spacing,
        exaggeration: this.exaggeration,
        domain: target,
        nodata: this.nodata,
        crs: this.crs,
        transform: this.transform,
        bounds: this.bounds,
        colormap: this.colormap,
      }),
    );
  }

  fillNodata(method: "nearest" | "mean" = "nearest"): TerrainDataset {
    if (method !== "nearest" && method !== "mean") {
      throw invalid("terrain fillNodata method must be 'nearest' or 'mean'");
    }
    const { width, height, nodata } = this;
    const heights = new Float32Array(this.heights);
    const validCells: number[] = [];
    for (let index = 0; index < heights.length; index += 1) {
      if (isValidSample(heights[index]!, nodata)) {
        validCells.push(index);
      }
    }
    if (method === "mean") {
      const mean = this.statistics.mean;
      for (let index = 0; index < heights.length; index += 1) {
        if (!isValidSample(heights[index]!, nodata)) {
          heights[index] = Math.fround(mean);
        }
      }
    } else {
      for (let index = 0; index < heights.length; index += 1) {
        if (isValidSample(heights[index]!, nodata)) {
          continue;
        }
        const x = index % width;
        const y = Math.floor(index / width);
        let bestDistance = Infinity;
        let bestValue = 0;
        for (const candidate of validCells) {
          const cx = candidate % width;
          const cy = Math.floor(candidate / width);
          const dx = cx - x;
          const dy = cy - y;
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            bestDistance = distance;
            bestValue = heights[candidate]!;
          }
        }
        heights[index] = bestValue;
      }
    }
    return new TerrainDataset(
      validateDatasetFields({
        width,
        height,
        heights,
        spacing: this.spacing,
        exaggeration: this.exaggeration,
        domain: this.domain,
        nodata: this.nodata,
        crs: this.crs,
        transform: this.transform,
        bounds: this.bounds,
        colormap: this.colormap,
      }),
    );
  }

  toTerrainInput(): TerrainHeightmapInput {
    const input: TerrainHeightmapInput = {
      width: this.width,
      height: this.height,
      heights: this.heights,
      spacing: [...this.spacing],
      exaggeration: this.exaggeration,
      domain: [...this.domain],
      colorRamp: resolveColormap(this.colormap),
    };
    if (this.nodata !== undefined) {
      input.nodata = this.nodata;
    }
    if (this.crs !== undefined) {
      input.crs = this.crs;
    }
    return input;
  }

  slopeAspect(): TerrainSlopeAspectResult {
    const { width, height } = this;
    const count = width * height;
    const slope = new Float32Array(count).fill(NaN);
    const aspect = new Float32Array(count).fill(NaN);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!this.isValid(x, y)) {
          continue;
        }
        const [dzdx, dzdz] = this.gradientAt(x, y);
        const index = y * width + x;
        slope[index] = Math.atan(Math.hypot(dzdx, dzdz));
        aspect[index] = downslopeAspect(dzdx, dzdz);
      }
    }
    return { width, height, slopeRadians: slope, aspectRadians: aspect };
  }

  contours(levels: readonly number[]): TerrainContourResult {
    if (!Array.isArray(levels) || levels.length === 0) {
      throw invalid("contour levels must not be empty");
    }
    for (const level of levels) {
      if (typeof level !== "number" || !Number.isFinite(level)) {
        throw invalid("contour levels must be finite");
      }
    }
    const { width, height } = this;
    if (width < 2 || height < 2) {
      throw invalid("terrain dimensions must be at least 2 to extract contours");
    }
    const polylines: TerrainContourPolyline[] = [];
    const halfX = ((width - 1) * this.spacing[0]) / 2;
    const halfZ = ((height - 1) * this.spacing[1]) / 2;
    const cornerX = [0, 1, 1, 0];
    const cornerY = [0, 0, 1, 1];
    const toPhysical = (gx: number, gy: number): [number, number] => [
      gx * this.spacing[0] - halfX,
      gy * this.spacing[1] - halfZ,
    ];
    let totalPoints = 0;
    const pushSegment = (
      level: number,
      a: [number, number],
      b: [number, number],
    ): void => {
      polylines.push({ level, points: Float32Array.of(a[0], a[1], b[0], b[1]) });
      totalPoints += 2;
    };
    for (const level of levels) {
      for (let y = 0; y < height - 1; y += 1) {
        for (let x = 0; x < width - 1; x += 1) {
          if (
            !this.isValid(x, y) ||
            !this.isValid(x + 1, y) ||
            !this.isValid(x + 1, y + 1) ||
            !this.isValid(x, y + 1)
          ) {
            continue;
          }
          const corners = [
            this.sample(x, y),
            this.sample(x + 1, y),
            this.sample(x + 1, y + 1),
            this.sample(x, y + 1),
          ];
          let caseIndex = 0;
          for (let i = 0; i < 4; i += 1) {
            if (corners[i]! >= level) {
              caseIndex |= 1 << i;
            }
          }
          if (caseIndex === 0 || caseIndex === 15) {
            continue;
          }
          const edge = (a: number, b: number): [number, number] => {
            const denominator = corners[b]! - corners[a]!;
            const t =
              denominator === 0 ? 0.5 : (level - corners[a]!) / denominator;
            const gx = x + cornerX[a]! + (cornerX[b]! - cornerX[a]!) * t;
            const gy = y + cornerY[a]! + (cornerY[b]! - cornerY[a]!) * t;
            return toPhysical(gx, gy);
          };
          switch (caseIndex) {
            case 1:
            case 14:
              pushSegment(level, edge(0, 3), edge(0, 1));
              break;
            case 2:
            case 13:
              pushSegment(level, edge(0, 1), edge(1, 2));
              break;
            case 3:
            case 12:
              pushSegment(level, edge(0, 3), edge(1, 2));
              break;
            case 4:
            case 11:
              pushSegment(level, edge(1, 2), edge(3, 2));
              break;
            case 6:
            case 9:
              pushSegment(level, edge(0, 1), edge(3, 2));
              break;
            case 7:
            case 8:
              pushSegment(level, edge(0, 3), edge(3, 2));
              break;
            case 5: {
              const determinant =
                (corners[0]! - level) * (corners[2]! - level) -
                (corners[1]! - level) * (corners[3]! - level);
              if (determinant >= 0) {
                pushSegment(level, edge(0, 1), edge(1, 2));
                pushSegment(level, edge(0, 3), edge(3, 2));
              } else {
                pushSegment(level, edge(0, 3), edge(0, 1));
                pushSegment(level, edge(1, 2), edge(3, 2));
              }
              break;
            }
            case 10: {
              const determinant =
                (corners[0]! - level) * (corners[2]! - level) -
                (corners[1]! - level) * (corners[3]! - level);
              if (determinant <= 0) {
                pushSegment(level, edge(0, 3), edge(0, 1));
                pushSegment(level, edge(1, 2), edge(3, 2));
              } else {
                pushSegment(level, edge(0, 1), edge(1, 2));
                pushSegment(level, edge(0, 3), edge(3, 2));
              }
              break;
            }
          }
        }
      }
    }
    return { polylines, polylineCount: polylines.length, totalPoints };
  }

  query(x: number, z: number): TerrainQueryResult | undefined {
    const { width, height } = this;
    if (!Number.isFinite(x) || !Number.isFinite(z) || width < 2 || height < 2) {
      return undefined;
    }
    const gx = x / this.spacing[0] + (width - 1) / 2;
    const gz = z / this.spacing[1] + (height - 1) / 2;
    if (gx < 0 || gx > width - 1 || gz < 0 || gz > height - 1) {
      return undefined;
    }
    const x0 = Math.min(Math.max(Math.floor(gx), 0), width - 2);
    const y0 = Math.min(Math.max(Math.floor(gz), 0), height - 2);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = gx - x0;
    const fz = gz - y0;
    const h00 = this.sample(x0, y0);
    const h10 = this.sample(x1, y0);
    const h01 = this.sample(x0, y1);
    const h11 = this.sample(x1, y1);
    const allValid =
      this.isValid(x0, y0) &&
      this.isValid(x1, y0) &&
      this.isValid(x0, y1) &&
      this.isValid(x1, y1);
    if (!allValid) {
      return {
        elevation: NaN,
        slopeRadians: NaN,
        aspectRadians: NaN,
        worldPosition: [x, NaN, z],
        normal: [NaN, NaN, NaN],
        gridPosition: [gx, gz],
      };
    }
    const elevation =
      h00 * (1 - fx) * (1 - fz) +
      h10 * fx * (1 - fz) +
      h01 * (1 - fx) * fz +
      h11 * fx * fz;
    const dhdx =
      (((h10 - h00) * (1 - fz) + (h11 - h01) * fz) / this.spacing[0]) *
      this.exaggeration;
    const dhdz =
      (((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / this.spacing[1]) *
      this.exaggeration;
    const slope = Math.atan(Math.hypot(dhdx, dhdz));
    const aspect = downslopeAspect(dhdx, dhdz);
    const normalLength = Math.hypot(dhdx, 1, dhdz);
    return {
      elevation,
      slopeRadians: slope,
      aspectRadians: aspect,
      worldPosition: [
        x,
        (elevation - this.domain[0]) * this.exaggeration,
        z,
      ],
      normal: [-dhdx / normalLength, 1 / normalLength, -dhdz / normalLength],
      gridPosition: [gx, gz],
    };
  }

  heightAo(options?: HeightAoOptions): TerrainScalarField {
    const settings = normalizeAoOptions(options);
    const [outW, outH] = outputDimensions(
      this.width,
      this.height,
      settings.resolutionScale,
    );
    const values = new Float32Array(outW * outH).fill(1);
    if (settings.enabled) {
      const extentX = this.spacing[0] * this.width;
      const extentY = this.spacing[1] * this.height;
      const maxUv = settings.maxDistance / Math.max(extentX, extentY);
      const stepUv = maxUv / settings.steps;
      for (let py = 0; py < outH; py += 1) {
        for (let px = 0; px < outW; px += 1) {
          const u = (px + 0.5) / outW;
          const v = (py + 0.5) / outH;
          const center = this.worldHeightAtUv(u, v);
          if (center === undefined) {
            values[py * outW + px] = NaN;
            continue;
          }
          let occlusion = 0;
          for (let direction = 0; direction < settings.directions; direction += 1) {
            const angle = (TWO_PI * direction) / settings.directions;
            const dirX = Math.cos(angle);
            const dirY = Math.sin(angle);
            let maxTan = -999;
            for (let step = 1; step <= settings.steps; step += 1) {
              const su = u + dirX * stepUv * step;
              const sv = v + dirY * stepUv * step;
              if (su < 0 || su >= 1 || sv < 0 || sv >= 1) {
                break;
              }
              const sample = this.worldHeightAtUv(su, sv);
              if (sample === undefined) {
                continue;
              }
              const dx = (su - u) * extentX;
              const dy = (sv - v) * extentY;
              const distance = Math.hypot(dx, dy);
              if (distance > 0.001) {
                maxTan = Math.max(maxTan, (sample - center) / distance);
              }
            }
            if (maxTan > -999) {
              occlusion += Math.min(Math.max(Math.atan(maxTan) / HALF_PI, 0), 1);
            }
          }
          const ao = 1 - occlusion / settings.directions;
          values[py * outW + px] = 1 + (ao - 1) * settings.strength;
        }
      }
    }
    return { kind: "height-ao", width: outW, height: outH, values };
  }

  sunVisibility(options?: SunVisibilityOptions): TerrainScalarField {
    const settings = normalizeSunOptions(options);
    const [outW, outH] = outputDimensions(
      this.width,
      this.height,
      settings.resolutionScale,
    );
    const values = new Float32Array(outW * outH).fill(1);
    if (settings.enabled) {
      const horizontalX = settings.direction[0];
      const horizontalZ = settings.direction[2];
      const horizontalLength = Math.hypot(horizontalX, horizontalZ);
      if (horizontalLength >= 0.001) {
        const marchX = horizontalX / horizontalLength;
        const marchZ = horizontalZ / horizontalLength;
        const sunTan = settings.direction[1] / horizontalLength;
        const extentX = this.spacing[0] * this.width;
        const extentY = this.spacing[1] * this.height;
        const maxUv = settings.maxDistance / Math.max(extentX, extentY);
        const stepUv = maxUv / settings.steps;
        const soft = settings.softness > 0;
        for (let py = 0; py < outH; py += 1) {
          for (let px = 0; px < outW; px += 1) {
            const u = (px + 0.5) / outW;
            const v = (py + 0.5) / outH;
            const center = this.worldHeightAtUv(u, v);
            if (center === undefined) {
              values[py * outW + px] = NaN;
              continue;
            }
            let total = 0;
            for (let sampleIndex = 0; sampleIndex < settings.samples; sampleIndex += 1) {
              const jitter = (sampleIndex - (settings.samples - 1) * 0.5) * 0.1;
              const jitteredX = marchX + jitter;
              const jitteredZ = marchZ - jitter;
              const jitteredLength = Math.hypot(jitteredX, jitteredZ);
              const dirX = jitteredX / jitteredLength;
              const dirZ = jitteredZ / jitteredLength;
              let visibility = 1;
              let occlusion = 0;
              for (let step = 1; step <= settings.steps; step += 1) {
                const su = u + dirX * stepUv * step;
                const sv = v + dirZ * stepUv * step;
                if (su < 0 || su >= 1 || sv < 0 || sv >= 1) {
                  break;
                }
                const sample = this.worldHeightAtUv(su, sv);
                if (sample === undefined) {
                  continue;
                }
                const dx = (su - u) * extentX;
                const dy = (sv - v) * extentY;
                const distance = Math.hypot(dx, dy);
                if (distance <= 0.001) {
                  continue;
                }
                const expected = center + settings.bias + distance * sunTan;
                const diff = sample - expected;
                if (diff > 0) {
                  if (soft) {
                    const t = Math.min(Math.max(diff / settings.softness, 0), 1);
                    occlusion = Math.max(occlusion, t * t * (3 - 2 * t));
                  } else {
                    visibility = 0;
                    break;
                  }
                }
              }
              if (soft) {
                visibility = 1 - occlusion;
              }
              total += visibility;
            }
            values[py * outW + px] = total / settings.samples;
          }
        }
      }
    }
    return { kind: "sun-visibility", width: outW, height: outH, values };
  }

  estimatedCpuBytes(): number {
    return this.heights.byteLength + (this.#mask?.byteLength ?? 0);
  }

  private sample(x: number, y: number): number {
    return this.heights[y * this.width + x]!;
  }

  private isValid(x: number, y: number): boolean {
    return isValidSample(this.sample(x, y), this.nodata);
  }

  private worldHeight(x: number, y: number): number {
    return (this.sample(x, y) - this.domain[0]) * this.exaggeration;
  }

  private worldHeightAtUv(u: number, v: number): number | undefined {
    const x = Math.min(Math.max(Math.trunc(u * this.width), 0), this.width - 1);
    const y = Math.min(
      Math.max(Math.trunc(v * this.height), 0),
      this.height - 1,
    );
    if (!this.isValid(x, y)) {
      return undefined;
    }
    return this.worldHeight(x, y);
  }

  private gradientAt(x: number, y: number): [number, number] {
    const { width, height } = this;
    const center = this.sample(x, y);
    const xm = Math.max(x - 1, 0);
    const xp = Math.min(x + 1, width - 1);
    const ym = Math.max(y - 1, 0);
    const yp = Math.min(y + 1, height - 1);
    const left = this.isValid(xm, y) ? this.sample(xm, y) : center;
    const right = this.isValid(xp, y) ? this.sample(xp, y) : center;
    const below = this.isValid(x, ym) ? this.sample(x, ym) : center;
    const above = this.isValid(x, yp) ? this.sample(x, yp) : center;
    const dzdx =
      xp === xm
        ? 0
        : ((right - left) / ((xp - xm) * this.spacing[0])) * this.exaggeration;
    const dzdz =
      yp === ym
        ? 0
        : ((above - below) / ((yp - ym) * this.spacing[1])) * this.exaggeration;
    return [dzdx, dzdz];
  }
}

export function createTerrainDatasetWorkerHandler(): Forge3DMessageHandler {
  return (payload: unknown, context: Forge3DMessageContext) => {
    if (context.signal.aborted) {
      throw new Forge3DError("REQUEST_CANCELLED", "Work was cancelled");
    }
    const input = payload as TerrainDatasetInput & { buffer?: ArrayBuffer };
    let heights = input.heights;
    if (heights === undefined && input.buffer instanceof ArrayBuffer) {
      if (input.buffer.byteLength % 4 !== 0) {
        throw invalid("terrain source buffer length is not a multiple of 4");
      }
      heights = new Float32Array(input.buffer);
    }
    const fields = validateDatasetFields(
      { ...input, heights },
      context.signal,
    );
    return fields.heights;
  };
}
