import type { TraceResult } from "./trace-types.js";
export interface TraceTile {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** Native scanline order and clipped edge tiles, without filesystem coupling. */
export declare function iterTraceTiles(width: number, height: number, tileSize: number): Generator<TraceTile>;
/** Native save_aovs outcome as named EXR/PNG Blobs, using W06 encoders. */
export declare function encodeTraceAovs(result: TraceResult, baseName?: string): Promise<Record<string, Blob>>;
