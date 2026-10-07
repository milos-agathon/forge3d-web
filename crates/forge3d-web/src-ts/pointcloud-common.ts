import { Forge3DError } from "./index.js";
import type { PointVec3, PointBounds, PointView } from "./pointcloud-types.js";
export const POINT_MAX_BYTES = 256 * 1024 * 1024;
export function pointError(
  message: string,
  reason = "invalid-point-data",
): never {
  throw new Forge3DError("INVALID_INPUT", message, { reason });
}
export function pointLimit(bytes: number, budget = POINT_MAX_BYTES): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget)
    throw new Forge3DError(
      "RESOURCE_LIMIT_EXCEEDED",
      "Point resource exceeds budget",
      { bytes, budget },
    );
}
export function pointInteger(
  n: number,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    pointError(`${name} is outside its integer range`);
  return n;
}
export function pointFinite(n: number, name: string): number {
  if (!Number.isFinite(n)) pointError(`${name} must be finite`);
  return n;
}
export function pointCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "Point/tile request cancelled");
}
/** Cancellation stops this subscriber promptly without cancelling another page reader. */
export async function pointAwait<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  pointCancelled(signal);
  let cancel: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    cancel = () =>
      reject(
        new Forge3DError("REQUEST_CANCELLED", "Point/tile request cancelled"),
      );
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
export function pointLive(disposed: boolean): void {
  if (disposed)
    throw new Forge3DError("RUNTIME_DISPOSED", "Point/tile owner disposed");
}
export function pointView(view: PointView): void {
  if (
    view.position.length !== 3 ||
    view.position.some((x) => !Number.isFinite(x)) ||
    !(view.viewportHeight > 0) ||
    !Number.isFinite(view.viewportHeight) ||
    !(view.fovY > 0 && view.fovY < Math.PI)
  )
    pointError("Invalid point view");
  const m = view.viewProjection;
  if (m && (m.length !== 16 || Array.from(m).some((x) => !Number.isFinite(x))))
    pointError("Invalid view-projection matrix");
}
export function checkBounds(b: PointBounds): PointBounds {
  for (let i = 0; i < 3; i++) {
    pointFinite(b.min[i]!, "bounds.min");
    pointFinite(b.max[i]!, "bounds.max");
    if (b.min[i]! > b.max[i]!) pointError("Inverted point bounds");
  }
  return b;
}
export function boundsCenter(b: PointBounds): PointVec3 {
  return b.min.map((x, i) => (x + b.max[i]!) / 2) as unknown as PointVec3;
}
export function boundsRadius(b: PointBounds): number {
  return Math.hypot(...b.min.map((x, i) => b.max[i]! - x)) / 2;
}
export function pointDistance(a: PointVec3, b: PointVec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
/** Test all six homogeneous planes without dividing by w or culling a crossing box. */
export function boundsInView(b: PointBounds, m?: ArrayLike<number>): boolean {
  if (!m) return true;
  const clips: number[][] = [];
  for (let o = 0; o < 8; o++) {
    const p = [0, 1, 2].map((i) => (o & (1 << i) ? b.max[i]! : b.min[i]!));
    clips.push(
      [0, 1, 2, 3].map(
        (r) =>
          m[r]! * p[0]! + m[r + 4]! * p[1]! + m[r + 8]! * p[2]! + m[r + 12]!,
      ),
    );
  }
  return ![0, 1, 2, 3, 4, 5].some((plane) =>
    clips.every(
      (c) =>
        (plane === 0
          ? c[0]! + c[3]!
          : plane === 1
            ? c[3]! - c[0]!
            : plane === 2
              ? c[1]! + c[3]!
              : plane === 3
                ? c[3]! - c[1]!
                : plane === 4
                  ? c[2]!
                  : c[3]! - c[2]!) < 0,
    ),
  );
}
export function pointJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .replace(/\0+$/u, ""),
    );
    if (!v || typeof v !== "object" || Array.isArray(v))
      pointError("Expected a JSON object");
    return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof Forge3DError) throw e;
    pointError("Malformed point/tile JSON");
  }
}
export function pointU64(v: DataView, offset: number): number {
  const n = v.getBigUint64(offset, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER))
    pointError("64-bit offset/count exceeds browser integer precision");
  return Number(n);
}
export function pointUrl(uri: string, base: string | URL): string {
  try {
    const u = new URL(uri, base);
    if (!["http:", "https:"].includes(u.protocol))
      pointError("Unsupported tile resource URL", "unsupported-uri");
    return u.href;
  } catch (e) {
    if (e instanceof Forge3DError) throw e;
    pointError("Invalid resource URL");
  }
}
/** Byte-bounded decoded LRU. Admission rejects a single oversized item before evicting. */
export class PointCache<T> {
  readonly entries = new Map<string, { value: T; bytes: number }>();
  bytes = 0;
  hits = 0;
  misses = 0;
  evictions = 0;
  peakBytes = 0;
  constructor(readonly budget: number) {
    pointInteger(budget, "cacheBytes", 1);
  }
  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) {
      this.misses++;
      return;
    }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }
  put(key: string, value: T, bytes: number): void {
    pointLimit(bytes, this.budget);
    this.delete(key);
    while (this.bytes + bytes > this.budget) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
      this.evictions++;
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
  }
  delete(key: string): void {
    const e = this.entries.get(key);
    if (e) {
      this.bytes -= e.bytes;
      this.entries.delete(key);
    }
  }
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
  stats() {
    return {
      cacheUsed: this.bytes,
      cacheBudget: this.budget,
      entryCount: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      peakBytes: this.peakBytes,
    };
  }
}
