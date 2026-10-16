import type { MeshBuffers, Vec3 } from "./mesh.js";
export type PrimitiveKind = "plane" | "box" | "sphere" | "cylinder" | "cone" | "torus";
export interface PrimitiveOptions {
    resolution?: readonly [number, number];
    radialSegments?: number;
    rings?: number;
    heightSegments?: number;
    tubeSegments?: number;
    radius?: number;
    tubeRadius?: number;
    includeCaps?: boolean;
}
export declare class MeshBuilder {
    p: number[];
    n: number[];
    uv: number[];
    i: number[];
    add(p: Vec3, n: Vec3, uv?: readonly [number, number]): number;
    build(): MeshBuffers;
}
/** Native unit dimensions: plane XY, cylinder/cone along Y, radius .5. */
export declare function generatePrimitive(kind: PrimitiveKind, options?: PrimitiveOptions): MeshBuffers;
export interface ExtrudeOptions {
    height?: number;
    baseHeight?: number;
    capUvScale?: number;
}
/** Rings use XY input and generate Z-up volumes; holes retain open courtyards. */
export declare function extrudePolygon(rings: readonly (readonly (readonly [number, number])[])[], options?: ExtrudeOptions): MeshBuffers;
export type JoinStyle = "miter" | "bevel" | "round";
export interface RibbonOptions {
    widthStart?: number;
    widthEnd?: number;
    joinStyle?: JoinStyle;
    joinStyles?: Uint8Array;
    miterLimit?: number;
    depthOffset?: number;
}
export declare function generateRibbon(path: readonly Vec3[], o?: RibbonOptions): MeshBuffers;
export declare function generateThickPolyline(path: readonly Vec3[], width: number, options?: Omit<RibbonOptions, "widthStart" | "widthEnd">): MeshBuffers;
export interface TubeOptions {
    radiusStart?: number;
    radiusEnd?: number;
    radialSegments?: number;
    capEnds?: boolean;
}
export declare function generateTube(path: readonly Vec3[], o?: TubeOptions): MeshBuffers;
