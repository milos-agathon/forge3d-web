import { Unzlib } from 'fflate';
import { Forge3DError } from './index.js';
import type { RasterImage } from './image-io.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const SAMPLES: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function fail(message: string): never { throw new Forge3DError('IO_ERROR', `PNG: ${message}`); }
export function isPng(bytes: Uint8Array): boolean { return SIGNATURE.every((v, i) => bytes[i] === v); }
const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
  return x <= y && x <= z ? a : y <= z ? b : c;
}
/** PNG baseline and Adam7; all native grayscale/RGB/indexed/GA/RGBA depths.
 * CRC, zlib checksum, chunk structure and exact decompressed length are checked.
 * Unlike Canvas decode, RGB is preserved even when alpha is zero.
 */
export function decodePng(bytes: Uint8Array, options: { maxPixels?: number } = {}): RasterImage {
  const maxPixels = options.maxPixels ?? 16_777_216;
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 16_777_216) throw new Forge3DError('INVALID_INPUT', 'maxPixels must be 1..16777216');
  if (!(bytes instanceof Uint8Array) || !isPng(bytes)) fail('not a PNG file');
  if (bytes.length > 128 * 1024 * 1024) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'PNG input byte limit exceeded');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0, offset = 8, ended = false, dataEnded = false;
  let palette: Uint8Array | undefined, trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail('truncated chunk');
    const length = view.getUint32(offset), end = offset + 12 + length;
    if (end > bytes.length) fail('truncated chunk data');
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), data = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(name) || name[2] !== name[2]!.toUpperCase()) fail('invalid chunk type');
    if (crc(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) fail(`CRC mismatch for ${name}`);
    if (!width && name !== 'IHDR') fail('IHDR must be first');
    if (name === 'IHDR') {
      if (width || length !== 13) fail('invalid IHDR');
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      depth = data[8]!; type = data[9]!; interlace = data[12]!;
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !DEPTHS[type]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || interlace > 1) fail('unsupported or invalid IHDR');
      if (width * height > maxPixels) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'PNG pixel limit exceeded');
    } else if (name === 'PLTE') {
      if (palette || idat.length || trns || !length || length % 3 || length > 768 || type === 0 || type === 4 || (type === 3 && length / 3 > 2 ** depth)) fail('invalid palette');
      palette = data;
    } else if (name === 'tRNS') {
      if (trns || idat.length || (type === 3 ? !palette || length > palette.length / 3 || !length : type === 0 ? length !== 2 : type === 2 ? length !== 6 : true)) fail('invalid transparency');
      trns = data;
    } else if (name === 'IDAT') {
      if (dataEnded || (type === 3 && !palette)) fail('invalid IDAT order or missing palette');
      idat.push(data);
    } else if (name === 'IEND') {
      if (length || !idat.length || end !== bytes.length) fail('invalid IEND or trailing bytes');
      ended = true; break;
    } else {
      if (name[0] === name[0]!.toUpperCase()) fail(`unsupported critical chunk ${name}`);
      if (idat.length) dataEnded = true;
    }
    offset = end;
  }
  if (!ended) fail('missing IEND');
  const passes = (interlace ? PASSES : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x!) / dx!)), h = Math.max(0, Math.ceil((height - y!) / dy!));
    return { x: x!, y: y!, dx: dx!, dy: dy!, w, h, rowBytes: Math.ceil(w * SAMPLES[type]! * depth / 8) };
  });
  const expected = passes.reduce((n, p) => n + (p.w && p.h ? (p.rowBytes + 1) * p.h : 0), 0);
  const compressed = new Uint8Array(idat.reduce((n, v) => n + v.length, 0));
  let cursor = 0;
  for (const chunk of idat) { compressed.set(chunk, cursor); cursor += chunk.length; }
  if (compressed.length < 6) fail('truncated zlib');
  const raw = new Uint8Array(expected);
  cursor = 0;
  try {
    const stream = new Unzlib(chunk => {
      if (cursor + chunk.length > expected) fail('inflated data exceeds expected image size');
      raw.set(chunk, cursor); cursor += chunk.length;
    });
    // Bound each inflater output allocation even for malicious compression ratios.
    for (let i = 0; i < compressed.length; i += 256) stream.push(compressed.subarray(i, i + 256), i + 256 >= compressed.length);
  } catch (error) { if (error instanceof Forge3DError) throw error; fail('invalid zlib data'); }
  if (cursor !== expected) fail('truncated scanlines');
  let a = 1, b = 0;
  for (const value of raw) { a = (a + value) % 65521; b = (b + a) % 65521; }
  if (((b * 65536 + a) >>> 0) !== new DataView(compressed.buffer).getUint32(compressed.length - 4)) fail('zlib checksum mismatch');
  const rgba = new Uint8ClampedArray(width * height * 4), samples = SAMPLES[type]!, bpp = Math.max(1, Math.ceil(samples * depth / 8));
  const transparency = trns ? new DataView(trns.buffer, trns.byteOffset, trns.byteLength) : undefined;
  cursor = 0;
  for (const pass of passes) {
    if (!pass.w || !pass.h) continue;
    let previous = new Uint8Array(pass.rowBytes);
    for (let y = 0; y < pass.h; y++) {
      const filter = raw[cursor++]!, row = raw.slice(cursor, cursor + pass.rowBytes); cursor += pass.rowBytes;
      if (filter > 4) fail('unsupported filter');
      for (let i = 0; i < row.length; i++) {
        const left = i >= bpp ? row[i - bpp]! : 0, up = previous[i]!, ul = i >= bpp ? previous[i - bpp]! : 0;
        row[i] = row[i]! + (filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, ul) : 0);
      }
      const sample = (i: number): number => depth === 8 ? row[i]! : depth === 16 ? row[i * 2]! * 256 + row[i * 2 + 1]! : (row[Math.floor(i * depth / 8)]! >> (8 - depth - i * depth % 8)) & (2 ** depth - 1);
      const scale = (value: number): number => Math.floor((value * 255 + Math.floor((2 ** depth - 1) / 2)) / (2 ** depth - 1));
      for (let x = 0; x < pass.w; x++) {
        const dst = ((pass.y + y * pass.dy) * width + pass.x + x * pass.dx) * 4, s = x * samples, v = sample(s);
        if (type === 3) {
          if (!palette || v * 3 >= palette.length) fail('palette index out of range');
          rgba.set(palette.subarray(v * 3, v * 3 + 3), dst); rgba[dst + 3] = trns?.[v] ?? 255;
        } else if (type === 0 || type === 4) {
          rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = scale(v);
          rgba[dst + 3] = type === 4 ? scale(sample(s + 1)) : transparency?.getUint16(0) === v ? 0 : 255;
        } else {
          rgba[dst] = scale(v); rgba[dst + 1] = scale(sample(s + 1)); rgba[dst + 2] = scale(sample(s + 2));
          rgba[dst + 3] = type === 6 ? scale(sample(s + 3)) : transparency && v === transparency.getUint16(0) && sample(s + 1) === transparency.getUint16(2) && sample(s + 2) === transparency.getUint16(4) ? 0 : 255;
        }
      }
      previous = row;
    }
  }
  return { width, height, data: rgba };
}
