import { cartographicError, checkBytes, color, finite, integer, linearToSrgb, srgbToLinear, type CartographicColor } from './cartography-common.js';

export type ColormapStop = readonly [number, string | readonly [number, number, number] | CartographicColor];
export interface ColormapEndcaps { under?: CartographicColor; over?: CartographicColor; bad?: CartographicColor }
export function hexToRgb(hex: string): [number, number, number] {
  const c = hexToRgba(hex); return [c[0] * 255, c[1] * 255, c[2] * 255];
}
export function hexToRgba(hex: string, alpha = 1): [number, number, number, number] {
  const h = hex.replace(/^#/, ''); finite(alpha, 'alpha', 0, 1);
  if (!/^(?:[a-f\d]{6}|[a-f\d]{8})$/i.test(h)) cartographicError(`Invalid hex color: ${hex}`);
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : alpha];
}
export function rgbToNormalized(rgb: readonly [number, number, number]): [number, number, number] {
  return rgb.map(v => finite(v, 'RGB', 0, 255) / 255) as [number, number, number];
}
/** Immutable sampled colormap in linear sRGB. Accessors return copies. */
export class Colormap {
  readonly name: string;
  readonly #rgba: Float32Array;
  readonly #caps: ColormapEndcaps;
  constructor(name: string, rgba: Float32Array | readonly number[], caps: ColormapEndcaps = {}) {
    if (!name.trim() || rgba.length < 4 || rgba.length % 4) cartographicError('Colormap requires a name and N×4 colors');
    checkBytes(rgba.length * 4); Array.from(rgba).forEach(v => finite(v, 'linear RGBA', 0, 1));
    this.name = name; this.#rgba = new Float32Array(rgba);
    this.#caps = { ...(caps.under ? { under: color(caps.under) } : {}), ...(caps.over ? { over: color(caps.over) } : {}), bad: color(caps.bad ?? [0, 0, 0, 0]) };
    Object.freeze(this);
  }
  get rgba(): Float32Array { return this.#rgba.slice(); }
  get size(): number { return this.#rgba.length / 4; }
  get endcaps(): ColormapEndcaps { return structuredClone(this.#caps); }
  sample(t: number): CartographicColor {
    const cap = Number.isNaN(t) ? this.#caps.bad : t < 0 ? this.#caps.under : t > 1 ? this.#caps.over : undefined;
    if (cap) return [...cap];
    if (Number.isNaN(t)) return [0, 0, 0, 0];
    const x = Math.max(0, Math.min(1, t)) * (this.size - 1), lo = Math.floor(x), hi = Math.min(lo + 1, this.size - 1), f = x - lo;
    return [0, 1, 2, 3].map(c => this.#rgba[lo * 4 + c]! * (1 - f) + this.#rgba[hi * 4 + c]! * f) as [number, number, number, number];
  }
  reversed(): Colormap {
    const out = new Float32Array(this.#rgba.length);
    for (let i = 0; i < this.size; i++) out.set(this.#rgba.subarray((this.size - i - 1) * 4, (this.size - i) * 4), i * 4);
    return new Colormap(this.name + '_r', out, this.#caps);
  }
  withEndcaps(caps: ColormapEndcaps): Colormap { return new Colormap(this.name, this.#rgba, { ...this.#caps, ...caps }); }
  /** Straight linear unorm8, matching native to_linear_rgba_u8. */
  toLinearRgba8(): Uint8Array { return Uint8Array.from(this.#rgba, v => Math.floor(v * 255 + 0.5)); }
  toDisplayRgba8(): Uint8Array { return Uint8Array.from(this.#rgba, (v, i) => Math.round((i % 4 === 3 ? v : linearToSrgb(v)) * 255)); }
  toTexture(): { width: number; height: 1; format: 'rgba8unorm'; data: Uint8Array } { return { width: this.size, height: 1, format: 'rgba8unorm', data: this.toLinearRgba8() }; }
}
export function colormapFromStops(name: string, stops: readonly ColormapStop[], size = 256): Colormap {
  integer(size, 'colormap size', 1, 1048576);
  if (stops.length < 2) cartographicError('At least two colormap stops are required');
  const values = stops.map(([p, c], i) => {
    finite(p, 'stop position', 0, 1);
    if (i && p <= stops[i - 1]![0]) cartographicError('Stop positions must increase strictly');
    const rgba = typeof c === 'string' ? hexToRgba(c) : color(c.length === 3 ? [...c, 1] : c);
    return { p, c: rgba.map((v, j) => Math.fround(j === 3 ? v : srgbToLinear(v))) };
  });
  const out = new Float32Array(size * 4); let j = 0;
  for (let i = 0; i < size; i++) {
    const t = size === 1 ? 0 : i / (size - 1);
    while (j < values.length - 2 && t > values[j + 1]!.p) j++;
    const a = values[j]!, b = values[j + 1]!, f = Math.max(0, Math.min(1, (t - a.p) / (b.p - a.p)));
    for (let c = 0; c < 4; c++) out[i * 4 + c] = a.c[c]! * (1 - f) + b.c[c]! * f;
  }
  return new Colormap(name, out);
}
export type ColormapProvider = (name: string) => Colormap;
/** Providers adapt application-owned palettes; no Python import or network fallback. */
export class ColormapRegistry {
  #maps = new Map<string, () => Colormap>();
  #providers = new Map<string, ColormapProvider>();
  constructor(builtins = true) { if (builtins) for (const [name, stops] of Object.entries(CORE_COLORMAP_STOPS)) this.register(name, () => colormapFromStops(name, stops)); }
  register(name: string, value: Colormap | (() => Colormap)): void {
    const key = name.toLowerCase(); if (!key.trim() || this.#maps.has(key)) cartographicError(`Colormap already registered or invalid: ${name}`);
    this.#maps.set(key, typeof value === 'function' ? value : () => value);
  }
  registerProvider(name: string, provider: ColormapProvider): void {
    const key = name.toLowerCase(); if (!/^[\w-]+$/.test(key) || this.#providers.has(key)) cartographicError(`Invalid or duplicate provider: ${name}`);
    this.#providers.set(key, provider);
  }
  available(): string[] { return [...this.#maps.keys()].sort(); }
  get(name: string): Colormap {
    const key = name.toLowerCase(), factory = this.#maps.get(key);
    if (factory) return factory();
    const i = key.indexOf(':'), provider = this.#providers.get(key.slice(0, i));
    if (i > 0 && provider) return provider(name.slice(i + 1));
    cartographicError(`Unknown colormap or unavailable provider: ${name}`, 'colormap-unavailable');
  }
}
export const OKABE_ITO: readonly string[] = Object.freeze(['#000000', '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7']);
export const CORE_COLORMAP_STOPS: Readonly<Record<string, readonly ColormapStop[]>> = Object.freeze({
  'forge3d:viridis': [[0, '#440154'], [.13, '#472C7A'], [.25, '#3B518B'], [.38, '#2C718E'], [.5, '#21918C'], [.63, '#2DB27D'], [.75, '#73D055'], [.88, '#DCE319'], [1, '#FDE725']],
  'forge3d:magma': [[0, '#000004'], [.2, '#3B0F70'], [.4, '#8C2981'], [.6, '#DE4968'], [.8, '#FE9F6D'], [1, '#FCFDBF']],
  'forge3d:vik': [[0, '#00224E'], [.25, '#2E6DB4'], [.5, '#F5F5F5'], [.75, '#C14A3B'], [1, '#5A0000']],
});
for (const stops of Object.values(CORE_COLORMAP_STOPS)) { for (const stop of stops) Object.freeze(stop); Object.freeze(stops); }
export const colormaps = new ColormapRegistry();
/** Native utility interpolates encoded RGB bytes (distinct from linear colormap stops). */
export function interpolateHexColors(colors: readonly string[], size: number): string[] {
  integer(size, 'size', 1, 1048576); if (colors.length < 2) return [...colors];
  const rgb = colors.map(hexToRgb);
  return Array.from({ length: size }, (_, i) => {
    const x = size === 1 ? 0 : i / (size - 1) * (rgb.length - 1), a = Math.floor(x), b = Math.min(a + 1, rgb.length - 1), t = x - a;
    return '#' + [0, 1, 2].map(c => Math.floor(rgb[a]![c]! * (1 - t) + rgb[b]![c]! * t + 1e-10).toString(16).padStart(2, '0')).join('');
  });
}
export function elevationStopsFromHexColors(domain: readonly [number, number], colors: readonly string[], options: { heightmap?: ArrayLike<number>; qLo?: number; qHi?: number } = {}): [number, string][] {
  domain.forEach(v => finite(v, 'domain')); colors.forEach(c => hexToRgba(c));
  const lo = finite(options.qLo ?? 0, 'qLo', 0, 1), hi = finite(options.qHi ?? 1, 'qHi', lo, 1);
  const data = options.heightmap ? Array.from(options.heightmap).filter(Number.isFinite).sort((a, b) => a - b) : [];
  if (!data.length && (colors.length === 1 || domain[1] <= domain[0])) return colors.length ? [[domain[0], colors[0]!]] : [];
  return colors.map((c, i) => { const t = colors.length === 1 ? 0 : i / (colors.length - 1), x = (lo + t * (hi - lo)) * (data.length - 1), j = Math.floor(x);
    return [data.length ? data[j]! + (data[Math.min(j + 1, data.length - 1)]! - data[j]!) * (x - j) : domain[0] + t * (domain[1] - domain[0]), c]; });
}
