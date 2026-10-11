import { BvhHandle } from "./bvh.js";
import { SdfScene } from "./sdf.js";
import type {
  TraceSceneInput,
  TraceMaterial,
  TraceLight,
  TraceMedium,
  TraceVec3,
  TraceRay,
  TraceHit,
  TraceTraversalMode,
} from "./trace-types.js";
import {
  vec,
  scalar,
  integer,
  traceInvalid,
  ray,
  unit,
  sub,
  cross,
  length,
  mul,
} from "./trace-math.js";
export interface EffectiveTraceMaterial {
  albedo: TraceVec3;
  emission: TraceVec3;
  metallic: number;
  roughness: number;
  ax: number;
  ay: number;
  ior: number;
}
export const normalizeTraceMaterial = (
  m: TraceMaterial,
): EffectiveTraceMaterial => ({
  albedo: color(m.albedo ?? [0.7, 0.7, 0.7], "albedo", 1),
  emission: color(m.emission ?? [0, 0, 0], "emission"),
  metallic: scalar(m.metallic ?? 0, "metallic", 0, 1),
  roughness: scalar(m.roughness ?? 0.5, "roughness", 0.001, 1),
  ax: scalar(
    m.ax ?? Math.max(0.001, (m.roughness ?? 0.5) ** 2),
    "ax",
    0.001,
    1,
  ),
  ay: scalar(
    m.ay ?? Math.max(0.001, (m.roughness ?? 0.5) ** 2),
    "ay",
    0.001,
    1,
  ),
  ior: scalar(m.ior ?? 1, "ior", 1, 5),
});
export function color(v: TraceVec3, name: string, max = 1e10): TraceVec3 {
  v = vec(v, name);
  v.forEach((x) => scalar(x, name, 0, max));
  return v;
}
export function normalizeTraceCamera(
  input: import("./trace-types.js").TraceCamera,
): Required<import("./trace-types.js").TraceCamera> {
  const origin = vec(input.origin),
    target = vec(input.target),
    up = unit(vec(input.up ?? [0, 1, 0]));
  if (
    length(sub(target, origin)) < 1e-6 ||
    length(cross(sub(target, origin), up)) < 1e-6
  )
    traceInvalid("camera basis must be nondegenerate");
  return {
    origin,
    target,
    up,
    fovY: scalar(input.fovY ?? 45, "fovY", 0.01, 179),
  };
}
export class TraceScene {
  readonly bvh: BvhHandle | undefined;
  readonly sdf: SdfScene | undefined;
  readonly materials: EffectiveTraceMaterial[];
  readonly lights: Required<TraceLight>[];
  readonly environment: TraceVec3;
  readonly medium: TraceMedium | undefined;
  constructor(
    input: TraceSceneInput = {},
    budget = 512 * 1024 * 1024,
    validateMaterials = true,
  ) {
    this.materials = (input.materials?.length ? input.materials : [{}]).map(
      normalizeTraceMaterial,
    );
    this.lights = (input.lights ?? []).map((l) => {
      const type = l.type ?? "point";
      if (!["point", "directional", "disc"].includes(type))
        traceInvalid("unknown light type");
      const direction = vec(l.direction ?? [0, -1, 0]),
        normal = vec(l.normal ?? [0, -1, 0]);
      if (length(direction) < 1e-6 || length(normal) < 1e-6)
        traceInvalid("light direction and normal must be nonzero");
      return {
        position: vec(l.position),
        color: color(l.color ?? [1, 1, 1], "light color"),
        intensity: scalar(l.intensity ?? 1, "intensity", 0, 1e10),
        weight: scalar(l.weight ?? 1, "weight", 1e-10, 1e10),
        type,
        direction: unit(direction),
        normal: unit(normal),
        radius: scalar(l.radius ?? 0, "light radius", 0),
      };
    });
    this.environment = color(
      input.environment ?? [0.6, 0.7, 0.9],
      "environment",
    );
    if (input.bvh && input.triangles?.length)
      traceInvalid("Provide triangles or a BVH handle");
    if (input.medium) {
      const m = input.medium,
        min = vec(m.bounds.min),
        max = vec(m.bounds.max);
      if (min.some((v, i) => v >= max[i]!))
        traceInvalid("medium bounds must have positive volume");
      this.medium = {
        sigmaA: color(m.sigmaA, "sigmaA"),
        sigmaS: color(m.sigmaS, "sigmaS"),
        g: scalar(m.g ?? 0, "g", -0.999, 0.999),
        bounds: { min, max },
      };
    }
    this.sdf = input.sdf?.cloneScene();
    this.bvh = input.bvh
      ? new BvhHandle(input.bvh.triangles, {
          method: "lbvh",
          memoryBudgetBytes: budget,
        })
      : input.triangles?.length
        ? new BvhHandle(input.triangles, { memoryBudgetBytes: budget })
        : undefined;
    if (input.bvh && this.bvh) {
      input.bvh.packNodes();
      this.bvh.nodes.length = 0;
      for (const node of input.bvh.nodes)
        this.bvh.nodes.push(structuredClone(node));
      this.bvh.indices = input.bvh.indices.slice();
      Object.assign(this.bvh.stats, input.bvh.stats);
    }
    if (validateMaterials)
      try {
        for (const t of this.bvh?.triangles ?? [])
          integer(
            t.materialId,
            "triangle materialId",
            0,
            this.materials.length - 1,
          );
        for (const n of this.sdf?.snapshot().nodes ?? [])
          if (n.leaf)
            integer(
              n.materialId,
              "SDF materialId",
              0,
              this.materials.length - 1,
            );
      } catch (error) {
        this.dispose();
        throw error;
      }
  }
  intersect(
    input: TraceRay,
    mode: TraceTraversalMode = "hybrid",
  ): TraceHit | undefined {
    const r = ray(input),
      mesh = mode !== "sdf-only" ? this.bvh?.intersect(r) : undefined,
      sdf =
        mode !== "mesh-only"
          ? this.sdf?.intersect({ ...r, tMax: mesh?.t ?? r.tMax })
          : undefined;
    if (sdf && (!mesh || sdf.t < mesh.t)) {
      if (importDot(sdf.normal, r.direction) > 0)
        sdf.normal = mul(sdf.normal, -1);
      return sdf;
    }
    return mesh;
  }
  snapshot(): unknown {
    return {
      triangles: this.bvh?.triangles ?? [],
      sdf: this.sdf?.snapshot() ?? null,
      materials: this.materials,
      lights: this.lights,
      environment: this.environment,
      medium: this.medium ?? null,
    };
  }
  dispose(): void {
    this.bvh?.dispose();
    this.sdf?.dispose();
  }
}
import { dot as importDot } from "./trace-math.js";
