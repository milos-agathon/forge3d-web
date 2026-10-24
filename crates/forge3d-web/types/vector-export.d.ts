import { type CartographicColor } from './cartography-common.js';
import { Bounds, VectorScene } from './vector-export-scene.js';
import type { BrowserByteSource } from './index.js';
export interface VectorExportFont {
    family: string;
    source: BrowserByteSource;
}
export interface VectorExportOptions {
    width?: number;
    height?: number;
    bounds?: Bounds;
    background?: CartographicColor;
    precision?: number;
    includeLabels?: boolean;
    maxBytes?: number;
    signal?: AbortSignal;
}
export interface VectorSvgOptions extends VectorExportOptions {
    fonts?: readonly VectorExportFont[];
}
export declare function generateSvg(scene: VectorScene, options?: VectorExportOptions): string;
/** Standalone SVG Blob with embedded fonts; generateSvg remains a synchronous markup API. */
export declare function exportSvg(scene: VectorScene, options?: VectorSvgOptions): Promise<Blob>;
/** Worker-safe XML structure validation. Rejects DTD/entities and malformed nesting/attributes. */
export declare function validateSvg(source: string): boolean;
