import { REGULAR_METRICS, BOLD_METRICS } from './cartography-font-metrics.js';
/** Pillow BASIC uses integer advances plus 26.6 kerning, not Canvas ink padding. */
export function basicLatinLayout(text: string, size: number, bold: boolean, draw?: (glyph: string, x: number) => void): number {
  const m = bold ? BOLD_METRICS : REGULAR_METRICS, count = 560, em = m.unitsPerEm;
  const pixel = (value: number) => Math.floor((value + 32) / 64);
  const signedRound = (value: number) => Math.sign(value) * Math.round(Math.abs(value));
  let position = 0, left = 0, right = 0;
  for (let i = 0; i < text.length; i++) {
    const index = text.charCodeAt(i) - 32, p = index * 3;
    const advance = pixel(Math.round(m.glyphs[p]! * size * 64 / em));
    const correction = m.bounds[size * count + index];
    const lo = Math.min(0, Math.floor(m.glyphs[p + 1]! * size / em)) + (correction?.[0] ?? 0);
    const hi = Math.max(advance, Math.ceil(m.glyphs[p + 2]! * size / em)) + (correction?.[1] ?? 0);
    const x = pixel(position); left = Math.min(left, x + lo); right = Math.max(right, x + hi);
    draw?.(text[i]!, x);
    let kern = m.kern[index * count + text.charCodeAt(i + 1) - 32] ?? 0;
    kern = signedRound(kern * size * 64 / em);
    if (size < 25) kern = signedRound(kern * size / 25);
    // The native BASIC backend adds the rounded kerning integer to its 26.6 advance.
    position += advance * 64 + pixel(kern); right = Math.max(right, pixel(position));
  }
  return right - left;
}
