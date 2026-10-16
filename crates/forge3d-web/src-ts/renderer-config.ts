import { Forge3DError } from "./index.js";
import { normalizeLightInput } from "./lighting.js";
import { resolveBrdfModel } from "./materials.js";
import type {
  BrdfRoute,
  LightSlotConfig,
  MaterialSlotConfig,
  RendererConfigData,
  RendererConfigInput,
  RendererConfigSource,
  RendererPresetName,
} from "./index.js";

const DEFAULT_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

const RENDER_QUALITIES = new Set(["ultra", "high", "medium", "low"]);
const OVERFLOW_POLICIES = new Set(["reject", "downscale"]);
const TIMESTAMP_MODES = new Set(["auto", "disabled"]);

const PRESET_ORDER: readonly RendererPresetName[] = Object.freeze([
  "studio-pbr",
  "outdoor-sun",
  "toon-viz",
  "rainier-showcase",
  "rainier-relief",
]);

const PRESETS: Record<RendererPresetName, RendererConfigInput> = {
  "studio-pbr": {
    lighting: {
      exposure: 1,
      lights: [
        {
          type: "directional",
          direction: [-0.3, -0.95, -0.2],
          intensity: 6,
          color: [1, 0.98, 0.95],
        },
      ],
    },
    shading: {
      brdf: "disney-principled",
      roughness: 0.35,
      metallic: 0,
      normalMaps: true,
    },
    shadows: { enabled: true, technique: "pcf", mapSize: 2048, cascades: 1 },
    gi: { modes: [] },
    atmosphere: { enabled: false },
  },
  "outdoor-sun": {
    lighting: {
      exposure: 1,
      lights: [
        {
          type: "directional",
          direction: [-0.35, -1, -0.25],
          intensity: 5,
          color: [1, 0.97, 0.92],
        },
      ],
    },
    shading: {
      brdf: "cooktorrance-ggx",
      roughness: 0.5,
      metallic: 0,
      normalMaps: true,
    },
    shadows: { enabled: true, technique: "pcf", mapSize: 2048, cascades: 3 },
    gi: { modes: [] },
    atmosphere: { enabled: true, sky: "hosek-wilkie" },
  },
  "toon-viz": {
    lighting: {
      exposure: 1,
      lights: [
        {
          type: "directional",
          direction: [-0.4, -0.9, -0.1],
          intensity: 4,
          color: [1, 1, 1],
        },
      ],
    },
    shading: { brdf: "toon", normalMaps: false },
    shadows: { enabled: true, technique: "hard", mapSize: 1024, cascades: 1 },
    gi: { modes: [] },
    atmosphere: { enabled: false },
  },
  "rainier-showcase": {
    lighting: {
      exposure: 1,
      lights: [
        {
          type: "directional",
          direction: [0.64, 0.42, -0.64],
          intensity: 4,
          color: [1, 0.95, 0.9],
        },
      ],
    },
    shading: {
      brdf: "cooktorrance-ggx",
      roughness: 0.6,
      metallic: 0,
      normalMaps: true,
    },
    shadows: { enabled: true, technique: "pcss", mapSize: 4096, cascades: 4 },
    gi: { modes: ["ibl"] },
    atmosphere: { enabled: true, sky: "hdri" },
  },
  "rainier-relief": {
    lighting: {
      exposure: 1.2,
      lights: [
        {
          type: "directional",
          direction: [-0.6724985119639573, 0.3090169943749474, -0.6724985119639575],
          intensity: 5,
          color: [1, 0.92, 0.85],
        },
      ],
    },
    shading: {
      brdf: "cooktorrance-ggx",
      roughness: 0.55,
      metallic: 0,
      normalMaps: true,
    },
    shadows: { enabled: true, technique: "pcss", mapSize: 4096, cascades: 4 },
    gi: { modes: ["ibl"] },
    atmosphere: { enabled: true, sky: "hdri" },
  },
};

export class RendererConfig {
  readonly #data: RendererConfigData;

  constructor(input?: RendererConfigInput) {
    this.#data = mergeConfig(defaultConfigData(), input ?? {});
    validateConfigData(this.#data);
  }

  static from(source?: RendererConfigSource): RendererConfig {
    if (source === undefined) {
      return new RendererConfig();
    }
    if (source instanceof RendererConfig) {
      return source.copy();
    }
    if (typeof source === "string") {
      return RendererConfig.preset(source as RendererPresetName);
    }
    return new RendererConfig(source);
  }

  static preset(name: RendererPresetName): RendererConfig {
    const preset = PRESETS[name];
    if (preset === undefined) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `Unknown renderer preset: ${String(name)}`,
      );
    }
    return new RendererConfig(deepCopy(preset));
  }

  validate(): this {
    validateConfigData(this.#data);
    return this;
  }

  copy(overrides?: RendererConfigInput): RendererConfig {
    return new RendererConfig(mergeConfig(this.toJSON(), overrides ?? {}));
  }

  toJSON(): RendererConfigData {
    return deepCopy(this.#data);
  }

  getBrdfRoute(): BrdfRoute {
    return resolveBrdfModel(this.#data.brdfOverride ?? this.#data.shading.brdf);
  }
}

export function rendererPresetNames(): readonly RendererPresetName[] {
  return Object.freeze([...PRESET_ORDER]);
}

export function getRendererPreset(name: RendererPresetName): RendererConfig {
  return RendererConfig.preset(name);
}

function defaultConfigData(): RendererConfigData {
  return {
    quality: "high",
    memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    overflowPolicy: "downscale",
    timestampMode: "auto",
    sampleCount: 1,
    lighting: { exposure: 1, lights: [] },
    materials: {},
    shading: {
      brdf: "cooktorrance-ggx",
      roughness: 0.5,
      metallic: 0,
      normalMaps: true,
    },
    shadows: { enabled: false, technique: "pcf", mapSize: 2048, cascades: 1 },
    gi: { modes: [], ambientOcclusionStrength: 0 },
    atmosphere: { enabled: false, sky: "hosek-wilkie" },
  };
}

function mergeConfig(
  base: RendererConfigData,
  input: RendererConfigInput,
): RendererConfigData {
  const merged = deepCopy(base);
  if (input.quality !== undefined) merged.quality = input.quality;
  if (input.memoryBudgetBytes !== undefined) {
    merged.memoryBudgetBytes = input.memoryBudgetBytes;
  }
  if (input.overflowPolicy !== undefined) {
    merged.overflowPolicy = input.overflowPolicy;
  }
  if (input.timestampMode !== undefined) {
    merged.timestampMode = input.timestampMode;
  }
  if (input.sampleCount !== undefined) merged.sampleCount = input.sampleCount;
  if (input.lighting !== undefined) {
    merged.lighting = {
      exposure: input.lighting.exposure ?? merged.lighting.exposure,
      lights:
        input.lighting.lights !== undefined
          ? deepCopy(input.lighting.lights)
          : merged.lighting.lights,
    };
  }
  if (input.materials !== undefined) {
    merged.materials = deepCopy(input.materials);
  }
  if (input.shading !== undefined) {
    merged.shading = { ...merged.shading, ...deepCopy(input.shading) };
  }
  if (input.shadows !== undefined) {
    merged.shadows = { ...merged.shadows, ...deepCopy(input.shadows) };
  }
  if (input.gi !== undefined) {
    merged.gi = {
      modes:
        input.gi.modes !== undefined ? deepCopy(input.gi.modes) : merged.gi.modes,
      ambientOcclusionStrength:
        input.gi.ambientOcclusionStrength ?? merged.gi.ambientOcclusionStrength,
    };
  }
  if (input.atmosphere !== undefined) {
    merged.atmosphere = {
      ...merged.atmosphere,
      ...deepCopy(input.atmosphere),
    };
  }
  if (input.brdfOverride === null) {
    delete merged.brdfOverride;
  } else if (input.brdfOverride !== undefined) {
    merged.brdfOverride = input.brdfOverride;
  }
  return merged;
}

function validateConfigData(data: RendererConfigData): void {
  if (!RENDER_QUALITIES.has(data.quality)) {
    invalid("quality", "must be ultra, high, medium, or low");
  }
  if (!Number.isSafeInteger(data.memoryBudgetBytes) || data.memoryBudgetBytes <= 0) {
    invalid("memoryBudgetBytes", "must be a positive safe integer");
  }
  if (!OVERFLOW_POLICIES.has(data.overflowPolicy)) {
    invalid("overflowPolicy", "must be reject or downscale");
  }
  if (!TIMESTAMP_MODES.has(data.timestampMode)) {
    invalid("timestampMode", "must be auto or disabled");
  }
  if (data.sampleCount !== 1 && data.sampleCount !== 4) {
    invalid("sampleCount", "must be 1 or 4");
  }
  validateLighting(data.lighting);
  validateMaterials(data.materials);
  validateShading(data.shading);
  validateShadows(data.shadows);
  validateGi(data.gi);
  validateAtmosphere(data.atmosphere);
  if (data.brdfOverride !== undefined) {
    if (data.brdfOverride.length === 0) {
      invalid("brdfOverride", "must be a nonempty string");
    }
    try {
      resolveBrdfModel(data.brdfOverride);
    } catch {
      invalid("brdfOverride", `unknown brdf model '${data.brdfOverride}'`);
    }
  }
}

function validateLighting(lighting: RendererConfigData["lighting"]): void {
  if (!Number.isFinite(lighting.exposure) || lighting.exposure < 0) {
    invalid("lighting.exposure", "must be finite and nonnegative");
  }
  for (const light of lighting.lights) {
    validateLight(light);
  }
}

function validateLight(light: LightSlotConfig): void {
  normalizeLightInput(light);
}

function validateMaterials(materials: Record<string, MaterialSlotConfig>): void {
  for (const [slot, material] of Object.entries(materials)) {
    if (slot.length === 0) {
      invalid("materials", "slot keys must be nonempty");
    }
    if (typeof material.id !== "string" || material.id.length === 0) {
      invalid("material.id", "must be a nonempty string");
    }
    if (typeof material.model !== "string" || material.model.length === 0) {
      invalid("material.model", "must be a nonempty string");
    }
    for (const value of Object.values(material.parameters)) {
      if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          invalid("material.parameters", "numeric parameters must be finite");
        }
        continue;
      }
      if (typeof value === "boolean" || typeof value === "string") {
        continue;
      }
      if (Array.isArray(value)) {
        const valid =
          value.length === 4 &&
          value.every(
            (component) =>
              typeof component === "number" &&
              Number.isFinite(component) &&
              component >= 0 &&
              component <= 1,
          );
        if (!valid) {
          invalid(
            "material.parameters",
            "tuple parameters must contain exactly four finite components in the 0..1 range",
          );
        }
        continue;
      }
      invalid(
        "material.parameters",
        "must be number, boolean, string, or a four-component color tuple",
      );
    }
  }
}

function validateShading(shading: RendererConfigData["shading"]): void {
  if (typeof shading.brdf !== "string" || shading.brdf.length === 0) {
    invalid("shading.brdf", "must be a nonempty string");
  }
  try {
    resolveBrdfModel(shading.brdf);
  } catch {
    invalid("shading.brdf", `unknown brdf model '${shading.brdf}'`);
  }
  validateUnitInterval(shading.roughness, "shading.roughness");
  validateUnitInterval(shading.metallic, "shading.metallic");
  if (typeof shading.normalMaps !== "boolean") {
    invalid("shading.normalMaps", "must be a boolean");
  }
}

function validateShadows(shadows: RendererConfigData["shadows"]): void {
  if (typeof shadows.enabled !== "boolean") {
    invalid("shadows.enabled", "must be a boolean");
  }
  if (typeof shadows.technique !== "string" || shadows.technique.length === 0) {
    invalid("shadows.technique", "must be a nonempty string");
  }
  const technique = shadows.technique.trim().toLowerCase();
  if (technique === "csm") {
    invalid("shadows.technique", "csm is a cascade pipeline, not a shadow filter");
  }
  if (
    technique !== "none" &&
    !["hard", "pcf", "pcss", "vsm", "evsm", "msm"].includes(technique)
  ) {
    invalid("shadows.technique", `unknown shadow technique "${shadows.technique}"`);
  }
  if (!Number.isSafeInteger(shadows.mapSize) || shadows.mapSize <= 0) {
    invalid("shadows.mapSize", "must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(shadows.cascades) ||
    shadows.cascades < 1 ||
    shadows.cascades > 4
  ) {
    invalid("shadows.cascades", "must be an integer between 1 and 4");
  }
  if (
    shadows.enabled &&
    (shadows.mapSize < 256 ||
      shadows.mapSize > 4096 ||
      (shadows.mapSize & (shadows.mapSize - 1)) !== 0)
  ) {
    invalid(
      "shadows.mapSize",
      "must be a power of two between 256 and 4096 when shadows are enabled",
    );
  }
}

function validateGi(gi: RendererConfigData["gi"]): void {
  for (const mode of gi.modes) {
    if (typeof mode !== "string" || mode.length === 0) {
      invalid("gi.modes", "must contain only nonempty strings");
    }
  }
  validateUnitInterval(gi.ambientOcclusionStrength, "gi.ambientOcclusionStrength");
}

function validateAtmosphere(atmosphere: RendererConfigData["atmosphere"]): void {
  if (typeof atmosphere.enabled !== "boolean") {
    invalid("atmosphere.enabled", "must be a boolean");
  }
  if (typeof atmosphere.sky !== "string" || atmosphere.sky.length === 0) {
    invalid("atmosphere.sky", "must be a nonempty string");
  }
  if (atmosphere.hdrUrl !== undefined && atmosphere.hdrUrl.length === 0) {
    invalid("atmosphere.hdrUrl", "must be a nonempty string");
  }
}

function validateUnitInterval(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    invalid(field, "must be finite and in the 0..1 range");
  }
}

function invalid(field: string, message: string): never {
  throw new Forge3DError("INVALID_INPUT", `${field} ${message}`, { field });
}

function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepCopy(entry)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = deepCopy(entry);
    }
    return copy as T;
  }
  return value;
}
