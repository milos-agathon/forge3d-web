import { Forge3DError } from "./runtime-failure.js";
import { cartographicError, checkBytes, color, finite, type CartographicColor } from './cartography-common.js';
import type { LabelPlanData } from './label-types.js';
import type { VectorLayerInput } from './vector-types.js';
export type ExportPoint = readonly [number, number];
export interface ExportVectorStyle { fillColor?: CartographicColor; strokeColor?: CartographicColor; strokeWidth?: number }
export interface ExportLabelStyle { fontSize?: number; color?: CartographicColor; haloColor?: CartographicColor; haloWidth?: number; fontFamily?: string; fontWeight?: string }
export interface ExportPolygon { exterior: ExportPoint[]; holes: ExportPoint[][]; style: Required<ExportVectorStyle> }
export interface ExportPolyline { path: ExportPoint[]; style: Required<ExportVectorStyle> }
export interface ExportScreenLabel { text: string; screenPosition?: ExportPoint | null; visible?: boolean; style?: ExportLabelStyle }
export interface ExportLabel { text: string; position: ExportPoint; style: Required<ExportLabelStyle> }
function point(p: ExportPoint): [number, number] { if (p.length !== 2) cartographicError('Expected a 2D point'); return [finite(p[0], 'x'), finite(p[1], 'y')]; }
function points(p: readonly ExportPoint[], min: number): ExportPoint[] { if (p.length < min) cartographicError(`Geometry requires at least ${min} points`); return p.map(point); }
function style(s: ExportVectorStyle): Required<ExportVectorStyle> { return { fillColor: color(s.fillColor ?? [.2, .4, .8, 1]), strokeColor: color(s.strokeColor ?? [0, 0, 0, 1]), strokeWidth: finite(s.strokeWidth ?? 1, 'strokeWidth', 0, 10000) }; }
export class Bounds {
  constructor(public minX = 0, public minY = 0, public maxX = 100, public maxY = 100) { this.validate(); }
  validate(): void { [this.minX, this.minY, this.maxX, this.maxY].forEach(v => finite(v, 'bounds')); if (this.maxX < this.minX || this.maxY < this.minY) cartographicError('Bounds must be ordered'); }
  get width(): number { return this.maxX - this.minX; } get height(): number { return this.maxY - this.minY; }
  get center(): ExportPoint { return [(this.minX + this.maxX) / 2, (this.minY + this.maxY) / 2]; }
  expandToInclude(p: ExportPoint): void { const [x, y] = point(p); this.minX = Math.min(this.minX, x); this.minY = Math.min(this.minY, y); this.maxX = Math.max(this.maxX, x); this.maxY = Math.max(this.maxY, y); }
  withPadding(padding: number): Bounds { finite(padding, 'padding', 0); return new Bounds(this.minX - padding, this.minY - padding, this.maxX + padding, this.maxY + padding); }
  static fromPoints(p: readonly ExportPoint[]): Bounds | null { if (!p.length) return null; const [x, y] = point(p[0]!), b = new Bounds(x, y, x, y); p.slice(1).forEach(v => b.expandToInclude(v)); return b; }
}
/** Native bounds-to-viewport convention, including degenerate-range fallback and Y flip. */
export function project2dToScreen(p: ExportPoint, bounds: Bounds, viewport: ExportPoint): [number, number] {
  point(p); bounds.validate(); viewport.forEach(v => finite(v, 'viewport', Number.MIN_VALUE));
  return [(p[0] - bounds.minX) / (bounds.width > 1e-10 ? bounds.width : 1) * viewport[0], (1 - (p[1] - bounds.minY) / (bounds.height > 1e-10 ? bounds.height : 1)) * viewport[1]];
}
/** Column-major matrix; offscreen points extrapolate, w<=0 is rejected. */
export function project3dTo2d(p: readonly [number, number, number], matrix: ArrayLike<number>, viewport: ExportPoint): [number, number] | null {
  if (matrix.length !== 16) cartographicError('viewProjection must have 16 elements'); Array.from(matrix).forEach(v => finite(v, 'matrix')); p.forEach(v => finite(v, 'point')); viewport.forEach(v => finite(v, 'viewport', Number.MIN_VALUE));
  const v = [p[0], p[1], p[2], 1], out = [0, 1, 2, 3].map(row => v.reduce((n, c, i) => n + c * matrix[i * 4 + row]!, 0));
  if (out[3]! <= 0) return null; return [(out[0]! / out[3]! + 1) * viewport[0] / 2, (1 - out[1]! / out[3]!) * viewport[1] / 2];
}
export class VectorScene {
  #polygons: ExportPolygon[] = []; #polylines: ExportPolyline[] = []; #labels: ExportLabel[] = []; #bytes = 0; #disposed = false;
  constructor(readonly maxBytes = 128 * 1024 * 1024) { checkBytes(0, maxBytes); }
  #live(): void { if (this.#disposed) throw new Forge3DError('RUNTIME_DISPOSED', 'VectorScene is disposed'); }
  #admit(bytes: number): void { this.#live(); checkBytes(this.#bytes + bytes, this.maxBytes); this.#bytes += bytes; }
  get polygons(): ExportPolygon[] { this.#live(); return structuredClone(this.#polygons); }
  get polylines(): ExportPolyline[] { this.#live(); return structuredClone(this.#polylines); }
  get labels(): ExportLabel[] { this.#live(); return structuredClone(this.#labels); }
  addPolygon(exterior: readonly ExportPoint[], options: ExportVectorStyle & { holes?: readonly (readonly ExportPoint[])[] } = {}): this {
    this.#live(); checkBytes(this.#bytes + (exterior.length + (options.holes ?? []).reduce((n, h) => n + h.length, 0)) * 16 + 72, this.maxBytes); const polygon = { exterior: points(exterior, 3), holes: (options.holes ?? []).map(p => points(p, 3)), style: style(options) };
    this.#admit((polygon.exterior.length + polygon.holes.reduce((n, h) => n + h.length, 0)) * 16 + 72); this.#polygons.push(polygon); return this;
  }
  addPolyline(path: readonly ExportPoint[], options: ExportVectorStyle = {}): this { this.#live(); checkBytes(this.#bytes + path.length * 16 + 72, this.maxBytes); const line = { path: points(path, 2), style: style(options) }; this.#admit(line.path.length * 16 + 72); this.#polylines.push(line); return this; }
  addLabel(text: string, position: ExportPoint, options: ExportLabelStyle = {}): this {
    this.#live(); if (typeof text !== 'string') cartographicError('Label text must be a string'); checkBytes(this.#bytes + text.length * 2 + 128, this.maxBytes); const label: ExportLabel = { text, position: point(position), style: { fontSize: finite(options.fontSize ?? 14, 'fontSize', Number.MIN_VALUE, 10000), color: color(options.color ?? [.1, .1, .1, 1]), haloColor: color(options.haloColor ?? [1, 1, 1, .8]), haloWidth: finite(options.haloWidth ?? 1.5, 'haloWidth', 0, 1000), fontFamily: options.fontFamily ?? 'sans-serif', fontWeight: options.fontWeight ?? 'normal' } };
    if (/[\r\n]/.test(text)) cartographicError('Export labels must be single-line'); this.#admit(text.length * 2 + 128); this.#labels.push(label); return this;
  }
  computeBounds(padding = 0): Bounds { this.#live(); const all = [...this.#polygons.flatMap(p => [p.exterior, ...p.holes].flat()), ...this.#polylines.flatMap(p => p.path), ...this.#labels.map(l => l.position)]; return (Bounds.fromPoints(all) ?? new Bounds()).withPadding(padding); }
  /** Native projected-label adapter. Hidden labels and points behind the camera are omitted. */
  addScreenLabels(labels: readonly ExportScreenLabel[], viewportHeight: number): this {
    this.#live(); finite(viewportHeight, 'viewportHeight', Number.MIN_VALUE);
    for (const label of labels) if (label.visible !== false && label.screenPosition != null) {
      const [x, y] = point(label.screenPosition); this.addLabel(label.text, [x, viewportHeight - y], label.style);
    }
    return this;
  }
  /** Accepted W13 labels are already in screen space. Bounds must match this viewport with Y reversed. */
  addLabelPlan(plan: LabelPlanData, viewportHeight: number, options: ExportLabelStyle = {}): this {
    finite(viewportHeight, 'viewportHeight', Number.MIN_VALUE);
    for (const l of plan.accepted) { const r = l.screen_bounds; this.addLabel(l.text, [(r[0] + r[2]) / 2, viewportHeight - (r[1] + r[3]) / 2], { ...options, fontSize: typeof l.typography.font_size === 'number' ? l.typography.font_size : options.fontSize ?? 14 }); } return this;
  }
  getMemoryReport(): { cpuBytes: number; disposed: boolean } { return { cpuBytes: this.#bytes, disposed: this.#disposed }; }
  clear(): void { this.#live(); this.#polygons = []; this.#polylines = []; this.#labels = []; this.#bytes = 0; }
  dispose(): void { this.#polygons = []; this.#polylines = []; this.#labels = []; this.#bytes = 0; this.#disposed = true; }
}
/** W12 world X/Z geometry adapter. Hidden layers are omitted and zOrder is stable. */
export function vectorSceneFromLayers(layers: readonly VectorLayerInput[]): VectorScene {
  const scene = new VectorScene();
  try { for (const layer of layers.filter(l => l.visible !== false).sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0))) for (const f of layer.features) {
    const s = { ...layer.style, ...f.style }, c = s.color ?? [1, 1, 1, 1], rgba: CartographicColor = [c[0], c[1], c[2], c[3] * (s.opacity ?? 1)], style = { fillColor: rgba, strokeColor: rgba, strokeWidth: s.lineWidth ?? 1 };
    if (f.kind === 'polygon') scene.addPolygon(f.rings[0]!.map(p => [p[0], p[2]]), { ...style, holes: f.rings.slice(1).map(r => r.map(p => [p[0], p[2]] as ExportPoint)) });
    else if (f.kind === 'line') scene.addPolyline(f.positions.map(p => [p[0], p[2]]), style);
    else { const [x, , z] = f.position, r = (s.pointSize ?? 1) / 2; scene.addPolygon([[x - r, z - r], [x + r, z - r], [x + r, z + r], [x - r, z + r]], style); }
  } return scene; } catch (e) { scene.dispose(); throw e; }
}
