import {
  cloneMesh,
  checkMesh,
  meshBounds,
  meshError,
  meshInteger,
  meshLimit,
  meshNumber,
  recomputeMeshNormals,
  attachMeshTangents,
  cross,
  sub,
  vertex,
  unit,
} from "./mesh.js";
import type { MeshInput, MeshBuffers, MeshBounds, Vec3 } from "./mesh.js";
import { simplifyScatterMesh } from "./scatter-mesh.js";
export interface MeshValidationIssue {
  kind:
    | "index-out-of-bounds"
    | "degenerate-triangle"
    | "duplicate-vertex"
    | "non-manifold-edge";
  index?: number;
  triangle?: number;
  first?: number;
  duplicate?: number;
  edge?: [number, number];
  count?: number;
}
export interface MeshValidationReport {
  clean: boolean;
  vertexCount: number;
  triangleCount: number;
  bounds: MeshBounds | null;
  issues: MeshValidationIssue[];
  boundaryEdges: number;
}
function edge(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
export function validateMesh(m: MeshInput): MeshValidationReport {
  checkMesh(m, false);
  const nv = m.positions.length / 3,
    issues: MeshValidationIssue[] = [],
    edges = new Map<string, number>(),
    seen = new Map<string, number>();
  for (const i of m.indices)
    if (i >= nv) issues.push({ kind: "index-out-of-bounds", index: i });
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t]!,
      b = m.indices[t + 1]!,
      c = m.indices[t + 2]!;
    if (a >= nv || b >= nv || c >= nv) continue;
    const n = cross(
      sub(vertex(m, b), vertex(m, a)),
      sub(vertex(m, c), vertex(m, a)),
    );
    if (
      a === b ||
      b === c ||
      a === c ||
      n.reduce((s, x) => s + x * x, 0) <= 1e-12
    )
      issues.push({ kind: "degenerate-triangle", triangle: t / 3 });
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = edge(i!, j!);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (let i = 0; i < nv; i++) {
    const key = vertex(m, i).join(",");
    const first = seen.get(key);
    if (first !== undefined)
      issues.push({ kind: "duplicate-vertex", first, duplicate: i });
    else seen.set(key, i);
  }
  let boundaryEdges = 0;
  for (const [key, count] of [...edges].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (count === 1) boundaryEdges++;
    if (count > 2)
      issues.push({
        kind: "non-manifold-edge",
        edge: key.split(":").map(Number) as [number, number],
        count,
      });
  }
  const bounds = nv ? meshBounds({ ...m, indices: new Uint32Array() }) : null;
  return {
    clean: !issues.length,
    vertexCount: nv,
    triangleCount: m.indices.length / 3,
    bounds,
    issues,
    boundaryEdges,
  };
}
export interface WeldOptions {
  positionEpsilon?: number;
  uvEpsilon?: number;
}
export function weldMesh(
  input: MeshInput,
  o: WeldOptions = {},
): { mesh: MeshBuffers; remap: Uint32Array; collapsed: number } {
  const m = cloneMesh(input),
    eps = meshNumber(
      o.positionEpsilon ?? 1e-5,
      "positionEpsilon",
      Number.MIN_VALUE,
    ),
    ue = meshNumber(o.uvEpsilon ?? 1e-4, "uvEpsilon", 0),
    nv = m.positions.length / 3,
    hasUv = m.uvs.length === nv * 2,
    p: number[] = [],
    uv: number[] = [],
    counts: number[] = [],
    groups = new Map<string, number[]>(),
    remap = new Uint32Array(nv);
  const round = (x: number) => Math.sign(x) * Math.floor(Math.abs(x) + 0.5);
  for (let i = 0; i < nv; i++) {
    const pos = vertex(m, i),
      key = pos.map((x) => round(x / eps)).join(","),
      candidates = groups.get(key) ?? [],
      id = candidates.find(
        (j) =>
          !hasUv ||
          (Math.abs(uv[j * 2]! - m.uvs[i * 2]!) <= ue &&
            Math.abs(uv[j * 2 + 1]! - m.uvs[i * 2 + 1]!) <= ue),
      );
    if (id !== undefined) {
      remap[i] = id;
      counts[id] = counts[id]! + 1;
    } else {
      const j = p.length / 3;
      p.push(...pos);
      remap[i] = j;
      counts.push(1);
      candidates.push(j);
      groups.set(key, candidates);
      if (hasUv) uv.push(m.uvs[i * 2]!, m.uvs[i * 2 + 1]!);
    }
  }
  if (hasUv) {
    const sums = new Float64Array(uv.length);
    for (let i = 0; i < nv; i++) {
      const j = remap[i]!;
      sums[j * 2] = sums[j * 2]! + m.uvs[i * 2]!;
      sums[j * 2 + 1] = sums[j * 2 + 1]! + m.uvs[i * 2 + 1]!;
    }
    for (let i = 0; i < uv.length; i++)
      uv[i] = sums[i]! / counts[Math.floor(i / 2)]!;
  }
  const indices: number[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = remap[m.indices[t]!]!,
      b = remap[m.indices[t + 1]!]!,
      c = remap[m.indices[t + 2]!]!;
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  return {
    mesh: recomputeMeshNormals(
      {
        positions: new Float32Array(p),
        indices: new Uint32Array(indices),
        uvs: new Float32Array(uv),
      },
      "equal",
    ),
    remap,
    collapsed: nv - p.length / 3,
  };
}
/** Row-major affine transforms, normals inverse-transpose, reflected winding/TBN. */
export function transformMesh(
  input: MeshInput,
  m: ArrayLike<number>,
): MeshBuffers {
  if (m.length !== 16) meshError("transform requires 16 elements");
  for (let i = 0; i < 16; i++) meshNumber(m[i]!, "transform");
  if (m[12] !== 0 || m[13] !== 0 || m[14] !== 0 || m[15] !== 1)
    meshError("transform must be affine");
  const a = m[0]!,
    b = m[1]!,
    c = m[2]!,
    d = m[4]!,
    e = m[5]!,
    f = m[6]!,
    g = m[8]!,
    h = m[9]!,
    i = m[10]!,
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-8) meshError("transform must be non-singular");
  const out = cloneMesh(input),
    co = [
      e * i - f * h,
      f * g - d * i,
      d * h - e * g,
      c * h - b * i,
      a * i - c * g,
      b * g - a * h,
      b * f - c * e,
      c * d - a * f,
      a * e - b * d,
    ];
  for (let k = 0; k < out.positions.length; k += 3) {
    const p: [number, number, number] = [
      out.positions[k]!,
      out.positions[k + 1]!,
      out.positions[k + 2]!,
    ];
    for (let r = 0; r < 3; r++)
      out.positions[k + r] =
        m[r * 4]! * p[0] +
        m[r * 4 + 1]! * p[1] +
        m[r * 4 + 2]! * p[2] +
        m[r * 4 + 3]!;
  }
  for (let k = 0; k < out.normals.length; k += 3) {
    const n: [number, number, number] = [
      out.normals[k]!,
      out.normals[k + 1]!,
      out.normals[k + 2]!,
    ];
    out.normals.set(
      unit(
        [0, 1, 2].map(
          (r) =>
            (co[r * 3]! * n[0] +
              co[r * 3 + 1]! * n[1] +
              co[r * 3 + 2]! * n[2]) /
            det,
        ) as [number, number, number],
      ),
      k,
    );
  }
  if (det < 0)
    for (let k = 0; k < out.indices.length; k += 3) {
      const j = out.indices[k + 1]!;
      out.indices[k + 1] = out.indices[k + 2]!;
      out.indices[k + 2] = j;
    }
  if (out.tangents.length) {
    for (let k = 0; k < out.tangents.length; k += 4) {
      const t: [number, number, number] = [
          out.tangents[k]!,
          out.tangents[k + 1]!,
          out.tangents[k + 2]!,
        ],
        v = unit([
          a * t[0] + b * t[1] + c * t[2],
          d * t[0] + e * t[1] + f * t[2],
          g * t[0] + h * t[1] + i * t[2],
        ]);
      out.tangents.set(v, k);
      out.tangents[k + 3] = out.tangents[k + 3]! * Math.sign(det);
    }
    if (out.uvs.length && out.normals.length) return attachMeshTangents(out);
  }
  checkMesh(out);
  return out;
}
export function centerMesh(
  m: MeshInput,
  target: Vec3 = [0, 0, 0],
): MeshBuffers {
  const b = meshBounds(m);
  if (!b) meshError("empty mesh cannot be centered");
  return transformMesh(m, [
    1,
    0,
    0,
    target[0] - (b.min[0] + b.max[0]) / 2,
    0,
    1,
    0,
    target[1] - (b.min[1] + b.max[1]) / 2,
    0,
    0,
    1,
    target[2] - (b.min[2] + b.max[2]) / 2,
    0,
    0,
    0,
    1,
  ]);
}
export function scaleMesh(
  m: MeshInput,
  scale: Vec3,
  pivot: Vec3 = [0, 0, 0],
): MeshBuffers {
  return transformMesh(m, [
    scale[0],
    0,
    0,
    pivot[0] * (1 - scale[0]),
    0,
    scale[1],
    0,
    pivot[1] * (1 - scale[1]),
    0,
    0,
    scale[2],
    pivot[2] * (1 - scale[2]),
    0,
    0,
    0,
    1,
  ]);
}
export function flipMeshAxis(m: MeshInput, axis: 0 | 1 | 2): MeshBuffers {
  meshInteger(axis, "axis", 0, 2);
  const s: [number, number, number] = [1, 1, 1];
  s[axis] = -1;
  return scaleMesh(m, s);
}
export function swapMeshAxes(
  m: MeshInput,
  a: 0 | 1 | 2,
  b: 0 | 1 | 2,
): MeshBuffers {
  meshInteger(a, "axisA", 0, 2);
  meshInteger(b, "axisB", 0, 2);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (a !== b) {
    matrix[a * 4 + a] = 0;
    matrix[b * 4 + b] = 0;
    matrix[a * 4 + b] = 1;
    matrix[b * 4 + a] = 1;
  }
  return transformMesh(m, matrix);
}
export interface SubdivisionOptions {
  levels?: number;
  creases?: readonly (readonly [number, number])[];
  preserveBoundary?: boolean;
  maxBytes?: number;
}
export function subdivideMesh(
  input: MeshInput,
  o: SubdivisionOptions = {},
): MeshBuffers {
  let m = cloneMesh(input);
  const levels = meshInteger(o.levels ?? 1, "levels", 0, 10),
    creases = new Set(
      (o.creases ?? []).map(([a, b]) => {
        meshInteger(a, "crease", 0, m.positions.length / 3 - 1);
        meshInteger(b, "crease", 0, m.positions.length / 3 - 1);
        return edge(a, b);
      }),
    ),
    preserve = o.preserveBoundary ?? true;
  meshLimit(
    m.indices.length * 4 ** levels * 4 + m.positions.length * 4 ** levels * 12,
    o.maxBytes,
  );
  for (let level = 0; level < levels; level++) {
    const nv = m.positions.length / 3,
      hasUv = m.uvs.length === nv * 2,
      neighbors = Array.from({ length: nv }, () => new Set<number>()),
      edges = new Map<
        string,
        { a: number; b: number; op: number[]; id: number }
      >();
    for (let t = 0; t < m.indices.length; t += 3) {
      const ids = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
      for (let j = 0; j < 3; j++) {
        const a = ids[j]!,
          b = ids[(j + 1) % 3]!,
          c = ids[(j + 2) % 3]!,
          key = edge(a, b);
        const record = edges.get(key) ?? {
          a: Math.min(a, b),
          b: Math.max(a, b),
          op: [],
          id: 0,
        };
        record.op.push(c);
        edges.set(key, record);
        neighbors[a]!.add(b);
        neighbors[b]!.add(a);
      }
    }
    if ([...edges.values()].some((e) => e.op.length > 2))
      meshError("subdivision requires manifold edges");
    const sharp = (key: string) =>
        creases.has(key) || (preserve && edges.get(key)!.op.length === 1),
      p = Array.from(m.positions),
      uv = Array.from(m.uvs),
      indices: number[] = [];
    for (const [key, e] of [...edges].sort(([a], [b]) => {
      const aa = a.split(":").map(Number),
        bb = b.split(":").map(Number);
      return aa[0]! - bb[0]! || aa[1]! - bb[1]!;
    })) {
      e.id = p.length / 3;
      const weights =
        sharp(key) || e.op.length < 2
          ? [
              [e.a, 0.5],
              [e.b, 0.5],
            ]
          : [
              [e.a, 0.375],
              [e.b, 0.375],
              [e.op[0]!, 0.125],
              [e.op[1]!, 0.125],
            ];
      for (let a = 0; a < 3; a++)
        p.push(
          weights.reduce((s, [i, w]) => s + m.positions[i! * 3 + a]! * w!, 0),
        );
      if (hasUv)
        for (let a = 0; a < 2; a++)
          uv.push(
            weights.reduce((s, [i, w]) => s + m.uvs[i! * 2 + a]! * w!, 0),
          );
    }
    for (let i = 0; i < nv; i++) {
      const nbr = [...neighbors[i]!].sort((a, b) => a - b),
        crease = nbr.filter((j) => sharp(edge(i, j)));
      let weights: number[][] = [];
      if (preserve && crease.length >= 2)
        weights = [
          [i, 0.75],
          [crease[0]!, 0.125],
          [crease[1]!, 0.125],
        ];
      else if (nbr.length >= 3) {
        const n = nbr.length,
          beta =
            n === 3
              ? 3 / 16
              : (5 / 8 - (3 / 8 + 0.25 * Math.cos((2 * Math.PI) / n)) ** 2) / n;
        weights = [[i, 1 - n * beta], ...nbr.map((j) => [j, beta])];
      } else weights = [[i, 1]];
      for (let a = 0; a < 3; a++)
        p[i * 3 + a] = weights.reduce(
          (s, [j, w]) => s + m.positions[j! * 3 + a]! * w!,
          0,
        );
      if (hasUv)
        for (let a = 0; a < 2; a++)
          uv[i * 2 + a] = weights.reduce(
            (s, [j, w]) => s + m.uvs[j! * 2 + a]! * w!,
            0,
          );
    }
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t]!,
        b = m.indices[t + 1]!,
        c = m.indices[t + 2]!,
        ab = edges.get(edge(a, b))!.id,
        bc = edges.get(edge(b, c))!.id,
        ca = edges.get(edge(c, a))!.id;
      indices.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    const nextCreases = new Set<string>();
    for (const key of creases) {
      const e = edges.get(key);
      if (e) {
        nextCreases.add(edge(e.a, e.id));
        nextCreases.add(edge(e.id, e.b));
      }
    }
    creases.clear();
    for (const key of nextCreases) creases.add(key);
    m = recomputeMeshNormals({
      positions: new Float32Array(p),
      indices: new Uint32Array(indices),
      uvs: new Float32Array(uv),
    });
  }
  return m;
}
export interface AdaptiveSubdivisionOptions extends SubdivisionOptions {
  maxEdgeLength?: number;
  curvatureThreshold?: number;
  maxLevels?: number;
}
/** Native global level selection from longest edge and maximum dihedral angle. */
export function subdivideMeshAdaptive(
  input: MeshInput,
  o: AdaptiveSubdivisionOptions = {},
): MeshBuffers {
  const m = cloneMesh(input),
    max = meshInteger(o.maxLevels ?? 3, "maxLevels", 0, 10);
  let levels = 0,
    longest = 0,
    maxAngle = 0;
  const faces = new Map<string, Vec3[]>();
  for (let t = 0; t < m.indices.length; t += 3) {
    const ids = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!],
      normal = unit(
        cross(
          sub(vertex(m, ids[1]!), vertex(m, ids[0]!)),
          sub(vertex(m, ids[2]!), vertex(m, ids[0]!)),
        ),
      );
    for (let j = 0; j < 3; j++) {
      const a = ids[j]!,
        b = ids[(j + 1) % 3]!;
      longest = Math.max(
        longest,
        Math.hypot(...sub(vertex(m, a), vertex(m, b))),
      );
      const key = edge(a, b),
        list = faces.get(key) ?? [];
      list.push(normal);
      faces.set(key, list);
    }
  }
  for (const normals of faces.values())
    if (normals.length === 2) {
      const a = normals[0]!,
        b = normals[1]!;
      maxAngle = Math.max(
        maxAngle,
        Math.acos(
          Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])),
        ),
      );
    }
  if (o.maxEdgeLength !== undefined) {
    const threshold = meshNumber(
      o.maxEdgeLength,
      "maxEdgeLength",
      Number.MIN_VALUE,
    );
    if (longest > threshold)
      levels = Math.max(levels, Math.ceil(Math.log2(longest / threshold)));
  }
  if (o.curvatureThreshold !== undefined) {
    const threshold = meshNumber(
      o.curvatureThreshold,
      "curvatureThreshold",
      Number.MIN_VALUE,
    );
    if (maxAngle > threshold)
      levels = Math.max(levels, Math.ceil(maxAngle / threshold) - 1);
  }
  return subdivideMesh(m, { ...o, levels: Math.min(levels, max) });
}
export interface HeightmapDisplacement {
  heights: Float32Array;
  width: number;
  height: number;
  scale?: number;
  uvSpace?: boolean;
}
export function displaceHeightmap(
  input: MeshInput,
  o: HeightmapDisplacement,
): MeshBuffers {
  const w = meshInteger(o.width, "width", 1, 16384),
    h = meshInteger(o.height, "height", 1, 16384),
    scale = meshNumber(o.scale ?? 1, "scale");
  if (!(o.heights instanceof Float32Array) || o.heights.length !== w * h)
    meshError("heightmap shape mismatch");
  for (const x of o.heights) meshNumber(x, "height");
  const m = input.normals?.length
      ? cloneMesh(input)
      : recomputeMeshNormals(input),
    bounds = meshBounds(m);
  if (!bounds) return m;
  const useUv =
    (o.uvSpace ?? true) && m.uvs.length === (m.positions.length / 3) * 2;
  for (let i = 0; i < m.positions.length / 3; i++) {
    const u = useUv
        ? m.uvs[i * 2]!
        : (m.positions[i * 3]! - bounds.min[0]) /
          Math.max(bounds.max[0] - bounds.min[0], 1e-8),
      v = useUv
        ? m.uvs[i * 2 + 1]!
        : (m.positions[i * 3 + 1]! - bounds.min[1]) /
          Math.max(bounds.max[1] - bounds.min[1], 1e-8),
      x = Math.min(1, Math.max(0, u)) * (w - 1),
      y = Math.min(1, Math.max(0, v)) * (h - 1),
      x0 = Math.floor(x),
      y0 = Math.floor(y),
      x1 = Math.min(x0 + 1, w - 1),
      y1 = Math.min(y0 + 1, h - 1),
      tx = x - x0,
      ty = y - y0,
      s =
        ((o.heights[y0 * w + x0]! * (1 - tx) + o.heights[y0 * w + x1]! * tx) *
          (1 - ty) +
          (o.heights[y1 * w + x0]! * (1 - tx) + o.heights[y1 * w + x1]! * tx) *
            ty) *
        scale;
    for (let a = 0; a < 3; a++)
      m.positions[i * 3 + a] =
        m.positions[i * 3 + a]! + m.normals[i * 3 + a]! * s;
  }
  return recomputeMeshNormals(m);
}
export function displaceProcedural(
  input: MeshInput,
  amplitude: number,
  frequency: number,
): MeshBuffers {
  meshNumber(amplitude, "amplitude");
  meshNumber(frequency, "frequency");
  const m = input.normals?.length
    ? cloneMesh(input)
    : recomputeMeshNormals(input);
  for (let i = 0; i < m.positions.length; i += 3) {
    const s =
      Math.sin(m.positions[i]! * frequency) *
      Math.cos(m.positions[i + 1]! * frequency) *
      amplitude;
    for (let a = 0; a < 3; a++)
      m.positions[i + a] = m.positions[i + a]! + m.normals[i + a]! * s;
  }
  return recomputeMeshNormals(m);
}
export function simplifyMesh(input: MeshInput, ratio: number): MeshBuffers {
  const m = input.normals?.length
    ? cloneMesh(input)
    : recomputeMeshNormals(input);
  if (ratio === 1) return m;
  const out = simplifyScatterMesh(m, ratio);
  return { ...out, uvs: new Float32Array(), tangents: new Float32Array() };
}
export function generateMeshLods(
  input: MeshInput,
  ratios: readonly number[] = [1, 0.5, 0.25],
): MeshBuffers[] {
  let previous = Infinity;
  return ratios.map((r) => {
    meshNumber(r, "ratio", Number.MIN_VALUE, 1);
    if (r >= previous) meshError("LOD ratios must decrease");
    previous = r;
    return simplifyMesh(input, r);
  });
}
export function planarMeshUv(
  input: MeshInput,
  axes: readonly [0 | 1 | 2, 0 | 1 | 2] = [0, 1],
): MeshBuffers {
  const m = cloneMesh(input),
    b = meshBounds(m);
  if (!b) return m;
  meshInteger(axes[0], "axis", 0, 2);
  meshInteger(axes[1], "axis", 0, 2);
  if (axes[0] === axes[1]) meshError("UV axes must differ");
  m.uvs = new Float32Array((m.positions.length / 3) * 2);
  for (let i = 0; i < m.positions.length / 3; i++)
    for (let j = 0; j < 2; j++) {
      const a = axes[j]!;
      m.uvs[i * 2 + j] =
        (m.positions[i * 3 + a]! - b.min[a]) /
        Math.max(b.max[a] - b.min[a], 1e-8);
    }
  m.tangents = new Float32Array();
  return m;
}
export function sphericalMeshUv(input: MeshInput): MeshBuffers {
  const m = cloneMesh(input),
    b = meshBounds(m);
  if (!b) return m;
  const center = b.min.map((x, i) => (x + b.max[i]!) / 2);
  const radius = Math.max(...b.max.map((x, i) => (x - b.min[i]!) / 2), 1e-8);
  m.uvs = new Float32Array((m.positions.length / 3) * 2);
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i]! - center[0]!,
      y = m.positions[i + 1]! - center[1]!,
      z = m.positions[i + 2]! - center[2]!,
      r = radius;
    m.uvs[(i / 3) * 2] = (Math.atan2(z, x) + Math.PI) / (2 * Math.PI);
    m.uvs[(i / 3) * 2 + 1] =
      (r ? Math.asin(Math.max(-1, Math.min(1, y / r))) : 0) / Math.PI + 0.5;
  }
  m.tangents = new Float32Array();
  return m;
}
