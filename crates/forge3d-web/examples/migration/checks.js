// RGB checks deliberately ignore opaque alpha: a clear-only RGBA frame fails.
export function changedPixels(before, after, tolerance = 2) {
  if (before.length !== after.length) throw Error('Frame dimensions changed');
  let count = 0;
  for (let i = 0; i < after.length; i += 4) if (Math.max(...[0, 1, 2].map(c => Math.abs(after[i + c] - before[i + c]))) > tolerance) count++;
  return count;
}
export function requirePixelChange(before, after, label, minimum = 8) {
  const changed = changedPixels(before, after);
  if (changed < minimum) throw Error(`${label} contributed only ${changed} RGB pixels (need ${minimum})`);
  return changed;
}
export function normalizeDemRgba(data) {
  let min = Infinity, max = -Infinity;
  for (const value of data) { min = Math.min(min, value); max = Math.max(max, value); }
  const span = Math.max(max - min, 1e-6), f = Math.fround;
  const rgba = new Uint8Array(data.length * 4);
  data.forEach((value, i) => { const n = Math.max(0, Math.min(255, Math.floor(f(f(f(value - min) / f(span)) * 255)))); rgba.set([n, n, n, 255], i * 4); });
  return rgba;
}
