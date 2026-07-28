import { Forge3DError } from "./index.js";
import type {
  ResizeInput,
  TerrainHeightmapInput,
  TerrainHeightmapSourceInput,
  ViewerResourceBudget,
  ViewerResourceOptions,
} from "./index.js";

export const DESKTOP_RESOURCE_BUDGET: Readonly<ViewerResourceBudget> =
  Object.freeze({
    maxTerrainSamples: 1_048_576,
    maxSourceBytes: 4_194_304,
    maxCanvasPixels: 8_294_400,
    maxScreenshotPixels: 8_294_400,
  });

export const MOBILE_RESOURCE_BUDGET: Readonly<ViewerResourceBudget> =
  Object.freeze({
    maxTerrainSamples: 262_144,
    maxSourceBytes: 1_048_576,
    maxCanvasPixels: 2_073_600,
    maxScreenshotPixels: 2_073_600,
  });

export function resolveResourceBudget(
  options: ViewerResourceOptions | undefined,
): ViewerResourceBudget {
  const preset =
    options?.preset === "mobile"
      ? MOBILE_RESOURCE_BUDGET
      : DESKTOP_RESOURCE_BUDGET;
  const overrides = options?.budget ?? {};
  const result: ViewerResourceBudget = {
    maxTerrainSamples:
      overrides.maxTerrainSamples ?? preset.maxTerrainSamples,
    maxSourceBytes: overrides.maxSourceBytes ?? preset.maxSourceBytes,
    maxCanvasPixels: overrides.maxCanvasPixels ?? preset.maxCanvasPixels,
    maxScreenshotPixels:
      overrides.maxScreenshotPixels ?? preset.maxScreenshotPixels,
  };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `${name} must be a finite positive integer`,
      );
    }
  }
  return result;
}

export function validateTerrainAgainstBudget(
  terrain: TerrainHeightmapInput,
  budget: ViewerResourceBudget,
  maxTextureDimension2D: number,
): number {
  const samples = checkedSamples(
    terrain.width,
    terrain.height,
    maxTextureDimension2D,
  );
  if (terrain.heights.length !== samples) {
    throw new Forge3DError(
      "INVALID_INPUT",
      `heights length ${terrain.heights.length} does not match ${samples} samples`,
    );
  }
  if (samples > budget.maxTerrainSamples) {
    throw limitError("terrain samples", samples, budget.maxTerrainSamples);
  }
  if (
    terrain.colorRamp !== undefined &&
    (!Array.isArray(terrain.colorRamp.stops) ||
      terrain.colorRamp.stops.length < 2 ||
      terrain.colorRamp.stops.length > 8)
  ) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "colorRamp.stops must contain between 2 and 8 stops",
    );
  }
  return samples;
}

export function validateSourceAgainstBudget(
  terrain: TerrainHeightmapSourceInput,
  budget: ViewerResourceBudget,
  maxTextureDimension2D: number,
): number {
  const samples = checkedSamples(
    terrain.width,
    terrain.height,
    maxTextureDimension2D,
  );
  if (samples > budget.maxTerrainSamples) {
    throw limitError("terrain samples", samples, budget.maxTerrainSamples);
  }
  const expectedBytes = checkedMultiply(samples, 4, "terrain byte length");
  if (
    terrain.byteLength !== undefined &&
    terrain.byteLength !== expectedBytes
  ) {
    throw new Forge3DError(
      "INVALID_INPUT",
      `byteLength must equal width * height * 4 (${expectedBytes})`,
    );
  }
  if (expectedBytes > budget.maxSourceBytes) {
    throw limitError("terrain source bytes", expectedBytes, budget.maxSourceBytes);
  }
  const knownBytes = knownSourceByteLength(terrain.source);
  if (knownBytes !== undefined) {
    const offset = terrain.byteOffset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "byteOffset must be a non-negative safe integer",
      );
    }
    const available = knownBytes - offset;
    const selected = terrain.byteLength ?? available;
    if (available < 0 || selected !== expectedBytes || selected > available) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `selected source payload must contain exactly ${expectedBytes} bytes`,
      );
    }
  }
  return expectedBytes;
}

export function validateScreenshotBudget(
  width: number,
  height: number,
  budget: ViewerResourceBudget,
): void {
  const pixels = checkedMultiply(width, height, "screenshot pixels");
  if (pixels > budget.maxScreenshotPixels) {
    throw limitError(
      "screenshot pixels",
      pixels,
      budget.maxScreenshotPixels,
    );
  }
}

export function validateExplicitResize(
  size: ResizeInput,
): void {
  for (const [name, value] of Object.entries(size)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Forge3DError("INVALID_INPUT", `${name} must be finite and positive`);
    }
  }
}

function checkedSamples(
  width: number,
  height: number,
  maxTextureDimension2D: number,
): number {
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `${name} must be a positive safe integer`,
      );
    }
    if (value > maxTextureDimension2D) {
      throw limitError(name, value, maxTextureDimension2D);
    }
  }
  return checkedMultiply(width, height, "terrain samples");
}

function checkedMultiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw new Forge3DError(
      "RESOURCE_LIMIT_EXCEEDED",
      `${label} exceeds JavaScript safe integer limits`,
    );
  }
  return value;
}

function knownSourceByteLength(
  source: TerrainHeightmapSourceInput["source"],
): number | undefined {
  if (source instanceof ArrayBuffer) {
    return source.byteLength;
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    return source.size;
  }
  return undefined;
}

function limitError(
  resource: string,
  requested: number,
  maximum: number,
): Forge3DError {
  return new Forge3DError(
    "RESOURCE_LIMIT_EXCEEDED",
    `${resource} ${requested} exceeds limit ${maximum}`,
    { resource, requested, maximum },
  );
}
