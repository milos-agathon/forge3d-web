import type { PointVec3, PointBounds } from "./pointcloud-types.js";
import { pointError, pointFinite, boundsInView } from "./pointcloud-common.js";
export type TileBoundsInput =
  | { sphere: number[] }
  | { box: number[] }
  | { region: number[] };
export const TILE_IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiplyTileMatrices(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number[] {
  return Array.from({ length: 16 }, (_, i) => {
    const row = i % 4,
      col = Math.floor(i / 4);
    let n = 0;
    for (let k = 0; k < 4; k++) n += a[k * 4 + row]! * b[col * 4 + k]!;
    return n;
  });
}
export function tileMatrix(m: unknown): number[] {
  if (m === undefined) return [...TILE_IDENTITY];
  if (
    !Array.isArray(m) ||
    m.length !== 16 ||
    m.some((x) => typeof x !== "number" || !Number.isFinite(x)) ||
    m[3] !== 0 ||
    m[7] !== 0 ||
    m[11] !== 0 ||
    m[15] !== 1
  )
    pointError("Tile transform must be affine column-major");
  return [...m] as number[];
}
export function transformTilePoint(
  m: ArrayLike<number>,
  p: PointVec3,
): PointVec3 {
  return [0, 1, 2].map(
    (r) => m[r]! * p[0] + m[r + 4]! * p[1] + m[r + 8]! * p[2] + m[r + 12]!,
  ) as unknown as PointVec3;
}
export function tileMatrixScale(m: ArrayLike<number>): number {
  // sqrt(max row sum of A^T A) bounds the spectral norm, including affine shear.
  const gram = Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) =>
      [0, 1, 2].reduce((n, r) => n + m[i * 4 + r]! * m[j * 4 + r]!, 0),
    ),
  );
  return Math.sqrt(
    Math.max(...gram.map((row) => row.reduce((n, v) => n + Math.abs(v), 0))),
  );
}
export function wgs84ToEcef(
  lon: number,
  lat: number,
  height: number,
): PointVec3 {
  const a = 6378137,
    e2 = 0.00669437999014,
    sin = Math.sin(lat),
    n = a / Math.sqrt(1 - e2 * sin * sin);
  return [
    (n + height) * Math.cos(lat) * Math.cos(lon),
    (n + height) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - e2) + height) * sin,
  ];
}
export class TileBoundingVolume {
  readonly type: "sphere" | "box" | "region";
  readonly data: number[];
  constructor(input: TileBoundsInput) {
    if (!input || typeof input !== "object")
      pointError("Unknown tile bounding volume");
    const keys = Object.keys(input);
    if (keys.length !== 1 || !["sphere", "box", "region"].includes(keys[0]!))
      pointError("Unknown tile bounding volume");
    this.type = keys[0] as typeof this.type;
    const data = (input as unknown as Record<string, unknown>)[this.type];
    if (!Array.isArray(data)) pointError("Tile bounds must be an array");
    this.data = [...data];
    if (
      this.data.length !==
      (this.type === "sphere" ? 4 : this.type === "box" ? 12 : 6)
    )
      pointError("Invalid tile bounds component count");
    this.data.forEach((x) => pointFinite(x, "tile bounds"));
    if (this.type === "sphere" && this.data[3]! < 0)
      pointError("Negative tile radius");
    if (
      this.type === "region" &&
      (Math.abs(this.data[0]!) > Math.PI ||
        Math.abs(this.data[2]!) > Math.PI ||
        this.data[1]! < -Math.PI / 2 ||
        this.data[3]! > Math.PI / 2 ||
        this.data[1]! > this.data[3]! ||
        this.data[4]! > this.data[5]!)
    )
      pointError("Invalid geographic region");
  }
  center(): PointVec3 {
    if (this.type !== "region")
      return this.data.slice(0, 3) as unknown as PointVec3;
    const d = this.data,
      e = d[2]! < d[0]! ? d[2]! + Math.PI * 2 : d[2]!;
    return wgs84ToEcef(
      (d[0]! + e) / 2,
      (d[1]! + d[3]!) / 2,
      (d[4]! + d[5]!) / 2,
    );
  }
  radius(): number {
    const d = this.data;
    if (this.type === "sphere") return d[3]!;
    if (this.type === "box")
      return Math.max(
        ...Array.from({ length: 8 }, (_, o) =>
          Math.hypot(
            ...[0, 1, 2].map((a) =>
              [0, 1, 2].reduce(
                (n, i) => n + d[3 + i * 3 + a]! * (o & (1 << i) ? 1 : -1),
                0,
              ),
            ),
          ),
        ),
      );
    const bounds = this.aabb(),
      center = this.center();
    return Math.hypot(
      ...[0, 1, 2].map((i) =>
        Math.max(
          Math.abs(bounds.min[i]! - center[i]!),
          Math.abs(bounds.max[i]! - center[i]!),
        ),
      ),
    );
  }
  transform(matrix: ArrayLike<number>): TileBoundingVolume {
    if (this.type === "region")
      return new TileBoundingVolume({ region: [...this.data] });
    const c = transformTilePoint(matrix, this.center());
    if (this.type === "sphere")
      return new TileBoundingVolume({
        sphere: [...c, this.radius() * tileMatrixScale(matrix)],
      });
    const axes: number[] = [];
    for (let a = 0; a < 3; a++) {
      const p = this.data.slice(3 + a * 3, 6 + a * 3);
      axes.push(
        ...[0, 1, 2].map(
          (r) =>
            matrix[r]! * p[0]! +
            matrix[r + 4]! * p[1]! +
            matrix[r + 8]! * p[2]!,
        ),
      );
    }
    return new TileBoundingVolume({ box: [...c, ...axes] });
  }
  aabb(): PointBounds {
    const d = this.data,
      c = this.center();
    if (this.type === "sphere") {
      const r = this.radius();
      return {
        min: [c[0] - r, c[1] - r, c[2] - r],
        max: [c[0] + r, c[1] + r, c[2] + r],
      };
    }
    if (this.type === "box") {
      const extent = [0, 1, 2].map(
        (i) => Math.abs(d[i + 3]!) + Math.abs(d[i + 6]!) + Math.abs(d[i + 9]!),
      );
      return {
        min: c.map((x, i) => x - extent[i]!) as unknown as PointVec3,
        max: c.map((x, i) => x + extent[i]!) as unknown as PointVec3,
      };
    }
    const west = d[0]!,
      east = d[2]! < west ? d[2]! + 2 * Math.PI : d[2]!,
      lons = [west, east],
      lats = [d[1]!, d[3]!];
    for (let i = -4; i <= 8; i++) {
      const lon = (i * Math.PI) / 2;
      if (lon > west && lon < east) lons.push(lon);
    }
    if (d[1]! < 0 && d[3]! > 0) lats.push(0);
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (const lon of lons)
      for (const lat of lats)
        for (const h of [d[4]!, d[5]!]) {
          const p = wgs84ToEcef(lon, lat, h);
          for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i]!, p[i]!);
            max[i] = Math.max(max[i]!, p[i]!);
          }
        }
    return {
      min: min as unknown as PointVec3,
      max: max as unknown as PointVec3,
    };
  }
  intersectsFrustum(matrix?: ArrayLike<number>): boolean {
    return boundsInView(this.aabb(), matrix);
  }
}
