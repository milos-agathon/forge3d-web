import type { BrowserByteSource, ByteReadOptions } from './index.js';
import { Colormap } from './colormaps.js';
export declare function parseColormapJson(input: string | unknown, size?: number, name?: string): Colormap;
/** GMT RGB/HSV/CMYK segments, slash/hex colors, discontinuities and B/F/N endcaps. */
export declare function parseColormapCpt(text: string, name?: string, size?: number): Colormap;
export declare function loadColormap(source: BrowserByteSource, format: 'json' | 'cpt', options?: ByteReadOptions & {
    size?: number;
    name?: string;
}): Promise<Colormap>;
