import { BBox } from './map-layout.js';
import { cartographicError, color, css, finite, integer, type CartographicColor } from './cartography-common.js';
import { canvas2d, canvasFrame, font, loadCartographicFonts } from './cartography-canvas.js';
import type { Frame } from './frames.js';
export interface ScaleBarConfig {
  units?: 'm' | 'km' | 'mi' | 'ft'; style?: 'simple' | 'alternating'; widthPx?: number; heightPx?: number; divisions?: number; fontSize?: number; padding?: number; barHeight?: number;
  background?: CartographicColor; barColor1?: CartographicColor; barColor2?: CartographicColor; labelColor?: CartographicColor; borderColor?: CartographicColor;
}
export interface ScaleBarMetrics { distanceMeters: number; displayDistance: number; actualBarPx: number; label: string }
const FACTORS = { m: 1, km: .001, mi: .000621371, ft: 3.28084 };
const INTERVALS = [.001, .002, .005, .01, .02, .05, .1, .2, .5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
export class ScaleBar {
  readonly config: Readonly<Required<ScaleBarConfig>>;
  constructor(readonly metersPerPixel: number, config: ScaleBarConfig = {}) {
    finite(metersPerPixel, 'metersPerPixel', Number.MIN_VALUE);
    const c = { units: 'km' as const, style: 'alternating' as const, widthPx: 180, heightPx: 25, divisions: 4, fontSize: 12, padding: 8, barHeight: 8, background: [1, 1, 1, 200 / 255] as CartographicColor, barColor1: [0, 0, 0, 1] as CartographicColor, barColor2: [1, 1, 1, 1] as CartographicColor, labelColor: [0, 0, 0, 1] as CartographicColor, borderColor: [0, 0, 0, 1] as CartographicColor, ...config };
    for (const k of ['widthPx', 'heightPx', 'divisions', 'fontSize', 'barHeight'] as const) integer(c[k], k);
    integer(c.padding, 'padding', 0); if (c.widthPx <= 2 * c.padding || !Object.hasOwn(FACTORS, c.units) || !['simple', 'alternating'].includes(c.style)) cartographicError('Invalid scale bar configuration');
    this.config = Object.freeze({ ...c, background: color(c.background), barColor1: color(c.barColor1), barColor2: color(c.barColor2), labelColor: color(c.labelColor), borderColor: color(c.borderColor) });
  }
  /** Native WGS84 longitude approximation. Projected bounds require an explicit metres-per-unit. */
  static computeMetersPerPixel(bbox: BBox, imageWidth: number, metersPerUnit?: number): number {
    integer(imageWidth, 'imageWidth');
    if (metersPerUnit !== undefined) return finite(bbox.width * finite(metersPerUnit, 'metersPerUnit', Number.MIN_VALUE) / imageWidth, 'metersPerPixel', Number.MIN_VALUE);
    if (!['EPSG:4326', 'OGC:CRS84', 'CRS84'].includes(bbox.crs.toUpperCase())) cartographicError('Projected bounds require metersPerUnit', 'scale-crs-units-required');
    finite(bbox.south, 'south', -90, 90); finite(bbox.north, 'north', -90, 90);
    return bbox.width * 111320 * Math.cos(bbox.centerLat * Math.PI / 180) / imageWidth;
  }
  metrics(): ScaleBarMetrics {
    const c = this.config, factor = FACTORS[c.units], max = finite((c.widthPx - 2 * c.padding) * this.metersPerPixel * factor, 'scale maximum distance', Number.MIN_VALUE);
    // Extend the native interval table below its minimum so the bar never lies about distance.
    let nice = INTERVALS[0]!; for (const value of INTERVALS) { if (value > max) break; nice = value; }
    if (nice > max) { const power = 10 ** Math.floor(Math.log10(max)); nice = [5, 2, 1].map(v => v * power).find(v => v <= max)!; }
    const meters = nice / factor, pixels = Math.min(c.widthPx - 2 * c.padding, Math.floor(meters / this.metersPerPixel + 1e-10));
    const label = `${nice >= 1 ? Math.floor(nice) : nice >= .1 ? nice.toFixed(1) : Number(nice.toPrecision(3))} ${c.units}`;
    return { distanceMeters: meters, displayDistance: nice, actualBarPx: pixels, label };
  }
  async render(): Promise<Frame> {
    await loadCartographicFonts(); const c = this.config, m = this.metrics(), measure = canvas2d(1, 1); font(measure.ctx, c.fontSize);
    const labelWidth = Math.ceil(measure.ctx.measureText(m.label).width), width = Math.max(m.actualBarPx, labelWidth) + 2 * c.padding, height = c.padding * 2 + c.barHeight + 4 + c.fontSize;
    const { canvas, ctx } = canvas2d(width, height); ctx.fillStyle = css(c.background); ctx.fillRect(0, 0, width, height);
    const x = c.padding + Math.floor((width - 2 * c.padding - m.actualBarPx) / 2), y = c.padding, divisions = c.style === 'alternating' ? c.divisions : 1;
    for (let i = 0; i < divisions; i++) { const a = Math.floor(i * m.actualBarPx / divisions), b = Math.floor((i + 1) * m.actualBarPx / divisions); ctx.fillStyle = css(i % 2 ? c.barColor2 : c.barColor1); ctx.fillRect(x + a, y, b - a, c.barHeight); }
    ctx.strokeStyle = css(c.borderColor); ctx.strokeRect(x + .5, y + .5, m.actualBarPx - 1, c.barHeight - 1);
    font(ctx, c.fontSize); ctx.fillStyle = css(c.labelColor); ctx.fillText(m.label, (width - labelWidth) / 2, y + c.barHeight + 4);
    try { return canvasFrame(canvas, ctx); } finally { canvas.width = canvas.height = measure.canvas.width = measure.canvas.height = 1; }
  }
}
