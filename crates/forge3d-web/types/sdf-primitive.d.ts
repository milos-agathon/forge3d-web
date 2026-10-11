import type { TraceVec3 } from "./trace-types.js";
export declare enum SdfPrimitiveType {
    Sphere = 0,
    Box = 1,
    Cylinder = 2,
    Plane = 3,
    Torus = 4,
    Capsule = 5
}
/** Parameters match the native 80-byte SdfPrimitive buffer. */
export declare class SdfPrimitive {
    readonly primitiveType: SdfPrimitiveType;
    readonly materialId: number;
    readonly params: Float32Array;
    private constructor();
    static sphere(center: TraceVec3, radius: number, materialId?: number): SdfPrimitive;
    static box(center: TraceVec3, extents: TraceVec3, materialId?: number): SdfPrimitive;
    static cylinder(center: TraceVec3, radius: number, height: number, materialId?: number): SdfPrimitive;
    static plane(normal: TraceVec3, distance: number, materialId?: number): SdfPrimitive;
    static torus(center: TraceVec3, majorRadius: number, minorRadius: number, materialId?: number): SdfPrimitive;
    static capsule(pointA: TraceVec3, pointB: TraceVec3, radius: number, materialId?: number): SdfPrimitive;
    static fromPacked(type: number, material: number, params: readonly number[]): SdfPrimitive;
    clone(): SdfPrimitive;
    evaluate(point: TraceVec3): number;
}
export declare const createSphere: typeof SdfPrimitive.sphere;
export declare const createBox: typeof SdfPrimitive.box;
