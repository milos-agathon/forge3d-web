import { Forge3DError } from "./index.js";
import type {
  AreaLightApproximation,
  AreaLightApproximationConfig,
  AreaLightSampleCount,
  DirectionalLightInput,
  LightBounds,
  LightId,
  LightInput,
  LightPresetName,
  LightingSnapshot,
  LightSnapshot,
  PointLightInput,
  RectAreaLightInput,
  SoftLightFalloff,
  SpotLightInput,
} from "./index.js";

export const MAX_LIGHTS = 64;
export const LIGHT_STRUCT_BYTES = 112;
export const LIGHTING_UNIFORM_BYTES = 32;
export const LTC_LUT_SIZE = 64;

const AREA_SAMPLE_COUNTS: readonly AreaLightSampleCount[] = [1, 4, 8, 16];
const FALLOFF_MODES: readonly SoftLightFalloff[] = [
  "linear",
  "quadratic",
  "cubic",
  "exponential",
];

type Vec3 = [number, number, number];

interface LightDefaults {
  enabled: boolean;
  castsShadow: boolean;
}

export class LightCollection {
  readonly #lights = new Map<LightId, LightSnapshot>();
  readonly #maxLights: number;
  #nextId = 0;
  #revision = 0;
  #exposure = 1;
  #debugBounds = false;
  #areaLights: AreaLightApproximationConfig = {
    mode: "ltc",
    sampleCount: 4,
    lutSize: LTC_LUT_SIZE,
  };

  constructor(maxLights: number = MAX_LIGHTS) {
    if (!Number.isSafeInteger(maxLights) || maxLights < 1 || maxLights > MAX_LIGHTS) {
      throw invalid("maxLights", "must be an integer between 1 and 64");
    }
    this.#maxLights = maxLights;
  }

  static defaults(maxLights?: number): LightCollection {
    const lights = new LightCollection(maxLights);
    lights.add({
      type: "directional",
      color: [1, 1, 1],
      intensity: 3,
      direction: [0.48, -0.78, -0.4],
    });
    if (lights.maxLights >= 2) {
      lights.add({
        type: "directional",
        color: [1, 1, 1],
        intensity: 0.36,
        direction: [-0.55, -0.45, 0.35],
      });
    }
    return lights;
  }

  static from(snapshot: LightingSnapshot): LightCollection {
    const state = normalizeLightingSnapshot(snapshot);
    const lights = new LightCollection(state.maxLights);
    lights.#exposure = state.exposure;
    lights.#debugBounds = state.debugBounds;
    lights.#areaLights = state.areaLights;
    lights.#revision = state.revision;
    for (const light of state.lights) {
      lights.#lights.set(light.id, light);
    }
    let next = 0;
    for (const id of lights.#lights.keys()) {
      if (id >= next) {
        next = id + 1;
      }
    }
    lights.#nextId = next;
    return lights;
  }

  get size(): number {
    return this.#lights.size;
  }

  get maxLights(): number {
    return this.#maxLights;
  }

  get revision(): number {
    return this.#revision;
  }

  add(light: LightInput): LightId {
    const normalized = normalizeLightInput(light);
    if (this.#lights.size >= this.#maxLights) {
      throw invalid(
        "lights",
        `collection holds the maximum of ${this.#maxLights} lights`,
      );
    }
    const id = this.#nextId;
    this.#nextId += 1;
    this.#lights.set(id, { ...normalized, id } as LightSnapshot);
    this.#revision += 1;
    return id;
  }

  update(id: LightId, light: LightInput): void {
    if (!this.#lights.has(id)) {
      throw invalid("id", "light does not exist");
    }
    const normalized = normalizeLightInput(light);
    this.#lights.set(id, { ...normalized, id } as LightSnapshot);
    this.#revision += 1;
  }

  remove(id: LightId): boolean {
    if (!this.#lights.delete(id)) {
      return false;
    }
    this.#revision += 1;
    return true;
  }

  clear(): void {
    if (this.#lights.size === 0) {
      return;
    }
    this.#lights.clear();
    this.#revision += 1;
  }

  get(id: LightId): LightSnapshot | undefined {
    const stored = this.#lights.get(id);
    return stored === undefined ? undefined : cloneLight(stored);
  }

  values(): LightSnapshot[] {
    return [...this.#lights.values()].map((light) => cloneLight(light));
  }

  setExposure(exposure: number): void {
    if (!Number.isFinite(exposure) || exposure < 0) {
      throw invalid("exposure", "must be finite and nonnegative");
    }
    this.#exposure = exposure;
    this.#revision += 1;
  }

  setDebugBounds(enabled: boolean): void {
    if (typeof enabled !== "boolean") {
      throw invalid("debugBounds", "must be a boolean");
    }
    this.#debugBounds = enabled;
    this.#revision += 1;
  }

  setAreaLightApproximation(
    config: Partial<AreaLightApproximationConfig>,
  ): void {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw invalid("areaLights", "must be an object");
    }
    const next: AreaLightApproximationConfig = { ...this.#areaLights };
    if (config.mode !== undefined) {
      next.mode = normalizeAreaMode(config.mode);
    }
    if (config.sampleCount !== undefined) {
      next.sampleCount = normalizeAreaSampleCount(config.sampleCount);
    }
    if (config.lutSize !== undefined) {
      next.lutSize = normalizeAreaLutSize(config.lutSize);
    }
    this.#areaLights = next;
    this.#revision += 1;
  }

  effectiveRange(id: LightId): number {
    return effectiveRangeOf(this.#require(id));
  }

  affectsPoint(id: LightId, point: Vec3): boolean {
    const light = this.#require(id);
    assertVec3(point, "point");
    return lightAffectsPoint(light, point);
  }

  bounds(id: LightId): LightBounds {
    return boundsOf(this.#require(id));
  }

  snapshot(): LightingSnapshot {
    return {
      revision: this.#revision,
      maxLights: this.#maxLights,
      exposure: this.#exposure,
      debugBounds: this.#debugBounds,
      areaLights: { ...this.#areaLights },
      lights: this.values(),
    };
  }

  copy(): LightCollection {
    return LightCollection.from(this.snapshot());
  }

  estimatedGpuBytes(): number {
    const bytes = this.#maxLights * LIGHT_STRUCT_BYTES + LIGHTING_UNIFORM_BYTES;
    if (!Number.isSafeInteger(bytes)) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "lighting byte estimate exceeds safe integer limits",
      );
    }
    return bytes;
  }

  #require(id: LightId): LightSnapshot {
    const light = this.#lights.get(id);
    if (light === undefined) {
      throw invalid("id", "light does not exist");
    }
    return light;
  }
}

const LIGHT_PRESET_ORDER: readonly LightPresetName[] = Object.freeze([
  "spotlight",
  "area-light",
  "ambient-light",
  "candle",
  "street-lamp",
]);

const LIGHT_PRESETS: Readonly<Record<LightPresetName, LightInput>> = {
  spotlight: {
    type: "point",
    position: [0, 15, 0],
    intensity: 2,
    range: 15,
    innerRadius: 2,
    edgeSoftness: 0.2,
    falloff: "exponential",
    falloffExponent: 4,
    color: [1, 1, 0.9],
  },
  "area-light": {
    type: "rect",
    position: [0, 8, 0],
    right: [1, 0, 0],
    up: [0, 0, 1],
    width: 16,
    height: 16,
    range: 25,
    edgeSoftness: 3,
    color: [1, 0.95, 0.9],
    intensity: 1.5,
  },
  "ambient-light": {
    type: "point",
    position: [0, 20, 0],
    intensity: 0.8,
    range: 50,
    innerRadius: 15,
    edgeSoftness: 5,
    falloff: "linear",
    color: [0.9, 0.95, 1],
  },
  candle: {
    type: "point",
    position: [0, 2, 0],
    intensity: 1.2,
    range: 8,
    innerRadius: 1,
    edgeSoftness: 0.5,
    falloff: "cubic",
    falloffExponent: 3,
    color: [1, 0.7, 0.4],
  },
  "street-lamp": {
    type: "point",
    position: [0, 12, 0],
    intensity: 1.8,
    range: 30,
    innerRadius: 5,
    edgeSoftness: 2,
    falloff: "quadratic",
    falloffExponent: 2.5,
    color: [1, 0.9, 0.7],
  },
};

export function lightPresetNames(): readonly LightPresetName[] {
  return Object.freeze([...LIGHT_PRESET_ORDER]);
}

export function getLightPreset(name: LightPresetName): LightInput {
  const preset = LIGHT_PRESETS[name];
  if (preset === undefined) {
    throw invalid("preset", `unknown light preset: ${String(name)}`);
  }
  return cloneLight(preset);
}

export function normalizeLightInput(light: unknown): LightInput {
  if (typeof light !== "object" || light === null || Array.isArray(light)) {
    throw invalid("light", "must be an object");
  }
  const input = light as Record<string, unknown>;
  const type = input.type;
  switch (type) {
    case "directional":
      return normalizeDirectional(input);
    case "point":
      return normalizePoint(input);
    case "spot":
      return normalizeSpot(input);
    case "rect":
      return normalizeRect(input);
    default:
      throw invalid(
        "light.type",
        "must be directional, point, spot, or rect",
      );
  }
}

export function normalizeLightingSnapshot(
  snapshot: LightingSnapshot,
): LightingSnapshot {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) {
    throw invalid("lighting", "must be an object");
  }
  const raw = snapshot as unknown as Record<string, unknown>;
  const maxLights = raw.maxLights;
  if (
    !Number.isSafeInteger(maxLights) ||
    (maxLights as number) < 1 ||
    (maxLights as number) > MAX_LIGHTS
  ) {
    throw invalid("lighting.maxLights", "must be an integer between 1 and 64");
  }
  const exposure = raw.exposure;
  if (!Number.isFinite(exposure) || (exposure as number) < 0) {
    throw invalid("lighting.exposure", "must be finite and nonnegative");
  }
  if (typeof raw.debugBounds !== "boolean") {
    throw invalid("lighting.debugBounds", "must be a boolean");
  }
  const revision = raw.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw invalid("lighting.revision", "must be a nonnegative integer");
  }
  const area = normalizeAreaConfig(raw.areaLights);
  const rawLights = raw.lights;
  if (!Array.isArray(rawLights)) {
    throw invalid("lighting.lights", "must be an array");
  }
  if (rawLights.length > (maxLights as number)) {
    throw invalid("lighting.lights", "exceeds maxLights");
  }
  const seen = new Set<LightId>();
  const lights: LightSnapshot[] = [];
  for (const entry of rawLights) {
    const normalized = normalizeLightInput(entry);
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (!Number.isSafeInteger(id) || (id as number) < 0) {
      throw invalid("lighting.lights.id", "must be a nonnegative integer");
    }
    if (seen.has(id as number)) {
      throw invalid("lighting.lights.id", "must be unique");
    }
    seen.add(id as number);
    if (typeof record.enabled !== "boolean") {
      throw invalid("lighting.lights.enabled", "must be a boolean");
    }
    if (typeof record.castsShadow !== "boolean") {
      throw invalid("lighting.lights.castsShadow", "must be a boolean");
    }
    lights.push({
      ...(normalized as Omit<LightSnapshot, "id" | "enabled" | "castsShadow">),
      id: id as number,
      enabled: record.enabled,
      castsShadow: record.castsShadow,
    } as LightSnapshot);
  }
  return {
    revision: revision as number,
    maxLights: maxLights as number,
    exposure: exposure as number,
    debugBounds: raw.debugBounds,
    areaLights: area,
    lights,
  };
}

function baseDefaults(type: string, input: Record<string, unknown>): LightDefaults {
  const enabled = input.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw invalid("light.enabled", "must be a boolean");
  }
  const castsShadow = input.castsShadow;
  if (castsShadow !== undefined && typeof castsShadow !== "boolean") {
    throw invalid("light.castsShadow", "must be a boolean");
  }
  return {
    enabled: (enabled as boolean | undefined) ?? true,
    castsShadow: (castsShadow as boolean | undefined) ?? type === "directional",
  };
}

function normalizeBase(
  input: Record<string, unknown>,
  type: string,
): { color: Vec3; intensity: number; enabled: boolean; castsShadow: boolean } {
  return {
    color: normalizeColor(input.color, "light.color"),
    intensity: normalizeIntensity(input.intensity),
    ...baseDefaults(type, input),
  };
}

function normalizeDirectional(input: Record<string, unknown>): DirectionalLightInput {
  return {
    type: "directional",
    ...normalizeBase(input, "directional"),
    direction: normalizeDirection(input.direction, "light.direction"),
  };
}

function normalizePoint(input: Record<string, unknown>): PointLightInput {
  const range = normalizeRange(input.range);
  return {
    type: "point",
    ...normalizeBase(input, "point"),
    position: normalizeVec3Copy(input.position, "light.position"),
    range,
    innerRadius: normalizeInnerRadius(input.innerRadius, range),
    edgeSoftness: normalizeEdgeSoftness(input.edgeSoftness),
    falloff: normalizeFalloff(input.falloff),
    falloffExponent: normalizeFalloffExponent(input.falloffExponent),
  };
}

function normalizeSpot(input: Record<string, unknown>): SpotLightInput {
  const range = normalizeRange(input.range);
  const innerCone = normalizeConeDegrees(
    input.innerConeDegrees,
    "light.innerConeDegrees",
  );
  const outerCone = normalizeConeDegrees(
    input.outerConeDegrees,
    "light.outerConeDegrees",
  );
  if (innerCone > outerCone) {
    throw invalid(
      "light.innerConeDegrees",
      "must not exceed outerConeDegrees",
    );
  }
  return {
    type: "spot",
    ...normalizeBase(input, "spot"),
    position: normalizeVec3Copy(input.position, "light.position"),
    direction: normalizeDirection(input.direction, "light.direction"),
    range,
    innerConeDegrees: innerCone,
    outerConeDegrees: outerCone,
    innerRadius: normalizeInnerRadius(input.innerRadius, range),
    edgeSoftness: normalizeEdgeSoftness(input.edgeSoftness),
    falloff: normalizeFalloff(input.falloff),
    falloffExponent: normalizeFalloffExponent(input.falloffExponent),
  };
}

function normalizeRect(input: Record<string, unknown>): RectAreaLightInput {
  const right = normalizeDirection(input.right, "light.right");
  const upRaw = normalizeDirection(input.up, "light.up");
  const up = orthogonalize(right, upRaw);
  const twoSided = input.twoSided;
  if (twoSided !== undefined && typeof twoSided !== "boolean") {
    throw invalid("light.twoSided", "must be a boolean");
  }
  return {
    type: "rect",
    ...normalizeBase(input, "rect"),
    position: normalizeVec3Copy(input.position, "light.position"),
    right,
    up,
    width: normalizePositive(input.width, "light.width"),
    height: normalizePositive(input.height, "light.height"),
    range: normalizeRange(input.range),
    edgeSoftness: normalizeEdgeSoftness(input.edgeSoftness),
    twoSided: twoSided ?? false,
  };
}

function normalizeAreaMode(value: unknown): AreaLightApproximation {
  if (value !== "ltc" && value !== "sampled") {
    throw invalid("areaLights.mode", "must be ltc or sampled");
  }
  return value;
}

function normalizeAreaSampleCount(value: unknown): AreaLightSampleCount {
  if (!AREA_SAMPLE_COUNTS.includes(value as AreaLightSampleCount)) {
    throw invalid("areaLights.sampleCount", "must be 1, 4, 8, or 16");
  }
  return value as AreaLightSampleCount;
}

function normalizeAreaLutSize(value: unknown): 64 {
  if (value !== LTC_LUT_SIZE) {
    throw invalid("areaLights.lutSize", "must be 64");
  }
  return LTC_LUT_SIZE;
}

function normalizeAreaConfig(value: unknown): AreaLightApproximationConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("areaLights", "must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    mode: normalizeAreaMode(record.mode),
    sampleCount: normalizeAreaSampleCount(record.sampleCount),
    lutSize: normalizeAreaLutSize(record.lutSize),
  };
}

function normalizeColor(value: unknown, field: string): Vec3 {
  assertVec3(value, field);
  for (const component of value) {
    if (component < 0 || component > 1) {
      throw invalid(field, "components must be in the 0..1 range");
    }
  }
  return [value[0], value[1], value[2]];
}

function normalizeIntensity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid("light.intensity", "must be finite and nonnegative");
  }
  return value;
}

function normalizeVec3Copy(value: unknown, field: string): Vec3 {
  assertVec3(value, field);
  return [value[0], value[1], value[2]];
}

function normalizeDirection(value: unknown, field: string): Vec3 {
  assertVec3(value, field);
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length === 0) {
    throw invalid(field, "must be a nonzero finite vector");
  }
  return [value[0] / length, value[1] / length, value[2] / length];
}

function normalizeRange(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid("light.range", "must be finite and positive");
  }
  return value;
}

function normalizePositive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid(field, "must be finite and positive");
  }
  return value;
}

function normalizeInnerRadius(value: unknown, range: number): number {
  if (value === undefined) {
    return 0;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= range
  ) {
    throw invalid("light.innerRadius", "must be in the 0..range interval");
  }
  return value;
}

function normalizeEdgeSoftness(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid("light.edgeSoftness", "must be finite and nonnegative");
  }
  return value;
}

function normalizeFalloff(value: unknown): SoftLightFalloff {
  if (value === undefined) {
    return "quadratic";
  }
  if (!FALLOFF_MODES.includes(value as SoftLightFalloff)) {
    throw invalid(
      "light.falloff",
      "must be linear, quadratic, cubic, or exponential",
    );
  }
  return value as SoftLightFalloff;
}

function normalizeFalloffExponent(value: unknown): number {
  if (value === undefined) {
    return 2;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid("light.falloffExponent", "must be finite and positive");
  }
  return value;
}

function normalizeConeDegrees(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= 90
  ) {
    throw invalid(field, "must be finite and in the 0..90 degree range");
  }
  return value;
}

function orthogonalize(right: Vec3, up: Vec3): Vec3 {
  const along = right[0] * up[0] + right[1] * up[1] + right[2] * up[2];
  const projected: Vec3 = [
    up[0] - along * right[0],
    up[1] - along * right[1],
    up[2] - along * right[2],
  ];
  const length = Math.hypot(projected[0], projected[1], projected[2]);
  if (!Number.isFinite(length) || length === 0) {
    throw invalid("light.up", "must not be parallel to light.right");
  }
  return [projected[0] / length, projected[1] / length, projected[2] / length];
}

function effectiveRangeOf(light: LightSnapshot): number {
  if (light.type === "directional") {
    return Number.POSITIVE_INFINITY;
  }
  return light.range + (light.edgeSoftness ?? 0);
}

function lightAffectsPoint(light: LightSnapshot, point: Vec3): boolean {
  if (!light.enabled) {
    return false;
  }
  if (light.type === "directional") {
    return true;
  }
  const dx = point[0] - light.position[0];
  const dy = point[1] - light.position[1];
  const dz = point[2] - light.position[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance > effectiveRangeOf(light)) {
    return false;
  }
  if (light.type === "spot") {
    if (distance === 0) {
      return true;
    }
    const cos =
      (dx * light.direction[0] +
        dy * light.direction[1] +
        dz * light.direction[2]) /
      distance;
    return cos >= Math.cos((light.outerConeDegrees * Math.PI) / 180);
  }
  if (light.type === "rect" && !light.twoSided) {
    const normalX =
      light.right[1] * light.up[2] - light.right[2] * light.up[1];
    const normalY =
      light.right[2] * light.up[0] - light.right[0] * light.up[2];
    const normalZ =
      light.right[0] * light.up[1] - light.right[1] * light.up[0];
    return dx * normalX + dy * normalY + dz * normalZ >= 0;
  }
  return true;
}

function boundsOf(light: LightSnapshot): LightBounds {
  if (light.type === "directional") {
    return { kind: "unbounded" };
  }
  const radius =
    light.type === "rect"
      ? effectiveRangeOf(light) + Math.hypot(light.width / 2, light.height / 2)
      : effectiveRangeOf(light);
  return {
    kind: "sphere",
    center: [light.position[0], light.position[1], light.position[2]],
    radius,
  };
}

function cloneLight<T>(light: T): T {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(light as Record<string, unknown>)) {
    copy[key] = Array.isArray(value) ? [...value] : value;
  }
  return copy as T;
}

function assertVec3(value: unknown, field: string): asserts value is Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw invalid(field, "must be a 3-component vector");
  }
  for (const component of value) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw invalid(field, "components must be finite");
    }
  }
}

function invalid(field: string, message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", `${field} ${message}`, { field });
}
