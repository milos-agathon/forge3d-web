import { SdfPrimitive } from "./sdf-primitive.js";
export { SdfPrimitive, SdfPrimitiveType, createSphere, createBox, } from "./sdf-primitive.js";
import type { TraceVec3, TraceRay, TraceHit, TraceBounds } from "./trace-types.js";
export declare enum CsgOperation {
    Union = 0,
    Intersection = 1,
    Subtraction = 2,
    SmoothUnion = 3,
    SmoothIntersection = 4,
    SmoothSubtraction = 5
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
    primitives: {
        type: number;
        materialId: number;
        params: number[];
    }[];
    nodes: SdfNode[];
    bounds: TraceBounds | null;
}
/** Native CSG distance and material selection, including smooth-union tie semantics. */
export declare function evaluateCsg(op: CsgOperation, a: SdfEvaluation, b: SdfEvaluation, k?: number): SdfEvaluation;
export declare class SdfScene {
    #private;
    static singlePrimitive(primitive: SdfPrimitive): SdfScene;
    addPrimitive(primitive: SdfPrimitive): number;
    addOperation(operation: CsgOperation, left: number, right: number, smoothing?: number, materialId?: number): number;
    setBounds(min: TraceVec3, max: TraceVec3): void;
    getBounds(): TraceBounds | undefined;
    inBounds(point: TraceVec3): boolean;
    primitiveCount(): number;
    nodeCount(): number;
    operationCount(): number;
    evaluate(point: TraceVec3): SdfEvaluation;
    normal(point: TraceVec3, epsilon?: number): TraceVec3;
    intersect(input: TraceRay, options?: {
        epsilon?: number;
        maxSteps?: number;
        id?: number;
    }): TraceHit | undefined;
    snapshot(): SdfSnapshot;
    static fromSnapshot(input: SdfSnapshot): SdfScene;
    cloneScene(): SdfScene;
    pack(): {
        primitives: ArrayBuffer;
        nodes: ArrayBuffer;
    };
    dispose(): void;
}
export declare class SdfSceneBuilder {
    #private;
    addSphere(c: TraceVec3, r: number, m?: number): number;
    addBox(c: TraceVec3, e: TraceVec3, m?: number): number;
    addCylinder(c: TraceVec3, r: number, h: number, m?: number): number;
    addPlane(n: TraceVec3, d: number, m?: number): number;
    addTorus(c: TraceVec3, r: number, s: number, m?: number): number;
    addCapsule(a: TraceVec3, b: TraceVec3, r: number, m?: number): number;
    union(a: number, b: number, m?: number): number;
    intersect(a: number, b: number, m?: number): number;
    subtract(a: number, b: number, m?: number): number;
    smoothUnion(a: number, b: number, k: number, m?: number): number;
    smoothIntersection(a: number, b: number, k: number, m?: number): number;
    smoothSubtraction(a: number, b: number, k: number, m?: number): number;
    withBounds(min: TraceVec3, max: TraceVec3): this;
    build(): SdfScene;
    reset(): void;
}
