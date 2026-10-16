import { Forge3DError } from "./index.js";
import { generateMeshTangents } from "./textures.js";
import { TerrainScatterBatch } from "./terrain-scatter.js";
import type { ScatterBatchInput, ScatterLevel } from "./scatter-types.js";

/** Owned, packed triangle buffers. Empty optional attributes mean absent. */
export interface MeshBuffers {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  uvs: Float32Array;
  tangents: Float32Array;
}
export interface MeshInput {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  tangents?: Float32Array;
}
export interface MeshBounds {
  min: [number, number, number];
  max: [number, number, number];
}
export const MAX_MESH_BYTES = 256 * 1024 * 1024;
export function meshError(message: string): never {
  throw new Forge3DError("INVALID_INPUT", `mesh: ${message}`);
}
export function meshLimit(bytes: number, maximum = MAX_MESH_BYTES): void {
  if (!Number.isSafeInteger(maximum) || maximum < 0)
    meshError("allocation budget must be a non-negative safe integer");
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum)
    throw new Forge3DError(
      "RESOURCE_LIMIT_EXCEEDED",
      "mesh allocation exceeds budget",
      { bytes, maximum },
    );
}
export function meshNumber(
  n: number,
  name: string,
  min = -Infinity,
  max = Infinity,
): number {
  if (!Number.isFinite(n) || n < min || n > max)
    meshError(`${name} must be finite in [${min}, ${max}]`);
  return n;
}
export function meshInteger(
  n: number,
  name: string,
  min = 1,
  max = 4096,
): number {
  meshNumber(n, name, min, max);
  if (!Number.isInteger(n)) meshError(`${name} must be an integer`);
  return n;
}
export function meshBytes(m: MeshInput): number {
  return (
    m.positions.byteLength +
    m.indices.byteLength +
    (m.normals?.byteLength ?? 0) +
    (m.uvs?.byteLength ?? 0) +
    (m.tangents?.byteLength ?? 0)
  );
}
export function checkMesh(m: MeshInput, checkIndices = true): void {
  if (
    !(m?.positions instanceof Float32Array) ||
    m.positions.length % 3 ||
    !(m.indices instanceof Uint32Array) ||
    m.indices.length % 3
  )
    meshError(
      "positions must be packed xyz f32 and indices packed triangle u32",
    );
  meshLimit(meshBytes(m));
  const count = m.positions.length / 3;
  for (const [key, width] of [
    ["normals", 3],
    ["uvs", 2],
    ["tangents", 4],
  ] as const) {
    const a = m[key];
    if (
      a !== undefined &&
      (!(a instanceof Float32Array) ||
        (a.length !== 0 && a.length !== count * width))
    )
      meshError(`${key} count does not match vertices`);
    if (a) for (const x of a) meshNumber(x, key);
  }
  for (const x of m.positions) meshNumber(x, "position");
  if (checkIndices)
    for (const i of m.indices)
      if (i >= count) meshError(`index ${i} out of bounds`);
}
export function cloneMesh(m: MeshInput): MeshBuffers {
  checkMesh(m);
  return {
    positions: m.positions.slice(),
    indices: m.indices.slice(),
    normals: m.normals?.slice() ?? new Float32Array(),
    uvs: m.uvs?.slice() ?? new Float32Array(),
    tangents: m.tangents?.slice() ?? new Float32Array(),
  };
}
export function meshBounds(m: MeshInput): MeshBounds | null {
  checkMesh(m);
  if (!m.positions.length) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i++) {
    const a = i % 3;
    min[a] = Math.min(min[a]!, m.positions[i]!);
    max[a] = Math.max(max[a]!, m.positions[i]!);
  }
  return { min, max };
}
export type Vec3 = readonly [number, number, number];
export function sub(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function unit(a: Vec3): [number, number, number] {
  const l = Math.hypot(...a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export function vertex(m: MeshInput, i: number): [number, number, number] {
  return [
    m.positions[i * 3]!,
    m.positions[i * 3 + 1]!,
    m.positions[i * 3 + 2]!,
  ];
}
/** Area weighting for subdivision/displacement; equal weighting matches native weld. */
export function recomputeMeshNormals(
  input: MeshInput,
  weighting: "area" | "equal" = "area",
): MeshBuffers {
  checkMesh(input);
  meshLimit(
    input.positions.byteLength * 2 +
      input.indices.byteLength +
      (input.uvs?.byteLength ?? 0),
  );
  const m = cloneMesh(input),
    n = new Float32Array(m.positions.length);
  for (let t = 0; t < m.indices.length; t += 3) {
    const ids = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    let c = cross(
      sub(vertex(m, ids[1]!), vertex(m, ids[0]!)),
      sub(vertex(m, ids[2]!), vertex(m, ids[0]!)),
    );
    if (weighting === "equal") c = unit(c);
    for (const id of ids)
      for (let a = 0; a < 3; a++) n[id * 3 + a] = n[id * 3 + a]! + c[a]!;
  }
  for (let i = 0; i < n.length; i += 3) {
    let v = unit([n[i]!, n[i + 1]!, n[i + 2]!]);
    if (!Math.hypot(...v)) v = [0, 0, 1];
    n.set(v, i);
  }
  m.normals = n;
  m.tangents = new Float32Array();
  return m;
}
export function attachMeshTangents(input: MeshInput): MeshBuffers {
  const m = cloneMesh(input);
  if (
    m.normals.length !== m.positions.length ||
    m.uvs.length !== (m.positions.length / 3) * 2
  )
    meshError("TBN requires normals and UVs");
  meshLimit(
    meshBytes(m) - m.tangents.byteLength + (m.positions.length / 3) * 16,
  );
  m.tangents = generateMeshTangents(m).tangents;
  return m;
}
/** Transfer a dedicated copy; borrowing and SharedArrayBuffers never detach caller data. */
export function transferMesh(input: MeshInput): {
  mesh: MeshBuffers;
  transfer: ArrayBuffer[];
} {
  const mesh = cloneMesh(input);
  return {
    mesh,
    transfer: [
      mesh.positions.buffer,
      mesh.indices.buffer,
      mesh.normals.buffer,
      mesh.uvs.buffer,
      mesh.tangents.buffer,
    ] as ArrayBuffer[],
  };
}
export function mergeMeshes(inputs: readonly MeshInput[]): MeshBuffers {
  inputs.forEach((m) => checkMesh(m));
  meshLimit(inputs.reduce((n, m) => n + meshBytes(m), 0));
  const nv = inputs.reduce((n, m) => n + m.positions.length / 3, 0),
    ni = inputs.reduce((n, m) => n + m.indices.length, 0);
  const result: MeshBuffers = {
    positions: new Float32Array(nv * 3),
    indices: new Uint32Array(ni),
    normals: new Float32Array(
      inputs.every((m) => m.normals?.length === m.positions.length)
        ? nv * 3
        : 0,
    ),
    uvs: new Float32Array(
      inputs.every((m) => m.uvs?.length === (m.positions.length / 3) * 2)
        ? nv * 2
        : 0,
    ),
    tangents: new Float32Array(
      inputs.every((m) => m.tangents?.length === (m.positions.length / 3) * 4)
        ? nv * 4
        : 0,
    ),
  };
  let v = 0,
    i = 0;
  for (const m of inputs) {
    result.positions.set(m.positions, v * 3);
    if (result.normals.length) result.normals.set(m.normals!, v * 3);
    if (result.uvs.length) result.uvs.set(m.uvs!, v * 2);
    if (result.tangents.length) result.tangents.set(m.tangents!, v * 4);
    for (const x of m.indices) result.indices[i++] = x + v;
    v += m.positions.length / 3;
  }
  return result;
}
export const MESH_IDENTITY = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);
/** General meshes use the shared W09 bounded instancing, LOD, AOV and recovery path. */
export class MeshLayer {
  #mesh: MeshBuffers | null;
  #options: Omit<ScatterBatchInput, "levels">;
  constructor(
    mesh: MeshInput,
    options: Partial<Omit<ScatterBatchInput, "levels">> = {},
  ) {
    this.#mesh = mesh.normals?.length
      ? cloneMesh(mesh)
      : recomputeMeshNormals(mesh);
    this.#options = {
      ...options,
      transforms: options.transforms?.slice() ?? MESH_IDENTITY.slice(),
    };
    this.toBatch();
  }
  get disposed(): boolean {
    return this.#mesh === null;
  }
  get cpuBytes(): number {
    return this.#mesh
      ? meshBytes(this.#mesh) + this.#options.transforms.byteLength
      : 0;
  }
  mesh(): MeshBuffers {
    if (!this.#mesh)
      throw new Forge3DError("RUNTIME_DISPOSED", "Mesh layer disposed");
    return cloneMesh(this.#mesh);
  }
  toBatch(levels?: readonly ScatterLevel[]): TerrainScatterBatch {
    return new TerrainScatterBatch({
      ...this.#options,
      levels: levels ?? [{ mesh: this.mesh() }],
    });
  }
  dispose(): void {
    this.#mesh = null;
    this.#options = { transforms: new Float32Array() };
  }
}
