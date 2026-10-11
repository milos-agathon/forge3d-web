import { SdfPrimitive } from "./sdf-primitive.js";
export {
  SdfPrimitive,
  SdfPrimitiveType,
  createSphere,
  createBox,
} from "./sdf-primitive.js";
import type {
  TraceVec3,
  TraceRay,
  TraceHit,
  TraceBounds,
} from "./trace-types.js";
import {
  scalar,
  integer,
  traceInvalid,
  vec,
  sub,
  length,
  add,
  mul,
  unit,
  dot,
  f,
  clamp,
  ray,
  boundsInterval,
  live,
} from "./trace-math.js";
export enum CsgOperation {
  Union = 0,
  Intersection = 1,
  Subtraction = 2,
  SmoothUnion = 3,
  SmoothIntersection = 4,
  SmoothSubtraction = 5,
}
export interface SdfEvaluation {
  distance: number;
  materialId: number;
}
export interface SdfNode {
  operation: CsgOperation;
  left: number;
  right: number;
  smoothing: number;
  materialId: number;
  leaf: boolean;
}
export interface SdfSnapshot {
  version: 1;
  primitives: { type: number; materialId: number; params: number[] }[];
  nodes: SdfNode[];
  bounds: TraceBounds | null;
}
const smoothMin = (a: number, b: number, k: number): number => {
  if (k <= 0) return Math.min(a, b);
  const h = clamp(f(0.5 + f(f(0.5 * f(b - a)) / k)));
  return f(f(f(f(1 - h) * b) + f(h * a)) - f(f(k * h) * f(1 - h)));
};
/** Native CSG distance and material selection, including smooth-union tie semantics. */
export function evaluateCsg(
  op: CsgOperation,
  a: SdfEvaluation,
  b: SdfEvaluation,
  k = 0,
): SdfEvaluation {
  if (op === 2 || op === 5)
    b = { distance: f(-b.distance), materialId: b.materialId };
  if (op === 0) return a.distance <= b.distance ? a : b;
  if (op === 1 || op === 2) return a.distance >= b.distance ? a : b;
  if (op === 3) {
    const t =
      f(a.distance + b.distance) === 0
        ? 0.5
        : f(b.distance / f(a.distance + b.distance));
    return {
      distance: smoothMin(a.distance, b.distance, k),
      materialId: t < 0.5 ? a.materialId : b.materialId,
    };
  }
  return {
    distance: f(-smoothMin(f(-a.distance), f(-b.distance), k)),
    materialId: a.distance >= b.distance ? a.materialId : b.materialId,
  };
}
export class SdfScene {
  #primitives: SdfPrimitive[] = [];
  #nodes: SdfNode[] = [];
  #bounds: TraceBounds | undefined;
  #disposed = false;
  static singlePrimitive(primitive: SdfPrimitive): SdfScene {
    const scene = new SdfScene();
    scene.addPrimitive(primitive);
    return scene;
  }
  addPrimitive(primitive: SdfPrimitive): number {
    live(this.#disposed);
    if (!(primitive instanceof SdfPrimitive))
      traceInvalid("Expected SdfPrimitive");
    const id = this.#primitives.length;
    this.#primitives.push(primitive.clone());
    this.#nodes.push({
      operation: 0,
      left: id,
      right: 0,
      smoothing: 0,
      materialId: primitive.materialId,
      leaf: true,
    });
    return this.#nodes.length - 1;
  }
  addOperation(
    operation: CsgOperation,
    left: number,
    right: number,
    smoothing = 0,
    materialId = 0,
  ): number {
    live(this.#disposed);
    integer(operation, "operation", 0, 5);
    integer(left, "left", 0, this.#nodes.length - 1);
    integer(right, "right", 0, this.#nodes.length - 1);
    this.#nodes.push({
      operation,
      left,
      right,
      smoothing: scalar(smoothing, "smoothing", 0),
      materialId: integer(materialId, "materialId", 0, 0xffffffff),
      leaf: false,
    });
    return this.#nodes.length - 1;
  }
  setBounds(min: TraceVec3, max: TraceVec3): void {
    live(this.#disposed);
    min = vec(min);
    max = vec(max);
    if (min.some((v, i) => v > max[i]!)) traceInvalid("bounds min exceeds max");
    this.#bounds = { min, max };
  }
  getBounds(): TraceBounds | undefined {
    live(this.#disposed);
    return this.#bounds ? structuredClone(this.#bounds) : undefined;
  }
  inBounds(point: TraceVec3): boolean {
    live(this.#disposed);
    point = vec(point);
    return (
      !this.#bounds ||
      point.every(
        (v, i) => v >= this.#bounds!.min[i]! && v <= this.#bounds!.max[i]!,
      )
    );
  }
  primitiveCount(): number {
    live(this.#disposed);
    return this.#primitives.length;
  }
  nodeCount(): number {
    live(this.#disposed);
    return this.#nodes.length;
  }
  operationCount(): number {
    return this.nodeCount() - this.primitiveCount();
  }
  evaluate(point: TraceVec3): SdfEvaluation {
    live(this.#disposed);
    point = vec(point);
    const values: SdfEvaluation[] = [];
    for (const node of this.#nodes)
      values.push(
        node.leaf
          ? {
              distance: this.#primitives[node.left]!.evaluate(point),
              materialId: node.materialId,
            }
          : evaluateCsg(
              node.operation,
              values[node.left]!,
              values[node.right]!,
              node.smoothing,
            ),
      );
    return values.at(-1) ?? { distance: Infinity, materialId: 0 };
  }
  normal(point: TraceVec3, epsilon = 1e-4): TraceVec3 {
    scalar(epsilon, "epsilon", 1e-8);
    return unit([
      f(
        this.evaluate(add(point, [epsilon, 0, 0])).distance -
          this.evaluate(sub(point, [epsilon, 0, 0])).distance,
      ),
      f(
        this.evaluate(add(point, [0, epsilon, 0])).distance -
          this.evaluate(sub(point, [0, epsilon, 0])).distance,
      ),
      f(
        this.evaluate(add(point, [0, 0, epsilon])).distance -
          this.evaluate(sub(point, [0, 0, epsilon])).distance,
      ),
    ]);
  }
  intersect(
    input: TraceRay,
    options: { epsilon?: number; maxSteps?: number; id?: number } = {},
  ): TraceHit | undefined {
    live(this.#disposed);
    if (!this.#nodes.length) return;
    const r = ray(input),
      eps = scalar(options.epsilon ?? 1e-5, "epsilon", 1e-8),
      steps = integer(options.maxSteps ?? 256, "maxSteps", 1, 4096);
    const interval = this.#bounds
      ? boundsInterval(this.#bounds, r)
      : [r.tMin, r.tMax];
    if (!interval) return;
    let t = interval[0]!;
    const speed = length(r.direction);
    for (let i = 0; i < steps && t <= interval[1]!; i++) {
      const p = add(r.origin, mul(r.direction, t)),
        e = this.evaluate(p);
      if (Math.abs(e.distance) <= eps) {
        const normal = this.normal(p, eps * 4);
        return {
          id: options.id ?? 0xfffffffe,
          materialId: e.materialId,
          t,
          barycentric: [0, 0, 0],
          position: p,
          normal,
          frontFace: dot(normal, r.direction) <= 0,
          kind: "sdf",
          steps: i + 1,
        };
      }
      t = f(t + Math.max(f(Math.abs(e.distance) / speed), eps * 0.25));
    }
  }
  snapshot(): SdfSnapshot {
    live(this.#disposed);
    return {
      version: 1,
      primitives: this.#primitives.map((p) => ({
        type: p.primitiveType,
        materialId: p.materialId,
        params: Array.from(p.params),
      })),
      nodes: structuredClone(this.#nodes),
      bounds: this.getBounds() ?? null,
    };
  }
  static fromSnapshot(input: SdfSnapshot): SdfScene {
    if (input.version !== 1) traceInvalid("unsupported SDF version");
    const scene = new SdfScene();
    const primitives = input.primitives.map((p) =>
      SdfPrimitive.fromPacked(p.type, p.materialId, p.params),
    );
    for (const n of input.nodes) {
      if (n.leaf) {
        integer(n.left, "primitive", 0, primitives.length - 1);
        const id = scene.addPrimitive(primitives[n.left]!);
        if (n.materialId !== primitives[n.left]!.materialId)
          scene.#nodes[id]!.materialId = integer(
            n.materialId,
            "materialId",
            0,
            0xffffffff,
          );
      } else
        scene.addOperation(
          n.operation,
          n.left,
          n.right,
          n.smoothing,
          n.materialId,
        );
    }
    if (input.bounds) scene.setBounds(input.bounds.min, input.bounds.max);
    return scene;
  }
  cloneScene(): SdfScene {
    return SdfScene.fromSnapshot(this.snapshot());
  }
  pack(): { primitives: ArrayBuffer; nodes: ArrayBuffer } {
    const snapshot = this.snapshot(),
      primitives = new ArrayBuffer(
        Math.max(1, snapshot.primitives.length) * 80,
      ),
      nodes = new ArrayBuffer(Math.max(1, snapshot.nodes.length) * 32),
      pf = new Float32Array(primitives),
      pu = new Uint32Array(primitives),
      nf = new Float32Array(nodes),
      nu = new Uint32Array(nodes);
    snapshot.primitives.forEach((p, i) => {
      pu.set([p.type, p.materialId, 0, 0], i * 20);
      pf.set(p.params, i * 20 + 4);
    });
    snapshot.nodes.forEach((n, i) => {
      nu.set(
        [n.operation, n.left, n.right, 0, n.materialId, n.leaf ? 1 : 0, 0, 0],
        i * 8,
      );
      nf[i * 8 + 3] = n.smoothing;
    });
    return { primitives, nodes };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#primitives = [];
    this.#nodes = [];
    this.#bounds = undefined;
  }
}
export class SdfSceneBuilder {
  #scene = new SdfScene();
  addSphere(c: TraceVec3, r: number, m = 0): number {
    return this.#scene.addPrimitive(SdfPrimitive.sphere(c, r, m));
  }
  addBox(c: TraceVec3, e: TraceVec3, m = 0): number {
    return this.#scene.addPrimitive(SdfPrimitive.box(c, e, m));
  }
  addCylinder(c: TraceVec3, r: number, h: number, m = 0): number {
    return this.#scene.addPrimitive(SdfPrimitive.cylinder(c, r, h, m));
  }
  addPlane(n: TraceVec3, d: number, m = 0): number {
    return this.#scene.addPrimitive(SdfPrimitive.plane(n, d, m));
  }
  addTorus(c: TraceVec3, r: number, s: number, m = 0): number {
    return this.#scene.addPrimitive(SdfPrimitive.torus(c, r, s, m));
  }
  addCapsule(a: TraceVec3, b: TraceVec3, r: number, m = 0): number {
    return this.#scene.addPrimitive(SdfPrimitive.capsule(a, b, r, m));
  }
  union(a: number, b: number, m = 0): number {
    return this.#scene.addOperation(0, a, b, 0, m);
  }
  intersect(a: number, b: number, m = 0): number {
    return this.#scene.addOperation(1, a, b, 0, m);
  }
  subtract(a: number, b: number, m = 0): number {
    return this.#scene.addOperation(2, a, b, 0, m);
  }
  smoothUnion(a: number, b: number, k: number, m = 0): number {
    return this.#scene.addOperation(3, a, b, k, m);
  }
  smoothIntersection(a: number, b: number, k: number, m = 0): number {
    return this.#scene.addOperation(4, a, b, k, m);
  }
  smoothSubtraction(a: number, b: number, k: number, m = 0): number {
    return this.#scene.addOperation(5, a, b, k, m);
  }
  withBounds(min: TraceVec3, max: TraceVec3): this {
    this.#scene.setBounds(min, max);
    return this;
  }
  build(): SdfScene {
    return this.#scene.cloneScene();
  }
  reset(): void {
    this.#scene.dispose();
    this.#scene = new SdfScene();
  }
}
