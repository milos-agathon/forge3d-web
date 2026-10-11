import type { Forge3DMessageHandler } from "./index.js";
import type {
  TraceTriangle,
  BvhBuildOptions,
  TraceVec3,
  TraceRay,
} from "./trace-types.js";
import { BvhHandle } from "./bvh.js";
import { SdfScene } from "./sdf.js";
import type { SdfSnapshot } from "./sdf.js";
import { loadOfflineWasm } from "./runtime-internals.js";
import { cancelled, traceInvalid, integer, vec } from "./trace-math.js";
export async function buildBvhWasm(
  triangles: readonly TraceTriangle[],
  options: BvhBuildOptions = {},
): Promise<BvhHandle> {
  if (options.method === "lbvh")
    traceInvalid("WASM builder uses SAH; GPU LBVH is buildBvhGpu");
  const handle = new BvhHandle(triangles, options);
  try {
    const wasm = await loadOfflineWasm(),
      result = wasm.buildTraceBvh(
        handle.triangles,
        integer(options.maxLeafSize ?? 4, "maxLeafSize", 1, 64),
        options.memoryBudgetBytes ?? 512 * 1024 * 1024,
      ) as {
        nodes: import("./trace-types.js").BvhNode[];
        indices: number[];
        maxDepth: number;
      };
    handle.nodes.length = 0;
    for (const node of result.nodes) handle.nodes.push(node);
    handle.indices.set(result.indices);
    Object.assign(handle.stats, {
      backend: "wasm",
      nodeCount: result.nodes.length,
      maxDepth: result.maxDepth,
      leafCount: result.nodes.filter((n) => n.count > 0).length,
    });
    return handle;
  } catch (error) {
    handle.dispose();
    throw error;
  }
}
export async function evaluateSdfWasm(
  scene: SdfScene,
  points: readonly TraceVec3[],
): Promise<{ distance: number; materialId: number }[]> {
  const wasm = await loadOfflineWasm(),
    data = new Float32Array(points.length * 3);
  points.forEach((p, i) => data.set(vec(p), i * 3));
  const result = wasm.evaluateTraceSdf(scene.snapshot(), data);
  return points.map((_, i) => ({
    distance: result.distances[i]!,
    materialId: result.materials[i]!,
  }));
}
export type TraceWorkerRequest =
  | {
      kind: "build-bvh";
      triangles: readonly TraceTriangle[];
      options?: BvhBuildOptions;
    }
  | {
      kind: "trace-rays";
      triangles: readonly TraceTriangle[];
      rays: readonly TraceRay[];
    }
  | { kind: "evaluate-sdf"; scene: SdfSnapshot; points: readonly TraceVec3[] };
/** Register with W02 WorkerPool/registerMessageHandlers; payloads use transferable typed buffers. */
export function createTraceWorkerHandler(): Forge3DMessageHandler {
  return async (payload, context) => {
    cancelled(context.signal);
    const request = payload as TraceWorkerRequest;
    if (request.kind === "evaluate-sdf") {
      const scene = SdfScene.fromSnapshot(request.scene);
      try {
        const result = [];
        for (let i = 0; i < request.points.length; i++) {
          if (i % 1024 === 0) {
            await new Promise<void>((r) => setTimeout(r, 0));
            cancelled(context.signal);
          }
          result.push(scene.evaluate(request.points[i]!));
        }
        cancelled(context.signal);
        return result;
      } finally {
        scene.dispose();
      }
    }
    if (request.kind === "build-bvh" || request.kind === "trace-rays") {
      const tree = new BvhHandle(
        request.triangles,
        request.kind === "build-bvh" ? request.options : {},
      );
      try {
        const result =
          request.kind === "build-bvh"
            ? {
                nodes: tree.packNodes(),
                triangles: tree.packTriangles(),
                indices: tree.indices.slice(),
                stats: { ...tree.stats },
              }
            : await (async () => {
                const hits = [];
                for (let i = 0; i < request.rays.length; i++) {
                  if (i % 1024 === 0) {
                    await new Promise<void>((r) => setTimeout(r, 0));
                    cancelled(context.signal);
                  }
                  hits.push(tree.intersect(request.rays[i]!));
                }
                return hits;
              })();
        cancelled(context.signal);
        return result;
      } finally {
        tree.dispose();
      }
    }
    traceInvalid("unknown trace worker operation");
  };
}
