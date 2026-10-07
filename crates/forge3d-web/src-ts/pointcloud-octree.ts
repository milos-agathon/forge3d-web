import type {
  PointVec3,
  PointBounds,
  PointNode,
  PointView,
  PointCloudDataset,
  PointTraversalOptions,
  VisiblePointNode,
} from "./pointcloud-types.js";
import {
  pointError,
  pointInteger,
  checkBounds,
  boundsCenter,
  boundsRadius,
  pointDistance,
  boundsInView,
  pointView,
  pointCancelled,
} from "./pointcloud-common.js";
export class OctreeKey {
  constructor(
    readonly depth = 0,
    readonly x = 0,
    readonly y = 0,
    readonly z = 0,
  ) {
    pointInteger(depth, "depth", 0, 30);
    for (const c of [x, y, z])
      pointInteger(c, "octree coordinate", 0, 2 ** depth - 1);
  }
  static parse(key: string): OctreeKey {
    const a = key.split("-").map(Number);
    if (a.length !== 4 || !/^\d+-\d+-\d+-\d+$/u.test(key))
      pointError("Invalid octree key");
    return new OctreeKey(a[0]!, a[1]!, a[2]!, a[3]!);
  }
  child(octant: number): OctreeKey {
    pointInteger(octant, "octant", 0, 7);
    return new OctreeKey(
      this.depth + 1,
      this.x * 2 + (octant & 1),
      this.y * 2 + ((octant >> 1) & 1),
      this.z * 2 + ((octant >> 2) & 1),
    );
  }
  parent(): OctreeKey | null {
    return this.depth
      ? new OctreeKey(
          this.depth - 1,
          Math.floor(this.x / 2),
          Math.floor(this.y / 2),
          Math.floor(this.z / 2),
        )
      : null;
  }
  toString(): string {
    return `${this.depth}-${this.x}-${this.y}-${this.z}`;
  }
  bounds(root: PointBounds): PointBounds {
    checkBounds(root);
    const scale = 2 ** this.depth,
      coords = [this.x, this.y, this.z];
    return {
      min: root.min.map(
        (v, i) => v + ((root.max[i]! - v) * coords[i]!) / scale,
      ) as unknown as PointVec3,
      max: root.min.map(
        (v, i) => v + ((root.max[i]! - v) * (coords[i]! + 1)) / scale,
      ) as unknown as PointVec3,
    };
  }
}
export function computePointSse(bounds: PointBounds, view: PointView): number {
  pointView(view);
  return (
    ((boundsRadius(bounds) /
      Math.max(0.001, pointDistance(boundsCenter(bounds), view.position))) *
      view.viewportHeight) /
    (2 * Math.tan(view.fovY / 2))
  );
}
/** Stable max heap avoids sorting the whole frontier for each visited node. */
class PointFrontier {
  #heap: { node: PointNode; priority: number; order: number }[] = [];
  #order = 0;
  #before(
    a: { priority: number; order: number },
    b: { priority: number; order: number },
  ): boolean {
    return (
      a.priority > b.priority ||
      (a.priority === b.priority && a.order < b.order)
    );
  }
  get length(): number {
    return this.#heap.length;
  }
  push(node: PointNode, priority: number): void {
    const entry = { node, priority, order: this.#order++ };
    let i = this.#heap.length;
    this.#heap.push(entry);
    while (i) {
      const parent = (i - 1) >> 1;
      if (!this.#before(entry, this.#heap[parent]!)) break;
      this.#heap[i] = this.#heap[parent]!;
      i = parent;
    }
    this.#heap[i] = entry;
  }
  pop(): PointNode {
    const root = this.#heap[0]!,
      last = this.#heap.pop()!;
    if (this.#heap.length) {
      let i = 0;
      while (i * 2 + 1 < this.#heap.length) {
        let c = i * 2 + 1;
        if (
          c + 1 < this.#heap.length &&
          this.#before(this.#heap[c + 1]!, this.#heap[c]!)
        )
          c++;
        if (!this.#before(this.#heap[c]!, last)) break;
        this.#heap[i] = this.#heap[c]!;
        i = c;
      }
      this.#heap[i] = last;
    }
    return root.node;
  }
}
export class PointCloudTraverser {
  pointBudget: number;
  maxDepth: number;
  minSpacing: number;
  sseThreshold: number;
  mode: "replace" | "add";
  constructor(o: PointTraversalOptions = {}) {
    this.pointBudget = o.pointBudget ?? 5_000_000;
    this.maxDepth = o.maxDepth ?? 20;
    this.minSpacing = o.minSpacing ?? 0.01;
    this.sseThreshold = o.sseThreshold ?? 1;
    this.mode = o.mode ?? "replace";
    this.#validate();
  }
  #validate(): void {
    pointInteger(this.pointBudget, "pointBudget", 0);
    pointInteger(this.maxDepth, "maxDepth", 0, 30);
    if (
      !Number.isFinite(this.minSpacing) ||
      this.minSpacing < 0 ||
      !Number.isFinite(this.sseThreshold) ||
      this.sseThreshold < 0 ||
      !["replace", "add"].includes(this.mode)
    )
      pointError("Invalid point traversal options");
  }
  setPointBudget(budget: number): void {
    pointInteger(budget, "pointBudget", 0);
    this.pointBudget = budget;
  }
  async visibleNodes(
    dataset: PointCloudDataset,
    view: PointView,
    signal?: AbortSignal,
  ): Promise<VisiblePointNode[]> {
    this.#validate();
    pointView(view);
    pointCancelled(signal);
    const queue = new PointFrontier(),
      result: VisiblePointNode[] = [];
    let used = 0;
    const priority = (n: PointNode) => {
      const d = pointDistance(boundsCenter(n.bounds), view.position),
        r = boundsRadius(n.bounds);
      return d < r ? Number.MAX_VALUE : r / Math.max(d, 0.001);
    };
    const root = dataset.rootNode();
    queue.push(root, priority(root));
    while (queue.length && used < this.pointBudget) {
      pointCancelled(signal);
      const node = queue.pop();
      if (
        node.depth > this.maxDepth ||
        !boundsInView(node.bounds, view.viewProjection)
      )
        continue;
      const sse = computePointSse(node.bounds, view),
        refine =
          node.depth < this.maxDepth &&
          sse > this.sseThreshold &&
          node.spacing >= this.minSpacing;
      const children = refine ? await dataset.children(node.key, signal) : [];
      pointCancelled(signal);
      if (this.mode === "add" || !children.length) {
        if (used + node.pointCount <= this.pointBudget) {
          result.push({ ...node, priority: priority(node), sse });
          used += node.pointCount;
        }
      }
      for (const child of children) queue.push(child, priority(child));
    }
    return result;
  }
}
