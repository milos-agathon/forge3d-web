import { Frame } from "./index.js";
import { type CartographicColor } from './cartography-common.js';
export type PlateCanvas = OffscreenCanvas | HTMLCanvasElement;
export type PlateContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
export interface PlatePixels {
    width: number;
    height: number;
    data: Uint8Array | Uint8ClampedArray;
    channels?: 1 | 3 | 4;
}
export type PlateImage = Frame | PlatePixels;
export declare function copyPlateImage(image: PlateImage, maxBytes?: number): Frame;
export declare function canvas2d(width: number, height: number, maxBytes?: number): {
    canvas: PlateCanvas;
    ctx: PlateContext;
};
export declare function imageCanvas(frame: Frame): PlateCanvas;
export declare function canvasFrame(canvas: PlateCanvas, ctx: PlateContext): Frame;
export declare function canvasBlob(canvas: PlateCanvas, type: 'image/png' | 'image/jpeg', quality?: number): Promise<Blob>;
/** Loads package fonts into Document.fonts or WorkerGlobalScope.fonts. Retryable on failure. */
export declare function loadCartographicFonts(): Promise<void>;
export declare function awaitCartographicFonts(signal?: AbortSignal): Promise<void>;
export declare const CARTOGRAPHIC_FONT_FAMILY = "NotoSans, NotoSansArabic, NotoSansDevanagari";
export declare function font(ctx: PlateContext, size: number): void;
export declare function rgbaBytes(c: CartographicColor): number[];
export declare function renderFurniture(width: number, height: number, draw: (ctx: PlateContext) => void, signal?: AbortSignal): Promise<Frame>;
