import { Forge3DError } from './index.js';
import { Frame } from './frames.js';
import { cancelled, checkBytes, integer, type CartographicColor } from './cartography-common.js';
export type PlateCanvas = OffscreenCanvas | HTMLCanvasElement;
export type PlateContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
export interface PlatePixels { width: number; height: number; data: Uint8Array | Uint8ClampedArray; channels?: 1 | 3 | 4 }
export type PlateImage = Frame | PlatePixels;
export function copyPlateImage(image: PlateImage, maxBytes?: number): Frame {
  integer(image.width, 'image width'); integer(image.height, 'image height'); checkBytes(image.width * image.height * 8, maxBytes);
  const channels = image instanceof Frame ? 4 : image.channels ?? 4;
  if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) || ![1, 3, 4].includes(channels) || image.data.length !== image.width * image.height * channels) throw new Forge3DError('INVALID_INPUT', 'Image data shape does not match its dimensions/channels');
  const data = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = image.data[i * channels + (channels === 1 ? 0 : c)]!;
    data[i * 4 + 3] = channels === 4 ? image.data[i * channels + 3]! : 255;
  }
  return new Frame(image.width, image.height, data);
}
export function canvas2d(width: number, height: number, maxBytes?: number): { canvas: PlateCanvas; ctx: PlateContext } {
  integer(width, 'canvas width'); integer(height, 'canvas height'); checkBytes(width * height * 12, maxBytes);
  let canvas: PlateCanvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
  else if (typeof document !== 'undefined') { canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; }
  else throw new Forge3DError('UNSUPPORTED_FEATURE', 'Canvas 2D is unavailable', { reason: 'canvas-unavailable' });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as PlateContext | null;
  if (!ctx) throw new Forge3DError('UNSUPPORTED_FEATURE', 'Canvas 2D context is unavailable');
  return { canvas, ctx };
}
export function imageCanvas(frame: Frame): PlateCanvas {
  const { canvas, ctx } = canvas2d(frame.width, frame.height); ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0); return canvas;
}
export function canvasFrame(canvas: PlateCanvas, ctx: PlateContext): Frame { const data = ctx.getImageData(0, 0, canvas.width, canvas.height); return new Frame(canvas.width, canvas.height, new Uint8Array(data.data)); }
export async function canvasBlob(canvas: PlateCanvas, type: 'image/png' | 'image/jpeg', quality = .9): Promise<Blob> {
  const blob = 'convertToBlob' in canvas ? await canvas.convertToBlob({ type, quality }) : await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Forge3DError('IO_ERROR', 'Canvas encoding failed')), type, quality));
  if (blob.type !== type) throw new Forge3DError('UNSUPPORTED_FEATURE', `Canvas encoder unavailable: ${type}`); return blob;
}
const fontNames = ['NotoSans', 'NotoSansArabic', 'NotoSansDevanagari'] as const;
let fontsReady: Promise<void> | undefined;
/** Loads package fonts into Document.fonts or WorkerGlobalScope.fonts. Retryable on failure. */
export function loadCartographicFonts(): Promise<void> {
  if (!fontsReady) fontsReady = (async () => {
    const fonts = (globalThis as unknown as { fonts?: FontFaceSet }).fonts ?? globalThis.document?.fonts;
    if (!fonts || typeof FontFace === 'undefined') throw new Forge3DError('UNSUPPORTED_FEATURE', 'FontFace/FontFaceSet unavailable');
    const faces = await Promise.all(fontNames.map(async name => { const face = new FontFace(name, `url("${new URL('../assets/fonts/' + name + '-Regular.ttf', import.meta.url).href}")`); await face.load(); return face; }));
    faces.forEach(face => fonts.add(face));
  })().catch(e => { fontsReady = undefined; throw e; });
  return fontsReady;
}
export async function awaitCartographicFonts(signal?: AbortSignal): Promise<void> {
  cancelled(signal); if (!signal) return loadCartographicFonts();
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new Forge3DError('REQUEST_CANCELLED', 'Cartographic font loading cancelled')); signal.addEventListener('abort', abort, { once: true }); });
  try { await Promise.race([loadCartographicFonts(), stopped]); cancelled(signal); } finally { signal.removeEventListener('abort', abort); }
}
export const CARTOGRAPHIC_FONT_FAMILY = 'NotoSans, NotoSansArabic, NotoSansDevanagari';
export function font(ctx: PlateContext, size: number): void { ctx.font = `${size}px ${CARTOGRAPHIC_FONT_FAMILY}`; ctx.textBaseline = 'top'; }
export function rgbaBytes(c: CartographicColor): number[] { return c.map(v => Math.round(v * 255)); }
export async function renderFurniture(width: number, height: number, draw: (ctx: PlateContext) => void, signal?: AbortSignal): Promise<Frame> {
  cancelled(signal); await loadCartographicFonts(); cancelled(signal);
  const { canvas, ctx } = canvas2d(width, height);
  try { draw(ctx); return canvasFrame(canvas, ctx); } finally { canvas.width = canvas.height = 1; }
}
