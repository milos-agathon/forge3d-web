import type { BrowserByteSource, ByteReadOptions, PngEncodeOptions } from './index.js';
import type { RasterImage } from './image-io.js';
export interface ImageArray {
    width: number;
    height: number;
    channels: 1 | 3 | 4;
    data: Uint8Array | Uint8ClampedArray;
}
export declare const MAX_IMAGE_PIXELS = 16777216;
/** Owned RGBA8, row major, top left origin. Grayscale/RGB gain opaque alpha. */
export declare function imageArrayToRgba(image: ImageArray): RasterImage;
export declare function arrayToPng(image: ImageArray, options?: PngEncodeOptions): Promise<Blob>;
export declare function pngToArray(source: BrowserByteSource, options?: ByteReadOptions & {
    maxPixels?: number;
}): Promise<RasterImage>;
export declare function imageArrayToImageData(image: ImageArray): ImageData;
/** Caller owns the canvas; this adapter allocates no URLs, listeners or GPU runtime. */
export declare function displayImageArray(canvas: HTMLCanvasElement | OffscreenCanvas, image: ImageArray): void;
