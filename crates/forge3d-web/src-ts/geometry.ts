import { triangulateVectorPolygon } from "./vector-geometry.js";
import {
  meshError,
  meshInteger,
  meshLimit,
  meshNumber,
  unit,
  cross,
  sub,
  dot,
} from "./mesh.js";
import type { MeshBuffers, Vec3 } from "./mesh.js";
export type PrimitiveKind =
  | "plane"
  | "box"
  | "sphere"
  | "cylinder"
  | "cone"
  | "torus";
export interface PrimitiveOptions {
  resolution?: readonly [number, number];
  radialSegments?: number;
  rings?: number;
  heightSegments?: number;
  tubeSegments?: number;
  radius?: number;
  tubeRadius?: number;
  includeCaps?: boolean;
}
export class MeshBuilder {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  i: number[] = [];
  add(p: Vec3, n: Vec3, uv: readonly [number, number] = [0, 0]): number {
    const id = this.p.length / 3;
    this.p.push(...p);
    this.n.push(...n);
    this.uv.push(...uv);
    return id;
  }
  build(): MeshBuffers {
    meshLimit(
      this.p.length * 4 +
        this.n.length * 4 +
        this.uv.length * 4 +
        this.i.length * 4,
    );
    return {
      positions: new Float32Array(this.p),
      normals: new Float32Array(this.n),
      uvs: new Float32Array(this.uv),
      tangents: new Float32Array(),
      indices: new Uint32Array(this.i),
    };
  }
}
/** Native unit dimensions: plane XY, cylinder/cone along Y, radius .5. */
export function generatePrimitive(
  kind: PrimitiveKind,
  options: PrimitiveOptions = {},
): MeshBuffers {
  const b = new MeshBuilder(),
    o = options,
    rs = meshInteger(o.radialSegments ?? 32, "radialSegments", 3),
    rings = meshInteger(o.rings ?? 16, "rings", 2),
    hs = meshInteger(o.heightSegments ?? 1, "heightSegments"),
    ts = meshInteger(o.tubeSegments ?? 12, "tubeSegments", 3),
    r = meshNumber(o.radius ?? 0.5, "radius", Number.MIN_VALUE),
    tr = meshNumber(o.tubeRadius ?? 0.15, "tubeRadius", Number.MIN_VALUE);
  meshLimit((rs + 1) * (Math.max(rings, hs, ts) + 1) * 56);
  if (kind === "plane") {
    const sx = meshInteger(o.resolution?.[0] ?? 1, "resolutionX"),
      sy = meshInteger(o.resolution?.[1] ?? 1, "resolutionY");
    meshLimit((sx + 1) * (sy + 1) * 32 + sx * sy * 24);
    for (let y = 0; y <= sy; y++)
      for (let x = 0; x <= sx; x++)
        b.add([x / sx - 0.5, y / sy - 0.5, 0], [0, 0, 1], [x / sx, 1 - y / sy]);
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const a = y * (sx + 1) + x,
          c = a + sx + 1;
        b.i.push(a, c + 1, c, a, a + 1, c + 1);
      }
  } else if (kind === "box") {
    const faces: [Vec3, Vec3, Vec3, Vec3][] = [
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [0.5, -0.5, -0.5],
      ],
      [
        [-1, 0, 0],
        [0, 1, 0],
        [0, 0, -1],
        [-0.5, -0.5, 0.5],
      ],
      [
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 0],
        [-0.5, 0.5, -0.5],
      ],
      [
        [0, -1, 0],
        [0, 0, 1],
        [-1, 0, 0],
        [0.5, -0.5, -0.5],
      ],
      [
        [0, 0, 1],
        [0, 1, 0],
        [-1, 0, 0],
        [0.5, -0.5, 0.5],
      ],
      [
        [0, 0, -1],
        [0, 1, 0],
        [1, 0, 0],
        [-0.5, -0.5, -0.5],
      ],
    ];
    for (const [n, up, right, p] of faces) {
      const a = b.p.length / 3;
      for (const [u, v] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ])
        b.add(
          [
            p[0] + right[0] * u! + up[0] * v!,
            p[1] + right[1] * u! + up[1] * v!,
            p[2] + right[2] * u! + up[2] * v!,
          ],
          n,
          [u!, v!],
        );
      b.i.push(a, a + 1, a + 2, a, a + 2, a + 3);
    }
  } else if (kind === "sphere" || kind === "torus") {
    const rows = kind === "sphere" ? rings : rs,
      cols = kind === "sphere" ? rs : ts,
      R = kind === "torus" ? Math.min(r, 0.35) : r,
      T = Math.min(tr, 0.15);
    for (let y = 0; y <= rows; y++)
      for (let x = 0; x <= cols; x++) {
        const u = x / cols,
          v = y / rows;
        if (kind === "sphere") {
          const t = v * Math.PI,
            p = u * Math.PI * 2,
            n: Vec3 = [
              Math.sin(t) * Math.cos(p),
              Math.cos(t),
              Math.sin(t) * Math.sin(p),
            ];
          b.add([r * n[0], r * n[1], r * n[2]], n, [u, 1 - v]);
        } else {
          const a = v * 2 * Math.PI,
            c = u * 2 * Math.PI,
            n: Vec3 = [
              Math.cos(a) * Math.cos(c),
              Math.sin(c),
              Math.sin(a) * Math.cos(c),
            ];
          b.add(
            [
              (R + T * Math.cos(c)) * Math.cos(a),
              T * Math.sin(c),
              (R + T * Math.cos(c)) * Math.sin(a),
            ],
            n,
            [v, u],
          );
        }
      }
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const a = y * (cols + 1) + x,
          c = a + cols + 1;
        b.i.push(a, a + 1, c, a + 1, c + 1, c);
      }
  } else if (kind === "cylinder" || kind === "cone") {
    for (let y = 0; y <= hs; y++)
      for (let x = 0; x <= rs; x++) {
        const v = y / hs,
          u = x / rs,
          a = u * Math.PI * 2,
          rad = kind === "cone" ? r * (1 - v) : r,
          n = unit([Math.cos(a), kind === "cone" ? r : 0, Math.sin(a)]);
        b.add([rad * Math.cos(a), v - 0.5, rad * Math.sin(a)], n, [u, 1 - v]);
      }
    for (let y = 0; y < hs; y++)
      for (let x = 0; x < rs; x++) {
        const a = y * (rs + 1) + x,
          c = a + rs + 1;
        b.i.push(a, a + 1, c, a + 1, c + 1, c);
      }
    if (o.includeCaps ?? true)
      for (const top of kind === "cone" ? [false] : [true, false]) {
        const y = top ? 0.5 : -0.5,
          n: Vec3 = [0, top ? 1 : -1, 0],
          a = b.add([0, y, 0], n, [0.5, 0.5]);
        for (let x = 0; x <= rs; x++) {
          const phi = (x / rs) * 2 * Math.PI;
          b.add([r * Math.cos(phi), y, r * Math.sin(phi)], n, [
            0.5 + 0.5 * Math.cos(phi),
            0.5 + 0.5 * Math.sin(phi),
          ]);
        }
        for (let x = 0; x < rs; x++) {
          if (top) b.i.push(a, a + x + 1, a + x + 2);
          else b.i.push(a, a + x + 2, a + x + 1);
        }
      }
  } else meshError(`unknown primitive ${kind}`);
  return b.build();
}
export interface ExtrudeOptions {
  height?: number;
  baseHeight?: number;
  capUvScale?: number;
}
/** Rings use XY input and generate Z-up volumes; holes retain open courtyards. */
export function extrudePolygon(
  rings: readonly (readonly (readonly [number, number])[])[],
  options: ExtrudeOptions = {},
): MeshBuffers {
  const height = meshNumber(options.height ?? 1, "height"),
    base = meshNumber(options.baseHeight ?? 0, "baseHeight"),
    uv = meshNumber(options.capUvScale ?? 1, "capUvScale");
  if (!height) meshError("height must be non-zero");
  if (!rings.length) meshError("extrusion requires an outer ring");
  const clean = rings.map((ring, index) => {
    const p = ring.map(
      (v) =>
        [meshNumber(v[0], "x"), meshNumber(v[1], "y"), 0] as [
          number,
          number,
          number,
        ],
    );
    if (p.length > 1 && p[0]![0] === p.at(-1)![0] && p[0]![1] === p.at(-1)![1])
      p.pop();
    if (p.length < 3) meshError("ring needs three points");
    const area = p.reduce((s, a, i) => {
      const c = p[(i + 1) % p.length]!;
      return s + a[0] * c[1] - c[0] * a[1];
    }, 0);
    if (!area) meshError("zero-area ring");
    if (area > 0 !== (index === 0)) p.reverse();
    return p;
  });
  meshLimit(clean.reduce((n, r) => n + r.length, 0) * 300);
  const triangles = triangulateVectorPolygon(
    clean.map((r) => r.map((p) => [p[0], 0, p[1]])),
  );
  const b = new MeshBuilder(),
    sign = Math.sign(height);
  // Caps share one vertex per ring point, matching the native square 24/12 contract.
  for (const top of [false, true]) {
    const ids = new Map<string, number>();
    for (const ring of clean)
      for (const p of ring) {
        const key = `${p[0]},${p[1]}`;
        if (!ids.has(key))
          ids.set(
            key,
            b.add(
              [p[0], p[1], base + (top ? height : 0)],
              [0, 0, (top ? 1 : -1) * sign],
              [p[0] * uv, p[1] * uv],
            ),
          );
      }
    for (const tri of triangles) {
      let t = tri.map((p) => ids.get(`${p[0]},${p[2]}`)!);
      const a = tri[0]!,
        c = tri[1]!,
        d = tri[2]!,
        area = (c[0] - a[0]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[0] - a[0]);
      if (area > 0 !== (top ? 1 : -1) * sign > 0) t = [t[0]!, t[2]!, t[1]!];
      b.i.push(...t);
    }
  }
  for (const ring of clean) {
    let distance = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!,
        q = ring[(i + 1) % ring.length]!,
        length = Math.hypot(q[0] - p[0], q[1] - p[1]),
        n = unit([q[1] - p[1], p[0] - q[0], 0]),
        a = b.p.length / 3;
      b.add([p[0], p[1], base], n, [distance, 0]);
      b.add([q[0], q[1], base], n, [distance + length, 0]);
      b.add([q[0], q[1], base + height], n, [
        distance + length,
        Math.abs(height),
      ]);
      b.add([p[0], p[1], base + height], n, [distance, Math.abs(height)]);
      if (sign > 0) b.i.push(a, a + 1, a + 2, a, a + 2, a + 3);
      else b.i.push(a, a + 2, a + 1, a, a + 3, a + 2);
      distance += length;
    }
  }
  return b.build();
}
export type JoinStyle = "miter" | "bevel" | "round";
export interface RibbonOptions {
  widthStart?: number;
  widthEnd?: number;
  joinStyle?: JoinStyle;
  joinStyles?: Uint8Array;
  miterLimit?: number;
  depthOffset?: number;
}
function frame(t: Vec3): [[number, number, number], [number, number, number]] {
  let n = cross([0, 0, 1], t);
  if (dot(n, n) < 1e-6) n = cross([0, 1, 0], t);
  if (dot(n, n) < 1e-6) n = cross([1, 0, 0], t);
  n = unit(n);
  return [n, unit(cross(t, n))];
}
function pathData(path: readonly Vec3[]): { lengths: number[]; total: number } {
  if (path.length < 2) meshError("path needs two points");
  meshLimit(path.length * 1024);
  for (const p of path) for (const x of p) meshNumber(x, "path");
  const lengths = [0];
  for (let i = 1; i < path.length; i++) {
    const l = Math.hypot(...sub(path[i]!, path[i - 1]!));
    if (!l) meshError("consecutive path points must differ");
    lengths.push(lengths[i - 1]! + l);
  }
  return { lengths, total: lengths.at(-1)! };
}
export function generateRibbon(
  path: readonly Vec3[],
  o: RibbonOptions = {},
): MeshBuffers {
  const { lengths, total } = pathData(path),
    w0 = meshNumber(o.widthStart ?? 1, "widthStart", Number.MIN_VALUE),
    w1 = meshNumber(o.widthEnd ?? w0, "widthEnd", Number.MIN_VALUE),
    limit = meshNumber(o.miterLimit ?? 4, "miterLimit", 1),
    offset = meshNumber(o.depthOffset ?? 0, "depthOffset");
  if (o.joinStyles && o.joinStyles.length !== path.length)
    meshError("joinStyles count mismatch");
  const b = new MeshBuilder();
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!,
      prev = unit(sub(p, path[Math.max(i - 1, 0)]!)),
      next = unit(sub(path[Math.min(i + 1, path.length - 1)]!, p)),
      tp = Math.hypot(...prev) ? prev : next,
      tn = Math.hypot(...next) ? next : prev,
      [np] = frame(tp),
      [nn] = frame(tn);
    let s = unit([np[0] + nn[0], np[1] + nn[1], np[2] + nn[2]]);
    const degenerateSide = !Math.hypot(...s);
    if (degenerateSide) s = nn;
    const style =
      o.joinStyles?.[i] === 1
        ? "bevel"
        : o.joinStyles?.[i] === 2
          ? "round"
          : (o.joinStyle ?? "miter");
    if (!["miter", "bevel", "round"].includes(style))
      meshError("unknown join style");
    const scale = degenerateSide
        ? 1
        : style === "miter"
          ? Math.min(1 + (1 - Math.abs(dot(prev, next))), limit)
          : style === "round"
            ? Math.min(1 / Math.max(Math.abs(dot(s, nn)), 1e-6), limit)
            : 1,
      half = (w0 + ((w1 - w0) * i) / (path.length - 1)) * 0.5;
    const [normal] = frame(
      unit(
        sub(path[Math.min(i + 1, path.length - 1)]!, path[Math.max(i - 1, 0)]!),
      ),
    );
    for (const side of [-1, 1])
      b.add(
        [
          p[0] + s[0] * scale * half * side,
          p[1] + s[1] * scale * half * side,
          p[2] + s[2] * scale * half * side + offset,
        ],
        normal,
        [lengths[i]! / total, side < 0 ? 0 : 1],
      );
    if (i < path.length - 1) {
      const a = i * 2;
      b.i.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
  }
  return b.build();
}
export function generateThickPolyline(
  path: readonly Vec3[],
  width: number,
  options: Omit<RibbonOptions, "widthStart" | "widthEnd"> = {},
): MeshBuffers {
  return generateRibbon(path, {
    ...options,
    widthStart: width,
    widthEnd: width,
  });
}
export interface TubeOptions {
  radiusStart?: number;
  radiusEnd?: number;
  radialSegments?: number;
  capEnds?: boolean;
}
export function generateTube(
  path: readonly Vec3[],
  o: TubeOptions = {},
): MeshBuffers {
  const { lengths, total } = pathData(path),
    rs = meshInteger(o.radialSegments ?? 16, "radialSegments", 3),
    r0 = meshNumber(o.radiusStart ?? 0.5, "radiusStart", Number.MIN_VALUE),
    r1 = meshNumber(o.radiusEnd ?? r0, "radiusEnd", Number.MIN_VALUE),
    b = new MeshBuilder();
  meshLimit(path.length * (rs + 1) * 56);
  const tangents = path.map((_, i) =>
    i + 1 < path.length
      ? unit(sub(path[i + 1]!, path[i]!))
      : unit(sub(path[i]!, path[i - 1]!)),
  );
  let [n, bin] = frame(tangents[0]!);
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!,
      t = tangents[i]!;
    if (i > 0) {
      const projection = unit([
        n[0] - t[0] * dot(n, t),
        n[1] - t[1] * dot(n, t),
        n[2] - t[2] * dot(n, t),
      ]);
      if (dot(projection, projection) < 1e-6) [n, bin] = frame(t);
      else {
        n = projection;
        bin = unit(cross(t, n));
        if (dot(bin, bin) < 1e-6) bin = unit(cross(tangents[i - 1]!, n));
      }
    }
    const r = r0 + ((r1 - r0) * i) / (path.length - 1);
    for (let j = 0; j < rs; j++) {
      const a = (j / rs) * 2 * Math.PI,
        v: Vec3 = [
          n[0] * Math.cos(a) + bin[0] * Math.sin(a),
          n[1] * Math.cos(a) + bin[1] * Math.sin(a),
          n[2] * Math.cos(a) + bin[2] * Math.sin(a),
        ];
      b.add([p[0] + r * v[0], p[1] + r * v[1], p[2] + r * v[2]], unit(v), [
        lengths[i]! / total,
        j / rs,
      ]);
    }
    if (i < path.length - 1)
      for (let j = 0; j < rs; j++) {
        const a = i * rs + j,
          c = a + rs,
          next = (j + 1) % rs;
        b.i.push(
          a,
          c,
          (i + 1) * rs + next,
          a,
          (i + 1) * rs + next,
          i * rs + next,
        );
      }
  }
  if (o.capEnds ?? true)
    for (const end of [0, path.length - 1]) {
      const p = path[end]!,
        t = tangents[end]!,
        s = end === 0 ? -1 : 1,
        n: Vec3 = [t[0] * s, t[1] * s, t[2] * s],
        a = b.add(p, n, end === 0 ? [0, 0] : [1, 1]);
      for (let j = 0; j < rs; j++)
        if (end === 0) b.i.push(a, end * rs + ((j + 1) % rs), end * rs + j);
        else b.i.push(a, end * rs + j, end * rs + ((j + 1) % rs));
    }
  return b.build();
}
