import { cartographicError, color, css, finite, integer, type CartographicColor } from './cartography-common.js';
import { font, renderFurniture, type PlateContext } from './cartography-canvas.js';
import type { Frame } from './frames.js';
export interface NorthArrowConfig {
  style?: 'arrow' | 'compass' | 'simple'; size?: number; rotationDeg?: number; color?: CartographicColor; background?: CartographicColor; showNLabel?: boolean; fontSize?: number; borderWidth?: number; borderColor?: CartographicColor;
}
export class NorthArrow {
  readonly config: Readonly<Required<NorthArrowConfig>>;
  constructor(config: NorthArrowConfig = {}) {
    const c = { style: 'arrow' as const, size: 60, rotationDeg: 0, color: [0, 0, 0, 1] as CartographicColor, background: [1, 1, 1, 200 / 255] as CartographicColor, showNLabel: true, fontSize: 14, borderWidth: 1, borderColor: [0, 0, 0, 1] as CartographicColor, ...config };
    integer(c.size, 'size', 32); integer(c.fontSize, 'fontSize'); finite(c.rotationDeg, 'rotationDeg'); finite(c.borderWidth, 'borderWidth', 0, c.size / 2);
    if (!['arrow', 'compass', 'simple'].includes(c.style)) cartographicError('Unknown north arrow style');
    this.config = Object.freeze({ ...c, color: color(c.color), background: color(c.background), borderColor: color(c.borderColor) });
  }
  /** North tip, in local image pixels, after clockwise rotation. */
  tip(): [number, number] { const c = this.config, mid = Math.floor((c.size + 16) / 2), len = Math.floor(c.size / 2) - (c.style === 'compass' ? 12 : 8), a = c.rotationDeg * Math.PI / 180; return [mid + len * Math.sin(a), mid - len * Math.cos(a)]; }
  render(): Promise<Frame> {
    const c = this.config, total = c.size + 16, mid = Math.floor(total / 2), angle = c.rotationDeg * Math.PI / 180;
    return renderFurniture(total, total, ctx => {
      ctx.fillStyle = css(c.background); ctx.beginPath(); ctx.ellipse(total / 2, total / 2, total / 2 - 4, total / 2 - 4, 0, 0, Math.PI * 2); ctx.fill();
      if (c.borderWidth) { ctx.strokeStyle = css(c.borderColor); ctx.lineWidth = c.borderWidth; ctx.stroke(); }
      const point = (len: number, a = angle): [number, number] => [mid + len * Math.sin(a), mid - len * Math.cos(a)];
      const poly = (points: [number, number][], fill: CartographicColor, outline = false) => { ctx.beginPath(); ctx.moveTo(...points[0]!); points.slice(1).forEach(p => ctx.lineTo(...p)); ctx.closePath(); ctx.fillStyle = css(fill); ctx.fill(); if (outline) { ctx.strokeStyle = css(c.color); ctx.lineWidth = 1; ctx.stroke(); } };
      const line = (a: [number, number], b: [number, number], width: number) => { ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.strokeStyle = css(c.color); ctx.lineWidth = width; ctx.stroke(); };
      const len = Math.floor(c.size / 2) - 8, tip = point(len);
      if (c.style === 'arrow') {
        const w = Math.floor(c.size / 6), dist = Math.hypot(len, w) * .4;
        poly([tip, [mid, mid], point(dist, angle + Math.PI + Math.atan2(w, len))], c.color);
        poly([tip, [mid, mid], point(dist, angle + Math.PI - Math.atan2(w, len))], c.background, true); line([mid, mid], point(-len * .6), 2);
      } else if (c.style === 'compass') {
        for (let i = 0; i < 4; i++) { const a = angle + i * Math.PI / 2; poly([point(Math.floor(c.size / 2) - 12, a), point(6, a + Math.PI / 2), point(-6, a + Math.PI / 2)], c.color); }
      } else { line(point(-len * .5), tip, 3); poly([tip, [tip[0] - 10 * Math.sin(angle - Math.PI / 6), tip[1] + 10 * Math.cos(angle - Math.PI / 6)], [tip[0] - 10 * Math.sin(angle + Math.PI / 6), tip[1] + 10 * Math.cos(angle + Math.PI / 6)]], c.color); }
      if (c.showNLabel) { font(ctx, c.fontSize); const p = point(Math.floor(c.size / 2) - 2); ctx.fillStyle = css(c.color); ctx.fillText('N', p[0] - ctx.measureText('N').width / 2, p[1] - c.fontSize / 2 - 2); }
    });
  }
}
