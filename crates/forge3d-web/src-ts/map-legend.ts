import { Colormap } from './colormaps.js';
import { color, css, finite, integer, checkBytes, cancelled, linearToSrgb, cartographicError, type CartographicColor } from './cartography-common.js';
import { canvas2d, canvasFrame, font, awaitCartographicFonts, drawText, textBox, type CartographicRenderOptions } from './cartography-canvas.js';
import { Frame } from './frames.js';
export interface LegendConfig {
  orientation?: 'vertical' | 'horizontal'; barWidth?: number; barHeight?: number; tickCount?: number; tickLength?: number;
  labelFormat?: string; labelSuffix?: string; fontSize?: number; title?: string; titleFontSize?: number; padding?: number;
  background?: CartographicColor; tickColor?: CartographicColor; labelColor?: CartographicColor;
}
export class Legend {
  readonly colormap: Colormap; readonly domain: readonly [number, number]; readonly config: Readonly<Required<LegendConfig>>;
  constructor(colormap: Colormap | Float32Array, domain: readonly [number, number], config: LegendConfig = {}) {
    domain.forEach(v => finite(v, 'legend domain')); if (domain[1] < domain[0]) cartographicError('Legend domain must increase');
    this.colormap = colormap instanceof Colormap ? colormap : new Colormap('legend', colormap); this.domain = Object.freeze([...domain]) as readonly [number, number];
    const c = { orientation: 'vertical' as const, barWidth: 25, barHeight: 250, tickCount: 5, tickLength: 8, labelFormat: '{:.0f}', labelSuffix: ' m', fontSize: 14, title: '', titleFontSize: 16, padding: 10, background: [1, 1, 1, 0] as CartographicColor, tickColor: [0, 0, 0, 1] as CartographicColor, labelColor: [0, 0, 0, 1] as CartographicColor, ...config };
    for (const k of ['barWidth', 'barHeight', 'fontSize', 'titleFontSize'] as const) integer(c[k], k);
    for (const k of ['tickCount', 'tickLength', 'padding'] as const) integer(c[k], k, 0, 1000);
    if (!['vertical', 'horizontal'].includes(c.orientation) || !/^\{:\.\d{1,2}f\}$/.test(c.labelFormat) || Number(c.labelFormat.slice(3, -2)) > 20) cartographicError('Invalid legend orientation or label format');
    this.config = Object.freeze({ ...c, background: color(c.background), tickColor: color(c.tickColor), labelColor: color(c.labelColor) });
  }
  getTicks(): [number, string][] {
    const c = this.config, digits = Number(/\.(\d+)f/.exec(c.labelFormat)![1]);
    return Array.from({ length: c.tickCount }, (_, i) => { const t = c.tickCount > 1 ? i / (c.tickCount - 1) : .5, v = this.domain[0] + t * (this.domain[1] - this.domain[0]); return [v, v.toFixed(digits) + c.labelSuffix]; });
  }
  /** Exact native nearest-index gradient and linear-to-display conversion. */
  gradient(): Frame {
    const c = this.config, vertical = c.orientation === 'vertical', w = vertical ? c.barWidth : c.barHeight, h = vertical ? c.barHeight : c.barWidth;
    checkBytes(w * h * 12); const data = new Uint8Array(w * h * 4), rgba = this.colormap.rgba;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = c.barHeight === 1 ? 0 : vertical ? 1 - y / (h - 1) : x / (w - 1), index = Math.floor(t * (this.colormap.size - 1)) * 4;
      for (let k = 0; k < 4; k++) data[(y * w + x) * 4 + k] = Math.round((k === 3 ? rgba[index + k]! : linearToSrgb(rgba[index + k]!)) * 255);
    }
    return new Frame(w, h, data);
  }
  async render(options: CartographicRenderOptions = {}): Promise<Frame> {
    const c = this.config, vertical = c.orientation === 'vertical', ticks = this.getTicks();
    cancelled(options.signal); checkBytes(c.barWidth * c.barHeight * 12, options.maxBytes);
    await awaitCartographicFonts(options.signal);
    const measure = canvas2d(1, 1);
    try {
      font(measure.ctx, c.fontSize);
      const labels = ticks.map(([, text]) => textBox(measure.ctx, text));
      const maxLabel = Math.max(0, ...labels.map(b => b.width)), labelH = Math.max(0, ...labels.map(b => b.height));
      font(measure.ctx, c.titleFontSize);
      const titleH = c.title ? textBox(measure.ctx, c.title).height + c.padding : 0;
      const barW = vertical ? c.barWidth : c.barHeight, barH = vertical ? c.barHeight : c.barWidth;
      const width = 2 * c.padding + barW + (vertical ? c.tickLength + c.padding + maxLabel : 0);
      const height = 2 * c.padding + titleH + barH + (vertical ? 0 : c.tickLength + c.padding + labelH);
      checkBytes(width * height * 12 + barW * barH * 8, options.maxBytes); cancelled(options.signal);
      const bar = this.gradient(), { canvas, ctx } = canvas2d(width, height, options.maxBytes);
      try {
        ctx.fillStyle = css(c.background); ctx.fillRect(0, 0, width, height);
        const bx = c.padding, by = c.padding + titleH;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(bar.data), bar.width, bar.height), bx, by);
        font(ctx, c.fontSize); ctx.fillStyle = css(c.labelColor);
        for (let i = 0; i < ticks.length; i++) {
          const t = ticks.length > 1 ? i / (ticks.length - 1) : .5, label = ticks[i]![1], box = labels[i]!;
          // Integer rectangles reproduce Pillow's inclusive, one-pixel tick lines.
          if (vertical) {
            const y = by + Math.floor((1 - t) * (barH - 1));
            ctx.fillStyle = css(c.tickColor); ctx.fillRect(bx + barW, y, c.tickLength + 1, 1);
            ctx.fillStyle = css(c.labelColor); drawText(ctx, label, bx + barW + c.tickLength + Math.floor(c.padding / 2), y - Math.floor(box.height / 2));
          } else {
            // Correct the native horizontal branch's transposed bar_h/bar_w tick coordinates.
            const x = bx + Math.floor(t * (barW - 1));
            ctx.fillStyle = css(c.tickColor); ctx.fillRect(x, by + barH, 1, c.tickLength + 1);
            ctx.fillStyle = css(c.labelColor); drawText(ctx, label, x - Math.floor(box.width / 2), by + barH + c.tickLength + 2);
          }
        }
        if (c.title) { font(ctx, c.titleFontSize); drawText(ctx, c.title, Math.floor((width - textBox(ctx, c.title).width) / 2), Math.floor(c.padding / 2)); }
        cancelled(options.signal); return canvasFrame(canvas, ctx);
      } finally { canvas.width = canvas.height = 1; }
    } finally { measure.canvas.width = measure.canvas.height = 1; }
  }
}
