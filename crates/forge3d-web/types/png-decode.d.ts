import type { RasterImage } from './image-io.js';
export declare function isPng(bytes: Uint8Array): boolean;
/** PNG baseline and Adam7; all native grayscale/RGB/indexed/GA/RGBA depths.
 * CRC, zlib checksum, chunk structure and exact decompressed length are checked.
 * Unlike Canvas decode, RGB is preserved even when alpha is zero.
 */
export declare function decodePng(bytes: Uint8Array, options?: {
    maxPixels?: number;
}): RasterImage;
