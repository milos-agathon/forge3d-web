import type { TraceVec3 } from "./trace-types.js";
import {
  vec,
  scalar,
  integer,
  length,
  sub,
  add,
  mul,
  dot,
  unit,
  clamp,
  f,
  traceInvalid,
} from "./trace-math.js";
export enum SdfPrimitiveType {
  Sphere = 0,
  Box = 1,
  Cylinder = 2,
  Plane = 3,
  Torus = 4,
  Capsule = 5,
}
/** Parameters match the native 80-byte SdfPrimitive buffer. */
export class SdfPrimitive {
  readonly params: Float32Array;
  private constructor(
    readonly primitiveType: SdfPrimitiveType,
    readonly materialId: number,
    values: readonly number[],
  ) {
    integer(materialId, "materialId", 0, 0xffffffff);
    this.params = new Float32Array(16);
    this.params.set(values);
  }
  static sphere(
    center: TraceVec3,
    radius: number,
    materialId = 0,
  ): SdfPrimitive {
    return new SdfPrimitive(0, materialId, [
      ...vec(center),
      scalar(radius, "radius", 0),
    ]);
  }
  static box(
    center: TraceVec3,
    extents: TraceVec3,
    materialId = 0,
  ): SdfPrimitive {
    const e = vec(extents);
    e.forEach((v) => scalar(v, "extents", 0));
    return new SdfPrimitive(1, materialId, [...vec(center), 0, ...e]);
  }
  static cylinder(
    center: TraceVec3,
    radius: number,
    height: number,
    materialId = 0,
  ): SdfPrimitive {
    return new SdfPrimitive(2, materialId, [
      ...vec(center),
      scalar(radius, "radius", 0),
      scalar(height, "height", 0),
    ]);
  }
  static plane(
    normal: TraceVec3,
    distance: number,
    materialId = 0,
  ): SdfPrimitive {
    const n = vec(normal);
    if (length(n) < 1e-20) traceInvalid("plane normal must be nonzero");
    return new SdfPrimitive(3, materialId, [
      ...unit(n),
      scalar(distance, "distance"),
    ]);
  }
  static torus(
    center: TraceVec3,
    majorRadius: number,
    minorRadius: number,
    materialId = 0,
  ): SdfPrimitive {
    return new SdfPrimitive(4, materialId, [
      ...vec(center),
      scalar(majorRadius, "majorRadius", 0),
      scalar(minorRadius, "minorRadius", 0),
    ]);
  }
  static capsule(
    pointA: TraceVec3,
    pointB: TraceVec3,
    radius: number,
    materialId = 0,
  ): SdfPrimitive {
    return new SdfPrimitive(5, materialId, [
      ...vec(pointA),
      scalar(radius, "radius", 0),
      ...vec(pointB),
    ]);
  }
  static fromPacked(
    type: number,
    material: number,
    params: readonly number[],
  ): SdfPrimitive {
    integer(type, "primitiveType", 0, 5);
    if (params.length !== 16) traceInvalid("SDF params must have 16 values");
    params.forEach((v) => scalar(v, "SDF param"));
    const a: TraceVec3 = [params[0]!, params[1]!, params[2]!],
      b: TraceVec3 = [params[4]!, params[5]!, params[6]!];
    switch (type) {
      case 0:
        return this.sphere(a, params[3]!, material);
      case 1:
        return this.box(a, b, material);
      case 2:
        return this.cylinder(a, params[3]!, params[4]!, material);
      case 3:
        return this.plane(a, params[3]!, material);
      case 4:
        return this.torus(a, params[3]!, params[4]!, material);
      default:
        return this.capsule(a, b, params[3]!, material);
    }
  }
  clone(): SdfPrimitive {
    return new SdfPrimitive(
      this.primitiveType,
      this.materialId,
      Array.from(this.params),
    );
  }
  evaluate(point: TraceVec3): number {
    const p = this.params,
      c: TraceVec3 = [p[0]!, p[1]!, p[2]!],
      q = sub(vec(point), c),
      r = p[3]!;
    switch (this.primitiveType) {
      case 0:
        return f(length(q) - r);
      case 1: {
        const d: TraceVec3 = [
          f(Math.abs(q[0]) - p[4]!),
          f(Math.abs(q[1]) - p[5]!),
          f(Math.abs(q[2]) - p[6]!),
        ];
        return f(
          length([Math.max(d[0], 0), Math.max(d[1], 0), Math.max(d[2], 0)]) +
            Math.min(Math.max(...d), 0),
        );
      }
      case 2: {
        const x = f(length([q[0], 0, q[2]]) - r),
          y = f(Math.abs(q[1]) - f(p[4]! * 0.5));
        return f(
          length([Math.max(x, 0), Math.max(y, 0), 0]) +
            Math.min(Math.max(x, y), 0),
        );
      }
      case 3:
        return f(dot(point, c) + r);
      case 4:
        return f(length([f(length([q[0], 0, q[2]]) - r), q[1], 0]) - p[4]!);
      case 5: {
        const segment = sub([p[4]!, p[5]!, p[6]!], c);
        const h = clamp(
          f(dot(q, segment) / Math.max(dot(segment, segment), 1e-30)),
        );
        return f(length(sub(point, add(c, mul(segment, h)))) - r);
      }
    }
    return Infinity;
  }
}
export const createSphere = SdfPrimitive.sphere;
export const createBox = SdfPrimitive.box;
