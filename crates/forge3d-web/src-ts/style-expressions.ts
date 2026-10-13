import { Forge3DError } from './index.js';
export interface StyleEvalContext { properties?: Record<string, unknown>; zoom?: number; geometryType?: string; }
export const STYLE_EXPRESSION_OPERATORS = new Set('get has at length interpolate interpolate-hcl interpolate-lab step match case coalesce == != < <= > >= all any ! + - * / % ^ abs ceil floor round min max ln log10 log2 sin cos tan sqrt concat downcase upcase to-number to-string to-boolean typeof rgb rgba zoom geometry-type literal'.split(' '));
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const truth = (v: unknown): boolean => !!v && (!Array.isArray(v) || v.length > 0) && (typeof v !== 'object' || v === null || Object.keys(v).length > 0);
function roundEven(n: number) { const f = Math.floor(n); return n - f === .5 ? f % 2 === 0 ? f : f + 1 : Math.round(n); }
function mix(a: unknown, b: unknown, t: number): unknown {
    if (num(a) && num(b)) return a + (b - a) * t;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((v, i) => mix(v, b[i], t));
    return t < .5 ? a : b;
}
/** Native expression subset. Failure returns null; unknown operators are diagnosed by the style parser. */
export function evaluateStyleExpression(expression: unknown, context: StyleEvalContext = {}): unknown {
    let nodes = 0;
    const evaluate = (e: unknown, depth = 0): unknown => {
        if (++nodes > 10000 || depth > 64) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Style expression exceeds evaluation limit');
        if (!Array.isArray(e)) return e ?? null;
        const op = e[0], args = e.slice(1), ev = (v: unknown) => evaluate(v, depth + 1);
        if (op === 'literal') return args[0] ?? null;
        if (op === 'zoom') return context.zoom ?? 10;
        if (op === 'geometry-type') return context.geometryType ?? null;
        if (op === 'get' || op === 'has') {
            const key = args[0], props = args.length > 1 ? ev(args[1]) : context.properties ?? {};
            if (typeof key !== 'string' || !props || typeof props !== 'object') return op === 'has' ? false : null;
            return op === 'has' ? Object.hasOwn(props, key) : Object.hasOwn(props, key) ? (props as Record<string, unknown>)[key] ?? null : null;
        }
        if (op === 'at') { const i = ev(args[0]), a = ev(args[1]); return num(i) && Array.isArray(a) ? a[Math.trunc(i)] ?? null : null; }
        if (op === 'length') { const a = ev(args[0]); return typeof a === 'string' ? [...a].length : Array.isArray(a) ? a.length : null; }
        if (op === 'coalesce') { for (const a of args) { const v = ev(a); if (v !== null) return v; } return null; }
        if (op === 'case') { for (let i = 0; i + 1 < args.length - 1; i += 2) if (truth(ev(args[i]))) return ev(args[i + 1]); return ev(args.at(-1)); }
        if (op === 'match') { const input = ev(args[0]); for (let i = 1; i + 1 < args.length - 1; i += 2) if (Array.isArray(args[i]) ? args[i].includes(input) : args[i] === input) return ev(args[i + 1]); return ev(args.at(-1)); }
        if (op === 'step') { const input = ev(args[0]); let result = args[1]; if (num(input)) for (let i = 2; i + 1 < args.length; i += 2) { if (!num(args[i]) || input < args[i]) break; result = args[i + 1]; } return ev(result); }
        if (typeof op === 'string' && op.startsWith('interpolate')) {
            const input = ev(args[1]); if (!num(input) || args.length < 4) return null;
            const stops: [number, unknown][] = []; for (let i = 2; i + 1 < args.length; i += 2) if (num(args[i])) stops.push([args[i], args[i + 1]]);
            if (!stops.length) return null;
            if (input <= stops[0]![0]) return ev(stops[0]![1]);
            if (input >= stops.at(-1)![0]) return ev(stops.at(-1)![1]);
            for (let i = 1; i < stops.length; i++) { const [lo, a] = stops[i - 1]!, [hi, b] = stops[i]!; if (input <= hi) {
                const base = Array.isArray(args[0]) && args[0][0] === 'exponential' ? Number(args[0][1]) : 1;
                const t = base !== 1 ? (base ** (input - lo) - 1) / (base ** (hi - lo) - 1) : (input - lo) / (hi - lo);
                return mix(ev(a), ev(b), t);
            } } return null;
        }
        if (op === 'all') return args.every(a => truth(ev(a)));
        if (op === 'any') return args.some(a => truth(ev(a)));
        if (op === '!') return !truth(ev(args[0]));
        const values = args.map(ev), a = values[0], b = values[1];
        if (op === '==' || op === '!=') { const equal = JSON.stringify(a) === JSON.stringify(b); return op === '==' ? equal : !equal; }
        if (['<', '<=', '>', '>='].includes(op)) return num(a) && num(b) ? op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b : false;
        if (op === 'typeof') return a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
        if (op === 'to-string') return a === null ? '' : String(a);
        if (op === 'to-boolean') return truth(a);
        if (op === 'to-number') { const n = typeof a === 'string' || typeof a === 'boolean' || num(a) ? Number(a) : NaN; return Number.isFinite(n) ? n : null; }
        if (op === 'concat') return values.map(v => v === null ? '' : String(v)).join('');
        if (op === 'upcase' || op === 'downcase') return typeof a === 'string' ? op === 'upcase' ? a.toUpperCase() : a.toLowerCase() : null;
        if (op === 'rgb' || op === 'rgba') return values.length >= (op === 'rgb' ? 3 : 4) && values.every(num) ? [Number(a) / 255, Number(b) / 255, Number(values[2]) / 255, op === 'rgb' ? 1 : values[3]] : null;
        if (op === 'min' || op === 'max') { const ns = values.filter(num); return ns.length ? op === 'min' ? Math.min(...ns) : Math.max(...ns) : null; }
        if (!values.every(num)) return null;
        let result: number;
        switch (op) {
            case '+': result = (values as number[]).reduce((x, y) => x + y, 0); break;
            case '*': result = (values as number[]).reduce((x, y) => x * y, 1); break;
            case '-': result = values.length === 1 ? -Number(a) : Number(a) - Number(b); break;
            case '/': result = Number(a) / Number(b); break;
            case '%': result = ((Number(a) % Number(b)) + Number(b)) % Number(b); break;
            case '^': result = Number(a) ** Number(b); break;
            default: {
                const functions: Record<string, (n: number) => number> = { abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: roundEven, ln: Math.log, log10: Math.log10, log2: Math.log2, sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt };
                if (typeof op !== 'string' || !Object.hasOwn(functions, op) || !num(a)) return null;
                result = functions[op]!(a);
            }
        }
        return Number.isFinite(result) ? result : null;
    };
    return evaluate(expression);
}
/** Legacy property filters are separate from expression literals. Native maxzoom is inclusive. */
export function evaluateStyleFilter(filter: unknown, context: StyleEvalContext = {}): boolean {
    if (filter == null) return true;
    if (!Array.isArray(filter)) return false;
    if (!filter.length) return true;
    const [op, key, ...args] = filter;
    if (op === 'all') return filter.slice(1).every(f => evaluateStyleFilter(f, context));
    if (op === 'any') return filter.slice(1).some(f => evaluateStyleFilter(f, context));
    if (op === 'none') return !filter.slice(1).some(f => evaluateStyleFilter(f, context));
    if (typeof key === 'string') {
        const value = key === '$type' ? context.geometryType : context.properties?.[key];
        if (op === 'has' || op === '!has') { const has = key === '$type' ? !!context.geometryType : Object.hasOwn(context.properties ?? {}, key); return op === 'has' ? has : !has; }
        if (op === 'in' || op === '!in') return op === 'in' ? args.includes(value) : !args.includes(value);
        return !!evaluateStyleExpression([op, ['literal', value ?? null], ['literal', args[0]]], context);
    }
    return !!evaluateStyleExpression(filter, context);
}
