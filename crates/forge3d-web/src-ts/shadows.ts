import { Forge3DError } from "./index.js";
import type {
  CascadedShadowConfigInput,
  CascadedShadowConfigSnapshot,
  ShadowCascadeInfo,
  ShadowConfigInput,
  ShadowConfigSnapshot,
  ShadowDebugView,
  ShadowFilter,
  ShadowReport,
  ShadowSnapshot,
} from "./index.js";

export const SHADOW_MAP_MIN = 256;
export const SHADOW_MAP_MAX = 4096;
export const SHADOW_MAX_CASCADES = 4;
const SHADOW_UNIFORM_BYTES = 368;
const SHADOW_DEPTH_UNIFORM_BYTES = 64;

export const SHADOW_FILTERS: readonly ShadowFilter[] = [
  "hard",
  "pcf",
  "pcss",
  "vsm",
  "evsm",
  "msm",
];
const MOMENT_FILTERS: readonly ShadowFilter[] = ["vsm", "evsm", "msm"];
const SHADOW_DEBUG_VIEWS: readonly ShadowDebugView[] = [
  "none",
  "cascades",
  "shadow-factor",
];
const MOMENT_FORMATS: readonly ShadowReport["momentFormat"][] = [
  "none",
  "rgba32float",
];

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalFinite(
  value: unknown,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw invalid(`${name} must be finite`);
  }
  return result;
}

function optionalNonnegative(
  value: unknown,
  fallback: number,
  name: string,
): number {
  const result = optionalFinite(value, fallback, name);
  if (result < 0) {
    throw invalid(`${name} must be nonnegative`);
  }
  return result;
}

export function parseShadowFilter(value: string): ShadowFilter {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid("shadow filter must be a nonempty string");
  }
  const lowered = value.trim().toLowerCase();
  if (lowered === "csm") {
    throw invalid("csm is a cascade pipeline, not a shadow filter");
  }
  const match = SHADOW_FILTERS.find((filter) => filter === lowered);
  if (match === undefined) {
    throw invalid(`unknown shadow filter "${value}"`);
  }
  return match;
}

export function shadowFilterRequiresMoments(filter: ShadowFilter): boolean {
  return MOMENT_FILTERS.includes(filter);
}

function optionalDebugView(
  value: unknown,
  fallback: ShadowDebugView,
): ShadowDebugView {
  const result = value ?? fallback;
  if (
    typeof result !== "string" ||
    !SHADOW_DEBUG_VIEWS.includes(result as ShadowDebugView)
  ) {
    throw invalid(`unknown shadow debug view "${String(result)}"`);
  }
  return result as ShadowDebugView;
}

function normalizeMapSize(value: unknown, fallback: number): number {
  const result = value ?? fallback;
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < SHADOW_MAP_MIN ||
    result > SHADOW_MAP_MAX ||
    (result & (result - 1)) !== 0
  ) {
    throw invalid(
      `mapSize must be a power of two between ${SHADOW_MAP_MIN} and ${SHADOW_MAP_MAX}`,
    );
  }
  return result;
}

function normalizeCascadeCount(
  value: unknown,
  fallback: 2 | 3 | 4,
): 2 | 3 | 4 {
  const result = value ?? fallback;
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < 2 ||
    result > SHADOW_MAX_CASCADES
  ) {
    throw invalid("cascadeCount must be an integer between 2 and 4");
  }
  return result as 2 | 3 | 4;
}

export class ShadowConfig {
  readonly #snapshot: ShadowConfigSnapshot;

  constructor(input?: ShadowConfigInput) {
    const source = input ?? {};
    if (!isRecord(source)) {
      throw invalid("shadow config input must be an object");
    }
    const enabledInput = source.enabled ?? false;
    if (typeof enabledInput !== "boolean") {
      throw invalid("enabled must be a boolean");
    }
    let enabled = enabledInput;
    const filterInput = source.filter ?? "pcf";
    if (typeof filterInput !== "string" || filterInput.length === 0) {
      throw invalid("filter must be a nonempty string");
    }
    let filter: ShadowFilter = "pcf";
    if (filterInput.trim().toLowerCase() === "none") {
      enabled = false;
    } else {
      filter = parseShadowFilter(filterInput);
    }
    const mapSize = normalizeMapSize(source.mapSize, 2048);
    const depthBias = optionalNonnegative(source.depthBias, 0.002, "depthBias");
    const normalBias = optionalNonnegative(
      source.normalBias,
      0.02,
      "normalBias",
    );
    const slopeBias = optionalNonnegative(source.slopeBias, 0.01, "slopeBias");
    const softness = optionalNonnegative(source.softness, 1.0, "softness");
    const pcssBlockerRadius = optionalNonnegative(
      source.pcssBlockerRadius,
      2.0,
      "pcssBlockerRadius",
    );
    const pcssFilterRadius = optionalNonnegative(
      source.pcssFilterRadius,
      4.0,
      "pcssFilterRadius",
    );
    const lightSize = optionalFinite(source.lightSize, 0.25, "lightSize");
    if (lightSize <= 0) {
      throw invalid("lightSize must be greater than zero");
    }
    const momentBias = optionalNonnegative(
      source.momentBias,
      0.0005,
      "momentBias",
    );
    const lightBleedReduction = optionalFinite(
      source.lightBleedReduction,
      0.2,
      "lightBleedReduction",
    );
    if (lightBleedReduction < 0 || lightBleedReduction >= 1) {
      throw invalid("lightBleedReduction must be in [0, 1)");
    }
    const evsmPositiveExponent = optionalFinite(
      source.evsmPositiveExponent,
      5.0,
      "evsmPositiveExponent",
    );
    if (evsmPositiveExponent <= 0 || evsmPositiveExponent > 10) {
      throw invalid("evsmPositiveExponent must be in (0, 10]");
    }
    const evsmNegativeExponent = optionalFinite(
      source.evsmNegativeExponent,
      5.0,
      "evsmNegativeExponent",
    );
    if (evsmNegativeExponent <= 0 || evsmNegativeExponent > 10) {
      throw invalid("evsmNegativeExponent must be in (0, 10]");
    }
    const peterPanningOffset = optionalNonnegative(
      source.peterPanningOffset,
      0.001,
      "peterPanningOffset",
    );
    this.#snapshot = {
      enabled,
      filter,
      mapSize,
      depthBias,
      normalBias,
      slopeBias,
      softness,
      pcssBlockerRadius,
      pcssFilterRadius,
      lightSize,
      momentBias,
      lightBleedReduction,
      evsmPositiveExponent,
      evsmNegativeExponent,
      peterPanningOffset,
    };
  }

  static from(snapshot: ShadowConfigSnapshot): ShadowConfig {
    return new ShadowConfig(
      normalizeShadowConfigSnapshot(snapshot) as ShadowConfigInput,
    );
  }

  snapshot(): ShadowConfigSnapshot {
    return { ...this.#snapshot };
  }

  copy(): ShadowConfig {
    return new ShadowConfig(this.#snapshot);
  }

  requiresMoments(): boolean {
    return shadowFilterRequiresMoments(this.#snapshot.filter);
  }

  peterPanningSafe(): boolean {
    return (
      this.#snapshot.depthBias > 1e-4 && this.#snapshot.peterPanningOffset > 1e-4
    );
  }

  estimatedGpuBytes(cascadeCount = 1): number {
    if (
      !Number.isSafeInteger(cascadeCount) ||
      cascadeCount < 1 ||
      cascadeCount > SHADOW_MAX_CASCADES
    ) {
      throw invalid("cascadeCount must be an integer between 1 and 4");
    }
    if (!this.#snapshot.enabled) {
      return 0;
    }
    const cascades = cascadeCount;
    const texels = this.#snapshot.mapSize * this.#snapshot.mapSize;
    let total = texels * cascades * 4;
    if (this.requiresMoments()) {
      total += texels * cascades * 16;
    }
    total += SHADOW_UNIFORM_BYTES + cascades * SHADOW_DEPTH_UNIFORM_BYTES;
    if (!Number.isSafeInteger(total)) {
      throw invalid("shadow gpu byte estimate overflowed");
    }
    return total;
  }
}

export class CascadedShadowConfig {
  readonly #snapshot: CascadedShadowConfigSnapshot;

  constructor(input?: CascadedShadowConfigInput) {
    const source = input ?? {};
    if (!isRecord(source)) {
      throw invalid("cascaded shadow config input must be an object");
    }
    const enabled = source.enabled ?? false;
    if (typeof enabled !== "boolean") {
      throw invalid("enabled must be a boolean");
    }
    const cascadeCount = normalizeCascadeCount(source.cascadeCount, 3);
    const maxDistance = optionalFinite(source.maxDistance, 200, "maxDistance");
    if (maxDistance <= 0) {
      throw invalid("maxDistance must be greater than zero");
    }
    const splitLambda = optionalFinite(source.splitLambda, 0.75, "splitLambda");
    if (splitLambda < 0 || splitLambda > 1) {
      throw invalid("splitLambda must be in [0, 1]");
    }
    const blendRange = optionalFinite(source.blendRange, 0.1, "blendRange");
    if (blendRange < 0 || blendRange > 1) {
      throw invalid("blendRange must be in [0, 1]");
    }
    const stabilize = source.stabilize ?? true;
    if (typeof stabilize !== "boolean") {
      throw invalid("stabilize must be a boolean");
    }
    const debugView = optionalDebugView(source.debugView, "none");
    this.#snapshot = {
      enabled,
      cascadeCount,
      maxDistance,
      splitLambda,
      blendRange,
      stabilize,
      debugView,
    };
  }

  static from(snapshot: CascadedShadowConfigSnapshot): CascadedShadowConfig {
    return new CascadedShadowConfig(
      normalizeCsmSnapshot(snapshot) as CascadedShadowConfigInput,
    );
  }

  snapshot(): CascadedShadowConfigSnapshot {
    return { ...this.#snapshot };
  }

  copy(): CascadedShadowConfig {
    return new CascadedShadowConfig(this.#snapshot);
  }

  calculateSplits(near: number, far: number): number[] {
    if (
      !Number.isFinite(near) ||
      !Number.isFinite(far) ||
      near <= 0 ||
      far <= near
    ) {
      throw invalid("camera planes must satisfy 0 < near < far");
    }
    const shadowFar = Math.min(far, this.#snapshot.maxDistance);
    if (shadowFar <= near) {
      throw invalid("shadow far plane must exceed the camera near plane");
    }
    if (!this.#snapshot.enabled) {
      return [near, shadowFar];
    }
    const count = this.#snapshot.cascadeCount;
    const lambda = this.#snapshot.splitLambda;
    const splits: number[] = [near];
    for (let index = 1; index < count; index += 1) {
      const fraction = index / count;
      const uniform = near + (shadowFar - near) * fraction;
      const logarithmic = near * Math.pow(shadowFar / near, fraction);
      splits.push(lambda * logarithmic + (1 - lambda) * uniform);
    }
    splits.push(shadowFar);
    return splits;
  }

  stabilizeBounds(
    min: [number, number, number],
    max: [number, number, number],
    mapSize: number,
  ): { min: [number, number, number]; max: [number, number, number]; texelSize: number } {
    if (
      !Array.isArray(min) ||
      !Array.isArray(max) ||
      min.length !== 3 ||
      max.length !== 3 ||
      ![...min, ...max].every((value) => Number.isFinite(value))
    ) {
      throw invalid("shadow cascade bounds must be finite 3-component arrays");
    }
    const size = normalizeMapSize(mapSize, -1);
    const extent = Math.max(max[0] - min[0], max[1] - min[1]);
    if (!(extent > 0)) {
      throw invalid("shadow cascade extent must be positive");
    }
    const texelSize = extent / size;
    const centerX = (min[0] + max[0]) / 2;
    const centerY = (min[1] + max[1]) / 2;
    const snappedX = Math.round(centerX / texelSize) * texelSize;
    const snappedY = Math.round(centerY / texelSize) * texelSize;
    const half = extent / 2;
    return {
      min: [snappedX - half, snappedY - half, min[2]],
      max: [snappedX + half, snappedY + half, max[2]],
      texelSize,
    };
  }
}

function normalizeShadowConfigSnapshot(
  value: unknown,
): ShadowConfigSnapshot {
  if (!isRecord(value)) {
    throw invalid("shadow config snapshot must be an object");
  }
  const filter = parseShadowFilter(
    typeof value.filter === "string" ? value.filter : "",
  );
  const snapshot: ShadowConfigSnapshot = {
    enabled: value.enabled === true,
    filter,
    mapSize: normalizeMapSize(value.mapSize as number | undefined, -1),
    depthBias: optionalNonnegative(value.depthBias as number, NaN, "depthBias"),
    normalBias: optionalNonnegative(
      value.normalBias as number,
      NaN,
      "normalBias",
    ),
    slopeBias: optionalNonnegative(value.slopeBias as number, NaN, "slopeBias"),
    softness: optionalNonnegative(value.softness as number, NaN, "softness"),
    pcssBlockerRadius: optionalNonnegative(
      value.pcssBlockerRadius as number,
      NaN,
      "pcssBlockerRadius",
    ),
    pcssFilterRadius: optionalNonnegative(
      value.pcssFilterRadius as number,
      NaN,
      "pcssFilterRadius",
    ),
    lightSize: optionalFinite(value.lightSize as number, NaN, "lightSize"),
    momentBias: optionalNonnegative(
      value.momentBias as number,
      NaN,
      "momentBias",
    ),
    lightBleedReduction: optionalFinite(
      value.lightBleedReduction as number,
      NaN,
      "lightBleedReduction",
    ),
    evsmPositiveExponent: optionalFinite(
      value.evsmPositiveExponent as number,
      NaN,
      "evsmPositiveExponent",
    ),
    evsmNegativeExponent: optionalFinite(
      value.evsmNegativeExponent as number,
      NaN,
      "evsmNegativeExponent",
    ),
    peterPanningOffset: optionalNonnegative(
      value.peterPanningOffset as number,
      NaN,
      "peterPanningOffset",
    ),
  };
  if (typeof value.enabled !== "boolean") {
    throw invalid("enabled must be a boolean");
  }
  return new ShadowConfig(snapshot as ShadowConfigInput).snapshot();
}

function normalizeCsmSnapshot(value: unknown): CascadedShadowConfigSnapshot {
  if (!isRecord(value)) {
    throw invalid("csm snapshot must be an object");
  }
  const snapshot: CascadedShadowConfigSnapshot = {
    enabled: value.enabled === true,
    cascadeCount: normalizeCascadeCount(
      value.cascadeCount as number | undefined,
      -1 as 2 | 3 | 4,
    ),
    maxDistance: optionalFinite(
      value.maxDistance as number,
      NaN,
      "maxDistance",
    ),
    splitLambda: optionalFinite(
      value.splitLambda as number,
      NaN,
      "splitLambda",
    ),
    blendRange: optionalFinite(value.blendRange as number, NaN, "blendRange"),
    stabilize: value.stabilize === true,
    debugView: optionalDebugView(
      value.debugView as ShadowDebugView | undefined,
      "none",
    ),
  };
  if (typeof value.enabled !== "boolean") {
    throw invalid("enabled must be a boolean");
  }
  if (typeof value.stabilize !== "boolean") {
    throw invalid("stabilize must be a boolean");
  }
  return new CascadedShadowConfig(
    snapshot as CascadedShadowConfigInput,
  ).snapshot();
}

export function normalizeShadowReport(
  value: unknown,
  config: ShadowConfigSnapshot,
  csm: CascadedShadowConfigSnapshot,
): ShadowReport {
  if (!isRecord(value)) {
    throw invalid("shadow report must be an object");
  }
  const requestedFilter = parseShadowFilter(
    typeof value.requestedFilter === "string" ? value.requestedFilter : "",
  );
  const effectiveFilter = parseShadowFilter(
    typeof value.effectiveFilter === "string" ? value.effectiveFilter : "",
  );
  if (requestedFilter !== config.filter) {
    throw invalid("shadow report requestedFilter must match config.filter");
  }
  if (effectiveFilter !== config.filter) {
    throw invalid("shadow report effectiveFilter must match config.filter");
  }
  const requestedMapSize = value.requestedMapSize;
  if (
    !Number.isSafeInteger(requestedMapSize) ||
    requestedMapSize !== config.mapSize
  ) {
    throw invalid("shadow report requestedMapSize must match config.mapSize");
  }
  const effectiveMapSize = value.effectiveMapSize;
  if (
    !Number.isSafeInteger(effectiveMapSize) ||
    (effectiveMapSize as number) < SHADOW_MAP_MIN ||
    (effectiveMapSize as number) > SHADOW_MAP_MAX ||
    ((effectiveMapSize as number) & ((effectiveMapSize as number) - 1)) !== 0
  ) {
    throw invalid(
      `shadow report effectiveMapSize must be a power of two between ${SHADOW_MAP_MIN} and ${SHADOW_MAP_MAX}`,
    );
  }
  const csmActive = config.enabled && csm.enabled;
  const csmEnabled = value.csmEnabled;
  if (typeof csmEnabled !== "boolean" || csmEnabled !== csmActive) {
    throw invalid("shadow report csmEnabled must match the effective csm state");
  }
  const cascadeCount = value.cascadeCount;
  const expectedCount = csmActive ? csm.cascadeCount : 1;
  if (
    !Number.isSafeInteger(cascadeCount) ||
    cascadeCount !== expectedCount
  ) {
    throw invalid("shadow report cascadeCount must match the csm setting");
  }
  const momentFormat = value.momentFormat;
  if (
    typeof momentFormat !== "string" ||
    !MOMENT_FORMATS.includes(momentFormat as ShadowReport["momentFormat"])
  ) {
    throw invalid("shadow report momentFormat must be none or rgba32float");
  }
  const expectedMomentFormat =
    config.enabled && shadowFilterRequiresMoments(effectiveFilter)
      ? "rgba32float"
      : "none";
  if (momentFormat !== expectedMomentFormat) {
    throw invalid(
      `shadow report momentFormat must be ${expectedMomentFormat} for this configuration`,
    );
  }
  const casterLightId = value.casterLightId;
  if (
    casterLightId !== null &&
    (!Number.isSafeInteger(casterLightId) || (casterLightId as number) < 0)
  ) {
    throw invalid("shadow report casterLightId must be null or a nonnegative integer");
  }
  if (typeof value.reason !== "string") {
    throw invalid("shadow report reason must be a string");
  }
  return {
    requestedFilter,
    effectiveFilter,
    requestedMapSize: requestedMapSize as number,
    effectiveMapSize: effectiveMapSize as number,
    csmEnabled,
    cascadeCount: cascadeCount as number,
    momentFormat: momentFormat as ShadowReport["momentFormat"],
    casterLightId: casterLightId as number | null,
    reason: value.reason,
  };
}

export function normalizeShadowSnapshot(value: unknown): ShadowSnapshot {
  if (!isRecord(value)) {
    throw invalid("shadows snapshot must be an object");
  }
  const config = normalizeShadowConfigSnapshot(value.config);
  const csm = normalizeCsmSnapshot(value.csm);
  const report = normalizeShadowReport(value.report, config, csm);
  return { config, csm, report };
}

export function shadowCascadeInfo(
  config: ShadowConfigSnapshot,
  csm: CascadedShadowConfigSnapshot,
  near: number,
  far: number,
): ShadowCascadeInfo[] {
  const splits = new CascadedShadowConfig(csm).calculateSplits(near, far);
  const info: ShadowCascadeInfo[] = [];
  for (let index = 0; index + 1 < splits.length; index += 1) {
    info.push({
      near: splits[index]!,
      far: splits[index + 1]!,
      texelSize: (2 * splits[index + 1]!) / config.mapSize,
    });
  }
  return info;
}

export function defaultShadowSnapshot(): ShadowSnapshot {
  const config = new ShadowConfig().snapshot();
  const csm = new CascadedShadowConfig().snapshot();
  return { config, csm, report: buildShadowReport(config, csm, null) };
}

export function buildShadowReport(
  config: ShadowConfigSnapshot,
  csm: CascadedShadowConfigSnapshot,
  casterLightId: number | null,
  effectiveMapSize = config.mapSize,
): ShadowReport {
  const caster = config.enabled ? casterLightId : null;
  // Cascades only exist when shadows render; report the effective state.
  const csmActive = config.enabled && csm.enabled;
  return {
    requestedFilter: config.filter,
    effectiveFilter: config.filter,
    requestedMapSize: config.mapSize,
    effectiveMapSize,
    csmEnabled: csmActive,
    cascadeCount: csmActive ? csm.cascadeCount : 1,
    momentFormat:
      config.enabled && shadowFilterRequiresMoments(config.filter)
        ? "rgba32float"
        : "none",
    casterLightId: caster,
    reason: !config.enabled
      ? "shadows disabled"
      : caster === null
        ? "no shadow-casting directional light"
        : "requested configuration",
  };
}
