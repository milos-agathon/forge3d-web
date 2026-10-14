import { cartographicError, cancelled, checkBytes, color, css, integer, xml, validateExportFont, type CartographicColor } from './cartography-common.js';
import { Bounds, VectorScene, project2dToScreen, type ExportPoint } from './vector-export-scene.js';
import { readByteSource } from './browser-io.js';
import type { BrowserByteSource } from './index.js';
import { exportFontSource } from './cartography-fonts.js';
export interface VectorExportFont { family: string; source: BrowserByteSource }
export interface VectorExportOptions {
  width?: number; height?: number; bounds?: Bounds; background?: CartographicColor; precision?: number; includeLabels?: boolean; maxBytes?: number; signal?: AbortSignal;
}
export interface VectorSvgOptions extends VectorExportOptions { fonts?: readonly VectorExportFont[] }
export function exportSnapshot(scene: VectorScene, options: VectorExportOptions = {}) {
  cancelled(options.signal); const width = integer(options.width ?? 800, 'width'), height = integer(options.height ?? 600, 'height'), precision = integer(options.precision ?? 2, 'precision', 0, 10);
  const bounds = options.bounds ?? scene.computeBounds(10); bounds.validate();
  checkBytes(scene.getMemoryReport().cpuBytes * 8, options.maxBytes);
  return { width, height, precision, bounds, polygons: scene.polygons, polylines: scene.polylines, labels: options.includeLabels === false ? [] : scene.labels, background: options.background ? color(options.background) : null };
}
export function generateSvg(scene: VectorScene, options: VectorExportOptions = {}): string {
  const s = exportSnapshot(scene, options), fmt = (v: number) => (Object.is(v, -0) ? 0 : v).toFixed(s.precision), project = (p: ExportPoint) => project2dToScreen(p, s.bounds, [s.width, s.height]);
  const coords = (p: ExportPoint) => project(p).map(fmt).join(','), path = (p: ExportPoint[]) => p.map((v, i) => `${i ? 'L' : 'M'} ${coords(v)}`).join(' ') + ' Z';
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${s.height}" viewBox="0 0 ${s.width} ${s.height}">`];
  if (s.background) lines.push(`  <rect width="${s.width}" height="${s.height}" fill="${css(s.background)}"/>`);
  for (const p of s.polygons) { const c = p.style, attrs = `fill="${c.fillColor[3] > .001 ? css(c.fillColor) : 'none'}" stroke="${c.strokeColor[3] > .001 ? css(c.strokeColor) : 'none'}" stroke-width="${fmt(c.strokeWidth)}" stroke-linejoin="round"`;
    lines.push(p.holes.length ? `  <path d="${[p.exterior, ...p.holes].map(path).join(' ')}" fill-rule="evenodd" ${attrs}/>` : `  <polygon points="${p.exterior.map(coords).join(' ')}" ${attrs}/>`);
  }
  for (const p of s.polylines) lines.push(`  <polyline points="${p.path.map(coords).join(' ')}" fill="none" stroke="${css(p.style.strokeColor)}" stroke-width="${fmt(p.style.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  for (const l of s.labels) { const c = l.style, [x, y] = project(l.position), attrs = `x="${fmt(x)}" y="${fmt(y)}" font-family="${xml(c.fontFamily)}" font-size="${fmt(c.fontSize)}" font-weight="${xml(c.fontWeight)}" text-anchor="middle" dominant-baseline="middle"`, text = xml(l.text);
    if (c.haloWidth && c.haloColor[3] > .001) lines.push(`  <text ${attrs} fill="none" stroke="${css(c.haloColor)}" stroke-width="${fmt(c.haloWidth * 2)}" stroke-linejoin="round">${text}</text>`);
    lines.push(`  <text ${attrs} fill="${css(c.color)}">${text}</text>`);
  }
  lines.push('</svg>'); const svg = lines.join('\n'); checkBytes(svg.length * 2, options.maxBytes); cancelled(options.signal); return svg;
}
/** Standalone SVG Blob with embedded fonts; generateSvg remains a synchronous markup API. */
export async function exportSvg(scene: VectorScene, options: VectorSvgOptions = {}): Promise<Blob> {
  const snapshot = exportSnapshot(scene, options), markup = generateSvg(scene, options), sceneBytes = scene.getMemoryReport().cpuBytes, families = new Set<string>();
  for (const label of snapshot.labels) {
    families.add(label.style.fontFamily);
    if (/[\u0600-\u06ff]/u.test(label.text)) families.add('NotoSansArabic');
    if (/[\u0900-\u097f]/u.test(label.text)) families.add('NotoSansDevanagari');
  }
  const cssRules: string[] = [], aliases = new Map([...families].sort().map((family, i) => [family, 'Forge3D-embedded-' + i])); let bytesHeld = 0;
  for (const family of [...families].sort()) {
    const canonical = ['sans-serif', 'Arial', 'DejaVu Sans'].includes(family) ? 'DejaVu Sans' : family;
    const source = options.fonts?.find(f => f.family === family || f.family === canonical)?.source ?? exportFontSource(canonical);
    if (!source) cartographicError(`SVG font family is unavailable: ${family}`, 'font-unavailable');
    const bytes = await readByteSource(source, { maxBytes: Math.min(options.maxBytes ?? 128 * 1024 * 1024, 16 * 1024 * 1024), ...(options.signal ? { signal: options.signal } : {}) });
    validateExportFont(bytes); bytesHeld += bytes.length; checkBytes(bytesHeld * 6 + sceneBytes * 8, options.maxBytes);
    let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    // CSS string escaping is separate from XML escaping.
    const safeFamily = aliases.get(family)!;
    cssRules.push(`@font-face{font-family:"${safeFamily}";src:url(data:font/ttf;base64,${btoa(binary)}) format("truetype")}`);
  }
  cancelled(options.signal); let svg = markup;
  for (const [family, alias] of aliases) {
    const fallback = ['NotoSansArabic', 'NotoSansDevanagari'].filter(f => f !== family && aliases.has(f)).map(f => aliases.get(f)!);
    svg = svg.replaceAll(`font-family="${xml(family)}"`, `font-family="${[alias, ...fallback].join(', ')}"`);
  }
  if (cssRules.length) { const index = svg.indexOf('>', svg.indexOf('<svg')) + 1; svg = svg.slice(0, index) + '\n<defs><style>' + xml(cssRules.join('\n')) + '</style></defs>' + svg.slice(index); }
  checkBytes(svg.length * 2, options.maxBytes); return new Blob([svg], { type: 'image/svg+xml' });
}
/** Worker-safe XML structure validation. Rejects DTD/entities and malformed nesting/attributes. */
export function validateSvg(source: string): boolean {
  checkBytes(source.length * 2); let i = 0, root = '', rootAttributes = '', roots = 0; const stack: string[] = [];
  const bad = () => cartographicError('Malformed SVG XML', 'invalid-svg');
  const entities = (s: string) => { if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[a-f\d]+;)/i.test(s)) bad(); };
  while (i < source.length) {
    if (source[i] !== '<') { const end = source.indexOf('<', i), t = source.slice(i, end < 0 ? source.length : end); entities(t); if (!stack.length && t.trim()) bad(); i += t.length; continue; }
    if (source.startsWith('<?xml ', i)) { const end = source.indexOf('?>', i); if (end < 0 || roots || stack.length) bad(); i = end + 2; continue; }
    if (source.startsWith('<!--', i)) { const end = source.indexOf('-->', i + 4); if (end < 0 || source.slice(i + 4, end).includes('--')) bad(); i = end + 3; continue; }
    if (source.startsWith('<![CDATA[', i)) { const end = source.indexOf(']]>', i); if (end < 0 || !stack.length) bad(); i = end + 3; continue; }
    let j = i + 1, quote = '';
    for (; j < source.length; j++) { const c = source[j]!; if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; }
    if (j === source.length) bad(); const token = source.slice(i + 1, j); i = j + 1;
    if (token.startsWith('/')) { const name = token.slice(1).trim(); if (!/^[A-Za-z_][\w:.-]*$/.test(name) || stack.pop() !== name) bad(); continue; }
    const m = /^([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)$/.exec(token); if (!m) bad();
    const [, name, attrs, closed] = m!, keys = new Set<string>(); let rest = attrs!;
    while (rest.trim()) { const a = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"<]*"|'[^'<]*')/.exec(rest); if (!a || keys.has(a[1]!)) bad(); keys.add(a![1]!); entities(a![2]!); rest = rest.slice(a![0].length); }
    if (!stack.length) { if (++roots !== 1) bad(); root = name!; rootAttributes = attrs!; }
    if (!closed) stack.push(name!);
  }
  if (stack.length || roots !== 1) bad();
  return root === 'svg' && (/\bviewBox\s*=/.test(rootAttributes) || /\bwidth\s*=/.test(rootAttributes) && /\bheight\s*=/.test(rootAttributes));
}
