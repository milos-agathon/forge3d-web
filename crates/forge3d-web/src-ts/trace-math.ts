import { Forge3DError } from "./index.js";
import type { TraceVec3, TraceRay, TraceBounds } from "./trace-types.js";
export const f = Math.fround;
export const add = (a: TraceVec3, b: TraceVec3): TraceVec3 => [
  f(a[0] + b[0]),
  f(a[1] + b[1]),
  f(a[2] + b[2]),
];
export const sub = (a: TraceVec3, b: TraceVec3): TraceVec3 => [
  f(a[0] - b[0]),
  f(a[1] - b[1]),
  f(a[2] - b[2]),
];
export const mul = (a: TraceVec3, s: number): TraceVec3 => [
  f(a[0] * s),
  f(a[1] * s),
  f(a[2] * s),
];
export const had = (a: TraceVec3, b: TraceVec3): TraceVec3 => [
  f(a[0] * b[0]),
  f(a[1] * b[1]),
  f(a[2] * b[2]),
];
export const dot = (a: TraceVec3, b: TraceVec3): number =>
  f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
export const cross = (a: TraceVec3, b: TraceVec3): TraceVec3 => [
  f(f(a[1] * b[2]) - f(a[2] * b[1])),
  f(f(a[2] * b[0]) - f(a[0] * b[2])),
  f(f(a[0] * b[1]) - f(a[1] * b[0])),
];
export const length = (a: TraceVec3): number => f(Math.sqrt(dot(a, a)));
export const unit = (a: TraceVec3): TraceVec3 =>
  mul(a, f(1 / Math.max(length(a), 1e-30)));
export const clamp = (v: number, lo = 0, hi = 1): number =>
  Math.max(lo, Math.min(hi, v));
export const luminance = (v: TraceVec3): number =>
  dot(v, [0.2126, 0.7152, 0.0722]);
export function traceInvalid(message: string): never {
  throw new Forge3DError("INVALID_INPUT", message);
}
export function traceLimit(
  resource: string,
  requested: number,
  limit: number,
): never {
  throw new Forge3DError(
    "RESOURCE_LIMIT_EXCEEDED",
    `${resource} requires ${requested}; limit is ${limit}`,
    { reason: "trace-limit", resource, requested, limit },
  );
}
export function integer(
  v: number,
  name: string,
  min = 1,
  max = 0x7fffffff,
): number {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    traceInvalid(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}
export function scalar(
  v: number,
  name: string,
  min = -Infinity,
  max = Infinity,
): number {
  if (!Number.isFinite(v) || v < min || v > max || !Number.isFinite(f(v)))
    traceInvalid(`${name} is out of range`);
  return f(v);
}
export function vec(v: TraceVec3, name = "vector"): TraceVec3 {
  if (!v || v.length !== 3)
    traceInvalid(`${name} must have three finite components`);
  return [scalar(v[0], name), scalar(v[1], name), scalar(v[2], name)];
}
export function ray(r: TraceRay): Required<TraceRay> {
  const origin = vec(r.origin),
    direction = vec(r.direction);
  if (length(direction) < 1e-20) traceInvalid("ray direction must be nonzero");
  const tMin = scalar(r.tMin ?? 1e-5, "tMin", 0),
    tMax = scalar(r.tMax ?? 1e30, "tMax", tMin);
  return { origin, direction, tMin, tMax };
}
export function live(disposed: boolean): void {
  if (disposed)
    throw new Forge3DError("RUNTIME_DISPOSED", "Tracing resource is disposed");
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "Tracing request cancelled");
}
export const emptyBounds = (): TraceBounds => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
});
export function unionBounds(a: TraceBounds, b: TraceBounds): TraceBounds {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  };
}
export function boundsInterval(
  b: TraceBounds,
  r: Required<TraceRay>,
  max = r.tMax,
): readonly [number, number] | undefined {
  let lo = r.tMin,
    hi = max;
  for (let a = 0; a < 3; a++) {
    const o = r.origin[a]!,
      d = r.direction[a]!;
    if (d === 0) {
      if (o < b.min[a]! || o > b.max[a]!) return;
    } else {
      const x = f((b.min[a]! - o) / d),
        y = f((b.max[a]! - o) / d);
      lo = Math.max(lo, Math.min(x, y));
      hi = Math.min(hi, Math.max(x, y));
      if (lo > hi) return;
    }
  }
  return [lo, hi];
}
/** Native xorshift32 stream; independent streams use pixel and absolute sample index. */
export class TraceRng {
  constructor(public state: number) {
    this.state = state >>> 0 || 1;
  }
  nextU32(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
  next(): number {
    return f((this.nextU32() >>> 8) / 16777216);
  }
}
export function sampleSeed(
  seed: number,
  pixel: number,
  sample: number,
): number {
  return (
    (seed ^
      Math.imul(pixel + 1, 0x9e3779b9) ^
      Math.imul(sample + 1, 0x85ebca6b)) >>>
    0
  );
}
