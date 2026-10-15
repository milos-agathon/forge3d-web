import type { BrowserByteSource, ByteReadOptions } from './index.js';
import { readByteSource } from './browser-io.js';
import { cartographicError, checkBytes, finite, integer, srgbToLinear } from './cartography-common.js';
import { Colormap, colormapFromStops, hexToRgba, type ColormapEndcaps, type ColormapStop } from './colormaps.js';

export function parseColormapJson(input: string | unknown, size = 256, name = 'json'): Colormap {
  let spec: unknown = input;
  if (typeof input === 'string') { checkBytes(input.length * 2); try { spec = JSON.parse(input); } catch { cartographicError('Invalid colormap JSON'); } }
  if (!spec || typeof spec !== 'object') cartographicError('Colormap JSON must be an object');
  const s = spec as Record<string, unknown>;
  if (s.name !== undefined && typeof s.name !== 'string' || !Array.isArray(s.stops) || !s.stops.every(v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && (typeof v[1] === 'string' || Array.isArray(v[1]) && [3, 4].includes(v[1].length) && v[1].every((n: unknown) => typeof n === 'number')))) cartographicError('Colormap JSON requires [position, color] stops and an optional name');
  return colormapFromStops(s.name as string | undefined ?? name, s.stops as ColormapStop[], size);
}
/** GMT RGB/HSV/CMYK segments, slash/hex colors, discontinuities and B/F/N endcaps. */
export function parseColormapCpt(text: string, name = 'cpt', size = 256): Colormap {
  checkBytes(text.length * 2); integer(size, 'colormap size', 1, 1048576);
  let model = 'RGB';
  const segments: { a: number; b: number; c: number[]; d: number[] }[] = [], caps: ColormapEndcaps = {};
  const decode = (parts: string[]): number[] => {
    if (parts.length === 1 && /^#?[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(parts[0]!)) return [...hexToRgba(parts[0]!)];
    if (parts.length === 1 && parts[0]!.includes('/')) parts = parts[0]!.split('/');
    const n = parts.map(Number);
    if (n.some(v => !Number.isFinite(v))) cartographicError('CPT color must be numeric or hex');
    if (model === 'RGB' && n.length === 1) return [n[0]! / 255, n[0]! / 255, n[0]! / 255, 1];
    if (n.length !== (model === 'CMYK' ? 4 : 3)) cartographicError(`Invalid ${model} CPT color`);
    if (model === 'RGB') return [...n.map(v => finite(v, 'CPT RGB', 0, 255) / 255), 1];
    if (model === 'CMYK') { n.forEach(v => finite(v, 'CPT CMYK', 0, 100)); return [0, 1, 2].map(i => (1 - n[i]! / 100) * (1 - n[3]! / 100)).concat(1); }
    finite(n[0]!, 'CPT hue', 0, 360); finite(n[1]!, 'CPT saturation', 0, 1); finite(n[2]!, 'CPT value', 0, 1);
    // Keep HSV components until sampling, so interpolation occurs in the declared model.
    return [...n, 1];
  };
  const hsv = (c: number[]): number[] => { const h = c[0]! / 60, s = c[1]!, v = c[2]!, f = (n: number) => v * (1 - s * Math.max(0, Math.min((n + h) % 6, 4 - (n + h) % 6, 1))); return [f(5), f(3), f(1), c[3]!]; };
  const linear = (c: number[]) => (model === 'HSV' ? hsv(c) : c).map((v, i) => i === 3 ? v : srgbToLinear(v)) as [number, number, number, number];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (line.startsWith('#')) { const m = /COLOR_MODEL\s*=\s*(\w+)/i.exec(line); if (m) { if (segments.length) cartographicError('CPT color model must precede segments'); model = m[1]!.toUpperCase(); if (!['RGB', 'HSV', 'CMYK'].includes(model)) cartographicError('Unsupported CPT color model'); } continue; }
    const p = line.split(';')[0]!.trim().split(/\s+/); if (/^[LUB]+$/.test(p.at(-1)!) && p.length > 2) p.pop();
    if (['B', 'F', 'N'].includes(p[0]!)) { if (p[1] === '-') continue; const c = linear(decode(p.slice(1))); caps[p[0] === 'B' ? 'under' : p[0] === 'F' ? 'over' : 'bad'] = c; continue; }
    const count = model === 'CMYK' ? 4 : 3, compact = p.length === 4;
    if (!compact && p.length !== 2 + 2 * count) cartographicError('Invalid CPT segment');
    const a = finite(Number(p[0]), 'CPT start'), b = finite(Number(p[compact ? 2 : count + 1]), 'CPT end');
    if (b <= a || segments.length && a !== segments.at(-1)!.b) cartographicError('CPT segments must be increasing and contiguous');
    segments.push({ a, b, c: decode(p.slice(1, compact ? 2 : count + 1)), d: decode(p.slice(compact ? 3 : count + 2)) });
  }
  if (!segments.length) cartographicError('CPT has no color segments');
  const out = new Float32Array(size * 4), lo = segments[0]!.a, hi = segments.at(-1)!.b; let j = 0;
  for (let i = 0; i < size; i++) {
    const x = lo + (hi - lo) * (size === 1 ? 0 : i / (size - 1)); while (j < segments.length - 1 && x >= segments[j]!.b) j++;
    const s = segments[j]!, t = (x - s.a) / (s.b - s.a), c = s.c.map((v, k) => v + (s.d[k]! - v) * t); out.set(linear(c), i * 4);
  }
  return new Colormap(name, out, caps);
}
export async function loadColormap(source: BrowserByteSource, format: 'json' | 'cpt', options: ByteReadOptions & { size?: number; name?: string } = {}): Promise<Colormap> {
  if (!['json', 'cpt'].includes(format)) cartographicError('Colormap format must be json or cpt');
  const bytes = await readByteSource(source, { ...options, maxBytes: options.maxBytes ?? 4 * 1024 * 1024 });
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { cartographicError('Colormap is not UTF-8'); }
  return format === 'json' ? parseColormapJson(text, options.size, options.name) : parseColormapCpt(text, options.name, options.size);
}
