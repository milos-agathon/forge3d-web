// Terrain PBR/POM material settings (W07, parity rows T05-T07).
//
// Mirrors the native `terrain_params.py` dataclasses and
// `forge3d-core::terrain_material`: every omitted field takes the native
// default, validation messages keep the native wording under a
// `material.<field>` path, and images are copied so later caller mutation
// cannot change a committed material.
import { Forge3DError } from "./index.js";
import type {
  TerrainAlbedoMode,
  TerrainHeightCurveMode,
  TerrainMaterialDebugView,
  TerrainMaterialImage,
  TerrainMaterialInput,
  TerrainMaterialLayerInput,
  TerrainMaterialLayerSnapshot,
  TerrainMaterialMask,
  TerrainMaterialSnapshot,
  TerrainPomMode,
  TerrainSamplingAddress,
  TerrainSamplingFilter,
  TerrainSpecularAaQuality,
} from "./index.js";

export const TERRAIN_MATERIAL_LAYER_CAPACITY = 4;
export const TERRAIN_HEIGHT_CURVE_LUT_SIZE = 256;

const ALBEDO_MODES: readonly TerrainAlbedoMode[] = ["material", "colormap", "mix"];
const POM_MODES: readonly TerrainPomMode[] = ["occlusion", "relief", "parallax"];
const CURVE_MODES: readonly TerrainHeightCurveMode[] = [
  "linear",
  "pow",
  "smoothstep",
  "lut",
];
const FILTERS: readonly TerrainSamplingFilter[] = ["linear", "nearest"];
const ADDRESSES: readonly TerrainSamplingAddress[] = [
  "repeat",
  "clamp-to-edge",
  "mirror-repeat",
];
const SPECULAR_AA: readonly TerrainSpecularAaQuality[] = [
  "off",
  "native",
  "medium",
  "high",
];
const DEBUG_VIEWS: readonly TerrainMaterialDebugView[] = [
  "none",
  "material-albedo",
  "triplanar-weights",
  "triplanar-checker",
  "pom-offset",
  "specular-aa-variance",
  "roughness",
  "layer-weights",
  "subsurface",
];

/** Native `MaterialSet.terrain_default()`: rock, grass, dirt and snow. */
const DEFAULT_LAYERS: readonly Omit<TerrainMaterialLayerSnapshot, "texture">[] = [
  { baseColor: [0.28, 0.26, 0.24], roughness: 0.5, metallic: 0 },
  { baseColor: [0.18, 0.38, 0.1], roughness: 0.85, metallic: 0 },
  { baseColor: [0.35, 0.25, 0.15], roughness: 0.5, metallic: 0 },
  { baseColor: [0.95, 0.97, 1.0], roughness: 0.25, metallic: 0 },
];

function invalid(field: string, message: string): Forge3DError {
  return new Forge3DError(
    "INVALID_INPUT",
    `Invalid input material.${field}: ${message}`,
    { field: `material.${field}` },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function section(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw invalid(field, "must be an object");
  }
  return value;
}

function finite(value: unknown, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw invalid(field, "must be finite");
  }
  return result;
}

function inRange(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  max: number,
  message: string,
): number {
  const result = finite(value, fallback, field);
  if (result < min || result > max) {
    throw invalid(field, message);
  }
  return result;
}

function positive(
  value: unknown,
  fallback: number,
  field: string,
  message = "must be > 0",
): number {
  const result = finite(value, fallback, field);
  if (!(result > 0)) {
    throw invalid(field, message);
  }
  return result;
}

function integer(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  max: number,
  message: string,
): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isSafeInteger(result)) {
    throw invalid(field, "must be an integer");
  }
  if (result < min || result > max) {
    throw invalid(field, message);
  }
  return result;
}

function bool(value: unknown, fallback: boolean, field: string): boolean {
  const result = value ?? fallback;
  if (typeof result !== "boolean") {
    throw invalid(field, "must be a boolean");
  }
  return result;
}

function oneOf<T extends string>(
  value: unknown,
  fallback: T,
  allowed: readonly T[],
  field: string,
): T {
  const result = value ?? fallback;
  if (typeof result !== "string" || !allowed.includes(result as T)) {
    throw invalid(field, `must be one of ${allowed.join(", ")}`);
  }
  return result as T;
}

function color(
  value: unknown,
  fallback: readonly [number, number, number],
  field: string,
  arityMessage: string,
  componentMessage?: string,
): [number, number, number] {
  const result = value ?? fallback;
  if (!Array.isArray(result) || result.length !== 3) {
    throw invalid(field, arityMessage);
  }
  return result.map((component) => {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw invalid(field, "components must be finite");
    }
    if (componentMessage !== undefined && (component < 0 || component > 1)) {
      throw invalid(field, componentMessage);
    }
    return component;
  }) as [number, number, number];
}

function ordered(
  value: unknown,
  fallback: readonly [number, number],
  field: string,
  nativeName: string,
): [number, number] {
  const result = value ?? fallback;
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    typeof result[0] !== "number" ||
    typeof result[1] !== "number" ||
    !Number.isFinite(result[0]) ||
    !Number.isFinite(result[1])
  ) {
    throw invalid(field, "must be two finite numbers");
  }
  if (result[0] >= result[1]) {
    throw invalid(field, `${nativeName}: min must be < max`);
  }
  return [result[0], result[1]];
}

function image(value: unknown, field: string): TerrainMaterialImage | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw invalid(field, "must be an object with width, height and data");
  }
  const width = value.width;
  const height = value.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw invalid(field, "width and height must be positive integers");
  }
  if (!(value.data instanceof Uint8Array)) {
    throw invalid(field, "data must be a Uint8Array");
  }
  return { width, height, data: value.data.slice() };
}

function mask(value: unknown, field: string): TerrainMaterialMask | null {
  return image(value, field);
}

function heightCurveLut(value: unknown): Float32Array | null {
  if (value === undefined || value === null) {
    return null;
  }
  const values =
    value instanceof Float32Array
      ? value
      : Array.isArray(value)
        ? Float32Array.from(value as number[])
        : undefined;
  if (values === undefined || values.length !== TERRAIN_HEIGHT_CURVE_LUT_SIZE) {
    throw invalid(
      "heightCurve.lut",
      "height_curve_lut must be a 1D float32 array of length 256",
    );
  }
  if (values.some((entry) => !Number.isFinite(entry))) {
    throw invalid("heightCurve.lut", "height_curve_lut must contain finite values");
  }
  if (values.some((entry) => entry < 0 || entry > 1)) {
    throw invalid(
      "heightCurve.lut",
      "height_curve_lut values must be within [0, 1]",
    );
  }
  return values.slice();
}

function materialLayer(
  value: TerrainMaterialLayerInput | undefined,
  index: number,
): TerrainMaterialLayerSnapshot {
  const field = `materialSet[${index}]`;
  const input = section(value, field);
  const fallback = DEFAULT_LAYERS[index] ?? DEFAULT_LAYERS[0]!;
  const roughness = finite(input.roughness, fallback.roughness, `${field}.roughness`);
  if (roughness < 0.04 || roughness > 1) {
    throw invalid(`${field}.roughness`, "roughness must be in [0.04, 1.0]");
  }
  return {
    baseColor: color(
      input.baseColor,
      fallback.baseColor,
      `${field}.baseColor`,
      "must be (R, G, B)",
      "components must be in [0, 1]",
    ),
    roughness,
    metallic: inRange(
      input.metallic,
      fallback.metallic,
      `${field}.metallic`,
      0,
      1,
      "metallic must be in [0, 1]",
    ),
    texture: image(input.texture, `${field}.texture`),
  };
}

function materialSet(value: unknown): TerrainMaterialLayerSnapshot[] {
  if (value === undefined || value === null) {
    return DEFAULT_LAYERS.map((_, index) => materialLayer(undefined, index));
  }
  if (!Array.isArray(value)) {
    throw invalid("materialSet", "must be an array");
  }
  if (value.length === 0 || value.length > TERRAIN_MATERIAL_LAYER_CAPACITY) {
    throw invalid("materialSet", "must contain between 1 and 4 layers");
  }
  return value.map((layer, index) =>
    materialLayer(layer as TerrainMaterialLayerInput | undefined, index),
  );
}

/**
 * Resolves a partial terrain material against the native defaults and
 * validates it with the native rules. Throws `INVALID_INPUT`.
 */
export function normalizeTerrainMaterial(
  input: TerrainMaterialInput = {},
): TerrainMaterialSnapshot {
  if (!isRecord(input)) {
    throw invalid("", "must be an object");
  }
  const triplanar = section(input.triplanar, "triplanar");
  const pom = section(input.pom, "pom");
  const lod = section(input.lod, "lod");
  const sampling = section(input.sampling, "sampling");
  const clamp = section(input.clamp, "clamp");
  const curve = section(input.heightCurve, "heightCurve");
  const layers = section(input.layers, "layers");
  const snow = section(layers.snow, "layers.snow");
  const rock = section(layers.rock, "layers.rock");
  const wetness = section(layers.wetness, "layers.wetness");
  const variation = section(layers.variation, "layers.variation");
  const detail = section(input.detail, "detail");
  const specularAa = section(input.specularAa, "specularAa");

  const colormapStrength = inRange(
    input.colormapStrength,
    1,
    "colormapStrength",
    0,
    1,
    "colormap_strength must be 0-1",
  );
  const gamma = finite(input.gamma, 2.2, "gamma");
  if (gamma < 0.1) {
    throw invalid("gamma", "must be >= 0.1");
  }

  const minSteps = integer(pom.minSteps, 12, "pom.minSteps", 1, Number.MAX_SAFE_INTEGER, "min_steps must be >= 1");
  const maxSteps = integer(pom.maxSteps, 40, "pom.maxSteps", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "");
  if (maxSteps < minSteps) {
    throw invalid("pom.maxSteps", "max_steps must be >= min_steps");
  }
  if (maxSteps > 100) {
    throw invalid("pom.maxSteps", "max_steps must be <= 100");
  }

  const curveMode = oneOf(curve.mode, "linear", CURVE_MODES, "heightCurve.mode");
  const lut = heightCurveLut(curve.lut);
  if (curveMode === "lut" && lut === null) {
    throw invalid(
      "heightCurve.lut",
      "height_curve_lut is required when height_curve_mode='lut'",
    );
  }

  const fadeStart = finite(detail.fadeStart, 50, "detail.fadeStart");
  if (fadeStart < 0) {
    throw invalid("detail.fadeStart", "fade_start must be >= 0");
  }
  const fadeEnd = finite(detail.fadeEnd, 200, "detail.fadeEnd");
  if (!(fadeEnd > fadeStart)) {
    throw invalid("detail.fadeEnd", "fade_end must be > fade_start");
  }

  const amplitude = (name: string, nativeName: string): number =>
    inRange(
      variation[name],
      0,
      `layers.variation.${name}`,
      0,
      1,
      `${nativeName} must be in [0, 1]`,
    );
  const tint = (value: unknown, field: string, nativeName: string) =>
    color(
      value,
      [1, 1, 1],
      field,
      `${nativeName} must be (R, G, B)`,
      `${nativeName} components must be in [0, 1]`,
    );
  const unit = (value: unknown, fallback: number, field: string, nativeName: string) =>
    inRange(value, fallback, field, 0, 1, `${nativeName} must be in [0, 1]`);

  const heightRange =
    clamp.heightRange === undefined || clamp.heightRange === null
      ? null
      : ordered(clamp.heightRange, [0, 1], "clamp.heightRange", "height_range");

  return {
    albedoMode: oneOf(input.albedoMode, "colormap", ALBEDO_MODES, "albedoMode"),
    colormapStrength,
    gamma,
    colormapSrgb: bool(input.colormapSrgb, false, "colormapSrgb"),
    outputSrgbEotf: bool(input.outputSrgbEotf, false, "outputSrgbEotf"),
    lambertContrast: inRange(
      input.lambertContrast,
      0,
      "lambertContrast",
      0,
      1,
      "lambert_contrast must be in [0, 1]",
    ),
    roughnessMultiplier: positive(input.roughnessMultiplier, 1, "roughnessMultiplier"),
    hueVariation: inRange(input.hueVariation, 0.08, "hueVariation", 0, 1, "must be in [0, 1]"),
    materialSet: materialSet(input.materialSet),
    triplanar: {
      scale: positive(triplanar.scale, 6, "triplanar.scale", "scale must be > 0"),
      blendSharpness: positive(
        triplanar.blendSharpness,
        4,
        "triplanar.blendSharpness",
        "blend_sharpness must be > 0",
      ),
      normalStrength: inRange(
        triplanar.normalStrength,
        1,
        "triplanar.normalStrength",
        0,
        Number.MAX_VALUE,
        "normal_strength must be >= 0",
      ),
    },
    pom: {
      enabled: bool(pom.enabled, false, "pom.enabled"),
      mode: oneOf(pom.mode, "occlusion", POM_MODES, "pom.mode"),
      scale: inRange(pom.scale, 0.04, "pom.scale", 0, Number.MAX_VALUE, "scale must be >= 0"),
      minSteps,
      maxSteps,
      refineSteps: integer(
        pom.refineSteps,
        4,
        "pom.refineSteps",
        0,
        Number.MAX_SAFE_INTEGER,
        "refine_steps must be >= 0",
      ),
      shadow: bool(pom.shadow, true, "pom.shadow"),
      occlusion: bool(pom.occlusion, true, "pom.occlusion"),
    },
    lod: {
      level: integer(lod.level, 0, "lod.level", 0, Number.MAX_SAFE_INTEGER, "level must be >= 0"),
      bias: finite(lod.bias, 0, "lod.bias"),
      lod0Bias: finite(lod.lod0Bias, -0.5, "lod.lod0Bias"),
    },
    sampling: {
      magFilter: oneOf(sampling.magFilter, "linear", FILTERS, "sampling.magFilter"),
      minFilter: oneOf(sampling.minFilter, "linear", FILTERS, "sampling.minFilter"),
      mipFilter: oneOf(sampling.mipFilter, "linear", FILTERS, "sampling.mipFilter"),
      anisotropy: integer(
        sampling.anisotropy,
        8,
        "sampling.anisotropy",
        1,
        16,
        "anisotropy must be 1-16",
      ),
      addressU: oneOf(sampling.addressU, "repeat", ADDRESSES, "sampling.addressU"),
      addressV: oneOf(sampling.addressV, "repeat", ADDRESSES, "sampling.addressV"),
      addressW: oneOf(sampling.addressW, "repeat", ADDRESSES, "sampling.addressW"),
    },
    clamp: {
      heightRange,
      slopeRange: ordered(clamp.slopeRange, [0.04, 1], "clamp.slopeRange", "slope_range"),
      ambientRange: ordered(clamp.ambientRange, [0.22, 0.38], "clamp.ambientRange", "ambient_range"),
      shadowRange: ordered(clamp.shadowRange, [0.3, 1], "clamp.shadowRange", "shadow_range"),
      occlusionRange: ordered(
        clamp.occlusionRange,
        [0.65, 1],
        "clamp.occlusionRange",
        "occlusion_range",
      ),
    },
    heightCurve: {
      mode: curveMode,
      strength: unit(curve.strength, 0, "heightCurve.strength", "height_curve_strength"),
      power: positive(
        curve.power,
        1,
        "heightCurve.power",
        "height_curve_power must be > 0",
      ),
      lut,
    },
    layers: {
      snow: {
        enabled: bool(snow.enabled, false, "layers.snow.enabled"),
        altitudeMin: finite(snow.altitudeMin, 2000, "layers.snow.altitudeMin"),
        altitudeBlend: positive(
          snow.altitudeBlend,
          500,
          "layers.snow.altitudeBlend",
          "snow_altitude_blend must be > 0",
        ),
        slopeMax: inRange(
          snow.slopeMax,
          45,
          "layers.snow.slopeMax",
          0,
          90,
          "snow_slope_max must be in [0, 90]",
        ),
        slopeBlend: positive(
          snow.slopeBlend,
          15,
          "layers.snow.slopeBlend",
          "snow_slope_blend must be > 0",
        ),
        aspectInfluence: unit(
          snow.aspectInfluence,
          0.3,
          "layers.snow.aspectInfluence",
          "snow_aspect_influence",
        ),
        color: color(snow.color, [0.95, 0.95, 0.98], "layers.snow.color", "snow_color must be (R, G, B)"),
        roughness: unit(snow.roughness, 0.4, "layers.snow.roughness", "snow_roughness"),
        subsurfaceStrength: unit(
          snow.subsurfaceStrength,
          0,
          "layers.snow.subsurfaceStrength",
          "snow_subsurface_strength",
        ),
        subsurfaceTint: tint(snow.subsurfaceTint, "layers.snow.subsurfaceTint", "snow_subsurface_tint"),
        mask: mask(snow.mask, "layers.snow.mask"),
      },
      rock: {
        enabled: bool(rock.enabled, false, "layers.rock.enabled"),
        slopeMin: inRange(
          rock.slopeMin,
          45,
          "layers.rock.slopeMin",
          0,
          90,
          "rock_slope_min must be in [0, 90]",
        ),
        slopeBlend: positive(
          rock.slopeBlend,
          10,
          "layers.rock.slopeBlend",
          "rock_slope_blend must be > 0",
        ),
        color: color(rock.color, [0.35, 0.32, 0.28], "layers.rock.color", "rock_color must be (R, G, B)"),
        roughness: unit(rock.roughness, 0.8, "layers.rock.roughness", "rock_roughness"),
        subsurfaceStrength: unit(
          rock.subsurfaceStrength,
          0,
          "layers.rock.subsurfaceStrength",
          "rock_subsurface_strength",
        ),
        subsurfaceTint: tint(rock.subsurfaceTint, "layers.rock.subsurfaceTint", "rock_subsurface_tint"),
        mask: mask(rock.mask, "layers.rock.mask"),
      },
      wetness: {
        enabled: bool(wetness.enabled, false, "layers.wetness.enabled"),
        strength: unit(wetness.strength, 0.3, "layers.wetness.strength", "wetness_strength"),
        slopeInfluence: unit(
          wetness.slopeInfluence,
          0.5,
          "layers.wetness.slopeInfluence",
          "wetness_slope_influence",
        ),
        subsurfaceStrength: unit(
          wetness.subsurfaceStrength,
          0,
          "layers.wetness.subsurfaceStrength",
          "wetness_subsurface_strength",
        ),
        subsurfaceTint: tint(
          wetness.subsurfaceTint,
          "layers.wetness.subsurfaceTint",
          "wetness_subsurface_tint",
        ),
        mask: mask(wetness.mask, "layers.wetness.mask"),
      },
      variation: {
        macroScale: positive(
          variation.macroScale,
          3.5,
          "layers.variation.macroScale",
          "macro_scale must be > 0",
        ),
        detailScale: positive(
          variation.detailScale,
          18,
          "layers.variation.detailScale",
          "detail_scale must be > 0",
        ),
        octaves: integer(
          variation.octaves,
          4,
          "layers.variation.octaves",
          1,
          8,
          "octaves must be in [1, 8]",
        ),
        snowMacroAmplitude: amplitude("snowMacroAmplitude", "snow_macro_amplitude"),
        snowDetailAmplitude: amplitude("snowDetailAmplitude", "snow_detail_amplitude"),
        rockMacroAmplitude: amplitude("rockMacroAmplitude", "rock_macro_amplitude"),
        rockDetailAmplitude: amplitude("rockDetailAmplitude", "rock_detail_amplitude"),
        wetnessMacroAmplitude: amplitude("wetnessMacroAmplitude", "wetness_macro_amplitude"),
        wetnessDetailAmplitude: amplitude("wetnessDetailAmplitude", "wetness_detail_amplitude"),
      },
    },
    detail: {
      enabled: bool(detail.enabled, false, "detail.enabled"),
      scale: positive(detail.scale, 2, "detail.scale", "detail_scale must be > 0"),
      normalStrength: unit(detail.normalStrength, 0.3, "detail.normalStrength", "normal_strength"),
      albedoNoise: inRange(
        detail.albedoNoise,
        0.1,
        "detail.albedoNoise",
        0,
        0.5,
        "albedo_noise must be in [0, 0.5]",
      ),
      fadeStart,
      fadeEnd,
      sigmaPx: positive(detail.sigmaPx, 3, "detail.sigmaPx", "detail_sigma_px must be > 0"),
      strength: unit(detail.strength, 0, "detail.strength", "detail_strength"),
      normalMap: image(detail.normalMap, "detail.normalMap"),
    },
    specularAa: {
      quality: oneOf(specularAa.quality, "native", SPECULAR_AA, "specularAa.quality"),
      sigmaScale: positive(specularAa.sigmaScale, 1, "specularAa.sigmaScale"),
    },
    debugView: oneOf(input.debugView, "none", DEBUG_VIEWS, "debugView"),
  };
}

/** The native-default (zero-feature) terrain material. */
export function getTerrainMaterialDefaults(): TerrainMaterialSnapshot {
  return normalizeTerrainMaterial({});
}

/** Size of the packed `TerrainMaterialUniform` (forge3d-core). */
export const TERRAIN_MATERIAL_UNIFORM_BYTES = (29 + 64) * 16;

function rgba8MipChainBytes(width: number, height: number, layers: number): number {
  let total = 0;
  let w = Math.max(width, 1);
  let h = Math.max(height, 1);
  for (;;) {
    total += w * h * layers * 4;
    if (w === 1 && h === 1) {
      return total;
    }
    w = Math.max(Math.floor(w / 2), 1);
    h = Math.max(Math.floor(h / 2), 1);
  }
}

/**
 * Upper-bound GPU bytes for a terrain material before budget downscaling:
 * the albedo array at the first texture's size with a full mip chain, the
 * detail-normal/mask array and the uniform. The runtime ledger reports the
 * admitted size.
 */
export function estimateTerrainMaterialBytes(input: TerrainMaterialInput | undefined): number {
  if (input === undefined) {
    return 0;
  }
  const material = normalizeTerrainMaterial(input);
  const layers = material.materialSet.length;
  const canonical = material.materialSet.find((layer) => layer.texture !== null)?.texture;
  const albedo =
    canonical === undefined || canonical === null
      ? layers * 4
      : rgba8MipChainBytes(canonical.width, canonical.height, layers);
  let auxWidth = 1;
  let auxHeight = 1;
  for (const image of [
    material.detail.normalMap,
    material.layers.snow.mask,
    material.layers.rock.mask,
    material.layers.wetness.mask,
  ]) {
    if (image !== null) {
      auxWidth = Math.max(auxWidth, image.width);
      auxHeight = Math.max(auxHeight, image.height);
    }
  }
  return albedo + auxWidth * auxHeight * 4 * 2 + TERRAIN_MATERIAL_UNIFORM_BYTES;
}
