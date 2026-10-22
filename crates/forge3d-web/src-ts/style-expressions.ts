import { Forge3DError } from "./runtime-failure.js";
import { NativeTuple, scalar, numeric, number, floating, result, unwrap, nativeTruth, nativeEqual, nativeString, nativeFloat } from './style-native-values.js';
export interface StyleEvalContext { properties?: Record<string, unknown>; zoom?: number; geometryType?: string; }
export const STYLE_EXPRESSION_OPERATORS = new Set('get has at length interpolate interpolate-hcl interpolate-lab step match case coalesce == != < <= > >= all any ! + - * / % ^ abs ceil floor round min max ln log10 log2 sin cos tan sqrt concat downcase upcase to-number to-string to-boolean typeof rgb rgba zoom geometry-type literal'.split(' '));
function roundEven(n: number) { const f = Math.floor(n); return n - f === .5 ? f % 2 === 0 ? f : f + 1 : Math.round(n); }
function mix(a: unknown, b: unknown, t: number): unknown { if (numeric(a) && numeric(b)) return result(number(a) + (number(b) - number(a)) * t, true); if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((v, i) => mix(v, b[i], t)); return t < .5 ? a : b; }
/** The native Python evaluator's supported behavior, including arity and Python coercions. */
export function evaluateStyleExpression(expression: unknown, context: StyleEvalContext = {}): unknown {
    let nodes = 0;
    const evaluate = (e: unknown, depth = 0): unknown => {
        if (++nodes > 10000 || depth > 64) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Style expression exceeds evaluation limit');
        if (!Array.isArray(e)) return scalar(e);
        const op = e[0], args = e.slice(1), ev = (v: unknown) => evaluate(v, depth + 1);
        if (op === 'literal') return scalar(args[0]);
        if (op === 'zoom') return context.zoom === undefined ? result(10, true) : scalar(context.zoom);
        if (op === 'geometry-type') return context.geometryType ?? null;
        if (op === 'get' || op === 'has') { const key = args[0], props = context.properties ?? {}; if (typeof key !== 'string') return op === 'has' ? false : null; return op === 'has' ? Object.hasOwn(props, key) : Object.hasOwn(props, key) ? scalar(props[key]) : null; }
        if (op === 'at') { if (args.length < 2) return null; const i = ev(args[0]), a = ev(args[1]); return numeric(i) && Array.isArray(a) && Math.trunc(number(i)) >= 0 ? scalar(a[Math.trunc(number(i))]) : null; }
        if (op === 'length') { if (!args.length) return null; const a = ev(args[0]); return typeof a === 'string' ? result([...a].length) : Array.isArray(a) ? result(a.length) : null; }
        if (op === 'coalesce') { for (const a of args) { const v = ev(a); if (v !== null) return v; } return null; }
        if (op === 'case') { if (args.length < 2) return null; for (let i = 0; i + 1 < args.length - 1; i += 2) if (nativeTruth(ev(args[i]))) return ev(args[i + 1]); return ev(args.at(-1)); }
        if (op === 'match') { if (args.length < 3) return null; const input = ev(args[0]); for (let i = 1; i + 1 < args.length - 1; i += 2) if (Array.isArray(args[i]) ? args[i].some((v: unknown) => nativeEqual(v, input)) : nativeEqual(args[i], input)) return ev(args[i + 1]); return ev(args.at(-1)); }
        if (op === 'step') { if (args.length < 3) return null; const input = ev(args[0]); let output = args[1]; if (numeric(input)) for (let i = 2; i + 1 < args.length; i += 2) { if (!numeric(args[i]) || number(input) < number(args[i])) break; output = args[i + 1]; } return ev(output); }
        if (['interpolate', 'interpolate-hcl', 'interpolate-lab'].includes(op)) {
            if (args.length < 4) return null; const input = ev(args[1]); if (!numeric(input)) return null;
            const stops: [number, unknown][] = []; for (let i = 2; i + 1 < args.length; i += 2) if (numeric(args[i])) stops.push([number(args[i]), args[i + 1]]);
            if (!stops.length) return null;
            if (number(input) <= stops[0]![0]) return ev(stops[0]![1]);
            if (number(input) >= stops.at(-1)![0]) return ev(stops.at(-1)![1]);
            for (let i = 1; i < stops.length; i++) { const [lo, a] = stops[i - 1]!, [hi, b] = stops[i]!; if (number(input) >= lo && number(input) <= hi) {
                const base = Array.isArray(args[0]) && args[0][0] === 'exponential' && args[0].length > 1 ? nativeFloat(args[0][1]) : result(1, true);
                if (!numeric(base)) return null;
                const t = hi === lo ? 0 : number(base) !== 1 ? (number(base) ** (number(input) - lo) - 1) / (number(base) ** (hi - lo) - 1) : (number(input) - lo) / (hi - lo);
                return mix(ev(a), ev(b), t);
            } } return null;
        }
        if (op === 'all') return args.every(a => nativeTruth(ev(a)));
        if (op === 'any') return args.some(a => nativeTruth(ev(a)));
        if (op === '!') return !nativeTruth(ev(args[0]));
        if (op === 'concat') return args.map(a => nativeString(ev(a))).join('');
        if (op === 'to-string') return nativeString(ev(args[0]));
        if (op === 'to-number') return nativeFloat(ev(args[0]));
        if (op === 'to-boolean') { const v = ev(args[0]); return typeof v === 'boolean' ? v : numeric(v) ? number(v) !== 0 : typeof v === 'string' ? !!v.length : v !== null; }
        if (op === 'typeof') { const v = ev(args[0]); return v === null || v instanceof NativeTuple ? 'null' : numeric(v) && typeof v !== 'boolean' ? 'number' : Array.isArray(v) ? 'array' : typeof v; }
        if (op === 'upcase' || op === 'downcase') { const v = ev(args[0]); return typeof v === 'string' ? op === 'upcase' ? v.toUpperCase() : v.toLowerCase() : null; }
        if (op === 'rgb' || op === 'rgba') { const count = op === 'rgb' ? 3 : 4; if (args.length < count) return null; const values = args.slice(0, count).map(ev); return values.every(numeric) ? new NativeTuple([result(number(values[0]) / 255, true), result(number(values[1]) / 255, true), result(number(values[2]) / 255, true), op === 'rgb' ? result(1, true) : values[3]]) : null; }
        if (op === 'min' || op === 'max') { const ns = args.map(ev).filter(numeric); if (!ns.length) return null; return ns.reduce((a, b) => op === 'min' ? number(b) < number(a) ? b : a : number(b) > number(a) ? b : a); }
        if (op === '+' || op === '*') { const ns = args.map(ev); return ns.every(numeric) ? result(ns.reduce<number>((n, v) => op === '+' ? n + number(v) : n * number(v), op === '+' ? 0 : 1), true) : null; }
        if (op === '==' || op === '!=') { if (args.length < 2) return op === '!='; const equal = nativeEqual(ev(args[0]), ev(args[1])); return op === '==' ? equal : !equal; }
        if (['<', '<=', '>', '>='].includes(op)) { if (args.length < 2) return false; const a = ev(args[0]), b = ev(args[1]); return numeric(a) && numeric(b) ? op === '<' ? number(a) < number(b) : op === '<=' ? number(a) <= number(b) : op === '>' ? number(a) > number(b) : number(a) >= number(b) : false; }
        if (['-', '/', '%', '^'].includes(op)) {
            if (op === '-' && args.length === 1) { const a = ev(args[0]); return numeric(a) ? result(-number(a), floating(a)) : null; }
            if (args.length < 2) return null; const a = ev(args[0]), b = ev(args[1]); if (!numeric(a) || !numeric(b)) return null;
            const x = number(a), y = number(b), float = floating(a) || floating(b);
            if (op === '-') return result(x - y, float);
            if (op === '/') return y ? result(x / y, true) : null;
            if (op === '%') return y ? result(((x % y) + y) % y, float) : null;
            return result(x ** y, float || y < 0);
        }
        const functions: Record<string, (n: number) => number> = { abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: roundEven, ln: Math.log, log10: Math.log10, log2: Math.log2, sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt };
        if (typeof op !== 'string' || !Object.hasOwn(functions, op) || !args.length) return null;
        const value = ev(args[0]); if (!numeric(value)) return null;
        return result(functions[op]!(number(value)), op === 'abs' ? floating(value) : !['ceil', 'floor', 'round'].includes(op));
    };
    return unwrap(evaluate(expression));
}
/** Native legacy filters pass unknown operators through; validation still diagnoses them. */
export function evaluateStyleFilter(filter: unknown, context: StyleEvalContext = {}, depth = 0): boolean {
    if (depth > 64) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Style filter exceeds evaluation limit');
    if (filter == null || Array.isArray(filter) && !filter.length) return true;
    if (!Array.isArray(filter)) return false;
    const [op, key, ...args] = filter, props = context.properties ?? {};
    if (op === 'all' || op === 'any') { const parts = filter.slice(1).filter(Array.isArray), run = (f: unknown) => evaluateStyleFilter(f, context, depth + 1); return op === 'all' ? parts.every(run) : parts.some(run); }
    if (op === '!' || op === 'not') return filter.length === 2 && Array.isArray(key) ? !evaluateStyleFilter(key, context, depth + 1) : true;
    if (op === '==' || op === 'eq' || op === '!=' || op === 'neq') { if (filter.length !== 3 || typeof key !== 'string') return true; const equal = nativeEqual(Object.hasOwn(props, key) ? props[key] : null, args[0]); return op === '==' || op === 'eq' ? equal : !equal; }
    if (op === 'has') return filter.length !== 2 || typeof key !== 'string' ? true : Object.hasOwn(props, key);
    if (op === 'in') return filter.length < 3 || typeof key !== 'string' ? true : args.some(v => nativeEqual(Object.hasOwn(props, key) ? props[key] : null, v));
    return true;
}
