import { type BrowserByteSource } from "./index.js";
import { Forge3DError } from "./runtime-failure.js";
import { readByteSource } from './browser-io.js';
import { decodeOverlayImage } from './terrain-overlay.js';
export interface SpriteEntry { x: number; y: number; width: number; height: number; pixelRatio?: number; pixel_ratio?: number; sdf?: boolean; content?: number[]; stretchX?: number[][]; stretchY?: number[][]; }
export interface StyleAssetOptions { signal?: AbortSignal; maxBytes?: number; resolveUrl?: (url: string) => string; }
export class SpriteAtlas {
    #entries: Record<string, SpriteEntry>;
    #rgba: Uint8Array;
    readonly width: number; readonly height: number;
    #disposed = false;
    constructor(entries: Record<string, SpriteEntry>, width: number, height: number, rgba: Uint8Array) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.byteLength !== width * height * 4) throw new Forge3DError('INVALID_INPUT', 'Invalid sprite atlas image');
        for (const e of Object.values(entries)) if (!e || [e.x, e.y, e.width, e.height].some(n => !Number.isInteger(n) || n < 0) || !e.width || !e.height || e.x + e.width > width || e.y + e.height > height || !Number.isFinite(e.pixelRatio ?? e.pixel_ratio ?? 1) || (e.pixelRatio ?? e.pixel_ratio ?? 1) <= 0) throw new Forge3DError('INVALID_INPUT', 'Sprite entry exceeds atlas bounds');
        this.#entries = structuredClone(entries); this.width = width; this.height = height; this.#rgba = rgba.slice();
    }
    #live() { if (this.#disposed) throw new Forge3DError('RUNTIME_DISPOSED', 'Sprite atlas is disposed'); }
    names(): string[] { this.#live(); return Object.keys(this.#entries).sort(); }
    get(name: string): SpriteEntry | null { this.#live(); return Object.hasOwn(this.#entries, name) ? structuredClone(this.#entries[name]!) : null; }
    getUvs(name: string): [number, number, number, number] | null { const e = this.get(name); return e ? [e.x / this.width, e.y / this.height, (e.x + e.width) / this.width, (e.y + e.height) / this.height] : null; }
    extractSprite(name: string): { rgba: Uint8Array; width: number; height: number; pixelRatio: number; sdf: boolean } | null {
        const e = this.get(name); if (!e) return null; const rgba = new Uint8Array(e.width * e.height * 4);
        for (let y = 0; y < e.height; y++) { const offset = ((e.y + y) * this.width + e.x) * 4; rgba.set(this.#rgba.subarray(offset, offset + e.width * 4), y * e.width * 4); }
        return { rgba, width: e.width, height: e.height, pixelRatio: e.pixelRatio ?? e.pixel_ratio ?? 1, sdf: e.sdf ?? false };
    }
    dispose() { this.#rgba = new Uint8Array(0); this.#entries = Object.create(null); this.#disposed = true; }
    getMemoryReport() { return { cpuBytes: this.#rgba.byteLength, disposed: this.#disposed }; }
}
export async function loadSpriteAtlas(base: string, options: StyleAssetOptions & { pixelRatio?: 1 | 2 } = {}): Promise<SpriteAtlas> {
    const url = (suffix: string) => { const source = base + (options.pixelRatio === 2 && !base.endsWith('@2x') ? '@2x' : '') + suffix; return options.resolveUrl?.(source) ?? source; };
    const metadata = await readByteSource(url('.json'), options), image = await readByteSource(url('.png'), options);
    if (metadata.length + image.length > (options.maxBytes ?? 64 * 1024 * 1024)) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Sprite assets exceed budget');
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    if (image.length < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(12) !== 0x49484452) throw new Forge3DError('IO_ERROR', 'Sprite atlas must have a valid PNG header');
    const decodedBytes = view.getUint32(16) * view.getUint32(20) * 4;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 4 || decodedBytes > (options.maxBytes ?? 64 * 1024 * 1024)) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Sprite dimensions exceed decoded byte budget');
    const decoded = await decodeOverlayImage(new Blob([image.slice().buffer]));
    if (decoded.data.byteLength > (options.maxBytes ?? 64 * 1024 * 1024)) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Decoded sprite atlas exceeds budget');
    if (options.signal?.aborted) throw new Forge3DError('REQUEST_CANCELLED', 'Sprite load cancelled');
    return new SpriteAtlas(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata)), decoded.width, decoded.height, new Uint8Array(decoded.data));
}
export interface StyleGlyph { id: number; bitmap: Uint8Array; width: number; height: number; left: number; top: number; advance: number; }
export interface GlyphRange { name: string; range: string; glyphs: StyleGlyph[]; }
class Pbf {
    pos = 0;
    constructor(readonly bytes: Uint8Array) {}
    varint(): number { let value = 0, scale = 1; for (let i = 0; i < 5; i++) { const byte = this.bytes[this.pos++]; if (byte === undefined) throw Error('Truncated glyph varint'); value += (byte & 127) * scale; if (!(byte & 128)) { if (value > 0xffffffff) throw Error('Glyph integer overflow'); return value; } scale *= 128; } throw Error('Invalid glyph varint'); }
    block(): Uint8Array { const size = this.varint(), end = this.pos + size; if (end > this.bytes.length) throw Error('Truncated glyph message'); const result = this.bytes.subarray(this.pos, end); this.pos = end; return result; }
    fields(handle: (tag: number, wire: number) => boolean) { while (this.pos < this.bytes.length) { const key = this.varint(), tag = key >>> 3, wire = key & 7; if (!tag) throw Error('Invalid glyph field'); if (handle(tag, wire)) continue; if (wire === 0) this.varint(); else if (wire === 2) this.block(); else if (wire === 1 || wire === 5) { this.pos += wire === 1 ? 8 : 4; if (this.pos > this.bytes.length) throw Error('Truncated glyph field'); } else throw Error('Unsupported glyph wire type'); } }
}
/** Mapbox glyph PBF protocol v1. Signed left/top use zigzag and bitmaps include the three-pixel border. */
export function decodeGlyphRanges(bytes: Uint8Array): GlyphRange[] {
    try {
        const ranges: GlyphRange[] = [], root = new Pbf(bytes), text = new TextDecoder('utf-8', { fatal: true });
        root.fields((tag, wire) => {
            if (tag !== 1 || wire !== 2) return false;
            const p = new Pbf(root.block()), range: GlyphRange = { name: '', range: '', glyphs: [] }, ids = new Set<number>();
            p.fields((t, w) => {
                if ((t === 1 || t === 2) && w === 2) { range[t === 1 ? 'name' : 'range'] = text.decode(p.block()); return true; }
                if (t !== 3 || w !== 2) return false;
                const g = new Pbf(p.block()), glyph: StyleGlyph = { id: 0, bitmap: new Uint8Array(0), width: 0, height: 0, left: 0, top: 0, advance: 0 }, required = new Set<number>();
                g.fields((field, type) => {
                    if (field === 2 && type === 2) { glyph.bitmap = g.block().slice(); return true; }
                    if (![1, 3, 4, 5, 6, 7].includes(field) || type !== 0) return false;
                    const n = g.varint(); required.add(field);
                    if (field === 1) glyph.id = n; else if (field === 3) glyph.width = n; else if (field === 4) glyph.height = n; else if (field === 5) glyph.left = (n >>> 1) ^ -(n & 1); else if (field === 6) glyph.top = (n >>> 1) ^ -(n & 1); else glyph.advance = n;
                    return true;
                });
                if (required.size !== 6 || glyph.id > 0x10ffff || ids.has(glyph.id) || glyph.width > 4096 || glyph.height > 4096 || glyph.bitmap.length && glyph.bitmap.length !== (glyph.width + 6) * (glyph.height + 6)) throw Error('Invalid glyph metrics or bitmap');
                ids.add(glyph.id); range.glyphs.push(glyph); if (range.glyphs.length > 256) throw Error('Glyph range exceeds 256 entries'); return true;
            });
            const match = /^(\d+)-(\d+)$/.exec(range.range), start = Number(match?.[1]), end = Number(match?.[2]);
            if (!range.name || !match || start % 256 !== 0 || end !== start + 255 || end > 0x10ffff || range.glyphs.some(g => g.id < start || g.id > end)) throw Error('Invalid glyph range');
            ranges.push(range); if (ranges.length > 64) throw Error('Too many glyph stacks'); return true;
        });
        if (!ranges.length) throw Error('Glyph PBF has no font stacks'); return ranges;
    } catch (e) { throw new Forge3DError('IO_ERROR', `Invalid glyph PBF: ${String(e)}`, { reason: 'invalid-glyph-range' }); }
}
export async function loadGlyphRange(source: BrowserByteSource, options: StyleAssetOptions = {}): Promise<GlyphRange[]> { return decodeGlyphRanges(await readByteSource(source, options)); }
export async function loadGlyphRanges(template: string, fontStack: string, text: string, options: StyleAssetOptions = {}): Promise<GlyphRange[]> {
    if (!template.includes('{fontstack}') || !template.includes('{range}')) throw new Forge3DError('INVALID_INPUT', 'Glyph URL needs fontstack and range tokens');
    const starts = [...new Set([...text].map(c => Math.floor(c.codePointAt(0)! / 256) * 256))].sort((a, b) => a - b), output: GlyphRange[] = []; let used = 0;
    for (const start of starts) {
        const name = `${start}-${start + 255}`, url = template.replaceAll('{fontstack}', encodeURIComponent(fontStack)).replaceAll('{range}', name), bytes = await readByteSource(options.resolveUrl?.(url) ?? url, { ...options, maxBytes: (options.maxBytes ?? 16 * 1024 * 1024) - used });
        used += bytes.length;
        const ranges = decodeGlyphRanges(bytes); if (ranges.some(r => r.name !== fontStack || r.range !== name)) throw new Forge3DError('IO_ERROR', 'Glyph response does not match requested stack/range'); output.push(...ranges);
    }
    return output;
}
