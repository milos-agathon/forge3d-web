import {ownBvhResult,type BvhResult} from "./bvh-result.js";
import type {
  TraceTriangle,
  TraceRay,
  TraceHit,
  BvhNode,
  BvhBuildOptions,
  BvhStats,
  TraceBounds,
} from "./trace-types.js";
import { normalizeTriangles, buildNodes, triangleBounds } from "./bvh-build.js";
import {
  ray,
  sub,
  cross,
  dot,
  mul,
  add,
  unit,
  f,
  boundsInterval,
  live,
  traceInvalid,
  traceLimit,
  integer,
  emptyBounds,
  unionBounds,
} from "./trace-math.js";
export function intersectTriangle(
  t: Required<TraceTriangle>,
  r: Required<TraceRay>,
  max = r.tMax,
): TraceHit | undefined {
  const e1 = sub(t.v1, t.v0),
    e2 = sub(t.v2, t.v0),
    p = cross(r.direction, e2),
    det = dot(e1, p);
  if (Math.abs(det) < 1e-8) return;
  const inv = f(1 / det),
    s = sub(r.origin, t.v0),
    u = f(dot(s, p) * inv);
  if (u < 0 || u > 1) return;
  const q = cross(s, e1),
    v = f(dot(r.direction, q) * inv);
  if (v < 0 || f(u + v) > 1) return;
  const distance = f(dot(e2, q) * inv);
  if (distance < r.tMin || distance > max) return;
  let normal = unit(cross(e1, e2));
  const frontFace = dot(normal, r.direction) <= 0;
  if (!frontFace) normal = mul(normal, -1);
  return {
    id: t.id,
    materialId: t.materialId,
    t: distance,
    barycentric: [f(1 - f(u + v)), u, v],
    position: add(r.origin, mul(r.direction, distance)),
    normal,
    frontFace,
    kind: "mesh",
    steps: 0,
  };
}
/** Owned CPU query tree; packed layout is shared by WASM and WebGPU. */
export class BvhHandle {
  #disposed = false;
  readonly triangles: Required<TraceTriangle>[];
  readonly nodes: BvhNode[];
  indices: Uint32Array;
  readonly stats: BvhStats;
  constructor(
    input: readonly TraceTriangle[],
    options: BvhBuildOptions = {},
    build = true,
  ) {
    const start = performance.now();
    const budget = integer(
      options.memoryBudgetBytes ?? 512 * 1024 * 1024,
      "memoryBudgetBytes",
    );
    if (input.length * 256 > budget)
      traceLimit("BVH build bytes", input.length * 256, budget);
    if (
      options.method !== undefined &&
      !["sah", "lbvh"].includes(options.method)
    )
      traceInvalid("unknown BVH method");
    this.triangles = normalizeTriangles(input);
    // Preparation validates and owns primitives without performing a throwaway
    // main-thread sort/build before the WASM or GPU builder.
    const tree = build
      ? buildNodes(this.triangles, options)
      : {
          nodes: [
            {
              ...this.triangles
                .map(triangleBounds)
                .reduce(unionBounds, emptyBounds()),
              left: 0,
              right: 0,
              first: 0,
              count: input.length,
            },
          ],
          indices: Uint32Array.from(input, (_, i) => i),
          maxDepth: 0,
        };
    this.nodes = tree.nodes;
    this.indices = tree.indices;
    this.stats = {
      triangleCount: this.triangles.length,
      nodeCount: this.nodes.length,
      leafCount: this.nodes.filter((n) => n.count > 0).length,
      maxDepth: tree.maxDepth,
      memoryUsageBytes: this.triangles.length * 68 + this.nodes.length * 48,
      buildTimeMs: performance.now() - start,
      backend: "cpu",
      method: options.method ?? "sah",
    };
    this.install(this);
  }
  /** Validated primitive storage for an external builder; no CPU tree build. */
  static prepare(
    input: readonly TraceTriangle[],
    options: BvhBuildOptions = {},
  ): BvhHandle {
    return new BvhHandle(input, options, false);
  }
  clone(memoryBudgetBytes = 512 * 1024 * 1024): BvhHandle {
    live(this.#disposed);
    const copy = BvhHandle.prepare(this.triangles, {
      method: this.stats.method,
      memoryBudgetBytes,
    });
    copy.install(this);
    return copy;
  }
  /** Internal builder seam. Existing mutable inspection fields remain compatible. */
  install(result:BvhResult):void {
    live(this.#disposed);
    const owned=ownBvhResult(result);
    this.triangles.length=0;for(const triangle of owned.triangles)this.triangles.push(triangle);
    this.nodes.length=0;for(const node of owned.nodes)this.nodes.push(node);
    this.indices=owned.indices;Object.assign(this.stats,owned.stats);
  }
  /** Build privately; failures cannot expose partially refitted query state. */
  async refitOwned(input:readonly TraceTriangle[],work:(candidate:BvhHandle)=>Promise<void>):Promise<void> {
    live(this.#disposed);const candidate=this.clone();
    try{candidate.refit(input);await work(candidate);this.install(candidate);}finally{candidate.dispose();}
  }
  get worldBounds(): TraceBounds {
    live(this.#disposed);
    const n = this.nodes[0]!;
    return { min: [...n.min], max: [...n.max] };
  }
  isGpu(): boolean {
    live(this.#disposed);
    return this.stats.backend === "webgpu";
  }
  isCpu(): boolean {
    live(this.#disposed);
    return this.stats.backend !== "webgpu";
  }
  validatePrimitives(): void {
    live(this.#disposed);
    normalizeTriangles(this.triangles);
  }
  getProperties(): BvhStats & { worldBounds: TraceBounds } {
    live(this.#disposed);
    return { ...this.stats, worldBounds: this.worldBounds };
  }
  intersect(input: TraceRay): TraceHit | undefined {
    live(this.#disposed);
    const r = ray(input);
    let hit: TraceHit | undefined;
    const stack = [0];
    while (stack.length) {
      const n = this.nodes[stack.pop()!]!;
      if (!boundsInterval(n, r, hit?.t ?? r.tMax)) continue;
      if (n.count) {
        for (let j = 0; j < n.count; j++) {
          const t = this.triangles[this.indices[n.first + j]!]!;
          const h = intersectTriangle(t, r, hit?.t ?? r.tMax);
          if (h && (!hit || h.t < hit.t || (h.t === hit.t && h.id < hit.id)))
            hit = h;
        }
      } else if (n.left || n.right) {
        stack.push(n.right, n.left);
      }
    }
    return hit;
  }
  refit(input: readonly TraceTriangle[]): void {
    live(this.#disposed);
    if (input.length !== this.triangles.length)
      traceInvalid("Primitive count mismatch");
    const replacement = normalizeTriangles(input);
    if (replacement.some((t, i) => t.id !== this.triangles[i]!.id))
      traceInvalid("Refit must preserve triangle IDs");
    const boxes = replacement.map(triangleBounds),nodes=structuredClone(this.nodes);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      const b = n.count
        ? Array.from(this.indices.subarray(n.first, n.first + n.count)).reduce(
            (a, id) => unionBounds(a, boxes[id]!),
            emptyBounds(),
          )
        : n.left || n.right
          ? unionBounds(nodes[n.left]!, nodes[n.right]!)
          : emptyBounds();
      nodes[i] = { ...n, ...b };
    }
    this.install({triangles:replacement,nodes,indices:this.indices,stats:this.stats});
  }
  /** 48-byte nodes: two padded vec3 bounds, four u32 topology words. */
  packNodes(): ArrayBuffer {
    live(this.#disposed);
    const data = new ArrayBuffer(this.nodes.length * 48),
      fv = new Float32Array(data),
      uv = new Uint32Array(data);
    this.nodes.forEach((n, i) => {
      fv.set(n.min, i * 12);
      fv.set(n.max, i * 12 + 4);
      uv.set([n.left, n.right, n.first, n.count], i * 12 + 8);
    });
    return data;
  }
  packTriangles(): ArrayBuffer {
    live(this.#disposed);
    const b = new ArrayBuffer(this.triangles.length * 64),
      fv = new Float32Array(b),
      uv = new Uint32Array(b);
    this.triangles.forEach((t, i) => {
      fv.set(t.v0, i * 16);
      fv.set(t.v1, i * 16 + 4);
      fv.set(t.v2, i * 16 + 8);
      uv.set([t.id, t.materialId, 0, 0], i * 16 + 12);
    });
    return b;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.triangles.length = 0;
    this.nodes.length = 0;
    this.indices = new Uint32Array(0);
  }
}
export const buildBvh = (
  triangles: readonly TraceTriangle[],
  options: BvhBuildOptions = {},
): BvhHandle => new BvhHandle(triangles, options);
export const refitBvh = (
  handle: BvhHandle,
  triangles: readonly TraceTriangle[],
): void => handle.refit(triangles);
