import { Forge3DError } from "./runtime-failure.js";

/** Straight RGBA, sRGB unless a particular API explicitly says linear. */
export type CartographicColor = readonly [number, number, number, number];
export const CARTOGRAPHY_MAX_BYTES = 128 * 1024 * 1024;
export function cartographicError(message: string, reason = 'invalid-cartography'): never {
  throw new Forge3DError('INVALID_INPUT', message, { reason });
}
export function finite(value: number, name: string, min = -Infinity, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max) cartographicError(`${name} must be finite in [${min}, ${max}]`);
  return value;
}
export function integer(value: number, name: string, min = 1, max = 16384): number {
  finite(value, name, min, max);
  if (!Number.isInteger(value)) cartographicError(`${name} must be an integer`);
  return value;
}
export function color(value: CartographicColor): [number, number, number, number] {
  if (value.length !== 4) cartographicError('RGBA must have four components');
  return value.map(v => finite(v, 'RGBA', 0, 1)) as [number, number, number, number];
}
export function css(value: CartographicColor): string {
  const c = color(value), rgb = c.slice(0, 3).map(v => Math.floor(v * 255));
  return c[3] === 1 ? '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('') : `rgba(${rgb.join(',')},${c[3].toFixed(2)})`;
}
export function checkBytes(bytes: number, maxBytes = CARTOGRAPHY_MAX_BYTES): void {
  integer(maxBytes, 'maxBytes', 1, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Cartographic memory budget exceeded', { requestedBytes: bytes, maxBytes });
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Forge3DError('REQUEST_CANCELLED', 'Cartographic operation cancelled');
}
export function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) cartographicError('Text contains invalid XML characters');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
export function srgbToLinear(c: number): number { return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
export function linearToSrgb(c: number): number { return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; }
export function validateExportFont(bytes: Uint8Array): void {
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  if (bytes.length < 12 || !['OTTO', '\0\x01\0\0', 'true'].includes(signature)) cartographicError('Invalid export font bytes', 'invalid-font');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint16(4);
  if (!count || 12 + count * 16 > bytes.length) cartographicError('Truncated font directory', 'invalid-font');
  for (let i = 0; i < count; i++) { const p = 12 + i * 16, offset = view.getUint32(p + 8), length = view.getUint32(p + 12); if (offset + length > bytes.length) cartographicError('Truncated font table', 'invalid-font'); }
}
