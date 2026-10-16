import { Forge3DError } from "./index.js";
import type {
  CameraInput,
  CameraStateCameraOptions,
  TerrainClearanceOptions,
  TerrainOrbitRigOptions,
  TerrainRailRigOptions,
  TerrainRigBakeOptions,
  TerrainRigJSON,
  TerrainRigSourceInput,
  TerrainTargetFollowRigOptions,
  Vec3,
} from "./index.js";
import {
  CameraAnimation,
  CameraKeyframe,
  orbitEye,
} from "./camera-animation.js";
import { validateCameraInput } from "./camera.js";
import type { TerrainDataset } from "./terrain-dataset.js";

/**
 * Terrain camera rigs that bake to `CameraAnimation` — a port of the native
 * `forge3d.camera_rigs` module.
 *
 * Rigs work in the native *contract* space: the terrain spans
 * `[0, terrainWidth]` on X and Z and heights are rebased so the lowest sample
 * is `0`, scaled by `zScale`. Rig math uses doubles (the native Python
 * floats); keyframes are stored in f32 (the native animation), so baked
 * keyframes and sampled paths match the native oracle. Baking is
 * deterministic. After the initial bake each rig verifies the Catmull-Rom
 * path at `max(32 * samplesPerSecond, 240)` Hz and inserts keyframes wherever
 * the eye would dip below `terrain + minimumHeight` or leave the terrain, for
 * up to `maxRefinePasses` passes; a path that still violates clearance is
 * rejected, so a returned animation never violates its minimum.
 *
 * `TerrainRigSource.cameraAt` maps contract-space states to the renderer's
 * world space for a `TerrainDataset`, preserving clearance because every eye
 * keeps its terrain sample position and a constant height offset.
 */

const EPSILON = 1e-6;
/** Clearance tolerance used by rig verification (world units). */
export const TERRAIN_CLEARANCE_TOLERANCE = 1e-4;
const RIG_JSON_KIND = "forge3d.terrain-rig";

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}

function finite(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${name} must be finite`);
  }
  return value;
}

function positive(name: string, value: unknown): number {
  const result = finite(name, value);
  if (result <= 0) {
    throw invalid(`${name} must be > 0`);
  }
  return result;
}

function nonNegative(name: string, value: unknown): number {
  const result = finite(name, value);
  if (result < 0) {
    throw invalid(`${name} must be >= 0`);
  }
  return result;
}

function polar(name: string, value: unknown): number {
  const result = finite(name, value);
  if (result < 0 || result >= 180) {
    throw invalid(`${name} must be in [0, 180)`);
  }
  return result;
}

/** Python `repr(float)`: integral values keep a trailing `.0`. */
function pyFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

function lerp(start: number, end: number, alpha: number): number {
  return start + (end - start) * alpha;
}

function alphaFor(time: number, duration: number): number {
  return duration <= EPSILON ? 0 : Math.min(Math.max(time / duration, 0), 1);
}

/** Key equivalent to Python's `round(value, 9)` for de-duplicating times. */
function roundKey(value: number): number {
  return Math.round(value * 1e9);
}

function alignAngle(angle: number, reference: number): number {
  let aligned = angle;
  while (aligned - reference > 180) {
    aligned -= 360;
  }
  while (aligned - reference < -180) {
    aligned += 360;
  }
  return aligned;
}

type XZ = [number, number];

function coercePoint(name: string, point: unknown): XZ {
  if (!Array.isArray(point) || point.length !== 2) {
    throw invalid(`${name} must be a 2D (x, z) point`);
  }
  return [finite(`${name}[0]`, point[0]), finite(`${name}[1]`, point[1])];
}

function coercePath(name: string, points: unknown): XZ[] {
  if (!Array.isArray(points) || points.length < 2) {
    throw invalid(`${name} must contain at least 2 points`);
  }
  const collapsed: XZ[] = [];
  points.forEach((point, index) => {
    const current = coercePoint(`${name}[${index}]`, point);
    const last = collapsed.at(-1);
    if (last === undefined || Math.hypot(current[0] - last[0], current[1] - last[1]) > EPSILON) {
      collapsed.push(current);
    }
  });
  if (collapsed.length < 2) {
    throw invalid(`${name} must contain at least 2 unique points`);
  }
  return collapsed;
}

interface TerrainWorldMapping {
  spacingX: number;
  spacingZ: number;
  halfX: number;
  halfZ: number;
  heightOffset: number;
  heightScale: number;
}

const worldMappings = new WeakMap<TerrainRigSource, TerrainWorldMapping>();

/** Heights sampler with the native `TerrainScatterSource` contract. */
export class TerrainRigSource {
  readonly width: number;
  readonly height: number;
  readonly terrainWidth: number;
  readonly zScale: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly #scaled: Float32Array;

  constructor(input: TerrainRigSourceInput) {
    const parsed = parseSourceInput(input);
    this.width = parsed.width;
    this.height = parsed.height;
    this.terrainWidth = parsed.terrainWidth;
    this.zScale = parsed.zScale;
    this.minHeight = parsed.minHeight;
    this.maxHeight = parsed.maxHeight;
    this.#scaled = parsed.scaled;
    Object.freeze(this);
  }

  /**
   * Source for a W03 `TerrainDataset`. `zScale` defaults to the dataset
   * exaggeration and `terrainWidth` to the larger physical extent; `toWorld`
   * and `cameraAt` then map contract space onto the renderer's world space
   * (x = col * spacingX - halfX, y = (h - domainMin) * exaggeration,
   * z = row * spacingZ - halfZ). Nodata samples are filled like NaN.
   */
  static fromDataset(
    dataset: TerrainDataset,
    options: { zScale?: number; terrainWidth?: number } = {},
  ): TerrainRigSource {
    const heights = new Float32Array(dataset.heights.length);
    const nodata = dataset.nodata;
    for (let index = 0; index < heights.length; index += 1) {
      const value = dataset.heights[index] as number;
      heights[index] = nodata !== undefined && value === nodata ? Number.NaN : value;
    }
    const extentX = (dataset.width - 1) * dataset.spacing[0];
    const extentZ = (dataset.height - 1) * dataset.spacing[1];
    const source = new TerrainRigSource({
      heights,
      width: dataset.width,
      height: dataset.height,
      zScale: options.zScale ?? dataset.exaggeration,
      terrainWidth: options.terrainWidth ?? Math.max(extentX, extentZ, EPSILON),
    });
    worldMappings.set(source, {
      spacingX: dataset.spacing[0],
      spacingZ: dataset.spacing[1],
      halfX: extentX * 0.5,
      halfZ: extentZ * 0.5,
      // Rig height is (h - minHeight) * zScale; renderer height is
      // (h - domainMin) * exaggeration.
      heightScale: dataset.exaggeration / source.zScale,
      heightOffset: (source.minHeight - dataset.domain[0]) * dataset.exaggeration,
    });
    return source;
  }

  /** Fractional `[row, col]` for a contract-space `(x, z)`. */
  contractToPixel(x: number, z: number): [number, number] {
    const span = Math.max(this.terrainWidth, 1e-6);
    return [
      (z / span) * Math.max(this.height - 1, 1),
      (x / span) * Math.max(this.width - 1, 1),
    ];
  }

  /** Bilinear scaled height at fractional pixel coordinates (clamped). */
  sampleScaledHeight(row: number, col: number): number {
    const scaled = this.#scaled;
    const maxRow = Math.max(this.height - 1, 0);
    const maxCol = Math.max(this.width - 1, 0);
    const r = Math.min(Math.max(row, 0), maxRow);
    const c = Math.min(Math.max(col, 0), maxCol);
    const row0 = Math.floor(r);
    const col0 = Math.floor(c);
    const row1 = Math.min(row0 + 1, maxRow);
    const col1 = Math.min(col0 + 1, maxCol);
    const tr = r - row0;
    const tc = c - col0;
    const at = (y: number, x: number): number => scaled[y * this.width + x] as number;
    const top = (1 - tc) * at(row0, col0) + tc * at(row0, col1);
    const bottom = (1 - tc) * at(row1, col0) + tc * at(row1, col1);
    return (1 - tr) * top + tr * bottom;
  }

  /** Scaled terrain height under contract-space `(x, z)`. */
  heightAt(x: number, z: number): number {
    const [row, col] = this.contractToPixel(x, z);
    return this.sampleScaledHeight(row, col);
  }

  /**
   * Contract-space point in renderer world space. Identity unless the source
   * was built with `fromDataset`.
   */
  toWorld(point: Readonly<Vec3>): Vec3 {
    const world = worldMappings.get(this);
    if (world === undefined) {
      return [point[0], point[1], point[2]];
    }
    const [row, col] = this.contractToPixel(point[0], point[2]);
    return [
      col * world.spacingX - world.halfX,
      point[1] * world.heightScale + world.heightOffset,
      row * world.spacingZ - world.halfZ,
    ];
  }

  /**
   * Contract-space camera for a baked animation at `time`. With
   * `minimumHeight`, the eye is lifted to at least terrain + minimum: baked
   * keyframes are verified on a dense grid (like native), and this clamp also
   * removes the sub-grid Catmull-Rom dips between verification samples, so
   * playback never violates clearance at any time.
   */
  eyeAt(
    animation: CameraAnimation,
    time: number,
    options: { minimumHeight?: number } = {},
  ): { eye: Vec3; target: Vec3; fovDeg: number } | undefined {
    const state = animation.evaluate(time);
    if (state === undefined) {
      return undefined;
    }
    if (state.target === null) {
      throw invalid("rig playback requires target-aware keyframes");
    }
    const eye = orbitEye(state.target, state.radius, state.phiDeg, state.thetaDeg);
    if (options.minimumHeight !== undefined) {
      const minimum = nonNegative("minimumHeight", options.minimumHeight);
      eye[1] = Math.max(eye[1], this.heightAt(eye[0], eye[2]) + minimum);
    }
    return { eye, target: [state.target[0], state.target[1], state.target[2]], fovDeg: state.fovDeg };
  }

  /**
   * Renderer camera for a baked animation at `time`: `eyeAt` mapped through
   * `toWorld`.
   */
  cameraAt(
    animation: CameraAnimation,
    time: number,
    options: Omit<CameraStateCameraOptions, "fallbackTarget"> & { minimumHeight?: number } = {},
  ): CameraInput | undefined {
    const pose = this.eyeAt(
      animation,
      time,
      options.minimumHeight === undefined ? {} : { minimumHeight: options.minimumHeight },
    );
    if (pose === undefined) {
      return undefined;
    }
    const position = this.toWorld(pose.eye);
    const target = this.toWorld(pose.target);
    const distance = Math.hypot(
      position[0] - target[0],
      position[1] - target[1],
      position[2] - target[2],
    );
    const input: CameraInput = {
      position,
      target,
      up: options.up ?? [0, 1, 0],
      fovYDegrees: pose.fovDeg,
      near: options.near ?? 0.1,
      far: options.far ?? Math.max(1000, distance * 10),
    };
    if (options.projection !== undefined) {
      input.projection = options.projection;
    }
    if (options.orthographicHeight !== undefined) {
      input.orthographicHeight = options.orthographicHeight;
    }
    return validateCameraInput(input);
  }
}

function validatePoint(source: TerrainRigSource, point: XZ, name: string): XZ {
  const [x, z] = point;
  const width = source.terrainWidth;
  if (x < 0 || x > width || z < 0 || z > width) {
    throw invalid(
      `${name} must stay within [0, ${pyFloat(width)}] terrain bounds, got (${pyFloat(x)}, ${pyFloat(z)})`,
    );
  }
  return point;
}

function parseSourceInput(input: TerrainRigSourceInput): {
  width: number;
  height: number;
  terrainWidth: number;
  zScale: number;
  minHeight: number;
  maxHeight: number;
  scaled: Float32Array;
} {
  if (input === null || typeof input !== "object") {
    throw invalid("terrain rig source must be an object");
  }
  const { width, height } = input;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw invalid("heightmap must not be empty");
  }
  const heights = input.heights;
  if (!(heights instanceof Float32Array) && !Array.isArray(heights)) {
    throw invalid("heights must be a Float32Array or number array");
  }
  if (heights.length !== width * height) {
    throw invalid(`heightmap must contain width * height = ${width * height} samples`);
  }
  const zScale = input.zScale ?? 1;
  if (!Number.isFinite(zScale) || zScale <= 0) {
    throw invalid("zScale must be a positive finite float");
  }
  const terrainWidth = input.terrainWidth ?? Math.max(width, height);
  if (!Number.isFinite(terrainWidth) || terrainWidth <= 0) {
    throw invalid("terrainWidth must be a positive finite float");
  }
  const values = Float32Array.from(heights as ArrayLike<number>);
  let fill = Infinity;
  for (const value of values) {
    if (Number.isFinite(value) && value < fill) {
      fill = value;
    }
  }
  if (fill === Infinity) {
    throw invalid("heightmap must contain at least one finite sample");
  }
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number;
    const filled = Number.isFinite(value) ? value : fill;
    values[index] = filled;
    min = Math.min(min, filled);
    max = Math.max(max, filled);
  }
  // NumPy float32 arithmetic with the scalars cast to float32.
  const zScale32 = Math.fround(zScale);
  const scaled = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    scaled[index] = Math.fround(Math.fround((values[index] as number) - min) * zScale32);
    if (!Number.isFinite(scaled[index])) {
      throw invalid("zScale produces non-finite scaled heights");
    }
  }
  return { width, height, terrainWidth, zScale, minHeight: min, maxHeight: max, scaled };
}

/** Terrain-width-relative orbit radius used by terrain viewers. */
export function viewerOrbitRadius(
  sourceOrWidth: TerrainRigSource | number,
  options: { scale?: number; minimum?: number } = {},
): number {
  const terrainWidth =
    sourceOrWidth instanceof TerrainRigSource ? sourceOrWidth.terrainWidth : sourceOrWidth;
  const scale = options.scale ?? 1.9;
  const minimum = options.minimum ?? 5;
  if (!Number.isFinite(terrainWidth) || terrainWidth <= 0) {
    throw invalid("terrainWidth must be a positive finite float");
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw invalid("scale must be a positive finite float");
  }
  if (!Number.isFinite(minimum) || minimum < 0) {
    throw invalid("minimum must be a non-negative finite float");
  }
  return Math.max(terrainWidth * scale, minimum);
}

export class TerrainClearance {
  readonly minimumHeight: number;
  readonly maxRefinePasses: number;

  constructor(options: TerrainClearanceOptions = {}) {
    this.minimumHeight = nonNegative("minimumHeight", options.minimumHeight ?? 0);
    const passes = options.maxRefinePasses ?? 8;
    if (!Number.isSafeInteger(passes) || passes < 0) {
      throw invalid("maxRefinePasses must be >= 0");
    }
    this.maxRefinePasses = passes;
    Object.freeze(this);
  }

  toJSON(): Required<TerrainClearanceOptions> {
    return { minimumHeight: this.minimumHeight, maxRefinePasses: this.maxRefinePasses };
  }
}

function coerceClearance(clearance: unknown): TerrainClearance {
  if (clearance === undefined) {
    return new TerrainClearance();
  }
  if (clearance instanceof TerrainClearance) {
    return clearance;
  }
  if (clearance !== null && typeof clearance === "object") {
    return new TerrainClearance(clearance as TerrainClearanceOptions);
  }
  throw invalid("clearance must be a TerrainClearance");
}

interface PathSample {
  x: number;
  z: number;
  tangentX: number;
  tangentZ: number;
}

class PolylinePath {
  readonly points: readonly XZ[];
  readonly totalLength: number;
  readonly #lengths: number[];
  readonly #segmentLengths: number[];

  constructor(points: readonly XZ[]) {
    this.points = points;
    this.#lengths = [0];
    this.#segmentLengths = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      const start = points[index] as XZ;
      const end = points[index + 1] as XZ;
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      this.#segmentLengths.push(length);
      this.#lengths.push((this.#lengths.at(-1) as number) + length);
    }
    this.totalLength = this.#lengths.at(-1) as number;
    if (this.totalLength <= EPSILON) {
      throw invalid("path length must be > 0");
    }
  }

  sampleDistance(distance: number, extrapolate = false): PathSample {
    const clamped = Math.max(0, Math.min(distance, this.totalLength));
    const points = this.points;
    const n = points.length;
    if (clamped <= 0) {
      const start = points[0] as XZ;
      const [tx, tz] = segmentTangent(start, points[1] as XZ);
      if (extrapolate && distance < 0) {
        return { x: start[0] + tx * distance, z: start[1] + tz * distance, tangentX: tx, tangentZ: tz };
      }
      return { x: start[0], z: start[1], tangentX: tx, tangentZ: tz };
    }
    if (clamped >= this.totalLength) {
      const end = points[n - 1] as XZ;
      const [tx, tz] = segmentTangent(points[n - 2] as XZ, end);
      if (extrapolate && distance > this.totalLength) {
        const extension = distance - this.totalLength;
        return { x: end[0] + tx * extension, z: end[1] + tz * extension, tangentX: tx, tangentZ: tz };
      }
      return { x: end[0], z: end[1], tangentX: tx, tangentZ: tz };
    }
    const last = this.#segmentLengths.length - 1;
    for (let index = 0; index <= last; index += 1) {
      const segmentLength = this.#segmentLengths[index] as number;
      const startDistance = this.#lengths[index] as number;
      const endDistance = this.#lengths[index + 1] as number;
      if (clamped <= endDistance || index === last) {
        const start = points[index] as XZ;
        const end = points[index + 1] as XZ;
        const alpha = segmentLength <= EPSILON ? 0 : (clamped - startDistance) / segmentLength;
        const [tx, tz] = segmentTangent(start, end);
        return {
          x: lerp(start[0], end[0], alpha),
          z: lerp(start[1], end[1], alpha),
          tangentX: tx,
          tangentZ: tz,
        };
      }
    }
    const end = points[n - 1] as XZ;
    const [tx, tz] = segmentTangent(points[n - 2] as XZ, end);
    return { x: end[0], z: end[1], tangentX: tx, tangentZ: tz };
  }
}

function segmentTangent(start: XZ, end: XZ): XZ {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const length = Math.hypot(dx, dz);
  if (length <= EPSILON) {
    throw invalid("path contains a degenerate segment");
  }
  return [dx / length, dz / length];
}

function offsetPathSample(sample: PathSample, lateralOffset: number): XZ {
  return [sample.x + -sample.tangentZ * lateralOffset, sample.z + sample.tangentX * lateralOffset];
}

function applyClearance(source: TerrainRigSource, eye: Vec3, clearance: TerrainClearance): Vec3 {
  validatePoint(source, [eye[0], eye[2]], "camera eye");
  const safeHeight = source.heightAt(eye[0], eye[2]) + clearance.minimumHeight;
  return eye[1] < safeHeight ? [eye[0], safeHeight, eye[2]] : eye;
}

function keyframeFromEye(time: number, eye: Vec3, target: Vec3, fovDeg: number): CameraKeyframe {
  const dx = eye[0] - target[0];
  const dy = eye[1] - target[1];
  const dz = eye[2] - target[2];
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (radius <= EPSILON) {
    throw invalid("camera eye and target must not coincide");
  }
  const phiDeg = Math.atan2(dz, dx) * (180 / Math.PI);
  const thetaDeg = Math.acos(Math.max(-1, Math.min(1, dy / radius))) * (180 / Math.PI);
  return new CameraKeyframe({ time, phiDeg, thetaDeg, radius, fovDeg, target });
}

function sampleTimes(duration: number, samplesPerSecond: number): number[] {
  const total = Math.ceil(duration * samplesPerSecond) + 1;
  return Array.from({ length: total }, (_, frame) => Math.min(duration, frame / samplesPerSecond));
}

function unwrapKeyframes(keyframes: CameraKeyframe[]): CameraKeyframe[] {
  const ordered = [...keyframes].sort((left, right) => left.time - right.time);
  const first = ordered[0];
  if (first === undefined) {
    return [];
  }
  const result = [first];
  let previousPhi = first.phiDeg;
  for (const keyframe of ordered.slice(1)) {
    const phi = alignAngle(keyframe.phiDeg, previousPhi);
    result.push(new CameraKeyframe({ ...keyframe.toJSON(), phiDeg: phi }));
    previousPhi = phi;
  }
  return result;
}

abstract class TerrainRigBase {
  abstract readonly duration: number;
  abstract readonly clearance: TerrainClearance;
  abstract readonly kind: TerrainRigJSON["kind"];

  /** @internal */
  abstract sampleKeyframe(source: TerrainRigSource, time: number): CameraKeyframe;

  /** @internal */
  normalizeKeyframes(keyframes: CameraKeyframe[]): CameraKeyframe[] {
    return unwrapKeyframes(keyframes);
  }

  abstract toJSON(): TerrainRigJSON;

  /**
   * Renderer camera for this rig's baked `animation` at `time`, with the
   * eye held at or above terrain + `clearance.minimumHeight` at every time.
   */
  cameraAt(
    source: TerrainRigSource,
    animation: CameraAnimation,
    time: number,
    options: Omit<CameraStateCameraOptions, "fallbackTarget"> = {},
  ): CameraInput | undefined {
    return source.cameraAt(animation, time, {
      ...options,
      minimumHeight: this.clearance.minimumHeight,
    });
  }

  /** Deterministically bakes the rig into a clearance-verified animation. */
  bake(source: TerrainRigSource, options: TerrainRigBakeOptions = {}): CameraAnimation {
    if (!(source instanceof TerrainRigSource)) {
      throw new Forge3DError("INVALID_INPUT", "source must be a TerrainRigSource");
    }
    const samplesPerSecond = options.samplesPerSecond ?? 60;
    if (!Number.isSafeInteger(samplesPerSecond) || samplesPerSecond <= 0) {
      throw invalid("samplesPerSecond must be > 0");
    }
    const keyframes = sampleTimes(this.duration, samplesPerSecond).map((time) =>
      this.sampleKeyframe(source, time),
    );
    const animation = new CameraAnimation();
    animation.replaceKeyframes(this.normalizeKeyframes(keyframes));
    return this.#refine(animation, source, samplesPerSecond);
  }

  #verificationTimes(animation: CameraAnimation, samplesPerSecond: number): number[] {
    const verifySps = Math.max(samplesPerSecond * 32, 240);
    // Python dict semantics: a repeated key keeps its slot, last value wins.
    const slots = new Map<number, number>();
    for (const time of sampleTimes(this.duration, verifySps)) {
      slots.set(roundKey(time), time);
    }
    for (const keyframe of animation.getKeyframes()) {
      const key = roundKey(keyframe.time);
      if (!slots.has(key)) {
        slots.set(key, keyframe.time);
      }
    }
    return [...slots.values()].sort((left, right) => left - right);
  }

  #validateSample(animation: CameraAnimation, source: TerrainRigSource, time: number): string | undefined {
    const state = animation.evaluate(time);
    if (state === undefined) {
      return "animation evaluation returned None";
    }
    if (state.target === null) {
      return "target-aware rig animation lost its target during evaluation";
    }
    const width = source.terrainWidth;
    const outside = (value: number): boolean =>
      value < -TERRAIN_CLEARANCE_TOLERANCE || value > width + TERRAIN_CLEARANCE_TOLERANCE;
    const target = state.target;
    if (outside(target[0]) || outside(target[2])) {
      return `camera target left terrain bounds at time=${time.toFixed(3)}`;
    }
    const eye = orbitEye(target, state.radius, state.phiDeg, state.thetaDeg);
    if (outside(eye[0]) || outside(eye[2])) {
      return `camera eye left terrain bounds at time=${time.toFixed(3)}`;
    }
    const safeHeight = source.heightAt(eye[0], eye[2]) + this.clearance.minimumHeight;
    if (eye[1] + TERRAIN_CLEARANCE_TOLERANCE < safeHeight) {
      return `camera eye violated clearance at time=${time.toFixed(3)}`;
    }
    return undefined;
  }

  #failing(animation: CameraAnimation, source: TerrainRigSource, samplesPerSecond: number): number[] {
    return this.#verificationTimes(animation, samplesPerSecond).filter(
      (time) => this.#validateSample(animation, source, time) !== undefined,
    );
  }

  #refine(animation: CameraAnimation, source: TerrainRigSource, samplesPerSecond: number): CameraAnimation {
    for (let pass = 0; pass <= this.clearance.maxRefinePasses; pass += 1) {
      const failing = this.#failing(animation, source, samplesPerSecond);
      if (failing.length === 0) {
        return animation;
      }
      const existing = new Set(animation.getKeyframes().map((keyframe) => roundKey(keyframe.time)));
      const keyframes = animation.getKeyframes();
      let inserted = false;
      for (const time of failing) {
        const key = roundKey(time);
        if (existing.has(key)) {
          continue;
        }
        keyframes.push(this.sampleKeyframe(source, time));
        existing.add(key);
        inserted = true;
      }
      if (!inserted) {
        throw invalid(
          this.#validateSample(animation, source, failing[0] as number) ??
            "failed to refine rig animation",
        );
      }
      animation.replaceKeyframes(this.normalizeKeyframes(keyframes));
    }
    const failing = this.#failing(animation, source, samplesPerSecond);
    if (failing.length === 0) {
      return animation;
    }
    throw invalid(
      this.#validateSample(animation, source, failing[0] as number) ??
        "failed to satisfy clearance constraints after refinement",
    );
  }
}

export class TerrainOrbitRig extends TerrainRigBase {
  readonly kind = "orbit" as const;
  readonly targetXZ: Readonly<XZ>;
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

  constructor(options: TerrainOrbitRigOptions) {
    super();
    if (options === null || typeof options !== "object") {
      throw invalid("orbit rig options must be an object");
    }
    this.targetXZ = Object.freeze(coercePoint("targetXZ", options.targetXZ));
    this.duration = positive("duration", options.duration);
    this.radius = positive("radius", options.radius);
    this.clearance = coerceClearance(options.clearance);
    this.phiStartDeg = finite("phiStartDeg", options.phiStartDeg);
    this.phiEndDeg = finite("phiEndDeg", options.phiEndDeg);
    this.thetaStartDeg = polar("thetaStartDeg", options.thetaStartDeg ?? 45);
    this.thetaEndDeg = options.thetaEndDeg === undefined ? undefined : polar("thetaEndDeg", options.thetaEndDeg);
    this.radiusEnd = options.radiusEnd === undefined ? undefined : positive("radiusEnd", options.radiusEnd);
    this.fovStartDeg = positive("fovStartDeg", options.fovStartDeg ?? 55);
    this.fovEndDeg = options.fovEndDeg === undefined ? undefined : positive("fovEndDeg", options.fovEndDeg);
    this.targetHeightOffset = finite("targetHeightOffset", options.targetHeightOffset ?? 0);
    Object.freeze(this);
  }

  override normalizeKeyframes(keyframes: CameraKeyframe[]): CameraKeyframe[] {
    return [...keyframes]
      .sort((left, right) => left.time - right.time)
      .map((keyframe) => {
        const reference = lerp(this.phiStartDeg, this.phiEndDeg, alphaFor(keyframe.time, this.duration));
        return new CameraKeyframe({
          ...keyframe.toJSON(),
          phiDeg: alignAngle(keyframe.phiDeg, reference),
        });
      });
  }

  sampleKeyframe(source: TerrainRigSource, time: number): CameraKeyframe {
    const targetXZ = validatePoint(source, [this.targetXZ[0], this.targetXZ[1]], "targetXZ");
    const alpha = alphaFor(time, this.duration);
    const target: Vec3 = [
      targetXZ[0],
      source.heightAt(targetXZ[0], targetXZ[1]) + this.targetHeightOffset,
      targetXZ[1],
    ];
    const eye = applyClearance(
      source,
      orbitEye(
        target,
        lerp(this.radius, this.radiusEnd ?? this.radius, alpha),
        lerp(this.phiStartDeg, this.phiEndDeg, alpha),
        lerp(this.thetaStartDeg, this.thetaEndDeg ?? this.thetaStartDeg, alpha),
      ),
      this.clearance,
    );
    return keyframeFromEye(time, eye, target, lerp(this.fovStartDeg, this.fovEndDeg ?? this.fovStartDeg, alpha));
  }

  toJSON(): TerrainRigJSON {
    const options: TerrainOrbitRigOptions = {
      targetXZ: [this.targetXZ[0], this.targetXZ[1]],
      duration: this.duration,
      radius: this.radius,
      phiStartDeg: this.phiStartDeg,
      phiEndDeg: this.phiEndDeg,
      thetaStartDeg: this.thetaStartDeg,
      fovStartDeg: this.fovStartDeg,
      targetHeightOffset: this.targetHeightOffset,
      clearance: this.clearance.toJSON(),
    };
    if (this.thetaEndDeg !== undefined) options.thetaEndDeg = this.thetaEndDeg;
    if (this.radiusEnd !== undefined) options.radiusEnd = this.radiusEnd;
    if (this.fovEndDeg !== undefined) options.fovEndDeg = this.fovEndDeg;
    return { kind: "orbit", version: 1, options };
  }
}

export class TerrainRailRig extends TerrainRigBase {
  readonly kind = "rail" as const;
  readonly pathXZ: readonly Readonly<XZ>[];
  readonly duration: number;
  readonly cameraHeightOffset: number;
  readonly lookAheadDistance: number;
  readonly lateralOffset: number;
  readonly targetHeightOffset: number;
  readonly fovDeg: number;
  readonly clearance: TerrainClearance;

  constructor(options: TerrainRailRigOptions) {
    super();
    if (options === null || typeof options !== "object") {
      throw invalid("rail rig options must be an object");
    }
    this.pathXZ = Object.freeze(coercePath("pathXZ", options.pathXZ).map((point) => Object.freeze(point)));
    this.duration = positive("duration", options.duration);
    this.cameraHeightOffset = finite("cameraHeightOffset", options.cameraHeightOffset);
    this.lookAheadDistance = nonNegative("lookAheadDistance", options.lookAheadDistance);
    this.lateralOffset = finite("lateralOffset", options.lateralOffset ?? 0);
    this.targetHeightOffset = finite("targetHeightOffset", options.targetHeightOffset ?? 0);
    this.fovDeg = positive("fovDeg", options.fovDeg ?? 55);
    this.clearance = coerceClearance(options.clearance);
    Object.freeze(this);
  }

  sampleKeyframe(source: TerrainRigSource, time: number): CameraKeyframe {
    this.pathXZ.forEach((point, index) => validatePoint(source, [point[0], point[1]], `pathXZ[${index}]`));
    const path = new PolylinePath(this.pathXZ as XZ[]);
    const distance = path.totalLength * alphaFor(time, this.duration);
    let [eyeX, eyeZ] = offsetPathSample(path.sampleDistance(distance), this.lateralOffset);
    validatePoint(source, [eyeX, eyeZ], "rail camera eye");

    const width = source.terrainWidth;
    const clamp = (value: number): number => Math.min(Math.max(value, 0), width);
    const lookAhead = path.sampleDistance(distance + this.lookAheadDistance, true);
    let targetX = clamp(lookAhead.x);
    let targetZ = clamp(lookAhead.z);
    if (Math.hypot(targetX - eyeX, targetZ - eyeZ) <= EPSILON) {
      const cellSize = width / Math.max(Math.max(source.height, source.width) - 1, 1);
      const fallback = Math.max(
        this.lookAheadDistance,
        path.totalLength / Math.max(path.points.length - 1, 1),
        cellSize,
      );
      const forward = path.sampleDistance(distance + fallback, true);
      targetX = clamp(forward.x);
      targetZ = clamp(forward.z);
      if (Math.hypot(targetX - eyeX, targetZ - eyeZ) <= EPSILON) {
        // Keep the forward boundary target and back the eye off rather than
        // flipping the shot back toward the start of the rail.
        const backoff = Math.min(distance, cellSize);
        if (backoff > 0) {
          const candidate = offsetPathSample(path.sampleDistance(distance - backoff), this.lateralOffset);
          validatePoint(source, candidate, "rail camera eye");
          if (Math.hypot(targetX - candidate[0], targetZ - candidate[1]) > EPSILON) {
            [eyeX, eyeZ] = candidate;
          }
        }
      }
      if (Math.hypot(targetX - eyeX, targetZ - eyeZ) <= EPSILON) {
        throw invalid(
          "rail camera target collapsed onto the camera eye; adjust the path or height offsets",
        );
      }
    }
    validatePoint(source, [targetX, targetZ], "rail camera target");
    const target: Vec3 = [targetX, source.heightAt(targetX, targetZ) + this.targetHeightOffset, targetZ];
    const eye = applyClearance(
      source,
      [eyeX, source.heightAt(eyeX, eyeZ) + this.cameraHeightOffset, eyeZ],
      this.clearance,
    );
    return keyframeFromEye(time, eye, target, this.fovDeg);
  }

  toJSON(): TerrainRigJSON {
    return {
      kind: "rail",
      version: 1,
      options: {
        pathXZ: this.pathXZ.map((point) => [point[0], point[1]] as XZ),
        duration: this.duration,
        cameraHeightOffset: this.cameraHeightOffset,
        lookAheadDistance: this.lookAheadDistance,
        lateralOffset: this.lateralOffset,
        targetHeightOffset: this.targetHeightOffset,
        fovDeg: this.fovDeg,
        clearance: this.clearance.toJSON(),
      },
    };
  }
}

export class TerrainTargetFollowRig extends TerrainRigBase {
  readonly kind = "follow" as const;
  readonly targetPathXZ: readonly Readonly<XZ>[];
  readonly duration: number;
  readonly radius: number;
  readonly thetaDeg: number;
  readonly headingOffsetDeg: number;
  readonly targetHeightOffset: number;
  readonly fovDeg: number;
  readonly clearance: TerrainClearance;

  constructor(options: TerrainTargetFollowRigOptions) {
    super();
    if (options === null || typeof options !== "object") {
      throw invalid("follow rig options must be an object");
    }
    this.targetPathXZ = Object.freeze(
      coercePath("targetPathXZ", options.targetPathXZ).map((point) => Object.freeze(point)),
    );
    this.duration = positive("duration", options.duration);
    this.radius = positive("radius", options.radius);
    this.thetaDeg = polar("thetaDeg", options.thetaDeg ?? 45);
    this.headingOffsetDeg = finite("headingOffsetDeg", options.headingOffsetDeg ?? 180);
    this.targetHeightOffset = finite("targetHeightOffset", options.targetHeightOffset ?? 0);
    this.fovDeg = positive("fovDeg", options.fovDeg ?? 55);
    this.clearance = coerceClearance(options.clearance);
    Object.freeze(this);
  }

  sampleKeyframe(source: TerrainRigSource, time: number): CameraKeyframe {
    this.targetPathXZ.forEach((point, index) =>
      validatePoint(source, [point[0], point[1]], `targetPathXZ[${index}]`),
    );
    const path = new PolylinePath(this.targetPathXZ as XZ[]);
    const sample = path.sampleDistance(path.totalLength * alphaFor(time, this.duration));
    const target: Vec3 = [
      sample.x,
      source.heightAt(sample.x, sample.z) + this.targetHeightOffset,
      sample.z,
    ];
    const headingDeg = Math.atan2(sample.tangentZ, sample.tangentX) * (180 / Math.PI);
    const eye = orbitEye(target, this.radius, headingDeg + this.headingOffsetDeg, this.thetaDeg);
    validatePoint(source, [eye[0], eye[2]], "follow camera eye");
    return keyframeFromEye(time, applyClearance(source, eye, this.clearance), target, this.fovDeg);
  }

  toJSON(): TerrainRigJSON {
    return {
      kind: "follow",
      version: 1,
      options: {
        targetPathXZ: this.targetPathXZ.map((point) => [point[0], point[1]] as XZ),
        duration: this.duration,
        radius: this.radius,
        thetaDeg: this.thetaDeg,
        headingOffsetDeg: this.headingOffsetDeg,
        targetHeightOffset: this.targetHeightOffset,
        fovDeg: this.fovDeg,
        clearance: this.clearance.toJSON(),
      },
    };
  }
}

export type TerrainRig = TerrainOrbitRig | TerrainRailRig | TerrainTargetFollowRig;

/** Rebuilds a rig from `rig.toJSON()`. */
export function terrainRigFromJSON(json: TerrainRigJSON): TerrainRig {
  if (json === null || typeof json !== "object" || json.version !== 1) {
    throw invalid(`terrain rig JSON must be version 1 of kind '${RIG_JSON_KIND}'`);
  }
  switch (json.kind) {
    case "orbit":
      return new TerrainOrbitRig(json.options as TerrainOrbitRigOptions);
    case "rail":
      return new TerrainRailRig(json.options as TerrainRailRigOptions);
    case "follow":
      return new TerrainTargetFollowRig(json.options as TerrainTargetFollowRigOptions);
    default:
      throw invalid("terrain rig kind must be 'orbit', 'rail' or 'follow'");
  }
}
