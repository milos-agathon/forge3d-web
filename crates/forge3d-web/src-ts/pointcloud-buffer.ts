import type { PointData, PointBounds, PointVec3 } from "./pointcloud-types.js";
import {
  pointError,
  pointLimit,
  pointLive,
  checkBounds,
} from "./pointcloud-common.js";
export function pointDataBytes(data: PointData): number {
  return (
    data.positions.byteLength +
    (data.colors?.byteLength ?? 0) +
    (data.intensities?.byteLength ?? 0) +
    (data.classifications?.byteLength ?? 0) +
    (data.normals?.byteLength ?? 0) +
    (data.ids?.byteLength ?? 0)
  );
}
export function validatePointData(data: PointData, maxBytes?: number): number {
  if (
    !(
      data.positions instanceof Float32Array ||
      data.positions instanceof Float64Array
    ) ||
    data.positions.length % 3
  )
    pointError("Point positions require xyz float tuples");
  const count = data.positions.length / 3,
    c = data.colorComponents ?? 3;
  pointLimit(pointDataBytes(data), maxBytes);
  for (const p of data.positions)
    if (!Number.isFinite(p)) pointError("Non-finite point position");
  if (
    data.colors &&
    (!(data.colors instanceof Uint8Array) || data.colors.length !== count * c)
  )
    pointError("Point color count mismatch");
  for (const [a, n, ctor] of [
    [data.intensities, count, Uint16Array],
    [data.classifications, count, Uint8Array],
    [data.normals, count * 3, Float32Array],
    [data.ids, count, Uint32Array],
  ] as const)
    if (a && (!(a instanceof ctor) || a.length !== n))
      pointError("Point attribute count mismatch");
  if (data.normals && data.normals.some((x) => !Number.isFinite(x)))
    pointError("Non-finite point normal");
  if (c !== 3 && c !== 4) pointError("Point colors require RGB or RGBA");
  return count;
}
export function clonePointData(data: PointData): PointData {
  return {
    positions: data.positions.slice(),
    ...(data.colors
      ? {
          colors: data.colors.slice(),
          colorComponents: data.colorComponents ?? 3,
        }
      : {}),
    ...(data.intensities ? { intensities: data.intensities.slice() } : {}),
    ...(data.classifications
      ? { classifications: data.classifications.slice() }
      : {}),
    ...(data.normals ? { normals: data.normals.slice() } : {}),
    ...(data.ids ? { ids: data.ids.slice() } : {}),
  };
}
export class PointBuffer {
  #data: PointData | null;
  constructor(data: PointData, maxBytes?: number) {
    validatePointData(data, maxBytes);
    this.#data = clonePointData(data);
  }
  #live(): PointData {
    pointLive(this.#data === null);
    return this.#data!;
  }
  get pointCount(): number {
    return this.#live().positions.length / 3;
  }
  get cpuBytes(): number {
    return this.#data ? pointDataBytes(this.#data) : 0;
  }
  get gpuBytes(): number {
    return this.pointCount * 24;
  }
  data(): PointData {
    return clonePointData(this.#live());
  }
  /** Independent lifetime over immutable owned arrays; public reads still copy. */
  retain(): PointBuffer {
    const retained = new PointBuffer({ positions: new Float64Array() });
    retained.#data = this.#live();
    return retained;
  }
  point(index: number): {
    position: PointVec3;
    color: readonly number[];
    intensity: number;
    classification: number;
    id: number | undefined;
  } {
    const d = this.#live();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.pointCount)
      pointError("Point index out of bounds");
    const c = d.colorComponents ?? 3;
    return {
      position: Array.from(
        d.positions.subarray(index * 3, index * 3 + 3),
      ) as unknown as PointVec3,
      color: d.colors
        ? Array.from(d.colors.subarray(index * c, index * c + c))
        : [255, 255, 255],
      intensity: d.intensities?.[index] ?? 32768,
      classification: d.classifications?.[index] ?? 0,
      id: d.ids?.[index],
    };
  }
  bounds(): PointBounds {
    const p = this.#live().positions;
    if (!p.length) return { min: [0, 0, 0], max: [0, 0, 0] };
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) {
      const a = i % 3;
      min[a] = Math.min(min[a]!, p[i]!);
      max[a] = Math.max(max[a]!, p[i]!);
    }
    return {
      min: min as unknown as PointVec3,
      max: max as unknown as PointVec3,
    };
  }
  /** Native [x,y,z,r,g,b] contract. Relative origin avoids large-coordinate f32 drift. */
  createGpuBuffer(origin: PointVec3 = [0, 0, 0]): Float32Array {
    const d = this.#live(),
      out = new Float32Array(this.pointCount * 6),
      c = d.colorComponents ?? 3;
    for (let i = 0; i < this.pointCount; i++)
      for (let a = 0; a < 3; a++) {
        out[i * 6 + a] = d.positions[i * 3 + a]! - origin[a]!;
        out[i * 6 + 3 + a] = d.colors ? d.colors[i * c + a]! / 255 : 1;
      }
    return out;
  }
  /** Historical viewer contract: xyz, elevation(Y), rgb, intensity, size, padding. */
  createViewerGpuBuffer(bounds: PointBounds = this.bounds()): Float32Array {
    checkBounds(bounds);
    const d = this.#live(),
      out = new Float32Array(this.pointCount * 12),
      c = d.colorComponents ?? 3,
      range = Math.max(0.001, bounds.max[1] - bounds.min[1]);
    for (let i = 0; i < this.pointCount; i++) {
      out.set(d.positions.subarray(i * 3, i * 3 + 3), i * 12);
      out[i * 12 + 3] = Math.max(
        0,
        Math.min(1, (d.positions[i * 3 + 1]! - bounds.min[1]) / range),
      );
      for (let a = 0; a < 3; a++)
        out[i * 12 + 4 + a] = d.colors ? d.colors[i * c + a]! / 255 : 1;
      out[i * 12 + 7] = d.intensities ? d.intensities[i]! / 65535 : 0.5;
      out[i * 12 + 8] = 1;
    }
    return out;
  }
  dispose(): void {
    this.#data = null;
  }
}
export function transferPointData(data: PointData): {
  data: PointData;
  transfer: ArrayBuffer[];
} {
  validatePointData(data);
  const copy = clonePointData(data),
    transfer = Object.values(copy)
      .filter((v): v is ArrayBufferView => ArrayBuffer.isView(v))
      .map((v) => v.buffer as ArrayBuffer);
  return { data: copy, transfer };
}
