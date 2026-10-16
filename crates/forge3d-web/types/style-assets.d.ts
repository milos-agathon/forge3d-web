import { type BrowserByteSource } from './index.js';
export interface SpriteEntry {
    x: number;
    y: number;
    width: number;
    height: number;
    pixelRatio?: number;
    pixel_ratio?: number;
    sdf?: boolean;
    content?: number[];
    stretchX?: number[][];
    stretchY?: number[][];
}
export interface StyleAssetOptions {
    signal?: AbortSignal;
    maxBytes?: number;
    resolveUrl?: (url: string) => string;
}
export declare class SpriteAtlas {
    #private;
    readonly width: number;
    readonly height: number;
    constructor(entries: Record<string, SpriteEntry>, width: number, height: number, rgba: Uint8Array);
    names(): string[];
    get(name: string): SpriteEntry | null;
    getUvs(name: string): [number, number, number, number] | null;
    extractSprite(name: string): {
        rgba: Uint8Array;
        width: number;
        height: number;
        pixelRatio: number;
        sdf: boolean;
    } | null;
    dispose(): void;
    getMemoryReport(): {
        cpuBytes: number;
        disposed: boolean;
    };
}
export declare function loadSpriteAtlas(base: string, options?: StyleAssetOptions & {
    pixelRatio?: 1 | 2;
}): Promise<SpriteAtlas>;
export interface StyleGlyph {
    id: number;
    bitmap: Uint8Array;
    width: number;
    height: number;
    left: number;
    top: number;
    advance: number;
}
export interface GlyphRange {
    name: string;
    range: string;
    glyphs: StyleGlyph[];
}
/** Mapbox glyph PBF protocol v1. Signed left/top use zigzag and bitmaps include the three-pixel border. */
export declare function decodeGlyphRanges(bytes: Uint8Array): GlyphRange[];
export declare function loadGlyphRange(source: BrowserByteSource, options?: StyleAssetOptions): Promise<GlyphRange[]>;
export declare function loadGlyphRanges(template: string, fontStack: string, text: string, options?: StyleAssetOptions): Promise<GlyphRange[]>;
