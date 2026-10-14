import { Forge3DError } from './index.js';
import { Frame } from './frames.js';
import { cancelled, checkBytes, integer } from './cartography-common.js';
import { cartographicFontSources } from './cartography-fonts.js';
export interface CartographicRenderOptions { signal?: AbortSignal; maxBytes?: number }
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
let fontsReady: Promise<void> | undefined;
/** Loads package fonts into Document.fonts or WorkerGlobalScope.fonts. Retryable on failure. */
export function loadCartographicFonts(): Promise<void> {
  if (!fontsReady) fontsReady = (async () => {
    const fonts = (globalThis as unknown as { fonts?: FontFaceSet }).fonts ?? globalThis.document?.fonts;
    if (!fonts || typeof FontFace === 'undefined') throw new Forge3DError('UNSUPPORTED_FEATURE', 'FontFace/FontFaceSet unavailable');
    const faces = await Promise.all(cartographicFontSources().map(async source => {
      const face = new FontFace(source.family, `url("${source.url.href}")`, { weight: source.weight });
      try { await face.load(); } catch (error) { throw new Forge3DError('IO_ERROR', 'Cartographic font loading failed', { reason: 'font-load-failed', family: source.family, weight: source.weight, cause: String(error) }); }
      return face;
    }));
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
export const CARTOGRAPHIC_FONT_FAMILY = '"DejaVu Sans", NotoSansArabic, NotoSansDevanagari, sans-serif';
export function font(ctx: PlateContext, size: number, bold = false): void { ctx.font = `${bold ? '700' : '400'} ${size}px ${CARTOGRAPHIC_FONT_FAMILY}`; ctx.textBaseline = 'alphabetic'; }
// The frozen PIL baseline uses BASIC layout (integer FreeType advances).
// Keep browser shaping for complex scripts, which BASIC cannot shape correctly.
const basicText = (text: string) => /^[\u0020-\u024f]*$/u.test(text);
function basicWidth(ctx: PlateContext, text: string): number {
  let advance = 0, left = 0, right = 0;
  for (const glyph of text) {
    const m = ctx.measureText(glyph);
    left = Math.min(left, advance - Math.ceil(m.actualBoundingBoxLeft));
    right = Math.max(right, advance + Math.ceil(m.actualBoundingBoxRight));
    advance += Math.round(m.width);
  }
  return Math.max(advance, right) - left;
}
export function textBox(ctx: PlateContext, text: string): { width: number; height: number } {
  const m = ctx.measureText(text);
  return { width: basicText(text) ? basicWidth(ctx, text) : Math.round(Math.max(m.width, m.actualBoundingBoxLeft + m.actualBoundingBoxRight)), height: Math.round(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) };
}
export function drawText(ctx: PlateContext, text: string, x: number, y: number): void {
  // DejaVu Sans hhea ascender is 1901/2048 em. PIL rounds it upward.
  const size = Number(/([\d.]+)px/.exec(ctx.font)![1]);
  const baseline = y + (basicText(text) ? Math.ceil(size * 1901 / 2048) : Math.ceil(ctx.measureText(text).fontBoundingBoxAscent));
  if (basicText(text)) for (const glyph of text) { ctx.fillText(glyph, x, baseline); x += Math.round(ctx.measureText(glyph).width); }
  else ctx.fillText(text, x, baseline);
}
export async function renderFurniture(width: number, height: number, draw: (ctx: PlateContext) => void, options: CartographicRenderOptions = {}): Promise<Frame> {
  cancelled(options.signal); checkBytes(width * height * 12, options.maxBytes);
  await awaitCartographicFonts(options.signal); cancelled(options.signal);
  const { canvas, ctx } = canvas2d(width, height, options.maxBytes);
  try { draw(ctx); cancelled(options.signal); return canvasFrame(canvas, ctx); } finally { canvas.width = canvas.height = 1; }
}
