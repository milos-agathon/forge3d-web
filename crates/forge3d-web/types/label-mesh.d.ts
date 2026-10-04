import type { ShapedText } from "./label-types.js";
export declare function glyphOutlineMesh(commands: readonly {
    type: string;
    values: number[];
}[], tolerance?: number): number[];
export declare function shapedTextMesh(shaped: ShapedText): Float32Array;
export declare function labelStrokeMesh(points: readonly [number, number][], width: number, closed?: boolean): Float32Array;
