/** Preserve Python numeric result kinds inside evaluation; public results remain JS values. */
export class NativeNumber { constructor(readonly value: number, readonly floating: boolean) {} }
export class NativeTuple { constructor(readonly values: unknown[]) {} }
export function scalar(v: unknown): unknown { return typeof v === 'number' ? new NativeNumber(v, !Number.isInteger(v) || Object.is(v, -0)) : v ?? null; }
export function numeric(v: unknown): boolean { return v instanceof NativeNumber || typeof v === 'number' || typeof v === 'boolean'; }
export function number(v: unknown): number { return v instanceof NativeNumber ? v.value : Number(v); }
export function floating(v: unknown): boolean { return v instanceof NativeNumber ? v.floating : typeof v === 'number' && !Number.isInteger(v); }
export function result(value: number, float = false): unknown { return Number.isFinite(value) ? new NativeNumber(float ? value : value === 0 ? 0 : value, float) : null; }
export function unwrap(v: unknown): unknown { return v instanceof NativeNumber ? v.value : v instanceof NativeTuple ? v.values.map(unwrap) : Array.isArray(v) ? v.map(unwrap) : v; }
export function nativeTruth(v: unknown): boolean { if (numeric(v)) return number(v) !== 0; if (v instanceof NativeTuple) return v.values.length > 0; if (Array.isArray(v)) return v.length > 0; if (v && typeof v === 'object') return Object.keys(v).length > 0; return !!v; }
export function nativeEqual(a: unknown, b: unknown): boolean {
    if (numeric(a) && numeric(b)) return number(a) === number(b);
    if (a instanceof NativeTuple || b instanceof NativeTuple) return a instanceof NativeTuple && b instanceof NativeTuple && nativeEqual(a.values, b.values);
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => nativeEqual(v, b[i]));
    if (a && b && typeof a === 'object' && typeof b === 'object') { const keys = Object.keys(a), other = Object.keys(b); return keys.length === other.length && keys.every(k => Object.hasOwn(b, k) && nativeEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])); }
    return a === b;
}
function floatText(value: number): string { if (Object.is(value, -0)) return '-0.0'; const abs = Math.abs(value); if (abs && (abs < 1e-4 || abs >= 1e16)) return value.toExponential().replace(/e([+-])(\d+)$/, (_m, sign: string, digits: string) => `e${sign}${digits.padStart(2, '0')}`); return Number.isInteger(value) ? `${value}.0` : String(value); }
function quoted(value: string): string { const quote = value.includes("'") && !value.includes('"') ? '"' : "'"; return quote + value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replaceAll(quote, '\\' + quote) + quote; }
export function nativeString(v: unknown, repr = false): string {
    if (v == null) return repr ? 'None' : '';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (v instanceof NativeNumber) return v.floating ? floatText(v.value) : String(v.value);
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return repr ? quoted(v) : v;
    if (v instanceof NativeTuple) return '(' + v.values.map(x => nativeString(x, true)).join(', ') + (v.values.length === 1 ? ',' : '') + ')';
    if (Array.isArray(v)) return '[' + v.map(x => nativeString(x, true)).join(', ') + ']';
    if (typeof v === 'object') return '{' + Object.entries(v).map(([k, value]) => `${quoted(k)}: ${nativeString(value, true)}`).join(', ') + '}';
    return '';
}
export function nativeFloat(value: unknown): unknown { if (numeric(value)) return result(number(value), true); if (typeof value !== 'string') return null; const text = value.trim(); if (!/^[+-]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.(?:\d(?:_?\d)*))(?:[eE][+-]?\d(?:_?\d)*)?$/.test(text)) return null; return result(Number(text.replaceAll('_', '')), true); }
