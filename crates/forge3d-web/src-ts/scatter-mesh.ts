import { Forge3DError } from "./index.js";
import type { ScatterMesh, ScatterBounds, ScatterLevel } from "./scatter-types.js";

export function scatterInvalid(message: string): never {
  throw new Forge3DError("INVALID_INPUT", `scatter: ${message}`);
}
export function finite(value: number, name: string, min = -Infinity, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max) scatterInvalid(`${name} must be finite in [${min}, ${max}]`);
  return value;
}
export function validateScatterMesh(mesh: ScatterMesh): ScatterMesh {
  if (!(mesh.positions instanceof Float32Array) || !mesh.positions.length || mesh.positions.length % 3) scatterInvalid("positions must be nonempty packed xyz Float32Array");
  if (!(mesh.normals instanceof Float32Array) || mesh.normals.length !== mesh.positions.length) scatterInvalid("normals must match positions");
  if (!(mesh.indices instanceof Uint32Array) || !mesh.indices.length || mesh.indices.length % 3) scatterInvalid("indices must contain complete triangles");
  for (const x of mesh.positions) finite(x, "position");
  for (const x of mesh.normals) finite(x, "normal");
  for (const i of mesh.indices) if (i >= mesh.positions.length / 3) scatterInvalid("index out of bounds");
  return { positions: mesh.positions.slice(), normals: mesh.normals.slice(), indices: mesh.indices.slice() };
}
export function scatterMeshBounds(mesh: ScatterMesh): ScatterBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) for (let j = 0; j < 3; j++) {
    const x = mesh.positions[i + j]!; min[j] = Math.min(min[j]!, x); max[j] = Math.max(max[j]!, x);
  }
  return { min, max };
}
export function scatterTransformPoint(m: ArrayLike<number>, p: ArrayLike<number>): [number, number, number] {
  return [0, 1, 2].map(r => m[r * 4]! * p[0]! + m[r * 4 + 1]! * p[1]! + m[r * 4 + 2]! * p[2]! + m[r * 4 + 3]!) as [number, number, number];
}
export function scatterTransformBounds(bounds: ScatterBounds, m: ArrayLike<number>): ScatterBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let bits = 0; bits < 8; bits++) {
    const p = scatterTransformPoint(m, [0, 1, 2].map(a => (bits & (1 << a)) ? bounds.max[a]! : bounds.min[a]!));
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a]!, p[a]!); max[a] = Math.max(max[a]!, p[a]!); }
  }
  return { min, max };
}
export function mergeScatterBounds(bounds: readonly ScatterBounds[]): ScatterBounds {
  const result: ScatterBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const b of bounds) for (let a = 0; a < 3; a++) { result.min[a] = Math.min(result.min[a]!, b.min[a]!); result.max[a] = Math.max(result.max[a]!, b.max[a]!); }
  return result;
}

/** Deterministic QEM edge collapse, preserving normals through area-weighted recomputation. */
export function simplifyScatterMesh(input: ScatterMesh, ratio: number): ScatterMesh {
  finite(ratio, "simplifyRatio", Number.MIN_VALUE, 1);
  const mesh = validateScatterMesh(input);
  if (ratio === 1) return mesh;
  if (mesh.indices.length / 3 > 4096) throw new Forge3DError("RESOURCE_LIMIT_EXCEEDED", "QEM work limit is 4096 source triangles; simplify the source asset before batching");
  const count = mesh.positions.length / 3;
  const positions = Array.from({ length: count }, (_, i) => Array.from(mesh.positions.subarray(i * 3, i * 3 + 3)));
  let triangles = Array.from({ length: mesh.indices.length / 3 }, (_, i) => Array.from(mesh.indices.subarray(i * 3, i * 3 + 3)));
  const quadrics = Array.from({ length: count }, () => new Float64Array(16));
  for (const t of triangles) {
    const a = positions[t[0]!]!, b = positions[t[1]!]!, c = positions[t[2]!]!;
    const u = b.map((x, k) => x - a[k]!), v = c.map((x, k) => x - a[k]!);
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const len = Math.hypot(...n); if (len < 1e-14) continue;
    const plane = [...n.map(x => x / len), -n.reduce((s, x, k) => s + x * a[k]!, 0) / len];
    for (const vertex of t) for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) quadrics[vertex]![r * 4 + c] = quadrics[vertex]![r * 4 + c]! + plane[r]! * plane[c]!;
  }
  const target = Math.max(1, Math.ceil(triangles.length * ratio));
  while (triangles.length > target) {
    const edges = new Map<string, { a: number; b: number; count: number }>();
    for (const t of triangles) for (let k = 0; k < 3; k++) {
      const a = Math.min(t[k]!, t[(k + 1) % 3]!), b = Math.max(t[k]!, t[(k + 1) % 3]!);
      const key = `${a}:${b}`, edge = edges.get(key); if (edge) edge.count++; else edges.set(key, { a, b, count: 1 });
    }
    let best: { a: number; b: number; count: number } | undefined, bestCost = Infinity;
    for (const e of edges.values()) {
      const p = [...positions[e.a]!.map((x, k) => (x + positions[e.b]![k]!) / 2), 1];
      let cost = 0;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) cost += p[r]! * p[c]! * (quadrics[e.a]![r * 4 + c]! + quadrics[e.b]![r * 4 + c]!);
      cost = Math.max(0, cost) * (e.count === 1 ? 10 : 1);
      const surviving = triangles.length - e.count;
      if (surviving < 1) continue;
      if (cost < bestCost || (cost === bestCost && best && (e.a < best.a || (e.a === best.a && e.b < best.b)))) { best = e; bestCost = cost; }
    }
    if (!best) break;
    const { a, b } = best;
    positions[a] = positions[a]!.map((x, k) => (x + positions[b]![k]!) / 2);
    for (let k = 0; k < 16; k++) quadrics[a]![k] = quadrics[a]![k]! + quadrics[b]![k]!;
    triangles = triangles.map(t => t.map(i => i === b ? a : i)).filter(t => new Set(t).size === 3);
  }
  const used = [...new Set(triangles.flat())].sort((a, b) => a - b), remap = new Map(used.map((v, i) => [v, i]));
  const out: ScatterMesh = { positions: new Float32Array(used.flatMap(i => positions[i]!)), normals: new Float32Array(used.length * 3), indices: new Uint32Array(triangles.flatMap(t => t.map(i => remap.get(i)!))) };
  recomputeScatterNormals(out);
  return out;
}
export function recomputeScatterNormals(mesh: ScatterMesh): void {
  mesh.normals.fill(0);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!];
    const p = ids.map(v => mesh.positions.subarray(v * 3, v * 3 + 3));
    const u = [0, 1, 2].map(k => p[1]![k]! - p[0]![k]!), v = [0, 1, 2].map(k => p[2]![k]! - p[0]![k]!);
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    for (const id of ids) for (let k = 0; k < 3; k++) mesh.normals[id * 3 + k] = mesh.normals[id * 3 + k]! + n[k]!;
  }
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const len = Math.hypot(...mesh.normals.subarray(i, i + 3));
    if (len < 1e-10) mesh.normals[i + 1] = 1; else for (let k = 0; k < 3; k++) mesh.normals[i + k] = mesh.normals[i + k]! / len;
  }
}
export function autoScatterLodLevels(mesh: ScatterMesh, options: { ratios?: readonly number[]; distances?: readonly number[]; minTriangles?: number } = {}): ScatterLevel[] {
  const ratios = options.ratios ?? [1, 0.1, 0.01], distances = options.distances ?? [30, 100];
  if (!ratios.length || ratios[0] !== 1 || distances.length !== ratios.length - 1) scatterInvalid("LOD ratios must start at 1 and have one fewer distances");
  let previous = Infinity;
  ratios.forEach(r => { finite(r, "ratio", Number.MIN_VALUE, 1); if (r >= previous) scatterInvalid("LOD ratios must descend"); previous = r; });
  previous = 0;
  distances.forEach(d => { finite(d, "distance", Number.MIN_VALUE); if (d <= previous) scatterInvalid("LOD distances must increase"); previous = d; });
  const minimum = options.minTriangles ?? 8; finite(minimum, "minTriangles", 1);
  if (!Number.isInteger(minimum)) scatterInvalid("minTriangles must be an integer");
  const levels: ScatterLevel[] = [];
  for (const r of ratios) {
    const level = simplifyScatterMesh(mesh, r);
    if (levels.length && level.indices.length / 3 < minimum) break;
    if (levels.length && level.indices.length >= levels[levels.length - 1]!.mesh.indices.length) continue;
    levels.push({ mesh: level });
  }
  return levels.map((level, i) => i < levels.length - 1 ? { ...level, maxDistance: distances[i]! } : level);
}
