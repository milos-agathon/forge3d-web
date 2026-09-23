import { Forge3DError } from "./index.js";
import type {
  CameraAnimationJSON,
  CameraAnimationSample,
  CameraInput,
  CameraKeyframeInput,
  CameraKeyframeJSON,
  CameraState,
  CameraStateCameraOptions,
  RenderConfigOptions,
  Vec3,
} from "./index.js";
import { validateCameraInput } from "./camera.js";

/**
 * Target-aware camera keyframe animation with Catmull-Rom (cubic Hermite)
 * interpolation. Values are stored and evaluated with IEEE single precision
 * (`Math.fround` after every operation), reproducing the native
 * `CameraAnimation` bit-for-bit so sampled paths match the native oracle.
 */

const fr = Math.fround;
const DEGREES_TO_RADIANS = Math.PI / 180;
const ANIMATION_JSON_KIND = "forge3d.camera-animation";

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}

function finite(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`keyframe ${name} must be finite`);
  }
  return value;
}

/** Catmull-Rom basis between `p1` (t = 0) and `p2` (t = 1), in f32. */
export function cubicHermite(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = fr(t * t);
  const t3 = fr(t2 * t);
  const h1 = fr(fr(fr(-0.5 * t3) + t2) - fr(0.5 * t));
  const h2 = fr(fr(fr(1.5 * t3) - fr(2.5 * t2)) + 1);
  const h3 = fr(fr(fr(-1.5 * t3) + fr(2 * t2)) + fr(0.5 * t));
  const h4 = fr(fr(0.5 * t3) - fr(0.5 * t2));
  return fr(fr(fr(fr(h1 * p0) + fr(h2 * p1)) + fr(h3 * p2)) + fr(h4 * p3));
}

/** Immutable keyframe; all values are rounded to f32 like the native store. */
export class CameraKeyframe {
  readonly time: number;
  readonly phiDeg: number;
  readonly thetaDeg: number;
  readonly radius: number;
  readonly fovDeg: number;
  readonly target: Readonly<Vec3> | null;

  constructor(input: CameraKeyframeInput) {
    if (input === null || typeof input !== "object") {
      throw invalid("keyframe must be an object");
    }
    this.time = fr(finite("time", input.time));
    this.phiDeg = fr(finite("phiDeg", input.phiDeg));
    this.thetaDeg = fr(finite("thetaDeg", input.thetaDeg));
    this.radius = fr(finite("radius", input.radius));
    this.fovDeg = fr(finite("fovDeg", input.fovDeg));
    const target = input.target;
    if (target === undefined || target === null) {
      this.target = null;
    } else {
      if (
        !Array.isArray(target) ||
        target.length !== 3 ||
        !target.every((value) => typeof value === "number" && Number.isFinite(value))
      ) {
        throw invalid("keyframe target components must be finite");
      }
      this.target = Object.freeze([fr(target[0]), fr(target[1]), fr(target[2])]) as Readonly<Vec3>;
    }
    Object.freeze(this);
  }

  static from(input: CameraKeyframeInput | CameraKeyframe): CameraKeyframe {
    return input instanceof CameraKeyframe ? input : new CameraKeyframe(input);
  }

  toJSON(): CameraKeyframeJSON {
    return {
      time: this.time,
      phiDeg: this.phiDeg,
      thetaDeg: this.thetaDeg,
      radius: this.radius,
      fovDeg: this.fovDeg,
      target: this.target === null ? null : [this.target[0], this.target[1], this.target[2]],
    };
  }

  toString(): string {
    const target =
      this.target === null
        ? "None"
        : `(${this.target.map((value) => value.toFixed(2)).join(", ")})`;
    return (
      `CameraKeyframe(time=${this.time.toFixed(2)}, phi=${this.phiDeg.toFixed(2)}, ` +
      `theta=${this.thetaDeg.toFixed(2)}, radius=${this.radius.toFixed(2)}, ` +
      `fov=${this.fovDeg.toFixed(2)}, target=${target})`
    );
  }
}

/**
 * Eye position of an orbit state (rig convention, polar angle from +Y):
 * `x = r sinθ cosφ`, `y = r cosθ`, `z = r sinθ sinφ` around the target.
 */
export function cameraStateEye(state: CameraState, fallbackTarget?: Readonly<Vec3>): Vec3 {
  const target = state.target ?? fallbackTarget;
  if (target === undefined || target === null) {
    throw invalid("camera state has no target; pass fallbackTarget");
  }
  return orbitEye(target, state.radius, state.phiDeg, state.thetaDeg);
}

export function orbitEye(
  target: Readonly<Vec3>,
  radius: number,
  phiDeg: number,
  thetaDeg: number,
): Vec3 {
  const phi = phiDeg * DEGREES_TO_RADIANS;
  const theta = thetaDeg * DEGREES_TO_RADIANS;
  const sinTheta = Math.sin(theta);
  return [
    target[0] + radius * sinTheta * Math.cos(phi),
    target[1] + radius * Math.cos(theta),
    target[2] + radius * sinTheta * Math.sin(phi),
  ];
}

/** Renderer camera for an animation state. */
export function cameraStateToInput(
  state: CameraState,
  options: CameraStateCameraOptions = {},
): CameraInput {
  const target = state.target ?? options.fallbackTarget;
  if (target === undefined || target === null) {
    throw invalid("camera state has no target; pass fallbackTarget");
  }
  const eye = orbitEye(target, state.radius, state.phiDeg, state.thetaDeg);
  const input: CameraInput = {
    position: eye,
    target: [target[0], target[1], target[2]],
    up: options.up ?? [0, 1, 0],
    fovYDegrees: state.fovDeg,
    near: options.near ?? 0.1,
    far: options.far ?? Math.max(1000, state.radius * 10),
  };
  if (options.projection !== undefined) {
    input.projection = options.projection;
  }
  if (options.orthographicHeight !== undefined) {
    input.orthographicHeight = options.orthographicHeight;
  }
  return validateCameraInput(input);
}

function sortKeyframes(keyframes: CameraKeyframe[]): void {
  // Array.prototype.sort is stable, preserving insertion order for ties.
  keyframes.sort((left, right) => left.time - right.time);
}

function interpolateTarget(
  k0: CameraKeyframe,
  k1: CameraKeyframe,
  k2: CameraKeyframe,
  k3: CameraKeyframe,
  t: number,
): Vec3 | null {
  const p1 = k1.target;
  const p2 = k2.target;
  if (p1 === null || p2 === null) {
    return null;
  }
  const p0 = k0.target ?? p1;
  const p3 = k3.target ?? p2;
  return [
    cubicHermite(p0[0], p1[0], p2[0], p3[0], t),
    cubicHermite(p0[1], p1[1], p2[1], p3[1], t),
    cubicHermite(p0[2], p1[2], p2[2], p3[2], t),
  ];
}

export class CameraAnimation {
  #keyframes: CameraKeyframe[] = [];

  constructor(keyframes?: Iterable<CameraKeyframeInput | CameraKeyframe>) {
    if (keyframes !== undefined) {
      this.replaceKeyframes(keyframes);
    }
  }

  static fromJSON(json: CameraAnimationJSON): CameraAnimation {
    if (json === null || typeof json !== "object" || json.kind !== ANIMATION_JSON_KIND) {
      throw invalid(`camera animation JSON must have kind '${ANIMATION_JSON_KIND}'`);
    }
    if (json.version !== 1 || !Array.isArray(json.keyframes)) {
      throw invalid("camera animation JSON version must be 1 with a keyframes array");
    }
    return new CameraAnimation(json.keyframes);
  }

  /** Inserts a keyframe; keyframes stay sorted by time (stable for ties). */
  addKeyframe(keyframe: CameraKeyframeInput | CameraKeyframe): void {
    const checked = CameraKeyframe.from(keyframe);
    this.#keyframes.push(checked);
    sortKeyframes(this.#keyframes);
  }

  /** Snapshot copy of the keyframes in time order. */
  getKeyframes(): CameraKeyframe[] {
    return [...this.#keyframes];
  }

  replaceKeyframes(keyframes: Iterable<CameraKeyframeInput | CameraKeyframe>): void {
    if (keyframes === null || typeof keyframes !== "object" || !(Symbol.iterator in keyframes)) {
      throw invalid("replaceKeyframes expects an iterable of keyframes");
    }
    const next = Array.from(keyframes, (keyframe) => CameraKeyframe.from(keyframe));
    sortKeyframes(next);
    this.#keyframes = next;
  }

  clearKeyframes(): void {
    this.#keyframes = [];
  }

  get keyframeCount(): number {
    return this.#keyframes.length;
  }

  /** Time of the last keyframe in seconds (animations start at 0). */
  get duration(): number {
    return this.#keyframes.at(-1)?.time ?? 0;
  }

  /** Inclusive frame count `ceil(duration * fps) + 1`, or 0. */
  getFrameCount(fps: number): number {
    if (!Number.isSafeInteger(fps) || fps < 0) {
      throw invalid("fps must be a non-negative integer");
    }
    const duration = this.duration;
    if (duration <= 0 || fps === 0) {
      return 0;
    }
    return Math.ceil(fr(duration * fr(fps))) + 1;
  }

  /** Frame times `frame / fps` for every frame of `getFrameCount(fps)`. */
  frameTimes(fps: number): number[] {
    const count = this.getFrameCount(fps);
    return Array.from({ length: count }, (_, frame) => frame / fps);
  }

  /** Deterministic per-frame samples for offline rendering. */
  sample(fps: number): CameraAnimationSample[] {
    return this.frameTimes(fps).map((time, frame) => ({
      frame,
      time,
      state: this.evaluate(time) as CameraState,
    }));
  }

  /** Interpolated state at `time` (clamped to the keyframe range). */
  evaluate(time: number): CameraState | undefined {
    if (typeof time !== "number" || Number.isNaN(time)) {
      throw invalid("time must be a number");
    }
    const keyframes = this.#keyframes;
    const n = keyframes.length;
    const first = keyframes[0];
    const last = keyframes[n - 1];
    if (first === undefined || last === undefined) {
      return undefined;
    }
    const clamped = Math.min(Math.max(fr(time), first.time), last.time);
    let k0: CameraKeyframe;
    let k1: CameraKeyframe;
    let k2: CameraKeyframe;
    let k3: CameraKeyframe;
    let t = 0;
    if (n === 1) {
      k0 = k1 = k2 = k3 = first;
    } else {
      let index = 0;
      for (let i = 0; i < n; i += 1) {
        if ((keyframes[i] as CameraKeyframe).time > clamped) {
          index = Math.max(0, i - 1);
          break;
        }
        index = i;
      }
      if (index >= n - 1) {
        index = n - 2;
      }
      k1 = keyframes[index] as CameraKeyframe;
      k2 = keyframes[index + 1] as CameraKeyframe;
      k0 = index > 0 ? (keyframes[index - 1] as CameraKeyframe) : k1;
      k3 = index + 2 < n ? (keyframes[index + 2] as CameraKeyframe) : k2;
      const segment = fr(k2.time - k1.time);
      t = segment > 0 ? fr(fr(clamped - k1.time) / segment) : 0;
    }
    return {
      phiDeg: cubicHermite(k0.phiDeg, k1.phiDeg, k2.phiDeg, k3.phiDeg, t),
      thetaDeg: cubicHermite(k0.thetaDeg, k1.thetaDeg, k2.thetaDeg, k3.thetaDeg, t),
      radius: cubicHermite(k0.radius, k1.radius, k2.radius, k3.radius, t),
      fovDeg: cubicHermite(k0.fovDeg, k1.fovDeg, k2.fovDeg, k3.fovDeg, t),
      target: interpolateTarget(k0, k1, k2, k3, t),
    };
  }

  /** Renderer camera at `time`, or `undefined` for an empty animation. */
  cameraAt(time: number, options: CameraStateCameraOptions = {}): CameraInput | undefined {
    const state = this.evaluate(time);
    return state === undefined ? undefined : cameraStateToInput(state, options);
  }

  toJSON(): CameraAnimationJSON {
    return {
      kind: ANIMATION_JSON_KIND,
      version: 1,
      keyframes: this.#keyframes.map((keyframe) => keyframe.toJSON()),
    };
  }

  toString(): string {
    return `CameraAnimation(keyframes=${this.keyframeCount}, duration=${this.duration.toFixed(2)}s)`;
  }
}

/** Offline frame-sequence configuration (native `RenderConfig`). */
export class RenderConfig {
  readonly outputDir: string;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly filenamePrefix: string;
  readonly frameDigits: number;

  constructor(options: RenderConfigOptions = {}) {
    this.outputDir = options.outputDir ?? "frames";
    this.fps = positiveInteger("fps", options.fps ?? 30);
    this.width = positiveInteger("width", options.width ?? 1920);
    this.height = positiveInteger("height", options.height ?? 1080);
    this.filenamePrefix = options.filenamePrefix ?? "frame";
    this.frameDigits = positiveInteger("frameDigits", options.frameDigits ?? 4);
    if (typeof this.outputDir !== "string" || typeof this.filenamePrefix !== "string") {
      throw invalid("outputDir and filenamePrefix must be strings");
    }
    if (/[\\/]/.test(this.filenamePrefix)) {
      throw invalid("filenamePrefix must not contain path separators");
    }
    Object.freeze(this);
  }

  /** `{prefix}_{frame zero-padded}.png`. */
  frameFileName(frame: number): string {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw invalid("frame must be a non-negative integer");
    }
    return `${this.filenamePrefix}_${String(frame).padStart(this.frameDigits, "0")}.png`;
  }

  /** `{outputDir}/{frameFileName(frame)}` using `/` separators. */
  framePath(frame: number): string {
    const directory = this.outputDir.replace(/[\\/]+$/, "");
    const name = this.frameFileName(frame);
    return directory === "" ? name : `${directory}/${name}`;
  }

  /**
   * Browser equivalent of the native `ensure_output_dir`: creates (or opens)
   * the nested `outputDir` below a File System Access / OPFS directory.
   */
  async ensureOutputDir(root: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
    if (root === null || typeof root !== "object" || typeof root.getDirectoryHandle !== "function") {
      throw invalid("ensureOutputDir requires a FileSystemDirectoryHandle");
    }
    let directory = root;
    for (const segment of this.outputDir.split(/[\\/]+/)) {
      if (segment === "" || segment === ".") {
        continue;
      }
      if (segment === "..") {
        throw invalid("outputDir must not escape the root directory");
      }
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    return directory;
  }
}

/** Progress for render callbacks (native `RenderProgress`). */
export class RenderProgress {
  readonly frame: number;
  readonly totalFrames: number;
  readonly time: number;
  readonly outputPath: string;

  constructor(frame: number, totalFrames: number, time: number, outputPath: string) {
    this.frame = frame;
    this.totalFrames = totalFrames;
    this.time = time;
    this.outputPath = outputPath;
    Object.freeze(this);
  }

  /** Fraction complete in `[0, 1]`; `0` when there are no frames. */
  get percent(): number {
    return this.totalFrames === 0 ? 0 : this.frame / this.totalFrames;
  }

  toString(): string {
    return `RenderProgress(${this.frame}/${this.totalFrames}, ${(this.percent * 100).toFixed(1)}%)`;
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${name} must be a positive integer`);
  }
  return value;
}
