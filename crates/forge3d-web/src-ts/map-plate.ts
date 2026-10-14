import { Forge3DError } from './index.js';
import { Frame } from './frames.js';
import { BBox, PlateRegion, fitPlateImage, positionPlateElement, type MapPlateConfig, type PlateLayout, type PositionAnchor } from './map-layout.js';
import { CARTOGRAPHY_MAX_BYTES, cancelled, checkBytes, color, css, finite, integer, cartographicError, type CartographicColor } from './cartography-common.js';
import { canvas2d, canvasBlob, canvasFrame, copyPlateImage, font, drawText, textBox, imageCanvas, awaitCartographicFonts, type PlateImage } from './cartography-canvas.js';

export interface PlateTitleOptions { position?: PositionAnchor; fontSize?: number; color?: CartographicColor }
export interface PlateInsetOptions { position?: PositionAnchor; size?: readonly [number, number]; borderWidth?: number; borderColor?: CartographicColor }
interface ImageElement { kind: string; image: Frame; position: PositionAnchor; margin: number; size?: readonly [number, number]; borderWidth: number; borderColor: CartographicColor }
/** Canvas/OffscreenCanvas composition. Owns copies of input pixels; no GPU/session ownership. */
export class MapPlate {
  readonly config: Readonly<Required<MapPlateConfig>>;
  #map: Frame | undefined; #bbox: BBox | undefined;
  #title: { text: string; position: PositionAnchor; fontSize: number; color: CartographicColor } | undefined;
  #elements: ImageElement[] = [];
  #disposed = false; #busy = false; #workingBytes = 0; #peakBytes = 0;
  constructor(config: MapPlateConfig = {}) {
    const c = { width: 1600, height: 1000, margin: [60, 200, 80, 40] as readonly [number, number, number, number], background: [1, 1, 1, 1] as CartographicColor, dpi: 150, maxBytes: CARTOGRAPHY_MAX_BYTES, ...config };
    integer(c.width, 'width'); integer(c.height, 'height'); finite(c.dpi, 'dpi', Number.MIN_VALUE, 9600);
    if (c.margin.length !== 4) cartographicError('margin must be [top,right,bottom,left]'); c.margin.forEach(v => integer(v, 'margin', 0));
    checkBytes(c.width * c.height * 12, c.maxBytes);
    this.config = Object.freeze({ ...c, margin: Object.freeze([...c.margin]) as readonly [number, number, number, number], background: Object.freeze(color(c.background)) });
  }
  #live(mutation = false): void {
    if (this.#disposed) throw new Forge3DError('RUNTIME_DISPOSED', 'MapPlate is disposed');
    if (mutation && this.#busy) cartographicError('MapPlate operation already in progress');
  }
  get disposed(): boolean { return this.#disposed; }
  get bbox(): BBox | undefined { return this.#bbox; }
  getMemoryReport(): { cpuBytes: number; workingBytes: number; peakBytes: number; imageCount: number; disposed: boolean } {
    return { cpuBytes: (this.#map?.data.byteLength ?? 0) + this.#elements.reduce((n, e) => n + e.image.data.byteLength, 0) + (this.#title?.text.length ?? 0) * 2, workingBytes: this.#workingBytes, peakBytes: this.#peakBytes, imageCount: this.#elements.length + Number(!!this.#map), disposed: this.#disposed };
  }
  #admit(extra: number): void { const total = this.getMemoryReport().cpuBytes + extra + this.config.width * this.config.height * 12; checkBytes(total, this.config.maxBytes); this.#peakBytes = Math.max(this.#peakBytes, total); }
  setMapRegion(image: PlateImage, bbox: BBox): this {
    this.#live(true); if (this.mapRegion().width <= 0 || this.mapRegion().height <= 0) cartographicError('Margins leave no map region');
    this.#admit(image.width * image.height * 8);
    this.#map = copyPlateImage(image, this.config.maxBytes); this.#bbox = new BBox(bbox.west, bbox.south, bbox.east, bbox.north, bbox.crs); return this;
  }
  addTitle(text: string, options: PlateTitleOptions = {}): this {
    this.#live(true); const size = integer(options.fontSize ?? 24, 'fontSize', 1, 1000), position = options.position ?? 'top'; positionPlateElement([0, 0], position, this.mapRegion());
    if (typeof text !== 'string') cartographicError('Title must be a string'); this.#admit(text.length * 2);
    this.#title = { text, fontSize: size, color: color(options.color ?? [0, 0, 0, 1]), position }; return this;
  }
  #add(kind: string, image: PlateImage, position: PositionAnchor, margin: number, options: PlateInsetOptions = {}): this {
    this.#live(true); positionPlateElement([image.width, image.height], position, this.mapRegion());
    if (options.size && options.size.length !== 2) cartographicError('Inset size must be [width,height]'); options.size?.forEach(v => integer(v, 'inset size')); const borderWidth = finite(options.borderWidth ?? 0, 'borderWidth', 0, 1000), borderColor = color(options.borderColor ?? [0, 0, 0, 1]);
    const old = kind === 'inset' ? undefined : this.#elements.find(e => e.kind === kind);
    this.#admit(image.width * image.height * 8);
    const element: ImageElement = { kind, image: copyPlateImage(image, this.config.maxBytes), position, margin, borderWidth, borderColor, ...(options.size ? { size: [...options.size] } : {}) };
    this.#elements = this.#elements.filter(e => e !== old); this.#elements.push(element); return this;
  }
  addLegend(image: PlateImage, position: PositionAnchor = 'right'): this { return this.#add('legend', image, position, 5); }
  addScaleBar(image: PlateImage, position: PositionAnchor = 'bottom-left'): this { return this.#add('scale-bar', image, position, 20); }
  addNorthArrow(image: PlateImage, position: PositionAnchor = 'top-right'): this { return this.#add('north-arrow', image, position, 15); }
  addInset(image: PlateImage, options: PlateInsetOptions = {}): this { return this.#add('inset', image, options.position ?? 'bottom-right', 15, { ...options, borderWidth: options.borderWidth ?? 2 }); }
  #orderedElements(): ImageElement[] { return ['legend', 'scale-bar', 'north-arrow', 'inset'].flatMap(kind => this.#elements.filter(e => e.kind === kind)); }
  mapRegion(): PlateRegion { const c = this.config, [t, r, b, l] = c.margin; return new PlateRegion(l, t, c.width - r, c.height - b); }
  /** Floor-rounded native placement. Includes the actual letterboxed map rectangle. */
  async layout(options: { signal?: AbortSignal } = {}): Promise<PlateLayout> {
    this.#live(); cancelled(options.signal); const c = this.config, region = this.mapRegion(), elements: PlateLayout['elements'] = [];
    if (this.#title) { await awaitCartographicFonts(options.signal); this.#live(); const { canvas, ctx } = canvas2d(1, 1); font(ctx, this.#title.fontSize);
      const w = textBox(ctx, this.#title.text).width + 20, h = textBox(ctx, this.#title.text).height + 20, [x, y] = positionPlateElement([w, h], this.#title.position, new PlateRegion(0, 0, c.width, c.height), 15);
      canvas.width = canvas.height = 1; elements.push({ kind: 'title', rect: new PlateRegion(x, y, x + w, y + h) });
    }
    for (const e of this.#orderedElements()) {
      const w = e.size?.[0] ?? e.image.width, h = e.size?.[1] ?? e.image.height;
      const target = e.kind === 'legend' && e.position === 'right' ? new PlateRegion(c.width - c.margin[1], c.margin[0], c.width - 10, c.height - c.margin[2]) : region;
      const [x, y] = positionPlateElement([w, h], e.kind === 'legend' && e.position === 'right' ? 'center' : e.position, target, e.margin);
      elements.push({ kind: e.kind, rect: new PlateRegion(x, y, x + w, y + h) });
    }
    return { mapRegion: region, mapImage: this.#map ? fitPlateImage(this.#map.width, this.#map.height, region) : null, elements };
  }
  async #compose<T>(output: (canvas: ReturnType<typeof canvas2d>['canvas'], ctx: ReturnType<typeof canvas2d>['ctx']) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    this.#live(true); this.#busy = true;
    try {
      cancelled(signal); const layout = await this.layout(signal ? { signal } : {}); this.#live(); cancelled(signal);
      const temporary = Math.max(this.#map?.data.byteLength ?? 0, ...this.#elements.map(e => e.image.data.byteLength), ...layout.elements.filter(e => e.kind === 'title').map(e => e.rect.width * e.rect.height * 4), 0) * 2;
      this.#admit(temporary); this.#workingBytes = this.config.width * this.config.height * 12 + temporary;
      const { canvas, ctx } = canvas2d(this.config.width, this.config.height, this.config.maxBytes);
      try {
        ctx.fillStyle = css(this.config.background); ctx.fillRect(0, 0, canvas.width, canvas.height);
        const blit = (image: Frame, r: PlateRegion) => { const source = imageCanvas(image); try { ctx.drawImage(source, r.x0, r.y0, r.width, r.height); } finally { source.width = source.height = 1; } };
        if (this.#map && layout.mapImage) blit(this.#map, layout.mapImage);
        const title = layout.elements.find(e => e.kind === 'title');
        if (this.#title && title) {
          const layer = canvas2d(title.rect.width, title.rect.height, this.config.maxBytes);
          try { font(layer.ctx, this.#title.fontSize); layer.ctx.fillStyle = css(this.#title.color); drawText(layer.ctx, this.#title.text, 10, 10); ctx.drawImage(layer.canvas, title.rect.x0, title.rect.y0); }
          finally { layer.canvas.width = layer.canvas.height = 1; }
        }
        let offset = title ? 1 : 0;
        for (const e of this.#orderedElements()) { const r = layout.elements[offset++]!.rect;
          if (e.borderWidth) { ctx.fillStyle = css(e.borderColor); ctx.fillRect(r.x0 - e.borderWidth, r.y0 - e.borderWidth, r.width + e.borderWidth * 2, r.height + e.borderWidth * 2); } blit(e.image, r);
        }
        cancelled(signal); const result = await output(canvas, ctx); this.#live(); cancelled(signal); return result;
      } finally { canvas.width = canvas.height = 1; }
    } finally { this.#busy = false; this.#workingBytes = 0; }
  }
  compose(options: { signal?: AbortSignal } = {}): Promise<Frame> { return this.#compose((canvas, ctx) => canvasFrame(canvas, ctx), options.signal); }
  exportPng(options: { signal?: AbortSignal } = {}): Promise<Blob> { return this.#compose(canvas => canvasBlob(canvas, 'image/png'), options.signal); }
  exportJpeg(options: { quality?: number; signal?: AbortSignal } = {}): Promise<Blob> { const quality = finite(options.quality ?? .9, 'JPEG quality', 0, 1); return this.#compose(canvas => canvasBlob(canvas, 'image/jpeg', quality), options.signal); }
  clear(): void { this.#live(true); this.#map = undefined; this.#bbox = undefined; this.#title = undefined; this.#elements = []; }
  dispose(): void { this.#disposed = true; this.#map = undefined; this.#bbox = undefined; this.#title = undefined; this.#elements = []; }
}
