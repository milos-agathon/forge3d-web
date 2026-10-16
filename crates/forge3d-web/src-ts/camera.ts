import { Forge3DError } from "./index.js";
import type {
  CameraDofParams,
  CameraDofParamsInput,
  CameraInput,
  CameraJSON,
  CameraOptions,
  CameraProjectionKind,
  ClipSpace,
  DepthOfFieldRange,
  PathTracingCamera,
  PathTracingCameraInput,
  ScreenPoint,
  ScreenRay,
  Vec3,
  ViewportSize,
} from "./index.js";

/**
 * Camera math for the browser package: look-at, perspective/orthographic
 * projection, view-projection, TRS transforms, world/screen conversion and
 * depth-of-field helpers.
 *
 * Conventions match native Forge3D: right-handed, Y-up, -Z forward look-at;
 * projections default to WebGPU clip space (depth `0..1`) and can target GL
 * clip space (`-1..1`). Matrices are column-major `Float32Array(16)` (WebGPU
 * uniform layout); `mat4ToRows`/`mat4FromRows` convert to and from the native
 * row-major NumPy layout. Validation messages keep the native wording but name
 * the browser parameters.
 */

const UP_COLINEAR_EPSILON = 1e-6;
const MIN_VECTOR_LENGTH = 1e-6;
const DEGREES_TO_RADIANS = Math.PI / 180;

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}

// ---------------------------------------------------------------------------
// Vector helpers (f64)
// ---------------------------------------------------------------------------

function sub(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length(a: Readonly<Vec3>): number {
  return Math.sqrt(dot(a, a));
}

function normalizeOrZero(a: Readonly<Vec3>): Vec3 {
  const len = length(a);
  return len > 0 && Number.isFinite(len)
    ? [a[0] / len, a[1] / len, a[2] / len]
    : [0, 0, 0];
}

function normalize(a: Readonly<Vec3>): Vec3 {
  const len = length(a);
  return [a[0] / len, a[1] / len, a[2] / len];
}

function isFiniteVec3(value: unknown): value is Vec3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

function copyVec3(value: Readonly<Vec3>): Vec3 {
  return [value[0], value[1], value[2]];
}

// ---------------------------------------------------------------------------
// Matrix helpers (column-major)
// ---------------------------------------------------------------------------

function fromColumns(values: readonly number[]): Float32Array {
  const matrix = new Float32Array(16);
  for (let index = 0; index < 16; index += 1) {
    matrix[index] = values[index] ?? 0;
  }
  return matrix;
}

function element(matrix: ArrayLike<number>, index: number): number {
  return matrix[index] ?? 0;
}

function multiplyColumns(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += element(left, k * 4 + row) * element(right, column * 4 + k);
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function assertMat4(name: string, matrix: ArrayLike<number>): void {
  if (matrix === null || typeof matrix !== "object" || matrix.length !== 16) {
    throw invalid(`${name} must be a 16-element column-major matrix`);
  }
  for (let index = 0; index < 16; index += 1) {
    if (!Number.isFinite(matrix[index])) {
      throw invalid(`${name} components must be finite`);
    }
  }
}

const GL_TO_WGPU = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1];

function applyClip(projectionGl: readonly number[], clipSpace: ClipSpace): Float32Array {
  return fromColumns(
    clipSpace === "gl" ? projectionGl : multiplyColumns(GL_TO_WGPU, projectionGl),
  );
}

function resolveClipSpace(clipSpace: unknown): ClipSpace {
  if (clipSpace === undefined || clipSpace === "wgpu") {
    return "wgpu";
  }
  if (clipSpace === "gl") {
    return "gl";
  }
  throw invalid("clipSpace must be 'wgpu' or 'gl'");
}

/** Converts a column-major matrix to native row-major rows. */
export function mat4ToRows(matrix: ArrayLike<number>): number[][] {
  assertMat4("matrix", matrix);
  return [0, 1, 2, 3].map((row) =>
    [0, 1, 2, 3].map((column) => element(matrix, column * 4 + row)),
  );
}

/** Builds a column-major matrix from native row-major rows. */
export function mat4FromRows(rows: readonly (readonly number[])[]): Float32Array {
  if (!Array.isArray(rows) || rows.length !== 4 || rows.some((row) => row.length !== 4)) {
    throw invalid("rows must be a 4x4 array");
  }
  const values: number[] = [];
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      values.push(rows[row]?.[column] ?? Number.NaN);
    }
  }
  const matrix = fromColumns(values);
  assertMat4("rows", matrix);
  return matrix;
}

// ---------------------------------------------------------------------------
// Validation shared with native
// ---------------------------------------------------------------------------

function validateVectors(eye: unknown, target: unknown, up: unknown): void {
  if (!isFiniteVec3(eye) || !isFiniteVec3(target) || !isFiniteVec3(up)) {
    throw invalid("eye/target/up components must be finite");
  }
}

function validateUpNotColinear(eye: Readonly<Vec3>, target: Readonly<Vec3>, up: Readonly<Vec3>): void {
  const view = normalizeOrZero(sub(target, eye));
  const upUnit = normalizeOrZero(up);
  const c = cross(view, upUnit);
  if (dot(c, c) < UP_COLINEAR_EPSILON) {
    throw invalid("up vector must not be colinear with view direction");
  }
}

function validateFov(fovYDegrees: number): void {
  if (!Number.isFinite(fovYDegrees) || fovYDegrees <= 0 || fovYDegrees >= 180) {
    throw invalid("fovYDegrees must be finite and in (0, 180)");
  }
}

function validateAspect(aspect: number): void {
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw invalid("aspect must be finite and > 0");
  }
}

function validateNearFar(near: number, far: number): void {
  if (!Number.isFinite(near) || near <= 0) {
    throw invalid("near must be finite and > 0");
  }
  if (!Number.isFinite(far) || far <= near) {
    throw invalid("far must be finite and > near");
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** View matrix (right-handed, Y-up, -Z forward). */
export function lookAt(eye: Readonly<Vec3>, target: Readonly<Vec3>, up: Readonly<Vec3>): Float32Array {
  validateVectors(eye, target, up);
  validateUpNotColinear(eye, target, up);
  return lookAtUnchecked(eye, target, up);
}

function lookAtUnchecked(eye: Readonly<Vec3>, target: Readonly<Vec3>, up: Readonly<Vec3>): Float32Array {
  const f = normalize(sub(target, eye));
  const s = normalize(cross(f, up));
  const u = cross(s, f);
  return fromColumns([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(eye, s), -dot(eye, u), dot(eye, f), 1,
  ]);
}

function perspectiveGl(fovYDegrees: number, aspect: number, near: number, far: number): number[] {
  const invLength = 1 / (near - far);
  const f = 1 / Math.tan(0.5 * fovYDegrees * DEGREES_TO_RADIANS);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (near + far) * invLength, -1,
    0, 0, 2 * near * far * invLength, 0,
  ];
}

function orthographicGl(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): number[] {
  const w = right - left;
  const h = top - bottom;
  const d = far - near;
  return [
    2 / w, 0, 0, 0,
    0, 2 / h, 0, 0,
    0, 0, -2 / d, 0,
    -(right + left) / w, -(top + bottom) / h, -(far + near) / d, 1,
  ];
}

/** Perspective projection (vertical FOV in degrees). */
export function perspective(
  fovYDegrees: number,
  aspect: number,
  near: number,
  far: number,
  clipSpace: ClipSpace = "wgpu",
): Float32Array {
  validateFov(fovYDegrees);
  validateAspect(aspect);
  validateNearFar(near, far);
  return applyClip(perspectiveGl(fovYDegrees, aspect, near, far), resolveClipSpace(clipSpace));
}

/** Orthographic projection with explicit view-volume bounds. */
export function orthographic(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
  clipSpace: ClipSpace = "wgpu",
): Float32Array {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left >= right) {
    throw invalid("left must be finite and < right");
  }
  if (!Number.isFinite(bottom) || !Number.isFinite(top) || bottom >= top) {
    throw invalid("bottom must be finite and < top");
  }
  validateNearFar(near, far);
  return applyClip(
    orthographicGl(left, right, bottom, top, near, far),
    resolveClipSpace(clipSpace),
  );
}

/** Combined perspective `projection * view`. */
export function viewProjection(
  eye: Readonly<Vec3>,
  target: Readonly<Vec3>,
  up: Readonly<Vec3>,
  fovYDegrees: number,
  aspect: number,
  near: number,
  far: number,
  clipSpace: ClipSpace = "wgpu",
): Float32Array {
  const view = lookAt(eye, target, up);
  const projection = perspective(fovYDegrees, aspect, near, far, clipSpace);
  return fromColumns(multiplyColumns(projection, view));
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

function finiteArgs(name: string, values: readonly number[]): void {
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw invalid(`${name} arguments must be finite`);
  }
}

export function translate(tx: number, ty: number, tz: number): Float32Array {
  finiteArgs("translate", [tx, ty, tz]);
  return fromColumns([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]);
}

export function rotateX(degrees: number): Float32Array {
  finiteArgs("rotateX", [degrees]);
  const radians = degrees * DEGREES_TO_RADIANS;
  const s = Math.sin(radians);
  const c = Math.cos(radians);
  return fromColumns([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

export function rotateY(degrees: number): Float32Array {
  finiteArgs("rotateY", [degrees]);
  const radians = degrees * DEGREES_TO_RADIANS;
  const s = Math.sin(radians);
  const c = Math.cos(radians);
  return fromColumns([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

export function rotateZ(degrees: number): Float32Array {
  finiteArgs("rotateZ", [degrees]);
  const radians = degrees * DEGREES_TO_RADIANS;
  const s = Math.sin(radians);
  const c = Math.cos(radians);
  return fromColumns([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function scale(sx: number, sy: number, sz: number): Float32Array {
  finiteArgs("scale", [sx, sy, sz]);
  return fromColumns([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]);
}

export function scaleUniform(s: number): Float32Array {
  return scale(s, s, s);
}

type Quat = [number, number, number, number];

function axisQuat(axis: 0 | 1 | 2, degrees: number): Quat {
  const half = degrees * DEGREES_TO_RADIANS * 0.5;
  const q: Quat = [0, 0, 0, Math.cos(half)];
  q[axis] = Math.sin(half);
  return q;
}

function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** `T * R * S`; Euler rotation applied X, then Y, then Z (`Rz * Ry * Rx`). */
export function composeTrs(
  translation: Readonly<Vec3>,
  rotationDegrees: Readonly<Vec3>,
  scaleVector: Readonly<Vec3>,
): Float32Array {
  if (!isFiniteVec3(translation) || !isFiniteVec3(rotationDegrees) || !isFiniteVec3(scaleVector)) {
    throw invalid("composeTrs translation, rotationDegrees and scale must be finite 3-vectors");
  }
  const [x, y, z, w] = quatMultiply(
    quatMultiply(axisQuat(2, rotationDegrees[2]), axisQuat(1, rotationDegrees[1])),
    axisQuat(0, rotationDegrees[0]),
  );
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const [sx, sy, sz] = scaleVector;
  return fromColumns([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}

/** Object-to-world transform pointing the object's local -Z at `target`. */
export function lookAtTransform(
  position: Readonly<Vec3>,
  target: Readonly<Vec3>,
  up: Readonly<Vec3>,
): Float32Array {
  validateVectors(position, target, up);
  validateUpNotColinear(position, target, up);
  const forward = normalize(sub(target, position));
  const right = normalize(cross(forward, up));
  const correctedUp = cross(right, forward);
  return fromColumns([
    right[0], right[1], right[2], 0,
    correctedUp[0], correctedUp[1], correctedUp[2], 0,
    -forward[0], -forward[1], -forward[2], 0,
    position[0], position[1], position[2], 1,
  ]);
}

export function multiplyMatrices(left: ArrayLike<number>, right: ArrayLike<number>): Float32Array {
  assertMat4("left", left);
  assertMat4("right", right);
  return fromColumns(multiplyColumns(left, right));
}

function inverseColumns(m: ArrayLike<number>): number[] | undefined {
  const a = (index: number): number => element(m, index);
  const inv = new Array<number>(16);
  inv[0] = a(5) * a(10) * a(15) - a(5) * a(11) * a(14) - a(9) * a(6) * a(15) + a(9) * a(7) * a(14) + a(13) * a(6) * a(11) - a(13) * a(7) * a(10);
  inv[4] = -a(4) * a(10) * a(15) + a(4) * a(11) * a(14) + a(8) * a(6) * a(15) - a(8) * a(7) * a(14) - a(12) * a(6) * a(11) + a(12) * a(7) * a(10);
  inv[8] = a(4) * a(9) * a(15) - a(4) * a(11) * a(13) - a(8) * a(5) * a(15) + a(8) * a(7) * a(13) + a(12) * a(5) * a(11) - a(12) * a(7) * a(9);
  inv[12] = -a(4) * a(9) * a(14) + a(4) * a(10) * a(13) + a(8) * a(5) * a(14) - a(8) * a(6) * a(13) - a(12) * a(5) * a(10) + a(12) * a(6) * a(9);
  inv[1] = -a(1) * a(10) * a(15) + a(1) * a(11) * a(14) + a(9) * a(2) * a(15) - a(9) * a(3) * a(14) - a(13) * a(2) * a(11) + a(13) * a(3) * a(10);
  inv[5] = a(0) * a(10) * a(15) - a(0) * a(11) * a(14) - a(8) * a(2) * a(15) + a(8) * a(3) * a(14) + a(12) * a(2) * a(11) - a(12) * a(3) * a(10);
  inv[9] = -a(0) * a(9) * a(15) + a(0) * a(11) * a(13) + a(8) * a(1) * a(15) - a(8) * a(3) * a(13) - a(12) * a(1) * a(11) + a(12) * a(3) * a(9);
  inv[13] = a(0) * a(9) * a(14) - a(0) * a(10) * a(13) - a(8) * a(1) * a(14) + a(8) * a(2) * a(13) + a(12) * a(1) * a(10) - a(12) * a(2) * a(9);
  inv[2] = a(1) * a(6) * a(15) - a(1) * a(7) * a(14) - a(5) * a(2) * a(15) + a(5) * a(3) * a(14) + a(13) * a(2) * a(7) - a(13) * a(3) * a(6);
  inv[6] = -a(0) * a(6) * a(15) + a(0) * a(7) * a(14) + a(4) * a(2) * a(15) - a(4) * a(3) * a(14) - a(12) * a(2) * a(7) + a(12) * a(3) * a(6);
  inv[10] = a(0) * a(5) * a(15) - a(0) * a(7) * a(13) - a(4) * a(1) * a(15) + a(4) * a(3) * a(13) + a(12) * a(1) * a(7) - a(12) * a(3) * a(5);
  inv[14] = -a(0) * a(5) * a(14) + a(0) * a(6) * a(13) + a(4) * a(1) * a(14) - a(4) * a(2) * a(13) - a(12) * a(1) * a(6) + a(12) * a(2) * a(5);
  inv[3] = -a(1) * a(6) * a(11) + a(1) * a(7) * a(10) + a(5) * a(2) * a(11) - a(5) * a(3) * a(10) - a(9) * a(2) * a(7) + a(9) * a(3) * a(6);
  inv[7] = a(0) * a(6) * a(11) - a(0) * a(7) * a(10) - a(4) * a(2) * a(11) + a(4) * a(3) * a(10) + a(8) * a(2) * a(7) - a(8) * a(3) * a(6);
  inv[11] = -a(0) * a(5) * a(11) + a(0) * a(7) * a(9) + a(4) * a(1) * a(11) - a(4) * a(3) * a(9) - a(8) * a(1) * a(7) + a(8) * a(3) * a(5);
  inv[15] = a(0) * a(5) * a(10) - a(0) * a(6) * a(9) - a(4) * a(1) * a(10) + a(4) * a(2) * a(9) + a(8) * a(1) * a(6) - a(8) * a(2) * a(5);
  const determinant = a(0) * (inv[0] ?? 0) + a(1) * (inv[4] ?? 0) + a(2) * (inv[8] ?? 0) + a(3) * (inv[12] ?? 0);
  if (!Number.isFinite(determinant) || determinant === 0) {
    return undefined;
  }
  return inv.map((value) => value / determinant);
}

export function invertMatrix(matrix: ArrayLike<number>): Float32Array {
  assertMat4("matrix", matrix);
  const inverse = inverseColumns(matrix);
  if (inverse === undefined) {
    throw invalid("matrix must be invertible");
  }
  return fromColumns(inverse);
}

/** Inverse-transpose of the upper 3x3, embedded in a 4x4 with unit `w`. */
export function normalMatrix(modelMatrix: ArrayLike<number>): Float32Array {
  assertMat4("modelMatrix", modelMatrix);
  const m = (column: number, row: number): number => element(modelMatrix, column * 4 + row);
  const a = m(0, 0), b = m(1, 0), c = m(2, 0);
  const d = m(0, 1), e = m(1, 1), f = m(2, 1);
  const g = m(0, 2), h = m(1, 2), i = m(2, 2);
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  if (!Number.isFinite(determinant) || determinant === 0) {
    throw invalid("modelMatrix upper 3x3 must be invertible");
  }
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  // inverse = adjugate / det; the normal matrix is its transpose, i.e. the
  // cofactor matrix / det, stored column-major.
  const s = 1 / determinant;
  return fromColumns([
    A * s, D * s, G * s, 0,
    B * s, E * s, H * s, 0,
    C * s, F * s, I * s, 0,
    0, 0, 0, 1,
  ]);
}

// ---------------------------------------------------------------------------
// World/screen conversion
// ---------------------------------------------------------------------------

function validateViewport(viewport: ViewportSize): void {
  if (
    viewport === null ||
    typeof viewport !== "object" ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    throw invalid("viewport width and height must be finite and > 0");
  }
}

function transform(matrix: ArrayLike<number>, x: number, y: number, z: number, w: number): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let row = 0; row < 4; row += 1) {
    out[row] =
      element(matrix, row) * x +
      element(matrix, 4 + row) * y +
      element(matrix, 8 + row) * z +
      element(matrix, 12 + row) * w;
  }
  return out;
}

/**
 * Projects a world point to pixels (origin top-left, +Y down) and WebGPU NDC
 * depth. Returns `undefined` for points behind the camera.
 */
export function worldToScreen(
  viewProjectionMatrix: ArrayLike<number>,
  point: Readonly<Vec3>,
  viewport: ViewportSize,
): ScreenPoint | undefined {
  assertMat4("viewProjection", viewProjectionMatrix);
  if (!isFiniteVec3(point)) {
    throw invalid("point must contain three finite numbers");
  }
  validateViewport(viewport);
  const [x, y, z, w] = transform(viewProjectionMatrix, point[0], point[1], point[2], 1);
  if (!(w > 0) || !Number.isFinite(x + y + z + w)) {
    return undefined;
  }
  return {
    x: ((x / w + 1) * 0.5) * viewport.width,
    y: ((1 - y / w) * 0.5) * viewport.height,
    depth: z / w,
  };
}

/** Unprojects a pixel at WebGPU NDC `depth` (0 = near, 1 = far). */
export function screenToWorld(
  inverseViewProjection: ArrayLike<number>,
  x: number,
  y: number,
  depth: number,
  viewport: ViewportSize,
): Vec3 {
  assertMat4("inverseViewProjection", inverseViewProjection);
  validateViewport(viewport);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(depth)) {
    throw invalid("screen coordinates must be finite");
  }
  const ndcX = (2 * x) / viewport.width - 1;
  const ndcY = 1 - (2 * y) / viewport.height;
  const [wx, wy, wz, ww] = transform(inverseViewProjection, ndcX, ndcY, depth, 1);
  if (!Number.isFinite(ww) || Math.abs(ww) <= Number.EPSILON) {
    throw invalid("point unprojects to infinity");
  }
  return [wx / ww, wy / ww, wz / ww];
}

/** Picking ray from the near plane through a pixel (unit direction). */
export function screenRay(
  inverseViewProjection: ArrayLike<number>,
  x: number,
  y: number,
  viewport: ViewportSize,
): ScreenRay {
  const near = screenToWorld(inverseViewProjection, x, y, 0, viewport);
  const far = screenToWorld(inverseViewProjection, x, y, 1, viewport);
  const direction = normalizeOrZero(sub(far, near));
  if (direction[0] === 0 && direction[1] === 0 && direction[2] === 0) {
    throw invalid("screen ray is degenerate");
  }
  return { origin: near, direction };
}

// ---------------------------------------------------------------------------
// Depth of field
// ---------------------------------------------------------------------------

function positive(value: number, message: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid(message);
  }
}

function f32(value: number): number {
  return Math.fround(value);
}

export function fStopToAperture(fStop: number): number {
  positive(fStop, "fStop must be finite and > 0");
  return f32(1 / f32(fStop));
}

export function apertureToFStop(aperture: number): number {
  positive(aperture, "aperture must be finite and > 0");
  return f32(1 / f32(aperture));
}

export function hyperfocalDistance(
  focalLength: number,
  fStop: number,
  circleOfConfusion = 0.03,
): number {
  positive(focalLength, "focalLength must be finite and > 0");
  positive(fStop, "fStop must be finite and > 0");
  positive(circleOfConfusion, "circleOfConfusion must be finite and > 0");
  return hyperfocalF32(f32(focalLength), f32(fStop), f32(circleOfConfusion));
}

function hyperfocalF32(focal: number, fStop: number, coc: number): number {
  return f32(f32(f32(focal * focal) / f32(fStop * coc)) + focal);
}

/** Near/far sharpness limits; `far` is `Infinity` beyond the hyperfocal distance. */
export function depthOfFieldRange(
  focalLength: number,
  fStop: number,
  focusDistance: number,
  circleOfConfusion = 0.03,
): DepthOfFieldRange {
  positive(focalLength, "focalLength must be finite and > 0");
  positive(focusDistance, "focusDistance must be finite and > 0");
  positive(fStop, "fStop must be finite and > 0");
  positive(circleOfConfusion, "circleOfConfusion must be finite and > 0");
  const fl = f32(focalLength);
  const fd = f32(focusDistance);
  const h = hyperfocalF32(fl, f32(fStop), f32(circleOfConfusion));
  const near = f32(f32(h * fd) / f32(f32(h + fd) - fl));
  const far = fd < f32(h - fl) ? f32(f32(h * fd) / f32(f32(h - fd) + fl)) : Infinity;
  return { near, far };
}

/** Circle of confusion in sensor millimetres for an object at `depth`. */
export function circleOfConfusion(
  depth: number,
  focalLength: number,
  aperture: number,
  focusDistance: number,
  sensorSize = 36,
): number {
  positive(depth, "depth must be finite and > 0");
  positive(focalLength, "focalLength must be finite and > 0");
  positive(aperture, "aperture must be finite and > 0");
  positive(focusDistance, "focusDistance must be finite and > 0");
  positive(sensorSize, "sensorSize must be finite and > 0");
  const d = f32(depth);
  const fl = f32(focalLength);
  const fd = f32(focusDistance);
  const diff = f32(Math.abs(f32(d - fd)));
  const denominator = f32(d * f32(fd + fl));
  if (denominator < 0.001) {
    return 0;
  }
  const coc = f32(f32(f32(f32(aperture) * fl) * diff) / denominator);
  return f32(coc * f32(sensorSize));
}

export function cameraDofParams(input: CameraDofParamsInput): CameraDofParams {
  if (input === null || typeof input !== "object") {
    throw invalid("dof params must be an object");
  }
  positive(input.aperture, "aperture must be finite and > 0");
  positive(input.focusDistance, "focusDistance must be finite and > 0");
  positive(input.focalLength, "focalLength must be finite and > 0");
  const autoFocusSpeed = input.autoFocusSpeed ?? 2;
  positive(autoFocusSpeed, "autoFocusSpeed must be finite and > 0");
  if (input.autoFocus !== undefined && typeof input.autoFocus !== "boolean") {
    throw invalid("autoFocus must be a boolean");
  }
  return {
    aperture: f32(input.aperture),
    focusDistance: f32(input.focusDistance),
    focalLength: f32(input.focalLength),
    autoFocus: input.autoFocus ?? false,
    autoFocusSpeed: f32(autoFocusSpeed),
  };
}

/** Path-tracing camera descriptor (native `make_camera`). */
export function makeCamera(input: PathTracingCameraInput): PathTracingCamera {
  if (input === null || typeof input !== "object") {
    throw invalid("camera descriptor must be an object");
  }
  validateVectors(input.origin, input.lookAt, input.up);
  validateUpNotColinear(input.origin, input.lookAt, input.up);
  validateFov(input.fovY);
  validateAspect(input.aspect);
  if (!Number.isFinite(input.exposure) || input.exposure <= 0) {
    throw invalid("exposure must be finite and > 0");
  }
  return {
    origin: copyVec3(input.origin),
    lookAt: copyVec3(input.lookAt),
    up: copyVec3(input.up),
    fovY: input.fovY,
    aspect: input.aspect,
    exposure: input.exposure,
  };
}

// ---------------------------------------------------------------------------
// CameraInput normalization shared by runtime, session and viewer
// ---------------------------------------------------------------------------

/** Copies a camera input, keeping only defined projection fields. */
export function cloneCameraInput(camera: CameraInput): CameraInput {
  const copy: CameraInput = {
    position: [camera.position[0], camera.position[1], camera.position[2]],
    target: [camera.target[0], camera.target[1], camera.target[2]],
    up: [camera.up[0], camera.up[1], camera.up[2]],
    fovYDegrees: camera.fovYDegrees,
    near: camera.near,
    far: camera.far,
  };
  if (camera.projection !== undefined) {
    copy.projection = camera.projection;
  }
  if (camera.orthographicHeight !== undefined) {
    copy.orthographicHeight = camera.orthographicHeight;
  }
  return copy;
}

/**
 * Validates a renderer camera and returns a detached copy. Throws
 * `INVALID_INPUT` with a `camera.<field>` message on the first violation.
 */
export function validateCameraInput(camera: CameraInput): CameraInput {
  if (camera === null || typeof camera !== "object") {
    throw invalid("camera must be an object");
  }
  for (const field of ["position", "target", "up"] as const) {
    const vector: unknown = camera[field];
    if (!Array.isArray(vector) || vector.length !== 3) {
      throw invalid(`camera.${field} must be a 3-component vector`);
    }
    if (!vector.every((component) => typeof component === "number" && Number.isFinite(component))) {
      throw invalid(`camera.${field} components must be finite`);
    }
  }
  const checked = cloneCameraInput(camera);
  if (length(checked.up) <= MIN_VECTOR_LENGTH) {
    throw invalid("camera.up must be a nonzero vector");
  }
  if (length(sub(checked.target, checked.position)) <= MIN_VECTOR_LENGTH) {
    throw invalid("camera.target must differ from camera.position");
  }
  const view = normalizeOrZero(sub(checked.target, checked.position));
  const c = cross(view, normalizeOrZero(checked.up));
  if (dot(c, c) < UP_COLINEAR_EPSILON) {
    throw invalid("camera.up must not be colinear with the view direction");
  }
  if (
    !Number.isFinite(checked.fovYDegrees) ||
    checked.fovYDegrees <= 0 ||
    checked.fovYDegrees >= 180
  ) {
    throw invalid("camera.fovYDegrees must be finite and within (0, 180)");
  }
  if (!Number.isFinite(checked.near) || checked.near <= 0) {
    throw invalid("camera.near must be finite and positive");
  }
  if (!Number.isFinite(checked.far) || checked.far <= checked.near) {
    throw invalid("camera.far must be finite and greater than near");
  }
  const projection = checked.projection ?? "perspective";
  if (projection !== "perspective" && projection !== "orthographic") {
    throw invalid("camera.projection must be 'perspective' or 'orthographic'");
  }
  if (projection === "orthographic") {
    const height = checked.orthographicHeight;
    if (height === undefined || !Number.isFinite(height) || height <= 0) {
      throw invalid("camera.orthographicHeight must be finite and positive for orthographic projection");
    }
  } else if (checked.orthographicHeight !== undefined) {
    throw invalid("camera.orthographicHeight is only valid for orthographic projection");
  }
  return checked;
}

// ---------------------------------------------------------------------------
// Camera class
// ---------------------------------------------------------------------------

const CAMERA_JSON_KIND = "forge3d.camera";

/**
 * Typed, validated camera with a perspective or orthographic projection.
 * Immutable: `with(...)` returns a modified copy.
 */
export class Camera {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  readonly fovYDegrees: number;
  readonly near: number;
  readonly far: number;
  readonly projection: CameraProjectionKind;
  readonly orthographicHeight: number | undefined;

  constructor(options: CameraOptions) {
    const input: CameraInput = {
      position: options.position,
      target: options.target,
      up: options.up ?? [0, 1, 0],
      fovYDegrees: options.fovYDegrees ?? 45,
      near: options.near ?? 0.1,
      far: options.far ?? 1000,
    };
    if (options.projection !== undefined) {
      input.projection = options.projection;
    }
    if (options.orthographicHeight !== undefined) {
      input.orthographicHeight = options.orthographicHeight;
    }
    const checked = validateCameraInput(input);
    this.position = checked.position;
    this.target = checked.target;
    this.up = checked.up;
    this.fovYDegrees = checked.fovYDegrees;
    this.near = checked.near;
    this.far = checked.far;
    this.projection = checked.projection ?? "perspective";
    this.orthographicHeight = checked.orthographicHeight;
    Object.freeze(this.position);
    Object.freeze(this.target);
    Object.freeze(this.up);
    Object.freeze(this);
  }

  static fromInput(input: CameraInput): Camera {
    const checked = validateCameraInput(input);
    return new Camera(checked);
  }

  static fromJSON(json: CameraJSON): Camera {
    if (json === null || typeof json !== "object" || json.kind !== CAMERA_JSON_KIND) {
      throw invalid(`camera JSON must have kind '${CAMERA_JSON_KIND}'`);
    }
    if (json.version !== 1) {
      throw invalid("camera JSON version must be 1");
    }
    const { kind: _kind, version: _version, ...options } = json;
    return new Camera(options);
  }

  with(changes: Partial<CameraOptions>): Camera {
    const options: CameraOptions = { ...this.#options(), ...changes };
    if (changes.projection === "perspective" && changes.orthographicHeight === undefined) {
      delete options.orthographicHeight;
    }
    return new Camera(options);
  }

  get forward(): Vec3 {
    return normalize(sub(this.target, this.position));
  }

  viewMatrix(): Float32Array {
    return lookAtUnchecked(this.position, this.target, normalize(this.up));
  }

  projectionMatrix(aspect: number, clipSpace: ClipSpace = "wgpu"): Float32Array {
    if (this.projection === "orthographic") {
      validateAspect(aspect);
      const halfHeight = (this.orthographicHeight ?? 1) / 2;
      const halfWidth = halfHeight * aspect;
      return orthographic(-halfWidth, halfWidth, -halfHeight, halfHeight, this.near, this.far, clipSpace);
    }
    return perspective(this.fovYDegrees, aspect, this.near, this.far, clipSpace);
  }

  viewProjectionMatrix(aspect: number, clipSpace: ClipSpace = "wgpu"): Float32Array {
    return fromColumns(multiplyColumns(this.projectionMatrix(aspect, clipSpace), this.viewMatrix()));
  }

  worldToScreen(point: Readonly<Vec3>, viewport: ViewportSize): ScreenPoint | undefined {
    validateViewport(viewport);
    return worldToScreen(
      this.#viewProjection64(viewport.width / viewport.height),
      point,
      viewport,
    );
  }

  screenToWorld(x: number, y: number, depth: number, viewport: ViewportSize): Vec3 {
    validateViewport(viewport);
    return screenToWorld(this.#inverseViewProjection64(viewport), x, y, depth, viewport);
  }

  screenRay(x: number, y: number, viewport: ViewportSize): ScreenRay {
    validateViewport(viewport);
    return screenRay(this.#inverseViewProjection64(viewport), x, y, viewport);
  }

  toInput(): CameraInput {
    const input: CameraInput = {
      position: copyVec3(this.position),
      target: copyVec3(this.target),
      up: copyVec3(this.up),
      fovYDegrees: this.fovYDegrees,
      near: this.near,
      far: this.far,
    };
    if (this.projection === "orthographic") {
      input.projection = "orthographic";
      input.orthographicHeight = this.orthographicHeight ?? 1;
    }
    return input;
  }

  toJSON(): CameraJSON {
    return { kind: CAMERA_JSON_KIND, version: 1, ...this.#options() };
  }

  #options(): CameraOptions {
    const options: CameraOptions = {
      position: copyVec3(this.position),
      target: copyVec3(this.target),
      up: copyVec3(this.up),
      fovYDegrees: this.fovYDegrees,
      near: this.near,
      far: this.far,
      projection: this.projection,
    };
    if (this.orthographicHeight !== undefined) {
      options.orthographicHeight = this.orthographicHeight;
    }
    return options;
  }

  /** Double-precision view-projection used for exact screen conversion. */
  #viewProjection64(aspect: number): number[] {
    validateAspect(aspect);
    const view = Array.from(lookAtUnchecked(this.position, this.target, normalize(this.up)));
    let projection: number[];
    if (this.projection === "orthographic") {
      const halfHeight = (this.orthographicHeight ?? 1) / 2;
      const halfWidth = halfHeight * aspect;
      projection = multiplyColumns(
        GL_TO_WGPU,
        orthographicGl(-halfWidth, halfWidth, -halfHeight, halfHeight, this.near, this.far),
      );
    } else {
      projection = multiplyColumns(
        GL_TO_WGPU,
        perspectiveGl(this.fovYDegrees, aspect, this.near, this.far),
      );
    }
    return multiplyColumns(projection, view);
  }

  #inverseViewProjection64(viewport: ViewportSize): number[] {
    const inverse = inverseColumns(this.#viewProjection64(viewport.width / viewport.height));
    if (inverse === undefined) {
      throw invalid("camera view-projection is not invertible");
    }
    return inverse;
  }
}
