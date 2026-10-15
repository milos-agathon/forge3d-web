import { type VectorScene } from './vector-export-scene.js';
import { type VectorExportOptions } from './vector-export.js';
import type { BrowserByteSource } from './index.js';
export interface VectorPdfFont {
    family: string;
    source: BrowserByteSource;
}
export interface VectorPdfOptions extends VectorExportOptions {
    /** Raster pixel dimensions are converted to PDF points at this DPI (native wrapper default 300). */
    dpi?: number;
    fonts?: readonly VectorPdfFont[];
}
/** Deterministic one-page PDF, true even-odd vector paths, embedded Unicode text and stroked halos. */
export declare function exportPdf(scene: VectorScene, options?: VectorPdfOptions): Promise<Blob>;
