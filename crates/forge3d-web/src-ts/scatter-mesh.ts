import { Forge3DError } from "./index.js";
import type { ScatterMesh, ScatterBounds, ScatterLevel } from "./scatter-types.js";
import { nativeAreaWeightedNormals, nativeQemSimplify } from "./scatter-qem.js";

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
  const result: ScatterMesh = { positions: mesh.positions.slice(), normals: mesh.normals.slice(), indices: mesh.indices.slice() };
  for (const [key,width] of [["uvs",2],["tangents",4]] as const) {
    const data=mesh[key];
    if(data!==undefined){if(!(data instanceof Float32Array)||data.length!==0&&data.length!==mesh.positions.length/3*width)scatterInvalid(`${key} count mismatch`);for(const x of data)finite(x,key);result[key]=data.slice();}
  }
  return result;
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
  ratio = finite(Math.fround(ratio), "simplifyRatio", Number.MIN_VALUE, 1);
  const mesh = validateScatterMesh(input);
  return nativeQemSimplify(mesh, ratio);
}
export function recomputeScatterNormals(mesh: ScatterMesh): void {
  nativeAreaWeightedNormals(mesh);
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
