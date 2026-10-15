import { Forge3DError } from './index.js';
import { encodePng } from './frames.js';
import { decodePng } from './png-decode.js';
import { readByteSource } from './browser-io.js';
import type { BrowserByteSource, ByteReadOptions, PngEncodeOptions } from './index.js';
import type { RasterImage } from './image-io.js';

export interface ImageArray {
  width: number; height: number; channels: 1 | 3 | 4;
  data: Uint8Array | Uint8ClampedArray;
}
export const MAX_IMAGE_PIXELS = 16_777_216;
/** Owned RGBA8, row major, top left origin. Grayscale/RGB gain opaque alpha. */
export function imageArrayToRgba(image: ImageArray): RasterImage {
  const { width, height, channels, data } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || ![1, 3, 4].includes(channels) || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * channels)
    throw new Forge3DError('INVALID_INPUT', 'Expected a nonempty uint8 grayscale, RGB or RGBA image array');
  if (width * height > MAX_IMAGE_PIXELS) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Image pixel limit exceeded');
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * channels, j = p * 4;
    out[j] = data[i]!; out[j + 1] = data[i + (channels === 1 ? 0 : 1)]!;
    out[j + 2] = data[i + (channels === 1 ? 0 : 2)]!; out[j + 3] = channels === 4 ? data[i + 3]! : 255;
  }
  return { width, height, data: out };
}
export function arrayToPng(image: ImageArray, options: PngEncodeOptions = {}): Promise<Blob> {
  const rgba = imageArrayToRgba(image);
  return encodePng(rgba.width, rgba.height, new Uint8Array(rgba.data.buffer), options);
}
export async function pngToArray(source: BrowserByteSource, options: ByteReadOptions & { maxPixels?: number } = {}): Promise<RasterImage> {
  const bytes = await readByteSource(source, options);
  return decodePng(bytes, options);
}
export function imageArrayToImageData(image: ImageArray): ImageData {
  const rgba = imageArrayToRgba(image);
  if (typeof ImageData === 'undefined') throw new Forge3DError('UNSUPPORTED_FEATURE', 'ImageData is unavailable');
  return new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height);
}
/** Caller owns the canvas; this adapter allocates no URLs, listeners or GPU runtime. */
export function displayImageArray(canvas: HTMLCanvasElement | OffscreenCanvas, image: ImageArray): void {
  const pixels = imageArrayToImageData(image);
  canvas.width = pixels.width; canvas.height = pixels.height;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) throw new Forge3DError('UNSUPPORTED_FEATURE', '2D image context unavailable');
  context.putImageData(pixels, 0, 0);
}
