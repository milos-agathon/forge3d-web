import type { ScatterMesh } from "./scatter-types.js";

type Quadric = Float64Array;

interface CollapseCandidate {
  cost: number;
  v0: number;
  v1: number;
  generation: number;
}

function zeroQuadric(): Quadric {
  return new Float64Array(10);
}

function planeQuadric(nx: number, ny: number, nz: number, d: number): Quadric {
  return new Float64Array([
    nx * nx,
    nx * ny,
    nx * nz,
    nx * d,
    ny * ny,
    ny * nz,
    ny * d,
    nz * nz,
    nz * d,
    d * d,
  ]);
}

function addQuadric(left: Quadric, right: Quadric): Quadric {
  const result = new Float64Array(10);
  for (let i = 0; i < result.length; i++) result[i] = left[i]! + right[i]!;
  return result;
}

function quadricError(q: Quadric, x: number, y: number, z: number): number {
  const result = q[0]! * x * x
    + 2 * q[1]! * x * y
    + 2 * q[2]! * x * z
    + 2 * q[3]! * x
    + q[4]! * y * y
    + 2 * q[5]! * y * z
    + 2 * q[6]! * y
    + q[7]! * z * z
    + 2 * q[8]! * z
    + q[9]!;
  return Math.max(result, 0);
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function edgeVertices(a: number, b: number): readonly [number, number] {
  return a < b ? [a, b] : [b, a];
}

/** BinaryHeap ordering used by native CollapseCandidate: lower cost is greater. */
class CollapseHeap {
  readonly #values: CollapseCandidate[] = [];

  push(value: CollapseCandidate): void {
    const values = this.#values;
    let index = values.length;
    values.push(value);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.#greater(value, values[parent]!)) break;
      values[index] = values[parent]!;
      index = parent;
    }
    values[index] = value;
  }

  pop(): CollapseCandidate | undefined {
    const values = this.#values;
    const first = values[0];
    const tail = values.pop();
    if (!first || !tail || values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= values.length) break;
      const right = left + 1;
      // Rust BinaryHeap chooses the right child when both compare equal.
      const child = right < values.length && !this.#greater(values[left]!, values[right]!) ? right : left;
      if (!this.#greater(values[child]!, tail)) break;
      values[index] = values[child]!;
      index = child;
    }
    values[index] = tail;
    return first;
  }

  #greater(left: CollapseCandidate, right: CollapseCandidate): boolean {
    return left.cost < right.cost;
  }
}

function find(parent: Uint32Array, start: number): number {
  let vertex = start;
  while (parent[vertex] !== vertex) {
    parent[vertex] = parent[parent[vertex]!]!;
    vertex = parent[vertex]!;
  }
  return vertex;
}

function collapseCost(
  positions: readonly (readonly number[])[],
  quadrics: readonly Quadric[],
  v0: number,
  v1: number,
  boundary: boolean,
): number {
  const p0 = positions[v0]!, p1 = positions[v1]!;
  const x = (p0[0]! + p1[0]!) * 0.5;
  const y = (p0[1]! + p1[1]!) * 0.5;
  const z = (p0[2]! + p1[2]!) * 0.5;
  let cost = quadricError(addQuadric(quadrics[v0]!, quadrics[v1]!), x, y, z);
  if (boundary) cost *= 10;
  return cost;
}

export function nativeQemSimplify(mesh: ScatterMesh, ratio: number): ScatterMesh {
  const nativeRatio = Math.fround(ratio);
  if (Math.abs(nativeRatio - 1) < 1e-7) {
    return { positions: mesh.positions.slice(), normals: mesh.normals.slice(), indices: mesh.indices.slice() };
  }

  const originalTriangleCount = mesh.indices.length / 3;
  const targetTriangles = Math.max(1, Math.ceil(originalTriangleCount * nativeRatio));
  const vertexCount = mesh.positions.length / 3;
  const positions: number[][] = Array.from({ length: vertexCount }, (_, vertex) => [
    mesh.positions[vertex * 3]!,
    mesh.positions[vertex * 3 + 1]!,
    mesh.positions[vertex * 3 + 2]!,
  ]);
  const triangles: number[][] = Array.from({ length: originalTriangleCount }, (_, triangle) => [
    mesh.indices[triangle * 3]!,
    mesh.indices[triangle * 3 + 1]!,
    mesh.indices[triangle * 3 + 2]!,
  ]);
  const parent = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;

  const vertexTriangles: number[][] = Array.from({ length: vertexCount }, () => []);
  triangles.forEach((triangle, triangleIndex) => {
    for (const vertex of triangle) vertexTriangles[vertex]!.push(triangleIndex);
  });

  const quadrics = Array.from({ length: vertexCount }, zeroQuadric);
  for (const triangle of triangles) {
    const p0 = positions[triangle[0]!]!, p1 = positions[triangle[1]!]!, p2 = positions[triangle[2]!]!;
    const ux = p1[0]! - p0[0]!, uy = p1[1]! - p0[1]!, uz = p1[2]! - p0[2]!;
    const vx = p2[0]! - p0[0]!, vy = p2[1]! - p0[1]!, vz = p2[2]! - p0[2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length < 1e-14) continue;
    nx /= length; ny /= length; nz /= length;
    const q = planeQuadric(nx, ny, nz, -(nx * p0[0]! + ny * p0[1]! + nz * p0[2]!));
    for (const vertex of triangle) quadrics[vertex] = addQuadric(quadrics[vertex]!, q);
  }

  const edgeTriangleCounts = new Map<string, number>();
  for (const triangle of triangles) for (const [a, b] of [[triangle[0]!, triangle[1]!], [triangle[1]!, triangle[2]!], [triangle[2]!, triangle[0]!]]) {
    const key = edgeKey(a!, b!);
    edgeTriangleCounts.set(key, (edgeTriangleCounts.get(key) ?? 0) + 1);
  }
  const boundaryEdges = new Set([...edgeTriangleCounts].filter(([, count]) => count === 1).map(([key]) => key));
  const generation = new Uint32Array(vertexCount);
  const heap = new CollapseHeap();
  const seenEdges = new Set<string>();
  for (const triangle of triangles) for (const [a, b] of [[triangle[0]!, triangle[1]!], [triangle[1]!, triangle[2]!], [triangle[2]!, triangle[0]!]]) {
    const key = edgeKey(a!, b!);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const [v0, v1] = edgeVertices(a!, b!);
    heap.push({ cost: collapseCost(positions, quadrics, v0, v1, boundaryEdges.has(key)), v0, v1, generation: 0 });
  }

  let liveTriangleCount = originalTriangleCount;
  while (liveTriangleCount > targetTriangles) {
    const candidate = heap.pop();
    if (!candidate) break;
    const rv0 = find(parent, candidate.v0), rv1 = find(parent, candidate.v1);
    if (rv0 === rv1) continue;
    if (candidate.generation !== generation[rv0] && candidate.generation !== generation[rv1]) continue;

    const p0 = positions[rv0]!, p1 = positions[rv1]!;
    positions[rv0] = [(p0[0]! + p1[0]!) * 0.5, (p0[1]! + p1[1]!) * 0.5, (p0[2]! + p1[2]!) * 0.5];
    quadrics[rv0] = addQuadric(quadrics[rv0]!, quadrics[rv1]!);
    parent[rv1] = rv0;

    const trianglesToCheck = new Set<number>();
    for (const triangle of vertexTriangles[rv0]!) trianglesToCheck.add(triangle);
    for (const triangle of vertexTriangles[rv1]!) trianglesToCheck.add(triangle);
    const neighbors = new Set<number>();
    const survivingTriangles: number[] = [];
    for (const triangleIndex of trianglesToCheck) {
      const triangle = triangles[triangleIndex]!;
      if (triangle[0] === -1) continue;
      for (let i = 0; i < 3; i++) triangle[i] = find(parent, triangle[i]!);
      if (triangle[0] === triangle[1] || triangle[1] === triangle[2] || triangle[0] === triangle[2]) {
        liveTriangleCount--;
        triangle[0] = -1;
        continue;
      }
      survivingTriangles.push(triangleIndex);
      for (const vertex of triangle) if (vertex !== rv0) neighbors.add(vertex);
    }
    vertexTriangles[rv0] = survivingTriangles;
    generation[rv0] = generation[rv0]! + 1;
    for (const neighbor of neighbors) {
      const [v0, v1] = edgeVertices(rv0, neighbor);
      const key = edgeKey(rv0, neighbor);
      heap.push({
        cost: collapseCost(positions, quadrics, rv0, neighbor, boundaryEdges.has(key)),
        v0,
        v1,
        generation: generation[rv0]!,
      });
    }
  }

  const usedVertices = new Set<number>();
  const liveTriangles: number[][] = [];
  for (const triangle of triangles) {
    if (triangle[0] === -1) continue;
    const resolved = triangle.map(vertex => find(parent, vertex));
    if (resolved[0] === resolved[1] || resolved[1] === resolved[2] || resolved[0] === resolved[2]) continue;
    resolved.forEach(vertex => usedVertices.add(vertex));
    liveTriangles.push(resolved);
  }
  const sortedVertices = [...usedVertices].sort((a, b) => a - b);
  const remap = new Map(sortedVertices.map((vertex, index) => [vertex, index]));
  const result: ScatterMesh = {
    positions: new Float32Array(sortedVertices.flatMap(vertex => positions[vertex]!)),
    normals: new Float32Array(sortedVertices.length * 3),
    indices: new Uint32Array(liveTriangles.flatMap(triangle => triangle.map(vertex => remap.get(vertex)!))),
  };
  nativeAreaWeightedNormals(result);
  return result;
}

function f32(value: number): number {
  return Math.fround(value);
}

export function nativeAreaWeightedNormals(mesh: ScatterMesh): void {
  mesh.normals.fill(0);
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset]!, b = mesh.indices[offset + 1]!, c = mesh.indices[offset + 2]!;
    const ux = f32(mesh.positions[b * 3]! - mesh.positions[a * 3]!);
    const uy = f32(mesh.positions[b * 3 + 1]! - mesh.positions[a * 3 + 1]!);
    const uz = f32(mesh.positions[b * 3 + 2]! - mesh.positions[a * 3 + 2]!);
    const vx = f32(mesh.positions[c * 3]! - mesh.positions[a * 3]!);
    const vy = f32(mesh.positions[c * 3 + 1]! - mesh.positions[a * 3 + 1]!);
    const vz = f32(mesh.positions[c * 3 + 2]! - mesh.positions[a * 3 + 2]!);
    const nx = f32(f32(uy * vz) - f32(uz * vy));
    const ny = f32(f32(uz * vx) - f32(ux * vz));
    const nz = f32(f32(ux * vy) - f32(uy * vx));
    for (const vertex of [a, b, c]) {
      mesh.normals[vertex * 3] = f32(mesh.normals[vertex * 3]! + nx);
      mesh.normals[vertex * 3 + 1] = f32(mesh.normals[vertex * 3 + 1]! + ny);
      mesh.normals[vertex * 3 + 2] = f32(mesh.normals[vertex * 3 + 2]! + nz);
    }
  }
  for (let offset = 0; offset < mesh.normals.length; offset += 3) {
    const x = mesh.normals[offset]!, y = mesh.normals[offset + 1]!, z = mesh.normals[offset + 2]!;
    const length = f32(Math.sqrt(f32(f32(x * x) + f32(y * y) + f32(z * z))));
    if (length > 1e-10) {
      mesh.normals[offset] = f32(x / length);
      mesh.normals[offset + 1] = f32(y / length);
      mesh.normals[offset + 2] = f32(z / length);
    } else {
      mesh.normals[offset] = 0;
      mesh.normals[offset + 1] = 0;
      mesh.normals[offset + 2] = 1;
    }
  }
}
