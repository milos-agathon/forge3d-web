import type {
  BvhNode,
  TraceTriangle,
  TraceBounds,
  BvhBuildOptions,
} from "./trace-types.js";
import {
  emptyBounds,
  unionBounds,
  integer,
  vec,
  traceInvalid,
  f,
} from "./trace-math.js";
export function normalizeTriangles(
  input: readonly TraceTriangle[],
): Required<TraceTriangle>[] {
  if (!Array.isArray(input) || input.length === 0)
    traceInvalid("Cannot build BVH from empty triangle list");
  const ids = new Set<number>();
  return input.map((t, i) => {
    const id = integer(t.id ?? i + 1, "triangle id", 1, 0xfffffffe);
    if (ids.has(id)) traceInvalid("triangle IDs must be unique");
    ids.add(id);
    return {
      v0: vec(t.v0),
      v1: vec(t.v1),
      v2: vec(t.v2),
      id,
      materialId: integer(t.materialId ?? 0, "materialId", 0, 0xfffffffe),
    };
  });
}
export function triangleBounds(t: TraceTriangle): TraceBounds {
  return unionBounds(
    unionBounds({ min: t.v0, max: t.v0 }, { min: t.v1, max: t.v1 }),
    { min: t.v2, max: t.v2 },
  );
}
const area = (b: TraceBounds): number => {
  const x = Math.max(0, b.max[0] - b.min[0]),
    y = Math.max(0, b.max[1] - b.min[1]),
    z = Math.max(0, b.max[2] - b.min[2]);
  return 2 * (x * y + y * z + z * x);
};
function spread(x: number): number {
  x &= 1023;
  x = (x | (x << 16)) & 0x030000ff;
  x = (x | (x << 8)) & 0x0300f00f;
  x = (x | (x << 4)) & 0x030c30c3;
  x = (x | (x << 2)) & 0x09249249;
  return x;
}
export function mortonCode(c: readonly number[], b: TraceBounds): number {
  const p = [0, 1, 2].map((a) =>
    Math.min(
      1023,
      Math.max(
        0,
        Math.floor(
          f(
            f((c[a]! - b.min[a]!) / Math.max(f(b.max[a]! - b.min[a]!), 1e-20)) *
              1024,
          ),
        ),
      ),
    ),
  );
  return (spread(p[0]!) | (spread(p[1]!) << 1) | (spread(p[2]!) << 2)) >>> 0;
}
export function buildNodes(
  triangles: readonly TraceTriangle[],
  options: BvhBuildOptions,
): { nodes: BvhNode[]; indices: Uint32Array; maxDepth: number } {
  const leaf = integer(options.maxLeafSize ?? 4, "maxLeafSize", 1, 64);
  const boxes = triangles.map(triangleBounds),
    centers = boxes.map((b) => [
      f(f(b.min[0] + b.max[0]) * 0.5),
      f(f(b.min[1] + b.max[1]) * 0.5),
      f(f(b.min[2] + b.max[2]) * 0.5),
    ]);
  const world = boxes.reduce(unionBounds, emptyBounds());
  let indices = Array.from({ length: triangles.length }, (_, i) => i);
  if (options.method === "lbvh") {
    const codes = centers.map((c) => mortonCode(c, world));
    indices.sort((a, b) => codes[a]! - codes[b]! || a - b);
  }
  const nodes: BvhNode[] = [];
  let maxDepth = 0;
  const visit = (first: number, count: number, depth: number): number => {
    maxDepth = Math.max(depth, maxDepth);
    const bounds = indices
      .slice(first, first + count)
      .reduce((a, i) => unionBounds(a, boxes[i]!), emptyBounds());
    const at = nodes.length;
    nodes.push({ ...bounds, left: 0, right: 0, first, count });
    if (count <= leaf || depth >= 60) return at;
    let split = first + Math.floor(count / 2);
    if (options.method !== "lbvh") {
      // Native SAH costs, evaluated with prefix/suffix bounds rather than O(n^2) scans.
      let bestCost = count,
        best: number[] | undefined,
        bestN = 0;
      const parentArea = area(bounds);
      for (let axis = 0; axis < 3; axis++) {
        const order = indices
          .slice(first, first + count)
          .sort((a, b) => centers[a]![axis]! - centers[b]![axis]! || a - b);
        const suffix: TraceBounds[] = new Array(count);
        let right = emptyBounds();
        for (let j = count - 1; j >= 0; j--) {
          right = unionBounds(right, boxes[order[j]!]!);
          suffix[j] = right;
        }
        let left = emptyBounds();
        for (let j = 1; j < count; j++) {
          left = unionBounds(left, boxes[order[j - 1]!]!);
          if (centers[order[j - 1]!]![axis] === centers[order[j]!]![axis])
            continue;
          const cost =
            1 +
            (area(left) * j + area(suffix[j]!) * (count - j)) /
              Math.max(parentArea, 1e-30);
          if (cost < bestCost) {
            bestCost = cost;
            best = order;
            bestN = j;
          }
        }
      }
      if (!best) return at;
      for (let i = 0; i < count; i++) indices[first + i] = best[i]!;
      split = first + bestN;
    }
    const left = visit(first, split - first, depth + 1),
      right = visit(split, first + count - split, depth + 1);
    nodes[at] = { ...bounds, left, right, first: 0, count: 0 };
    return at;
  };
  visit(0, triangles.length, 0);
  return { nodes, indices: Uint32Array.from(indices), maxDepth };
}
