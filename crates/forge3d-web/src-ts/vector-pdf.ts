import { Forge3DError } from './index.js';
import { readByteSource } from './browser-io.js';
import { cancelled, checkBytes, finite, cartographicError, validateExportFont, type CartographicColor } from './cartography-common.js';
import { project2dToScreen, type ExportPoint, type VectorScene } from './vector-export-scene.js';
import { exportSnapshot, type VectorExportOptions } from './vector-export.js';
import type { BrowserByteSource } from './index.js';
export interface VectorPdfFont { family: string; source: BrowserByteSource }
export interface VectorPdfOptions extends VectorExportOptions {
  /** Raster pixel dimensions are converted to PDF points at this DPI (native wrapper default 300). */
  dpi?: number; fonts?: readonly VectorPdfFont[];
}
/** Deterministic one-page PDF, true even-odd vector paths, embedded Unicode text and stroked halos. */
export async function exportPdf(scene: VectorScene, options: VectorPdfOptions = {}): Promise<Blob> {
  const s = exportSnapshot(scene, options), dpi = finite(options.dpi ?? 300, 'dpi', Number.MIN_VALUE, 9600), scale = 72 / dpi;
  const lib = await import('pdf-lib'); cancelled(options.signal);
  const doc = await lib.PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0)); doc.setModificationDate(new Date(0)); doc.setCreator('Forge3D'); doc.setProducer('Forge3D W20');
  const page = doc.addPage([s.width * scale, s.height * scale]);
  const rgb = (c: CartographicColor) => lib.rgb(c[0], c[1], c[2]);
  const alpha = (fill: number, stroke: number) => lib.setGraphicsState(page.node.newExtGState('GS', doc.context.obj({ Type: 'ExtGState', ca: fill, CA: stroke })));
  const project = (p: ExportPoint): [number, number] => { const [x, y] = project2dToScreen(p, s.bounds, [s.width, s.height]); return [x * scale, (s.height - y) * scale]; };
  if (s.background) page.drawRectangle({ x: 0, y: 0, width: s.width * scale, height: s.height * scale, color: rgb(s.background), opacity: s.background[3] });
  for (const p of s.polygons) {
    cancelled(options.signal); const c = p.style, fill = c.fillColor[3] > .001, stroke = c.strokeWidth > 0 && c.strokeColor[3] > .001;
    page.pushOperators(lib.pushGraphicsState(), alpha(c.fillColor[3], c.strokeColor[3]), lib.setFillingColor(rgb(c.fillColor)), lib.setStrokingColor(rgb(c.strokeColor)), lib.setLineWidth(c.strokeWidth * scale), lib.setLineJoin(lib.LineJoinStyle.Round));
    for (const ring of [p.exterior, ...p.holes]) { page.pushOperators(lib.moveTo(...project(ring[0]!))); for (const v of ring.slice(1)) page.pushOperators(lib.lineTo(...project(v))); page.pushOperators(lib.closePath()); }
    page.pushOperators(fill ? lib.PDFOperator.of(stroke ? lib.PDFOperatorNames.FillEvenOddAndStroke : lib.PDFOperatorNames.FillEvenOdd) : stroke ? lib.stroke() : lib.endPath(), lib.popGraphicsState());
  }
  for (const l of s.polylines) {
    cancelled(options.signal); const c = l.style;
    page.pushOperators(lib.pushGraphicsState(), alpha(0, c.strokeColor[3]), lib.setStrokingColor(rgb(c.strokeColor)), lib.setLineWidth(c.strokeWidth * scale), lib.setLineJoin(lib.LineJoinStyle.Round), lib.setLineCap(lib.LineCapStyle.Round), lib.moveTo(...project(l.path[0]!)));
    for (const v of l.path.slice(1)) page.pushOperators(lib.lineTo(...project(v))); page.pushOperators(lib.stroke(), lib.popGraphicsState());
  }
  const fonts = new Map<string, import('pdf-lib').PDFFont>(); let fontBytes = 0;
  if (s.labels.length) {
    const kit = await import('@pdf-lib/fontkit'); doc.registerFontkit('default' in kit ? kit.default as typeof kit : kit);
    const defaults: VectorPdfFont[] = ['NotoSans', 'NotoSansArabic', 'NotoSansDevanagari'].map(family => ({ family, source: new URL('../assets/fonts/' + family + '-Regular.ttf', import.meta.url) }));
    const sources = [...(options.fonts ?? []), ...defaults];
    const getFont = async (family: string) => {
      if (fonts.has(family)) return fonts.get(family)!;
      const source = sources.find(f => f.family === family); if (!source) cartographicError(`PDF font family is unavailable: ${family}`, 'font-unavailable');
      const bytes = await readByteSource(source.source, { maxBytes: Math.min(options.maxBytes ?? 128 * 1024 * 1024, 16 * 1024 * 1024), ...(options.signal ? { signal: options.signal } : {}) });
      fontBytes += bytes.length; checkBytes(scene.getMemoryReport().cpuBytes * 8 + fontBytes * 4, options.maxBytes);
      validateExportFont(bytes);
      let font: import('pdf-lib').PDFFont;
      try { font = await doc.embedFont(bytes, { subset: true }); } catch (e) { throw new Forge3DError('INVALID_INPUT', `Invalid PDF font: ${String(e)}`, { reason: 'invalid-font' }); }
      fonts.set(family, font); return font;
    };
    for (const label of s.labels) {
      cancelled(options.signal); const c = label.style;
      let family = ['sans-serif', 'Arial', 'DejaVu Sans'].includes(c.fontFamily) ? 'NotoSans' : c.fontFamily;
      if (family === 'NotoSans' && /[\u0600-\u06ff]/u.test(label.text)) family = 'NotoSansArabic';
      if (family === 'NotoSans' && /[\u0900-\u097f]/u.test(label.text)) family = 'NotoSansDevanagari';
      const font = await getFont(family), charset = new Set(font.getCharacterSet());
      const missing = [...label.text].filter(c => !charset.has(c.codePointAt(0)!)); if (missing.length) cartographicError(`PDF font lacks glyphs: ${missing.join('')}`, 'missing-glyph');
      const size = c.fontSize * scale, [px, py] = project(label.position), x = px - font.widthOfTextAtSize(label.text, size) / 2, y = py - font.heightAtSize(size, { descender: false }) / 2;
      const bold = c.fontWeight === 'bold' || Number(c.fontWeight) >= 600;
      if (!['normal', 'bold', '400', '500', '600', '700', '800', '900'].includes(c.fontWeight)) cartographicError('Unsupported PDF font weight');
      if (c.haloWidth && c.haloColor[3] > .001) {
        page.pushOperators(lib.pushGraphicsState(), alpha(c.haloColor[3], c.haloColor[3]), lib.setStrokingColor(rgb(c.haloColor)), lib.setLineWidth(c.haloWidth * 2 * scale), lib.setLineJoin(lib.LineJoinStyle.Round), lib.setTextRenderingMode(lib.TextRenderingMode.FillAndOutline));
        page.drawText(label.text, { x, y, size, font, color: rgb(c.haloColor) }); page.pushOperators(lib.popGraphicsState());
      }
      page.pushOperators(lib.pushGraphicsState(), alpha(c.color[3], c.color[3]), ...(bold ? [lib.setStrokingColor(rgb(c.color)), lib.setLineWidth(size * .025), lib.setTextRenderingMode(lib.TextRenderingMode.FillAndOutline)] : [lib.setTextRenderingMode(lib.TextRenderingMode.Fill)]));
      page.drawText(label.text, { x, y, size, font, color: rgb(c.color), opacity: c.color[3] }); page.pushOperators(lib.popGraphicsState());
    }
  }
  cancelled(options.signal); const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false, objectsPerTick: 50 }); cancelled(options.signal); checkBytes(bytes.length + fontBytes, options.maxBytes);
  return new Blob([bytes.slice().buffer], { type: 'application/pdf' });
}
