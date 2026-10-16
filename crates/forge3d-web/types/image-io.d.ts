import type { BrowserByteSource, ByteReadOptions, RgbeImage } from "./index.js";
export interface RasterImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}
export declare function loadHdr(source: BrowserByteSource, o?: ByteReadOptions): Promise<RgbeImage>;
/** Radiance RGBE is a shared-exponent format; use float EXR for lossless HDR. */
export declare function exportHdr(image: RgbeImage): Blob;
export declare function loadImage(source: BrowserByteSource, o?: ByteReadOptions): Promise<RasterImage>;
export declare function exportImage(image: RasterImage, o?: {
    type?: "image/png" | "image/jpeg" | "image/webp";
    quality?: number;
    signal?: AbortSignal;
}): Promise<Blob>;
