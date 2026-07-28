import type {
  CameraInput,
  OrbitControlsOptions,
  OrbitView,
} from "./index.js";

const DEFAULT_VIEW: Readonly<OrbitView> = {
  target: [0, 0, 0],
  distance: 2.72,
  yawDegrees: 0,
  pitchDegrees: 24,
  fovYDegrees: 46,
  near: 0.01,
  far: 100,
};

const MIN_FOV_DEGREES = 1;
const MAX_FOV_DEGREES = 179;
const DEGREES_TO_RADIANS = Math.PI / 180;
const WHEEL_EXPONENT_SCALE = 0.001;

interface ResolvedOrbitOptions {
  orbitSpeed: number;
  panSpeed: number;
  zoomSpeed: number;
  minDistance: number;
  maxDistance: number;
  minPitchDegrees: number;
  maxPitchDegrees: number;
}

/**
 * Browser-independent, Y-up orbit camera math.
 *
 * The complete camera is derived from the canonical OrbitView on every read.
 * No operation incrementally mutates the previous camera position.
 */
export class OrbitController {
  readonly #options: ResolvedOrbitOptions;
  readonly #initialView: OrbitView;
  #view: OrbitView;

  constructor(
    initialView: OrbitView = defaultOrbitView(),
    options: OrbitControlsOptions = {},
  ) {
    this.#options = resolveOptions(options);
    this.#view = normalizeView(initialView, this.#options);
    this.#initialView = cloneView(this.#view);
  }

  getView(): OrbitView {
    return cloneView(this.#view);
  }

  getCamera(): CameraInput {
    const view = this.#view;
    const yaw = view.yawDegrees * DEGREES_TO_RADIANS;
    const pitch = view.pitchDegrees * DEGREES_TO_RADIANS;
    const horizontalDistance = view.distance * Math.cos(pitch);
    const position: [number, number, number] = [
      view.target[0] + horizontalDistance * Math.sin(yaw),
      view.target[1] + view.distance * Math.sin(pitch),
      view.target[2] + horizontalDistance * Math.cos(yaw),
    ];

    assertFiniteTuple("derived camera position", position);
    return {
      position,
      target: cloneTuple(view.target),
      up: [0, 1, 0],
      fovYDegrees: view.fovYDegrees,
      near: view.near,
      far: view.far,
    };
  }

  setView(view: OrbitView): boolean {
    const next = normalizeView(view, this.#options);
    return this.#commit(next);
  }

  orbitBy(deltaYawDegrees: number, deltaPitchDegrees: number): boolean {
    assertFinite("deltaYawDegrees", deltaYawDegrees);
    assertFinite("deltaPitchDegrees", deltaPitchDegrees);

    const yawDelta = deltaYawDegrees * this.#options.orbitSpeed;
    const pitchDelta = deltaPitchDegrees * this.#options.orbitSpeed;
    if (!Number.isFinite(yawDelta) || !Number.isFinite(pitchDelta)) {
      throw new TypeError("scaled orbit deltas must be finite");
    }

    const next = cloneView(this.#view);
    const yawDegrees = next.yawDegrees + yawDelta;
    if (!Number.isFinite(yawDegrees)) {
      throw new TypeError("resulting yawDegrees must be finite");
    }
    next.yawDegrees = yawDegrees;
    next.pitchDegrees = clamp(
      next.pitchDegrees + pitchDelta,
      this.#options.minPitchDegrees,
      this.#options.maxPitchDegrees,
    );
    return this.#commit(next);
  }

  /**
   * Pans by CSS-pixel deltas. Sensitivity depends on distance, FOV, and CSS
   * viewport height only, so it is independent of device pixel ratio.
   */
  panBy(
    deltaXCssPixels: number,
    deltaYCssPixels: number,
    viewportHeightCssPixels: number,
  ): boolean {
    assertFinite("deltaXCssPixels", deltaXCssPixels);
    assertFinite("deltaYCssPixels", deltaYCssPixels);
    assertPositiveFinite("viewportHeightCssPixels", viewportHeightCssPixels);

    const view = this.#view;
    const yaw = view.yawDegrees * DEGREES_TO_RADIANS;
    const pitch = view.pitchDegrees * DEGREES_TO_RADIANS;
    const radians = view.fovYDegrees * DEGREES_TO_RADIANS;
    const worldUnitsPerCssPixel =
      (2 * view.distance * Math.tan(radians / 2) * this.#options.panSpeed) /
      viewportHeightCssPixels;

    const right: [number, number, number] = [
      Math.cos(yaw),
      0,
      -Math.sin(yaw),
    ];
    const screenUp: [number, number, number] = [
      -Math.sin(yaw) * Math.sin(pitch),
      Math.cos(pitch),
      -Math.cos(yaw) * Math.sin(pitch),
    ];
    const horizontal = -deltaXCssPixels * worldUnitsPerCssPixel;
    const vertical = deltaYCssPixels * worldUnitsPerCssPixel;
    const target: [number, number, number] = [
      view.target[0] + right[0] * horizontal + screenUp[0] * vertical,
      view.target[1] + right[1] * horizontal + screenUp[1] * vertical,
      view.target[2] + right[2] * horizontal + screenUp[2] * vertical,
    ];
    assertFiniteTuple("panned target", target);

    return this.#commit({ ...cloneView(view), target });
  }

  /**
   * Applies an exponential zoom. Positive deltas zoom out and negative deltas
   * zoom in; a finite delta can never cross or reach zero distance.
   */
  zoomBy(delta: number): boolean {
    assertFinite("zoom delta", delta);
    const exponent = delta * this.#options.zoomSpeed * WHEEL_EXPONENT_SCALE;
    if (!Number.isFinite(exponent)) {
      throw new TypeError("scaled zoom delta must be finite");
    }

    const minLog = Math.log(this.#options.minDistance);
    const maxLog = Math.log(this.#options.maxDistance);
    const distance = Math.exp(
      clamp(Math.log(this.#view.distance) + exponent, minLog, maxLog),
    );
    return this.#commit({ ...cloneView(this.#view), distance });
  }

  reset(): boolean {
    return this.#commit(cloneView(this.#initialView));
  }

  #commit(next: OrbitView): boolean {
    if (viewsEqual(this.#view, next)) {
      return false;
    }
    this.#view = next;
    return true;
  }
}

export function defaultOrbitView(): OrbitView {
  return cloneView(DEFAULT_VIEW);
}

function resolveOptions(options: OrbitControlsOptions): ResolvedOrbitOptions {
  const resolved: ResolvedOrbitOptions = {
    orbitSpeed: options.orbitSpeed ?? 1,
    panSpeed: options.panSpeed ?? 1,
    zoomSpeed: options.zoomSpeed ?? 1,
    minDistance: options.minDistance ?? 0.01,
    maxDistance: options.maxDistance ?? 1_000_000,
    minPitchDegrees: options.minPitchDegrees ?? -89,
    maxPitchDegrees: options.maxPitchDegrees ?? 89,
  };

  assertNonNegativeFinite("orbitSpeed", resolved.orbitSpeed);
  assertNonNegativeFinite("panSpeed", resolved.panSpeed);
  assertNonNegativeFinite("zoomSpeed", resolved.zoomSpeed);
  assertPositiveFinite("minDistance", resolved.minDistance);
  assertPositiveFinite("maxDistance", resolved.maxDistance);
  if (resolved.minDistance > resolved.maxDistance) {
    throw new RangeError("minDistance must not exceed maxDistance");
  }
  assertFinite("minPitchDegrees", resolved.minPitchDegrees);
  assertFinite("maxPitchDegrees", resolved.maxPitchDegrees);
  if (
    resolved.minPitchDegrees <= -90 ||
    resolved.maxPitchDegrees >= 90 ||
    resolved.minPitchDegrees > resolved.maxPitchDegrees
  ) {
    throw new RangeError(
      "pitch limits must be ordered and strictly inside (-90, 90) degrees",
    );
  }
  return resolved;
}

function normalizeView(
  view: OrbitView,
  options: ResolvedOrbitOptions,
): OrbitView {
  assertFiniteTuple("target", view.target);
  assertPositiveFinite("distance", view.distance);
  assertFinite("yawDegrees", view.yawDegrees);
  assertFinite("pitchDegrees", view.pitchDegrees);
  assertFinite("fovYDegrees", view.fovYDegrees);
  assertPositiveFinite("near", view.near);
  assertPositiveFinite("far", view.far);
  if (view.far <= view.near) {
    throw new RangeError("far must be greater than near");
  }

  return {
    target: cloneTuple(view.target),
    distance: clamp(view.distance, options.minDistance, options.maxDistance),
    yawDegrees: view.yawDegrees,
    pitchDegrees: clamp(
      view.pitchDegrees,
      options.minPitchDegrees,
      options.maxPitchDegrees,
    ),
    fovYDegrees: clamp(
      view.fovYDegrees,
      MIN_FOV_DEGREES,
      MAX_FOV_DEGREES,
    ),
    near: view.near,
    far: view.far,
  };
}

function cloneView(view: Readonly<OrbitView>): OrbitView {
  return {
    target: cloneTuple(view.target),
    distance: view.distance,
    yawDegrees: view.yawDegrees,
    pitchDegrees: view.pitchDegrees,
    fovYDegrees: view.fovYDegrees,
    near: view.near,
    far: view.far,
  };
}

function cloneTuple(
  tuple: readonly [number, number, number],
): [number, number, number] {
  return [tuple[0], tuple[1], tuple[2]];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function viewsEqual(left: OrbitView, right: OrbitView): boolean {
  return (
    left.target.every((value, index) => Object.is(value, right.target[index])) &&
    Object.is(left.distance, right.distance) &&
    Object.is(left.yawDegrees, right.yawDegrees) &&
    Object.is(left.pitchDegrees, right.pitchDegrees) &&
    Object.is(left.fovYDegrees, right.fovYDegrees) &&
    Object.is(left.near, right.near) &&
    Object.is(left.far, right.far)
  );
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
}

function assertPositiveFinite(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0) {
    throw new RangeError(`${name} must be greater than zero`);
  }
}

function assertNonNegativeFinite(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0) {
    throw new RangeError(`${name} must not be negative`);
  }
}

function assertFiniteTuple(
  name: string,
  tuple: readonly [number, number, number],
): void {
  if (tuple.length !== 3 || tuple.some((value) => !Number.isFinite(value))) {
    throw new TypeError(`${name} must contain three finite numbers`);
  }
}
