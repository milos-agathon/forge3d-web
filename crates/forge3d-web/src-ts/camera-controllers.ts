import { Forge3DError } from "./index.js";
import type {
  CameraControllerMode,
  CameraControllerOptions,
  CameraControllerState,
  CameraInput,
  CameraInputEvent,
  CameraKeyAction,
  CameraKeyBindings,
  FlyControlsOptions,
  FlyInputState,
  FlyView,
  OrbitView,
  Vec3,
} from "./index.js";
import { cloneCameraInput, validateCameraInput } from "./camera.js";
import { OrbitController, defaultOrbitView } from "./orbit-controller.js";

/**
 * Fly (FPS) camera and the combined orbit/fly controller.
 *
 * Both controllers share the direction convention
 * `dir(yaw, pitch) = (cos p sin y, sin p, cos p cos y)` (degrees): the orbit
 * eye is `target + distance * dir` and the fly forward vector is `dir`, as in
 * the native viewer `camera_controller`. Movement follows the native FPS
 * camera: `forward` moves along the full view direction, `right` along
 * `forward x up`, `up` along world +Y, at `moveSpeed` units per second, with
 * a boost multiplier (native Shift = 2x). Mode switches keep the eye and view
 * direction continuous (the native sync jumped the view; see the core
 * `camera::controller` notes).
 *
 * Every mutation can be expressed as a serializable `CameraInputEvent`;
 * applying a recorded event list to a controller in the same initial state
 * reproduces the camera bit-for-bit (deterministic replay).
 */

const DEGREES_TO_RADIANS = Math.PI / 180;
/** Native pitch margin: 0.01 rad inside +/-90 degrees. */
const FLY_PITCH_LIMIT_DEGREES = 90 - 0.01 / DEGREES_TO_RADIANS;

const DEFAULT_FLY_VIEW: Readonly<FlyView> = {
  position: [0, 5, -10],
  yawDegrees: 0,
  pitchDegrees: 0,
  fovYDegrees: 46,
  near: 0.01,
  far: 100,
};

/** Default key bindings (`KeyboardEvent.code`). */
export const DEFAULT_CAMERA_KEY_BINDINGS: Readonly<Required<CameraKeyBindings>> = Object.freeze({
  forward: Object.freeze(["KeyW", "ArrowUp"]),
  backward: Object.freeze(["KeyS", "ArrowDown"]),
  left: Object.freeze(["KeyA", "ArrowLeft"]),
  right: Object.freeze(["KeyD", "ArrowRight"]),
  up: Object.freeze(["KeyE"]),
  down: Object.freeze(["KeyQ"]),
  boost: Object.freeze(["ShiftLeft", "ShiftRight"]),
  // Native used Tab; the browser default avoids trapping keyboard focus.
  toggleMode: Object.freeze(["KeyV"]),
  reset: Object.freeze(["Home"]),
}) as Readonly<Required<CameraKeyBindings>>;

const KEY_ACTIONS: readonly CameraKeyAction[] = [
  "forward",
  "backward",
  "left",
  "right",
  "up",
  "down",
  "boost",
  "toggleMode",
  "reset",
];

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}

function assertFinite(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${name} must be finite`);
  }
}

function assertPositive(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0) {
    throw invalid(`${name} must be greater than zero`);
  }
}

function assertNonNegative(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0) {
    throw invalid(`${name} must not be negative`);
  }
}

function assertVec3(name: string, value: unknown): asserts value is Vec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((component) => typeof component === "number" && Number.isFinite(component))
  ) {
    throw invalid(`${name} must contain three finite numbers`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Wraps degrees into `(-180, 180]`. */
function wrapDegrees(value: number): number {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** `dir(yaw, pitch)` in degrees. */
export function cameraDirection(yawDegrees: number, pitchDegrees: number): Vec3 {
  const yaw = yawDegrees * DEGREES_TO_RADIANS;
  const pitch = pitchDegrees * DEGREES_TO_RADIANS;
  return [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
}

/** `[yawDegrees, pitchDegrees]` whose `cameraDirection` is `vector`. */
export function yawPitchFromDirection(vector: Readonly<Vec3>): [number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!(length > 0) || !Number.isFinite(length)) {
    throw invalid("direction must be a nonzero finite vector");
  }
  return [
    Math.atan2(vector[0], vector[2]) / DEGREES_TO_RADIANS,
    Math.asin(clamp(vector[1] / length, -1, 1)) / DEGREES_TO_RADIANS,
  ];
}

interface ResolvedFlyOptions {
  moveSpeed: number;
  boostMultiplier: number;
  lookSpeed: number;
  minPitchDegrees: number;
  maxPitchDegrees: number;
}

function resolveFlyOptions(options: FlyControlsOptions): ResolvedFlyOptions {
  const resolved: ResolvedFlyOptions = {
    moveSpeed: options.moveSpeed ?? 5,
    boostMultiplier: options.boostMultiplier ?? 2,
    lookSpeed: options.lookSpeed ?? 0.25,
    minPitchDegrees: options.minPitchDegrees ?? -FLY_PITCH_LIMIT_DEGREES,
    maxPitchDegrees: options.maxPitchDegrees ?? FLY_PITCH_LIMIT_DEGREES,
  };
  assertNonNegative("moveSpeed", resolved.moveSpeed);
  assertPositive("boostMultiplier", resolved.boostMultiplier);
  assertNonNegative("lookSpeed", resolved.lookSpeed);
  assertFinite("minPitchDegrees", resolved.minPitchDegrees);
  assertFinite("maxPitchDegrees", resolved.maxPitchDegrees);
  if (
    resolved.minPitchDegrees <= -90 ||
    resolved.maxPitchDegrees >= 90 ||
    resolved.minPitchDegrees > resolved.maxPitchDegrees
  ) {
    throw invalid("fly pitch limits must be ordered and strictly inside (-90, 90) degrees");
  }
  return resolved;
}

function cloneFlyView(view: Readonly<FlyView>): FlyView {
  return {
    position: [view.position[0], view.position[1], view.position[2]],
    yawDegrees: view.yawDegrees,
    pitchDegrees: view.pitchDegrees,
    fovYDegrees: view.fovYDegrees,
    near: view.near,
    far: view.far,
  };
}

function flyViewsEqual(left: FlyView, right: FlyView): boolean {
  return (
    left.position.every((value, index) => Object.is(value, right.position[index])) &&
    Object.is(left.yawDegrees, right.yawDegrees) &&
    Object.is(left.pitchDegrees, right.pitchDegrees) &&
    Object.is(left.fovYDegrees, right.fovYDegrees) &&
    Object.is(left.near, right.near) &&
    Object.is(left.far, right.far)
  );
}

export function defaultFlyView(): FlyView {
  return cloneFlyView(DEFAULT_FLY_VIEW);
}

/** Resolved movement axes `(forward, right, up)` for held keys. */
export function flyInputAxes(input: FlyInputState, boostMultiplier = 2): Vec3 {
  const multiplier = input.boost === true ? boostMultiplier : 1;
  const axis = (positive: boolean | undefined, negative: boolean | undefined): number =>
    ((positive === true ? 1 : 0) - (negative === true ? 1 : 0)) * multiplier;
  return [
    axis(input.forward, input.backward),
    axis(input.right, input.left),
    axis(input.up, input.down),
  ];
}

/** Free-flying first-person camera (native FPS camera). */
export class FlyController {
  readonly #options: ResolvedFlyOptions;
  readonly #initialView: FlyView;
  #view: FlyView;

  constructor(initialView: FlyView = defaultFlyView(), options: FlyControlsOptions = {}) {
    this.#options = resolveFlyOptions(options);
    this.#view = this.#normalize(initialView);
    this.#initialView = cloneFlyView(this.#view);
  }

  /** Fly view that reproduces `camera`'s eye and view direction. */
  static viewFromCamera(camera: CameraInput): FlyView {
    const checked = validateCameraInput(camera);
    const [yawDegrees, pitchDegrees] = yawPitchFromDirection([
      checked.target[0] - checked.position[0],
      checked.target[1] - checked.position[1],
      checked.target[2] - checked.position[2],
    ]);
    return {
      position: [checked.position[0], checked.position[1], checked.position[2]],
      yawDegrees,
      pitchDegrees: clamp(pitchDegrees, -FLY_PITCH_LIMIT_DEGREES, FLY_PITCH_LIMIT_DEGREES),
      fovYDegrees: checked.fovYDegrees,
      near: checked.near,
      far: checked.far,
    };
  }

  get moveSpeed(): number {
    return this.#options.moveSpeed;
  }

  get lookSpeed(): number {
    return this.#options.lookSpeed;
  }

  get boostMultiplier(): number {
    return this.#options.boostMultiplier;
  }

  getView(): FlyView {
    return cloneFlyView(this.#view);
  }

  setView(view: FlyView): boolean {
    return this.#commit(this.#normalize(view));
  }

  get forward(): Vec3 {
    return cameraDirection(this.#view.yawDegrees, this.#view.pitchDegrees);
  }

  /** Horizontal right vector `forward x up`. */
  get right(): Vec3 {
    const f = this.forward;
    const right: Vec3 = [-f[2], 0, f[0]];
    const length = Math.hypot(right[0], right[2]);
    return [right[0] / length, 0, right[2] / length];
  }

  getCamera(): CameraInput {
    const view = this.#view;
    const f = this.forward;
    return {
      position: [view.position[0], view.position[1], view.position[2]],
      target: [view.position[0] + f[0], view.position[1] + f[1], view.position[2] + f[2]],
      up: [0, 1, 0],
      fovYDegrees: view.fovYDegrees,
      near: view.near,
      far: view.far,
    };
  }

  /** Rotates the view; pitch is clamped to the configured limits. */
  lookBy(deltaYawDegrees: number, deltaPitchDegrees: number): boolean {
    assertFinite("deltaYawDegrees", deltaYawDegrees);
    assertFinite("deltaPitchDegrees", deltaPitchDegrees);
    const next = cloneFlyView(this.#view);
    next.yawDegrees = wrapDegrees(next.yawDegrees + deltaYawDegrees);
    next.pitchDegrees = clamp(
      next.pitchDegrees + deltaPitchDegrees,
      this.#options.minPitchDegrees,
      this.#options.maxPitchDegrees,
    );
    return this.#commit(next);
  }

  /** Moves by world-unit distances along forward/right/up. */
  moveBy(forward: number, right: number, up: number): boolean {
    assertFinite("forward", forward);
    assertFinite("right", right);
    assertFinite("up", up);
    const f = this.forward;
    const r = this.right;
    const next = cloneFlyView(this.#view);
    next.position = [
      next.position[0] + f[0] * forward + r[0] * right,
      next.position[1] + f[1] * forward + up,
      next.position[2] + f[2] * forward + r[2] * right,
    ];
    if (!next.position.every(Number.isFinite)) {
      throw invalid("fly movement produced a non-finite position");
    }
    return this.#commit(next);
  }

  /** Native `update(dt)`: held-key axes times `moveSpeed * dt`. */
  update(deltaSeconds: number, input: FlyInputState): boolean {
    assertNonNegative("deltaSeconds", deltaSeconds);
    const [forward, right, up] = flyInputAxes(input, this.#options.boostMultiplier);
    const step = this.#options.moveSpeed * deltaSeconds;
    return this.moveBy(forward * step, right * step, up * step);
  }

  /** Changes the vertical field of view (clamped to [1, 179] degrees). */
  zoomBy(deltaFovDegrees: number): boolean {
    assertFinite("deltaFovDegrees", deltaFovDegrees);
    return this.#commit({
      ...cloneFlyView(this.#view),
      fovYDegrees: clamp(this.#view.fovYDegrees + deltaFovDegrees, 1, 179),
    });
  }

  reset(): boolean {
    return this.#commit(cloneFlyView(this.#initialView));
  }

  #normalize(view: FlyView): FlyView {
    if (view === null || typeof view !== "object") {
      throw invalid("fly view must be an object");
    }
    assertVec3("position", view.position);
    assertFinite("yawDegrees", view.yawDegrees);
    assertFinite("pitchDegrees", view.pitchDegrees);
    assertFinite("fovYDegrees", view.fovYDegrees);
    assertPositive("near", view.near);
    assertPositive("far", view.far);
    if (view.far <= view.near) {
      throw invalid("far must be greater than near");
    }
    return {
      position: [view.position[0], view.position[1], view.position[2]],
      yawDegrees: view.yawDegrees,
      pitchDegrees: clamp(view.pitchDegrees, this.#options.minPitchDegrees, this.#options.maxPitchDegrees),
      fovYDegrees: clamp(view.fovYDegrees, 1, 179),
      near: view.near,
      far: view.far,
    };
  }

  #commit(next: FlyView): boolean {
    if (flyViewsEqual(this.#view, next)) {
      return false;
    }
    this.#view = next;
    return true;
  }
}

/** Normalized key bindings: each action maps to a frozen list of codes. */
export function resolveCameraKeyBindings(
  bindings: CameraKeyBindings = {},
): Readonly<Required<CameraKeyBindings>> {
  if (bindings === null || typeof bindings !== "object") {
    throw invalid("key bindings must be an object");
  }
  const resolved = {} as Record<CameraKeyAction, readonly string[]>;
  const owners = new Map<string, CameraKeyAction>();
  for (const action of KEY_ACTIONS) {
    const codes = bindings[action] ?? DEFAULT_CAMERA_KEY_BINDINGS[action];
    if (!Array.isArray(codes) || codes.some((code) => typeof code !== "string" || code === "")) {
      throw invalid(`key binding '${action}' must be an array of KeyboardEvent.code strings`);
    }
    for (const code of codes) {
      const owner = owners.get(code);
      if (owner !== undefined && owner !== action) {
        throw invalid(`key '${code}' is bound to both '${owner}' and '${action}'`);
      }
      owners.set(code, action);
    }
    resolved[action] = Object.freeze([...codes]);
  }
  for (const key of Object.keys(bindings)) {
    if (!KEY_ACTIONS.includes(key as CameraKeyAction)) {
      throw invalid(`unknown key binding action '${key}'`);
    }
  }
  return Object.freeze(resolved) as Readonly<Required<CameraKeyBindings>>;
}

/**
 * Orbit + fly controller with mode switching, key bindings and
 * deterministic, serializable input events.
 */
export class CameraController {
  readonly orbit: OrbitController;
  readonly fly: FlyController;
  readonly bindings: Readonly<Required<CameraKeyBindings>>;
  readonly #pressed = new Set<string>();
  readonly #initialMode: CameraControllerMode;
  #mode: CameraControllerMode;
  #recording: CameraInputEvent[] | undefined;

  constructor(options: CameraControllerOptions = {}, orbit?: OrbitController) {
    if (options === null || typeof options !== "object") {
      throw invalid("camera controller options must be an object");
    }
    this.orbit = orbit ?? new OrbitController(options.orbit ?? defaultOrbitView(), options.orbitOptions ?? {});
    this.fly = new FlyController(
      options.fly ?? FlyController.viewFromCamera(this.orbit.getCamera()),
      options.flyOptions ?? {},
    );
    this.bindings = resolveCameraKeyBindings(options.bindings);
    const mode = options.mode ?? "orbit";
    if (mode !== "orbit" && mode !== "fly") {
      throw invalid("camera controller mode must be 'orbit' or 'fly'");
    }
    this.#mode = mode;
    this.#initialMode = mode;
  }

  get mode(): CameraControllerMode {
    return this.#mode;
  }

  /** Movement keys currently held (fly mode only uses them). */
  get flyInput(): FlyInputState {
    const held = (action: CameraKeyAction): boolean =>
      this.bindings[action].some((code) => this.#pressed.has(code));
    return {
      forward: held("forward"),
      backward: held("backward"),
      left: held("left"),
      right: held("right"),
      up: held("up"),
      down: held("down"),
      boost: held("boost"),
    };
  }

  /** True while fly mode has a held movement key (needs per-frame ticks). */
  get moving(): boolean {
    if (this.#mode !== "fly") {
      return false;
    }
    const [forward, right, up] = flyInputAxes(this.flyInput);
    return forward !== 0 || right !== 0 || up !== 0;
  }

  /** Active camera for the renderer. */
  getCamera(): CameraInput {
    return this.#mode === "orbit" ? this.orbit.getCamera() : this.fly.getCamera();
  }

  getState(): CameraControllerState {
    return { mode: this.#mode, orbit: this.orbit.getView(), fly: this.fly.getView() };
  }

  /** Restores a `getState()` snapshot; returns whether anything changed. */
  setState(state: CameraControllerState): boolean {
    if (state === null || typeof state !== "object") {
      throw invalid("camera controller state must be an object");
    }
    if (state.mode !== "orbit" && state.mode !== "fly") {
      throw invalid("camera controller mode must be 'orbit' or 'fly'");
    }
    const orbitChanged = this.orbit.setView(state.orbit);
    const flyChanged = this.fly.setView(state.fly);
    const modeChanged = this.#mode !== state.mode;
    this.#mode = state.mode;
    this.#pressed.clear();
    return orbitChanged || flyChanged || modeChanged;
  }

  /**
   * Switches mode, carrying the eye and view direction across: fly takes the
   * orbit eye looking at the orbit target; orbit re-targets `distance` units
   * ahead of the fly eye.
   */
  setMode(mode: CameraControllerMode): boolean {
    return this.apply({ type: "mode", mode });
  }

  toggleMode(): CameraControllerMode {
    this.setMode(this.#mode === "orbit" ? "fly" : "orbit");
    return this.#mode;
  }

  /**
   * Points both controllers at `camera` (eye, target, FOV and clip planes);
   * the active mode is kept.
   */
  setCamera(camera: CameraInput): boolean {
    const checked = validateCameraInput(camera);
    const offset: Vec3 = [
      checked.position[0] - checked.target[0],
      checked.position[1] - checked.target[1],
      checked.position[2] - checked.target[2],
    ];
    const [yawDegrees, pitchDegrees] = yawPitchFromDirection(offset);
    const orbitChanged = this.orbit.setView({
      target: [checked.target[0], checked.target[1], checked.target[2]],
      distance: Math.hypot(offset[0], offset[1], offset[2]),
      yawDegrees,
      pitchDegrees,
      fovYDegrees: checked.fovYDegrees,
      near: checked.near,
      far: checked.far,
    });
    const flyChanged = this.fly.setView(FlyController.viewFromCamera(checked));
    return orbitChanged || flyChanged;
  }

  /** Starts recording every applied input event (replaces a prior recording). */
  startRecording(): void {
    this.#recording = [];
  }

  /** Stops recording and returns the recorded events. */
  stopRecording(): CameraInputEvent[] {
    const events = this.#recording ?? [];
    this.#recording = undefined;
    return events;
  }

  get recording(): boolean {
    return this.#recording !== undefined;
  }

  /** Applies one input event; returns whether the camera changed. */
  apply(event: CameraInputEvent): boolean {
    const checked = validateEvent(event);
    this.#recording?.push(checked);
    switch (checked.type) {
      case "orbit":
        return this.#mode === "orbit"
          ? this.orbit.orbitBy(checked.deltaYawDegrees, checked.deltaPitchDegrees)
          : false;
      case "pan":
        return this.#mode === "orbit"
          ? this.orbit.panBy(checked.deltaX, checked.deltaY, checked.viewportHeight)
          : false;
      case "zoom":
        return this.#mode === "orbit"
          ? this.orbit.zoomBy(checked.delta)
          : false;
      case "look":
        return this.#mode === "fly"
          ? this.fly.lookBy(checked.deltaYawDegrees, checked.deltaPitchDegrees)
          : false;
      case "move":
        return this.#mode === "fly"
          ? this.fly.moveBy(checked.forward, checked.right, checked.up)
          : false;
      case "key":
        return this.#applyKey(checked.code, checked.pressed);
      case "tick":
        return this.#mode === "fly" ? this.fly.update(checked.deltaSeconds, this.flyInput) : false;
      case "mode":
        return this.#switchMode(checked.mode);
      case "reset":
        return this.#mode === "orbit" ? this.orbit.reset() : this.fly.reset();
      case "releaseKeys":
        this.#pressed.clear();
        return false;
    }
  }

  /** Applies a recorded event list; returns whether anything changed. */
  replay(events: readonly CameraInputEvent[]): boolean {
    if (!Array.isArray(events)) {
      throw invalid("replay expects an array of camera input events");
    }
    let changed = false;
    for (const event of events) {
      changed = this.apply(event) || changed;
    }
    return changed;
  }

  /** Restores the construction-time mode and both initial views. */
  resetAll(): boolean {
    const orbit = this.orbit.reset();
    const fly = this.fly.reset();
    const mode = this.#mode !== this.#initialMode;
    this.#mode = this.#initialMode;
    this.#pressed.clear();
    return orbit || fly || mode;
  }

  #applyKey(code: string, pressed: boolean): boolean {
    const wasPressed = this.#pressed.has(code);
    if (pressed) {
      this.#pressed.add(code);
    } else {
      this.#pressed.delete(code);
    }
    if (!pressed || wasPressed) {
      return false;
    }
    if (this.bindings.toggleMode.includes(code)) {
      return this.#switchMode(this.#mode === "orbit" ? "fly" : "orbit");
    }
    if (this.bindings.reset.includes(code) && this.#mode === "fly") {
      return this.fly.reset();
    }
    return false;
  }

  #switchMode(mode: CameraControllerMode): boolean {
    if (mode === this.#mode) {
      return false;
    }
    if (mode === "fly") {
      const orbit = this.orbit.getView();
      this.fly.setView({
        position: this.orbit.getCamera().position,
        yawDegrees: wrapDegrees(orbit.yawDegrees + 180),
        pitchDegrees: -orbit.pitchDegrees,
        fovYDegrees: orbit.fovYDegrees,
        near: orbit.near,
        far: orbit.far,
      });
    } else {
      const fly = this.fly.getView();
      const orbit = this.orbit.getView();
      const forward = this.fly.forward;
      const next: OrbitView = {
        target: [
          fly.position[0] + forward[0] * orbit.distance,
          fly.position[1] + forward[1] * orbit.distance,
          fly.position[2] + forward[2] * orbit.distance,
        ],
        distance: orbit.distance,
        yawDegrees: wrapDegrees(fly.yawDegrees + 180),
        pitchDegrees: -fly.pitchDegrees,
        fovYDegrees: fly.fovYDegrees,
        near: fly.near,
        far: fly.far,
      };
      this.orbit.setView(next);
    }
    this.#mode = mode;
    return true;
  }
}

function validateEvent(event: CameraInputEvent): CameraInputEvent {
  if (event === null || typeof event !== "object") {
    throw invalid("camera input event must be an object");
  }
  switch (event.type) {
    case "orbit":
    case "look":
      assertFinite(`${event.type}.deltaYawDegrees`, event.deltaYawDegrees);
      assertFinite(`${event.type}.deltaPitchDegrees`, event.deltaPitchDegrees);
      return { type: event.type, deltaYawDegrees: event.deltaYawDegrees, deltaPitchDegrees: event.deltaPitchDegrees };
    case "pan":
      assertFinite("pan.deltaX", event.deltaX);
      assertFinite("pan.deltaY", event.deltaY);
      assertPositive("pan.viewportHeight", event.viewportHeight);
      return { type: "pan", deltaX: event.deltaX, deltaY: event.deltaY, viewportHeight: event.viewportHeight };
    case "zoom":
      assertFinite("zoom.delta", event.delta);
      return { type: "zoom", delta: event.delta };
    case "move":
      assertFinite("move.forward", event.forward);
      assertFinite("move.right", event.right);
      assertFinite("move.up", event.up);
      return { type: "move", forward: event.forward, right: event.right, up: event.up };
    case "key":
      if (typeof event.code !== "string" || event.code === "" || typeof event.pressed !== "boolean") {
        throw invalid("key event requires a code string and pressed boolean");
      }
      return { type: "key", code: event.code, pressed: event.pressed };
    case "tick":
      assertNonNegative("tick.deltaSeconds", event.deltaSeconds);
      return { type: "tick", deltaSeconds: event.deltaSeconds };
    case "mode":
      if (event.mode !== "orbit" && event.mode !== "fly") {
        throw invalid("mode event requires 'orbit' or 'fly'");
      }
      return { type: "mode", mode: event.mode };
    case "reset":
      return { type: "reset" };
    case "releaseKeys":
      return { type: "releaseKeys" };
    default:
      throw invalid(`unknown camera input event type '${String((event as { type?: unknown }).type)}'`);
  }
}

/** Replays `events` on a fresh controller and returns its final camera. */
export function replayCameraInput(
  options: CameraControllerOptions,
  events: readonly CameraInputEvent[],
): CameraInput {
  const controller = new CameraController(options);
  controller.replay(events);
  return cloneCameraInput(controller.getCamera());
}
